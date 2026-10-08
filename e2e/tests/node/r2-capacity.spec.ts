import { CLEANUP_BUDGET, runCleanup } from "../../../packages/worker/src/cleanup.js";
import { LIST_BUDGET, summarize, Uploads, type UploadMeta } from "../../../packages/worker/src/uploads.js";
import { expect, test } from "../../lib/index.js";
import { StrictBucket } from "../../lib/strict-r2.js";

// The capacity figures in docs/design/api.md ("Listing within a fixed number
// of R2 calls", "Cleanup (cron)") and the README, measured on the in-memory
// bucket (100 objects per list call with metadata, as miniflare returns): what
// one GET /api/uploads lists, and how many cron runs a bucket of 5,000 uploads
// takes, with summaries and with sidecars of yeet < 0.2 that have none. Every
// tenth upload is expired. Keep the docs in step when these change.

const P = "uploads";
const NOW = Date.UTC(2026, 9, 8, 3);
const DAY = 86_400_000;
const N = 5000;

function seed(b: StrictBucket, id: string, legacy: boolean, expired: boolean) {
  const meta: UploadMeta = {
    filename: "f.bin",
    file_size: 1,
    uploaded_at: new Date(NOW - DAY).toISOString(),
    expires_at: new Date(expired ? NOW - 1 : NOW + DAY * 30).toISOString(),
  };
  b.seed(`${P}/${id}/f.bin`, "x");
  b.seed(
    `${P}/${id}/.meta.json`,
    JSON.stringify(meta),
    legacy ? {} : { summary: JSON.stringify(summarize(meta)) },
  );
}

function bucketOf(legacy: boolean, expiredEvery = 10): StrictBucket {
  const b = new StrictBucket();
  for (let i = 0; i < N; i++) {
    seed(b, `u${String(i).padStart(5, "0")}`, legacy, i % expiredEvery === expiredEvery - 1);
  }
  return b;
}

/** Cron runs until nothing expired and no sidecar without a summary is left. */
async function runsToFinish(b: StrictBucket) {
  const first = { summarized: 0, deleted: 0, subrequests: 0 };
  for (let runs = 1; runs <= 1000; runs++) {
    b.reset();
    const report = await runCleanup(b, P, NOW);
    expect(report.subrequests).toBeLessThanOrEqual(CLEANUP_BUDGET);
    if (runs === 1) Object.assign(first, report);
    const sidecars = b.sorted(`${P}/`).filter((k) => k.endsWith("/.meta.json"));
    const expiredLeft = sidecars.filter(
      (k) => JSON.parse(b.objects.get(k)!.body).expires_at < new Date(NOW).toISOString(),
    ).length;
    const unsummarized = sidecars.filter((k) => !b.objects.get(k)!.meta.summary).length;
    if (expiredLeft === 0 && unsummarized === 0) return { runs, first };
  }
  throw new Error("not finished after 1,000 runs");
}

test.describe("capacity, 5,000 uploads", () => {
  test("with summaries: one listing shows 1,999; the cron is done in 5 runs", async () => {
    const b = bucketOf(false);
    const listing = await new Uploads(b, P).listAll();
    expect([listing.uploads.length, listing.subrequests, listing.truncated]).toEqual([
      1999,
      LIST_BUDGET,
      true,
    ]);
    const { runs, first } = await runsToFinish(b);
    console.log(`with summaries: first run ${JSON.stringify(first)}; runs to finish ${runs}`);
    expect(runs).toBeLessThanOrEqual(5);
  });

  test("old sidecars: one listing shows 39; the cron adds 21 summaries a run", async () => {
    test.setTimeout(300_000);
    const b = bucketOf(true);
    const listing = await new Uploads(b, P).listAll();
    // One list call, then one read per sidecar.
    expect([listing.uploads.length, listing.subrequests, listing.truncated]).toEqual([
      LIST_BUDGET - 1,
      LIST_BUDGET,
      true,
    ]);
    const { runs, first } = await runsToFinish(b);
    console.log(`old sidecars, 10% expired: first run ${JSON.stringify(first)}; runs to finish ${runs}`);
    expect(first).toMatchObject({ summarized: 21, subrequests: CLEANUP_BUDGET });
    expect(runs).toBeLessThanOrEqual(350);

    // Without expired ones: 5,000 / 21 runs.
    const plain = await runsToFinish(bucketOf(true, Infinity));
    console.log(`old sidecars, none expired: runs to finish ${plain.runs}`);
    expect(plain.runs).toBe(Math.ceil(N / 21));
  });
});
