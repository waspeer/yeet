// Round 2E: a `complete` of an upload whose size is known checks the
// length of `parts` against the declared size before any entry is looked
// at, and the request body is capped. Phase 2 measured a sized `complete`
// with 10,000 entries (refused for the size) at p90 18 ms CPU on Workers
// Free, nearly all of it validating and sorting the entries. The Worker's
// fetch handler runs in Node here on the in-memory strict bucket, so the R2
// calls are counted. The same refusals against `wrangler dev`:
// upload-api.spec.ts and verify-1l.spec.ts.

import { summarize, type UploadMeta } from "../../../packages/worker/src/uploads.js";
import { expect, test } from "../../lib/index.js";
import { StrictBucket } from "../../lib/strict-r2.js";
import { WORKER_ORIGIN, WORKER_TOKEN, workerFetch } from "../../lib/worker-node.js";

const P = "uploads";
const DAY = 86_400_000;
const PART_SIZE = 50 * 1024 * 1024;
/** R2's 10,000 parts (`MAX_PARTS` in index.ts). */
const MAX_PARTS = 10_000;
/** `MAX_COMPLETE_BODY` in index.ts: 96 bytes per entry and 1 KiB besides. */
const MAX_COMPLETE_BODY = 1024 + MAX_PARTS * 96;

/** A strict bucket whose multipart complete works and records what it got. */
class CompleteBucket extends StrictBucket {
  /** The parts each multipart complete was called with. */
  readonly completed: unknown[][] = [];
  override resumeMultipartUpload(key: string, uploadId: string) {
    const base = super.resumeMultipartUpload(key, uploadId);
    return {
      abort: base.abort,
      complete: async (parts: unknown[]) => {
        this.calls["complete"] = (this.calls["complete"] ?? 0) + 1;
        this.completed.push(parts);
        const id = key.slice(P.length + 1).split("/")[0]!;
        const meta = JSON.parse(this.objects.get(`${P}/${id}/.meta.json`)!.body) as UploadMeta;
        this.seed(key, "");
        return { size: meta.file_size ?? 0 };
      },
    };
  }
}

function seedPending(b: StrictBucket, id: string, size: number | undefined): void {
  const meta: UploadMeta = {
    filename: "f.bin",
    ...(size === undefined ? {} : { file_size: size }),
    uploaded_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 30 * DAY).toISOString(),
    pending_upload_id: `mp-${id}`,
  };
  b.seed(`${P}/${id}/.meta.json`, JSON.stringify(meta), {
    summary: JSON.stringify(summarize(meta)),
  });
}

/** A bucket with one pending upload `u` of `size` bytes, calls reset. */
function bucketWith(size: number | undefined): CompleteBucket {
  const b = new CompleteBucket({ maxCalls: Infinity });
  seedPending(b, "u", size);
  b.reset();
  return b;
}

