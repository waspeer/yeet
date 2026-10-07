// Browser harness, bundled by scripts/browser-test.ts into an IIFE that
// exposes `window.zipHarness`. Uses the same zip.ts and fixtures.ts files.
import { fixtureEntries, generatedStream, noise, wavFill } from "../fixtures.ts";
import { crc32Js, createZip, type ZipEntry } from "../zip.ts";

async function bytesOf(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

async function supports(format: string): Promise<boolean> {
  try {
    await bytesOf(
      new Blob([new Uint8Array(16)])
        .stream()
        .pipeThrough(new CompressionStream(format as CompressionFormat)),
    );
    return true;
  } catch {
    return false;
  }
}

/** Turn fixture entries into real File objects, then back into ZipEntry the way the upload page would. */
async function asFiles(entries: ZipEntry[]): Promise<ZipEntry[]> {
  const out: ZipEntry[] = [];
  for (const e of entries) {
    if (!e.stream) {
      out.push(e);
      continue;
    }
    const blob = await new Response(e.stream()).blob();
    const file = new File([blob], e.path.split("/").pop()!, { lastModified: e.lastModified });
    out.push({
      path: e.path,
      lastModified: file.lastModified,
      size: file.size,
      compress: e.compress,
      stream: () => file.stream(),
    });
  }
  return out;
}

const harness = {
  async info() {
    return {
      userAgent: navigator.userAgent,
      compressionStream: typeof CompressionStream,
      formats: Object.fromEntries(
        await Promise.all(
          ["deflate-raw", "deflate", "gzip"].map(async (f) => [f, await supports(f)]),
        ),
      ),
    };
  },
  /** Build a zip in the page and return it base64-encoded. */
  async zip(sizes: "known" | "unknown" | "mixed", viaFiles: boolean, tzOffset?: number) {
    let entries = fixtureEntries({ sizes });
    if (viaFiles) entries = await asFiles(entries);
    const t0 = performance.now();
    const bytes = await bytesOf(createZip(entries, { timeZoneOffset: tzOffset }));
    return { base64: toBase64(bytes), ms: performance.now() - t0 };
  },
  /** CompressionStream("deflate-raw") on files fetched from the harness server (held in memory first). */
  async benchUrls(urls: string[]) {
    const files = await Promise.all(
      urls.map(async (u) => new Uint8Array(await (await fetch(u)).arrayBuffer())),
    );
    const total = files.reduce((a, f) => a + f.length, 0);
    let best = Infinity;
    let out = 0;
    for (let run = 0; run < 3; run++) {
      const t = performance.now();
      out = 0;
      for (const f of files) {
        const source = new ReadableStream<Uint8Array>({
          start(c) {
            for (let i = 0; i < f.length; i += 1 << 16) c.enqueue(f.subarray(i, i + (1 << 16)));
            c.close();
          },
        });
        out += (
          await bytesOf(
            source.pipeThrough(
              new CompressionStream("deflate-raw") as unknown as ReadableWritablePair<
                Uint8Array,
                Uint8Array
              >,
            ),
          )
        ).length;
      }
      best = Math.min(best, performance.now() - t);
    }
    return { bytes: total, "deflate-raw MB/s": total / 1e6 / (best / 1000), ratio: out / total };
  },
  /** Throughput of crc32Js and CompressionStream("deflate-raw") on 64 MiB of random and synthetic WAV data. */
  async bench() {
    const size = 64 * 1024 * 1024;
    const results: Record<string, number> = {};
    for (const [label, fill] of [
      ["random", noise(9)],
      ["wav", wavFill(size)],
    ] as const) {
      const data = await bytesOf(generatedStream(size, fill as (c: Uint8Array, o: number) => void));
      const chunks: Uint8Array[] = [];
      for (let i = 0; i < size; i += 1 << 20) chunks.push(data.subarray(i, i + (1 << 20)));
      let best = Infinity;
      for (let run = 0; run < 3; run++) {
        const t = performance.now();
        let crc = 0;
        for (const c of chunks) crc = crc32Js(c, crc);
        best = Math.min(best, performance.now() - t);
      }
      results[`${label} crc32Js MB/s`] = size / 1e6 / (best / 1000);
      best = Infinity;
      let out = 0;
      for (let run = 0; run < 3; run++) {
        const t = performance.now();
        const source = new ReadableStream<Uint8Array>({
          start(c) {
            for (const ch of chunks) c.enqueue(ch);
            c.close();
          },
        });
        out = (
          await bytesOf(
            source.pipeThrough(
              new CompressionStream("deflate-raw") as unknown as ReadableWritablePair<
                Uint8Array,
                Uint8Array
              >,
            ),
          )
        ).length;
        best = Math.min(best, performance.now() - t);
      }
      results[`${label} deflate-raw MB/s`] = size / 1e6 / (best / 1000);
      results[`${label} deflate-raw ratio`] = out / size;
    }
    return results;
  },
};

(globalThis as unknown as { zipHarness: typeof harness }).zipHarness = harness;
