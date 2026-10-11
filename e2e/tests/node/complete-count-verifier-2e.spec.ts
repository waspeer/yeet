// Independent verifier of round 2E: what complete-count.spec.ts leaves
// open. Each test kills a mutant that survived it: the Content-Length check
// removed (the stream cap alone still answers 413, but only after reading
// up to 961,024 bytes), the `size` check moved after the sidecar read, the
// reader not cancelled past the cap, and a PUT part count without
// `max(1, …)` (an empty sized file's only part refused). The Worker's
// fetch handler in Node on the strict in-memory bucket, R2 calls counted.

import { readTextUpTo } from "../../../packages/worker/src/parse.js";
import { summarize, type UploadMeta } from "../../../packages/worker/src/uploads.js";
import { expect, test } from "../../lib/index.js";
import { StrictBucket } from "../../lib/strict-r2.js";
import { WORKER_ORIGIN, WORKER_TOKEN, workerFetch } from "../../lib/worker-node.js";

const P = "uploads";
const PART_SIZE = 50 * 1024 * 1024;
const MAX_COMPLETE_BODY = 1024 + 10_000 * 96;

/** A strict bucket whose multipart uploadPart works and records the parts. */
class PartBucket extends StrictBucket {
  readonly uploaded: number[] = [];
  override resumeMultipartUpload(key: string, uploadId: string) {
    const base = super.resumeMultipartUpload(key, uploadId);
    return {
      abort: base.abort,
      uploadPart: async (partNumber: number) => {
        this.calls["uploadPart"] = (this.calls["uploadPart"] ?? 0) + 1;
        this.uploaded.push(partNumber);
        return { partNumber, etag: `etag-${partNumber}` };
      },
    };
  }
}

function bucketWith(size: number | undefined): PartBucket {
  const b = new PartBucket({ maxCalls: Infinity });
  const meta: UploadMeta = {
    filename: "f.bin",
    ...(size === undefined ? {} : { file_size: size }),
    uploaded_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    pending_upload_id: "mp-u",
  };
  b.seed(`${P}/u/.meta.json`, JSON.stringify(meta), { summary: JSON.stringify(summarize(meta)) });
  b.reset();
  return b;
}

const auth = { Authorization: `Bearer ${WORKER_TOKEN}` };

/** A body stream that counts its pulls and whether it was cancelled; nothing is pulled until read. */
function countingStream(chunk: Uint8Array, total: number) {
  const state = { pulled: 0, cancelled: false };
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (state.pulled * chunk.length >= total) return controller.close();
        state.pulled++;
        controller.enqueue(chunk);
      },
      cancel() {
        state.cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  return { body, state };
}

test.describe("verifier 2E: complete body cap and check order", () => {
  test("a Content-Length over the cap is refused without reading any of the body", async () => {
    const b = bucketWith(3);
    const { body, state } = countingStream(new Uint8Array(64 * 1024).fill(0x20), 2_000_000);
    const res = await workerFetch(
      b,
      new Request(`${WORKER_ORIGIN}/api/uploads/u/complete`, {
        method: "POST",
        headers: { ...auth, "Content-Type": "application/json", "Content-Length": "2000000" },
        body,
        duplex: "half",
      } as RequestInit),
    );
    expect(res.status).toBe(413);
    expect(state.pulled).toBe(0);
    expect(b.calls).toEqual({});
  });

  test("a Content-Length of exactly the cap is read", async () => {
    const b = bucketWith(3);
    const text = JSON.stringify({ parts: [{ part_number: 1, etag: "e" }] });
    const padded = text.slice(0, -1) + " ".repeat(MAX_COMPLETE_BODY - text.length) + "}";
    const res = await workerFetch(
      b,
      new Request(`${WORKER_ORIGIN}/api/uploads/u/complete`, {
        method: "POST",
        headers: { ...auth, "Content-Length": String(padded.length) },
        body: padded,
      }),
    );
    // Past the cap and the count (1 part for 3 bytes): this bucket has no
    // multipart complete, so the route reaches R2 and fails there.
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/^Could not complete/);
  });

  test("an invalid size is refused before the sidecar read, also for an unknown id", async () => {
    for (const size of [-1, 1.5, "3", Number.MAX_SAFE_INTEGER + 2]) {
      for (const known of [true, false]) {
        const b = known ? bucketWith(3) : new PartBucket({ maxCalls: Infinity });
        const res = await workerFetch(
          b,
          new Request(`${WORKER_ORIGIN}/api/uploads/u/complete`, {
            method: "POST",
            headers: auth,
            body: JSON.stringify({ parts: [{ part_number: 1, etag: "e" }], size }),
          }),
        );
        expect(res.status, `${size} ${known}`).toBe(400);
        expect(await res.json()).toEqual({ error: "Invalid size" });
        expect(b.calls, `${size} ${known}`).toEqual({});
      }
    }
  });

  test("readTextUpTo cancels the body once it is over the limit", async () => {
    const { body, state } = countingStream(new Uint8Array(10).fill(0x20), 1000);
    expect(await readTextUpTo(body, 25)).toBeNull();
    expect(state.cancelled).toBe(true);
    expect(state.pulled).toBe(3);
  });
});

test.describe("verifier 2E: PUT uses the same part count", () => {
  async function put(b: StrictBucket, n: number, length: number) {
    const res = await workerFetch(
      b,
      new Request(`${WORKER_ORIGIN}/api/uploads/u/parts/${n}`, {
        method: "PUT",
        headers: { ...auth, "Content-Length": String(length) },
        body: length === 0 ? null : new Uint8Array(length),
      }),
    );
    return res.status;
  }

  test("an empty sized file: its one empty part is accepted, a part 2 is not", async () => {
    const b = bucketWith(0);
    expect(await put(b, 1, 0)).toBe(200);
    expect(await put(b, 2, 0)).toBe(400);
    expect(b.uploaded).toEqual([1]);
  });

  test("a file of one byte over a part: the last part is that byte, a part 3 is refused", async () => {
    const b = bucketWith(PART_SIZE + 1);
    expect(await put(b, 2, 1)).toBe(200);
    expect(await put(b, 2, 2)).toBe(400);
    expect(await put(b, 3, 1)).toBe(400);
    expect(b.uploaded).toEqual([2]);
  });
});
