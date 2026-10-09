import {
  CLEANUP_BUDGET,
  CLEANUP_LIST_LIMIT,
  CLEANUP_SUMMARIES,
  runCleanup,
} from "../../../packages/worker/src/cleanup.js";
import {
  PAGE_LIMIT,
  PAGE_READS,
  summarize,
  Uploads,
  type UploadMeta,
} from "../../../packages/worker/src/uploads.js";
import { expect, test } from "../../lib/index.js";
import { REAL_R2_CAPS, StrictBucket } from "../../lib/strict-r2.js";

// The capacity figures in docs/design/api.md ("Listing a page", "Cleanup
// (cron)") and the README, counted on the in-memory bucket returning as many
// objects per list call as real R2 did in the phase 1H measurement
// (REAL_R2_CAPS): how many pages GET /api/uploads takes for a bucket of
// 5,000 uploads, and how many hourly cron runs it takes to get through it,
// with summaries and with sidecars of yeet < 0.2 that have none. Every
// tenth upload is expired. Keep the docs in step when these change. The
// bounds of each page and run are asserted in r2-work-bounds.spec.ts.

const P = "uploads";
const NOW = Date.UTC(2026, 9, 8, 3);
const DAY = 86_400_000;
const N = 5000;
// Uploads (2 objects each) a page and a run list, minus the last one, left
// for the next: 149 and 99 at the limits of round 1I. From the constants, so
// that lowering them (see "To measure next" in api.md) needs no test change.
const PER_PAGE = Math.floor(PAGE_LIMIT / 2) - 1;
const PER_RUN = Math.floor(CLEANUP_LIST_LIMIT / 2) - 1;

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
  const b = new StrictBucket({ ...REAL_R2_CAPS });
  for (let i = 0; i < N; i++) {
    seed(b, `u${String(i).padStart(5, "0")}`, legacy, i % expiredEvery === expiredEvery - 1);
  }
  return b;
}

/** Every page of GET /api/uploads: how many, and the uploads on the first. */
async function pages(b: StrictBucket) {
  const uploads = new Uploads(b, P);
  let count = 0;
  let first = 0;
  let after: string | undefined;
  for (;;) {
    b.reset();
    const page = await uploads.listPage(after);
    if (count++ === 0) first = page.uploads.length;
    if (page.next === null) return { count, first };
    after = page.next;
  }
}

/** Cron runs until nothing expired and no sidecar without a summary is left. */
async function runsToFinish(b: StrictBucket) {
  const first = { summarized: 0, deleted: 0, subrequests: 0 };
  for (let runs = 1; runs <= 2000; runs++) {
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
  throw new Error("not finished after 2,000 runs");
}

test.describe("capacity, 5,000 uploads", () => {
  test(`with summaries: pages of ${PER_PAGE} uploads; the cron is done in ceil(N / ${PER_RUN}) runs`, async () => {
    const b = bucketOf(false);
    // Pages of PER_PAGE until the rest fits one page (PER_PAGE + 1 uploads):
    // 34 pages at the limits of round 1I.
    expect(await pages(b)).toEqual({
      count: Math.ceil((N - (PER_PAGE + 1)) / PER_PAGE) + 1,
      first: PER_PAGE,
    });
    const { runs, first } = await runsToFinish(b);
    console.log(`with summaries: first run ${JSON.stringify(first)}; runs to finish ${runs}`);
    // CLEANUP_LIST_LIMIT objects a run: PER_RUN uploads, the last one left
    // for the next run; every tenth of them expired (9 of 99).
    expect(first).toMatchObject({ deleted: Math.floor(PER_RUN / 10), summarized: 0 });
    expect(runs).toBe(Math.ceil(N / PER_RUN));
  });

  test(`old sidecars: ${PAGE_READS} uploads a page; the cron adds ${CLEANUP_SUMMARIES} summaries a run`, async () => {
    test.setTimeout(300_000);
    const b = bucketOf(true);
    // One list call, then one read per sidecar.
    expect(await pages(b)).toEqual({ count: N / PAGE_READS, first: PAGE_READS });
    const { runs, first } = await runsToFinish(b);
    console.log(
      `old sidecars, 10% expired: first run ${JSON.stringify(first)}; runs to finish ${runs}`,
    );
    expect(first).toMatchObject({ summarized: CLEANUP_SUMMARIES, deleted: 1 });
    expect(runs).toBe(N / CLEANUP_SUMMARIES);

    // Without expired ones: the same, 5,000 / 10 runs.
    const plain = await runsToFinish(bucketOf(true, Infinity));
    console.log(`old sidecars, none expired: runs to finish ${plain.runs}`);
    expect(plain.runs).toBe(Math.ceil(N / CLEANUP_SUMMARIES));
  });
});
