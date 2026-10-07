// Streams a zip of the standard fixtures as the response body.
//   GET /zip?sizes=known|unknown|mixed&zip64=auto|always&compress=1|0&tz=<minutes east of UTC>
//   GET /info   runtime capabilities (CompressionStream formats)
//   GET /bench  CRC-32 and deflate-raw throughput inside workerd
import { fixtureEntries, generatedStream, noise, wavFill } from "../../fixtures.ts";
import { crc32Js, createZip } from "../../zip.ts";

async function supports(format: string): Promise<boolean> {
  try {
    const cs = new CompressionStream(format as CompressionFormat);
    await new Response(new Blob([new Uint8Array(16)]).stream().pipeThrough(cs)).arrayBuffer();
    return true;
  } catch {
    return false;
  }
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<number> {
  let n = 0;
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return n;
    n += value.length;
  }
}

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/info") {
      return Response.json({
        userAgent: navigator.userAgent,
        compressionStream: typeof CompressionStream,
        formats: Object.fromEntries(
          await Promise.all(
            ["deflate-raw", "deflate", "gzip"].map(async (f) => [f, await supports(f)]),
          ),
        ),
      });
    }
    if (url.pathname === "/bench") {
      // Note: Date.now()/performance.now() in workerd only advance across I/O;
      // locally (wrangler dev) timers are not coarsened the same way as in
      // production, so treat these as indicative only.
      const size = 32 * 1024 * 1024;
      const results: Record<string, number> = {};
      for (const [label, fill] of [
        ["random", noise(9)],
        ["wav", wavFill(size)],
      ] as const) {
        const t0 = Date.now();
        const buffers: Uint8Array[] = [];
        await drain(
          generatedStream(size, fill as (c: Uint8Array, o: number) => void).pipeThrough(
            new TransformStream({
              transform(chunk, c) {
                buffers.push(chunk);
                c.enqueue(chunk);
              },
            }),
          ),
        );
        await scheduler.wait(1);
        const t1 = Date.now();
        let crc = 0;
        for (const b of buffers) crc = crc32Js(b, crc);
        await scheduler.wait(1);
        const t2 = Date.now();
        const out = await drain(
          new ReadableStream<Uint8Array>({
            start(c) {
              for (const b of buffers) c.enqueue(b);
              c.close();
            },
          }).pipeThrough(
            new CompressionStream("deflate-raw") as unknown as ReadableWritablePair<
              Uint8Array,
              Uint8Array
            >,
          ),
        );
        const t3 = Date.now();
        results[`${label} generate ms`] = t1 - t0;
        results[`${label} crc32Js MB/s`] = size / 1e6 / ((t2 - t1) / 1000);
        results[`${label} deflate-raw MB/s`] = size / 1e6 / ((t3 - t2) / 1000);
        results[`${label} deflate-raw ratio`] = out / size;
      }
      return Response.json(results);
    }
    if (url.pathname === "/zip") {
      const sizes = (url.searchParams.get("sizes") ?? "known") as "known" | "unknown" | "mixed";
      const zip64 = url.searchParams.get("zip64") === "always" ? "always" : "auto";
      const compress = url.searchParams.get("compress") !== "0";
      const tz = url.searchParams.get("tz");
      const timeZoneOffset = tz === null ? undefined : Number(tz);
      const body = createZip(fixtureEntries({ sizes }), { zip64, compress, timeZoneOffset });
      return new Response(body, {
        headers: {
          "content-type": "application/zip",
          "content-disposition": 'attachment; filename="yeet-prototype.zip"',
        },
      });
    }
    return new Response("not found", { status: 404 });
  },
};

declare const scheduler: { wait(ms: number): Promise<void> };
