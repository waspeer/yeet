// Independent verifier of round 2F: the R2 call budget behind
// MAX_UNSIZED_PARTS (100) at its exact edges, which the existing tests only
// approach from far away (100 records at 3 per list call take 35 of the 46
// calls). readPartSizes() on the in-memory strict bucket, and a `complete`
// through the Worker's fetch handler in Node, its R2 calls counted.

import {
  MAX_UNSIZED_PARTS,
  PART_RECORDS_BUDGET,
  summarize,
  Uploads,
  type UploadMeta,
} from "../../../packages/worker/src/uploads.js";
import { expect, test } from "../../lib/index.js";
import { StrictBucket } from "../../lib/strict-r2.js";
import { WORKER_ORIGIN, WORKER_TOKEN, workerFetch } from "../../lib/worker-node.js";

const P = "uploads";
const PART_SIZE = 50 * 1024 * 1024;

/** A strict bucket with `n` part records of upload `x`, `perCall` per metadata list call. */
function records(n: number, perCall: number): StrictBucket {
  const b = new StrictBucket({ maxCalls: 1000, metadataCap: perCall });
  for (let i = 1; i <= n; i++) b.seed(`${P}/x/.parts/${i}`, "", { size: String(PART_SIZE) });
  b.reset();
  return b;
}

test.describe("verifier 2F: the R2 call budget of readPartSizes() at its edges", () => {
  test("the budget is the Free plan's 50 subrequests minus complete's 4 others", () => {
    expect(PART_RECORDS_BUDGET).toBe(50 - 4);
  });

  test("100 records at 3 per call: 34 list calls and a delete fit a budget of 35, not 34", async () => {
    const fits = records(MAX_UNSIZED_PARTS, 3);
    const ok = await new Uploads(fits, P).readPartSizes("x", 35, MAX_UNSIZED_PARTS);
    expect(ok?.keys).toHaveLength(MAX_UNSIZED_PARTS);
    expect(fits.calls).toEqual({ list: 34 });

    // One short: refused before the list call that would leave no room for
    // the delete, so the calls made stay within the budget minus the delete.
    const short = records(MAX_UNSIZED_PARTS, 3);
    expect(await new Uploads(short, P).readPartSizes("x", 34, MAX_UNSIZED_PARTS)).toBeNull();
    expect(short.calls).toEqual({ list: 33 });
  });

  test("at PART_RECORDS_BUDGET: 45 list calls and a delete fit, 46 list calls are refused", async () => {
    // 2 records per call (fewer than the 3 at which MAX_UNSIZED_PARTS
    // records always fit): 90 records take exactly 45 calls.
    const fits = records(90, 2);
    const ok = await new Uploads(fits, P).readPartSizes(
      "x",
      PART_RECORDS_BUDGET,
      MAX_UNSIZED_PARTS,
    );
    expect(ok?.keys).toHaveLength(90);
    expect(fits.calls).toEqual({ list: 45 });

    const over = records(91, 2);
    expect(
      await new Uploads(over, P).readPartSizes("x", PART_RECORDS_BUDGET, MAX_UNSIZED_PARTS),
    ).toBeNull();
    expect(over.calls["list"]).toBe(PART_RECORDS_BUDGET - 1);
  });
});

/** A strict bucket whose multipart complete works (and is counted). */
class CompleteBucket extends StrictBucket {
  override resumeMultipartUpload(key: string, uploadId: string) {
    const base = super.resumeMultipartUpload(key, uploadId);
    return {
      abort: base.abort,
      complete: async (_parts: unknown[]) => {
        this.calls["complete"] = (this.calls["complete"] ?? 0) + 1;
        this.seed(key, "");
        return { size: 0 };
      },
    };
  }
}

/** A pending upload `u` of unknown size with `n` full part records, `perCall` per list call. */
function pendingWith(n: number, perCall: number): CompleteBucket {
  const b = new CompleteBucket({ maxCalls: Infinity, metadataCap: perCall });
  const meta: UploadMeta = {
    filename: "f.bin",
    uploaded_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    pending_upload_id: "mp-u",
  };
  b.seed(`${P}/u/.meta.json`, JSON.stringify(meta), { summary: JSON.stringify(summarize(meta)) });
  for (let i = 1; i <= n; i++) b.seed(`${P}/u/.parts/${i}`, "", { size: String(PART_SIZE) });
  b.reset();
  return b;
}

async function complete(b: StrictBucket, n: number): Promise<{ status: number; error?: string }> {
  const parts = Array.from({ length: n }, (_, i) => ({ part_number: i + 1, etag: `e${i + 1}` }));
  const res = await workerFetch(
    b,
    new Request(`${WORKER_ORIGIN}/api/uploads/u/complete`, {
      method: "POST",
      headers: { Authorization: `Bearer ${WORKER_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ parts }),
    }),
  );
  const json = (await res.json()) as { error?: string };
  return { status: res.status, ...(json.error ? { error: json.error } : {}) };
}

test.describe("verifier 2F: complete of unknown size, its R2 calls at the edges", () => {
  test("100 parts in one list call: completed, the edge a zip of exactly 100 parts reaches", async () => {
    const b = pendingWith(MAX_UNSIZED_PARTS, 1000);
    expect(await complete(b, MAX_UNSIZED_PARTS)).toEqual({ status: 200 });
    expect(b.calls["complete"]).toBe(1);
    expect(b.calls["list"]).toBe(1);
  });

  test("90 parts at 2 records per list call: completed within 49 R2 calls (50 with the rate limit)", async () => {
    const b = pendingWith(90, 2);
    expect(await complete(b, 90)).toEqual({ status: 200 });
    expect(b.calls["list"]).toBe(45);
    expect(b.calls["complete"]).toBe(1);
    expect(b.total).toBeLessThanOrEqual(50 - 1);
  });

  test("91 parts at 2 records per list call: refused before completing, within the budget", async () => {
    const b = pendingWith(91, 2);
    const res = await complete(b, 91);
    expect(res.status).toBe(400);
    expect(res.error).toMatch(
      /^Too many parts to complete an upload of unknown size \(at most 100\)/,
    );
    expect(b.calls["complete"] ?? 0).toBe(0);
    expect(b.calls["delete"] ?? 0).toBe(0);
    expect(b.total).toBeLessThanOrEqual(50 - 1);
  });
});
