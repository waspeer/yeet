import { CLEANUP_LIST_LIMIT, runCleanup } from "../../../packages/worker/src/cleanup.js";
import { summarize, type UploadMeta } from "../../../packages/worker/src/uploads.js";
import { FakeBucket } from "../../lib/fake-r2.js";
import { expect, test } from "../../lib/index.js";

// A stale upload with thousands of keys whose deletion the cron cannot finish
// in one run, with 0-30 old sidecars before it so that its budget runs out at
// every possible point: whatever is left must still be an upload (with its
// sidecar) that a later run finds and deletes. From the verifier of round 1F.

// Run counts below were set for round 1I's CLEANUP_LIST_LIMIT of 200; a run
// does work in proportion to the limit, so they scale with it (round 1J:
// lowering the limit after a measurement must need no test change).
const runsAt200 = (runs: number) => Math.ceil((runs * 200) / CLEANUP_LIST_LIMIT);
const P = "uploads";
const NOW = Date.UTC(2026, 9, 8, 3);
const DAY = 86_400_000;
test("an interrupted deletion of a stale upload leaves no keys without a sidecar", async () => {
  const found: string[] = [];
  for (const kind of ["parts", "records"] as const) {
    for (let k = 0; k <= 30; k++) {
      const b = new FakeBucket();
      for (let i = 0; i < k; i++) {
        const m: UploadMeta = {
          filename: "f",
          file_size: 1,
          uploaded_at: new Date(NOW - DAY).toISOString(),
          expires_at: new Date(NOW + DAY).toISOString(),
        };
        b.seed(`${P}/b${String(i).padStart(4, "0")}/f`, "x");
        b.seed(`${P}/b${String(i).padStart(4, "0")}/.meta.json`, JSON.stringify(m)); // no summary
      }
      const meta: UploadMeta =
        kind === "parts"
          ? {
              filename: "big.bin",
              uploaded_at: new Date(NOW - 2 * DAY).toISOString(),
              expires_at: new Date(NOW + DAY).toISOString(),
              pending_upload_id: "mp",
            }
          : {
              filename: "big.bin",
              file_size: 1,
              uploaded_at: new Date(NOW - 2 * DAY).toISOString(),
              expires_at: new Date(NOW - 1000).toISOString(),
            };
      b.seed(`${P}/c0000/.meta.json`, JSON.stringify(meta), {
        summary: JSON.stringify(summarize(meta)),
      });
      if (kind === "parts")
        for (let n = 1; n <= 1500; n++) b.seed(`${P}/c0000/.parts/${n}`, "", { size: "5" });
      else {
        for (let n = 0; n < 1999; n++)
          b.seed(`${P}/c0000/.downloads/2026-06-01T00:00:00.${String(n).padStart(4, "0")}Z_0`);
        b.seed(`${P}/c0000/big.bin`, "x");
      }
      // Round 1I: a run deletes at most 200 keys of such an upload; 20 runs.
      for (let r = 0; r < runsAt200(20); r++) {
        b.resetCalls();
        await runCleanup(b, P, NOW);
      }
      const left = b.keys(`${P}/c0000/`);
      if (left.length)
        found.push(
          `${kind} k=${k}: ${left.length} keys left, sidecar ${left.includes(`${P}/c0000/.meta.json`)}, e.g. ${left[0]}`,
        );
    }
  }
  console.log(found.join("\n"));
  expect(found).toEqual([]);
});