/** POST complete with `body` (JSON-encoded unless a string or a stream). */
async function complete(
  b: StrictBucket,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; json: Record<string, unknown> }> {
  const stream = body instanceof ReadableStream;
  const res = await workerFetch(
    b,
    new Request(`${WORKER_ORIGIN}/api/uploads/u/complete`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${WORKER_TOKEN}`,
        "Content-Type": "application/json",
        ...headers,
      },
      body: stream || typeof body === "string" ? (body as BodyInit) : JSON.stringify(body),
      ...(stream ? { duplex: "half" } : {}),
    } as RequestInit),
  );
  return {
    status: res.status,
    json: (await res.json().catch(() => null)) as Record<string, unknown>,
  };
}

/** Entries 1..n, valid. */
const entries = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ part_number: i + 1, etag: `e${i + 1}` }));

/** n entries of which the first is invalid (no part_number). */
const withInvalid = (n: number) => [{ etag: "no number" }, ...entries(n - 1)];

const countError = (size: number, count: number, got: number) =>
  `Invalid parts: an upload of ${size} bytes has ${count} part${count === 1 ? "" : "s"} ` +
  `(part_size ${PART_SIZE} bytes), not ${got}`;

const ENTRY_ERROR = "Invalid parts: every part needs a part_number of 1 or more";

test.describe("complete with the size known: the count is checked first", () => {
  for (const [size, count] of [
    [1, 1],
    [PART_SIZE, 1],
    [PART_SIZE + 1, 2],
    [3 * PART_SIZE, 3],
  ] as const) {
    test(`size ${size} (${count} part${count === 1 ? "" : "s"}): one more or one fewer is refused before the entries are looked at`, async () => {
      for (const got of [count - 1, count + 1].filter((n) => n > 0)) {
        const b = bucketWith(size);
        // The invalid entry is never reported: the count is refused first.
        const res = await complete(b, { parts: withInvalid(got) });
        expect(res, `${got} entries`).toEqual({
          status: 400,
          json: { error: countError(size, count, got) },
        });
        // One sidecar read (to know the size) and nothing else.
        expect(b.calls, `${got} entries`).toEqual({ get: 1 });
        // Valid entries are refused the same way: one fewer never reaches R2.
        const valid = bucketWith(size);
        expect((await complete(valid, { parts: entries(got) })).json).toEqual({
          error: countError(size, count, got),
        });
        expect(valid.calls).toEqual({ get: 1 });
      }
    });
  }

  test("10,000 entries against a one-part upload: the count error, one R2 call", async () => {
    const b = bucketWith(3);
    const parts: unknown[] = [null, ...entries(MAX_PARTS - 1)];
    const res = await complete(b, { parts });
    expect(res).toEqual({ status: 400, json: { error: countError(3, 1, MAX_PARTS) } });
    expect(b.calls).toEqual({ get: 1 });
  });

  test("the exact count is accepted (entries in any order); one fewer is not", async () => {
    const size = 2 * PART_SIZE + 1;
    const b = bucketWith(size);
    const res = await complete(b, { parts: entries(3).reverse() });
    expect(res).toEqual({ status: 200, json: { id: "u", url: `${WORKER_ORIGIN}/u/f.bin` } });
    expect(b.completed).toEqual([
      entries(3).map(({ part_number, etag }) => ({ partNumber: part_number, etag })),
    ]);
    // With the exact count, the entries are still checked.
    const invalid = bucketWith(size);
    expect((await complete(invalid, { parts: withInvalid(3) })).json).toEqual({
      error: ENTRY_ERROR,
    });
    expect(invalid.calls).toEqual({ get: 1 });
    // One fewer used to reach R2's complete (and end in a 422 that deleted
    // the upload); now it is refused and the upload stays pending.
    const fewer = bucketWith(size);
    expect((await complete(fewer, { parts: entries(2) })).status).toBe(400);
    expect(fewer.completed).toEqual([]);
    expect(fewer.objects.has(`${P}/u/.meta.json`)).toBe(true);
  });

  test("an empty file is one part: accepted with 1, refused with 2 before the entries", async () => {
    const b = bucketWith(0);
    const res = await complete(b, { parts: entries(1), size: 0 });
    expect(res.status).toBe(200);
    expect(b.completed).toHaveLength(1);
    const two = bucketWith(0);
    expect(await complete(two, { parts: [...entries(1), { part_number: 2 }] })).toEqual({
      status: 400,
      json: { error: countError(0, 1, 2) },
    });
    expect(two.calls).toEqual({ get: 1 });
    const none = bucketWith(0);
    expect((await complete(none, { parts: [] })).json).toEqual({ error: "Missing parts" });
    expect(none.calls).toEqual({});
  });

  test("a finished upload answers its link without looking at the entries", async () => {
    const b = bucketWith(3);
    expect((await complete(b, { parts: entries(1) })).status).toBe(200);
    b.reset();
    // Whatever the entries: they are never used for a finished upload.
    const again = await complete(b, { parts: [null, ...entries(MAX_PARTS - 1)] });
    expect(again).toEqual({ status: 200, json: { id: "u", url: `${WORKER_ORIGIN}/u/f.bin` } });
    expect(b.calls).toEqual({ get: 1 });
    expect(b.completed).toHaveLength(1);
  });

  test("the size unknown at create: unchanged, the entries are checked", async () => {
    const b = bucketWith(undefined);
    expect((await complete(b, { parts: withInvalid(2), size: 3 })).json).toEqual({
      error: ENTRY_ERROR,
    });
  });
});

test.describe("the complete body is capped", () => {
  test(`a Content-Length over ${MAX_COMPLETE_BODY} bytes: 413 before anything is read`, async () => {
    const b = bucketWith(3);
    const body = JSON.stringify({ parts: entries(1), pad: "x".repeat(MAX_COMPLETE_BODY) });
    const res = await complete(b, body, { "Content-Length": String(body.length) });
    expect(res).toEqual({
      status: 413,
      json: { error: `Request body too large: at most ${MAX_COMPLETE_BODY} bytes` },
    });
    expect(b.calls).toEqual({});
  });

  test("a body without Content-Length is read no further than the cap", async () => {
    const b = bucketWith(3);
    let pulled = 0;
    const chunk = new Uint8Array(64 * 1024).fill(0x20);
    // A 4 MiB body of spaces, streamed: the route must stop reading it at the cap.
    const large = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulled >= 4 * 1024 * 1024) return controller.close();
        pulled += chunk.length;
        controller.enqueue(chunk);
      },
    });
    const res = await complete(b, large);
    expect(res.status).toBe(413);
    expect(pulled).toBeLessThan(MAX_COMPLETE_BODY + 4 * chunk.length);
    expect(b.calls).toEqual({});
  });

  test("a body of exactly the cap is read; 10,000 entries with 64-character etags fit", async () => {
    const etag = "f".repeat(64);
    const parts = Array.from({ length: MAX_PARTS }, (_, i) => ({ part_number: i + 1, etag }));
    const body = JSON.stringify({ parts, size: MAX_PARTS * PART_SIZE });
    expect(body.length).toBeLessThanOrEqual(MAX_COMPLETE_BODY);
    const b = bucketWith(MAX_PARTS * PART_SIZE);
    expect((await complete(b, body, { "Content-Length": String(body.length) })).status).toBe(200);
    const padded = body.slice(0, -1) + " ".repeat(MAX_COMPLETE_BODY - body.length) + "}";
    expect(padded.length).toBe(MAX_COMPLETE_BODY);
    const c = bucketWith(MAX_PARTS * PART_SIZE);
    expect((await complete(c, padded)).status).toBe(200);
  });
});
