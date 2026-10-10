import { MAX_LIST_PAGES } from "../../../packages/cli/src/limits.js";
import {
  CLEANUP_BUDGET,
  CLEANUP_JUMPS,
  CLEANUP_LIST_LIMIT,
  CLEANUP_SUMMARIES,
  runCleanup,
} from "../../../packages/worker/src/cleanup.js";
import {
  DELETE_LIMIT,
  JUMP_LIMIT,
  MAX_UNSIZED_PARTS,
  PAGE_LIMIT,
  PAGE_READS,
  summarize,
  Uploads,
  type UploadMeta,
} from "../../../packages/worker/src/uploads.js";
import { readFile } from "node:fs/promises";
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
// for the next: 74 and 49 at the limits of round 1K (149 and 99 in round
// 1I). From the constants, so
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
    // 68 pages at the limits of round 1K (34 in round 1I).
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
    // Every tenth upload is expired: deleted in the first run if among its
    // CLEANUP_SUMMARIES (none at 3 a run, 1 at 10).
    expect(first).toMatchObject({
      summarized: CLEANUP_SUMMARIES,
      deleted: Math.floor(CLEANUP_SUMMARIES / 10),
    });
    expect(runs).toBe(Math.ceil(N / CLEANUP_SUMMARIES));

    // Without expired ones: the same, ceil(5,000 / CLEANUP_SUMMARIES) runs.
    const plain = await runsToFinish(bucketOf(true, Infinity));
    console.log(`old sidecars, none expired: runs to finish ${plain.runs}`);
    expect(plain.runs).toBe(Math.ceil(N / CLEANUP_SUMMARIES));
  });
});

test.describe("the docs state the numbers derived from the constants", () => {
  // Round 1K: the constants were lowered after the phase 1J measurement;
  // this checks that docs/design/api.md and the README quote what the tests
  // above compute from them, so the next change cannot leave them stale.
  const n = (x: number) => x.toLocaleString("en");
  const read = async (path: string) =>
    (await readFile(new URL(path, import.meta.url), "utf-8")).replace(/\s+/g, " ");
  const row = (...cells: string[]) => new RegExp(`\\| ${cells.join(" +\\| ")} +\\|`);

  test("api.md: pages, runs and limits", async () => {
    const doc = await read("../../../docs/design/api.md");
    const pagesWithSummaries = Math.ceil((N - (PER_PAGE + 1)) / PER_PAGE) + 1;
    expect(doc).toMatch(row("5,000 uploads with a summary", `${PER_PAGE}`, n(pagesWithSummaries)));
    expect(doc).toMatch(
      row("1,000 uploads, none with a summary", `${PAGE_READS}`, n(1000 / PAGE_READS)),
    );
    expect(doc).toMatch(
      row("5,000 uploads, none with a summary", `${PAGE_READS}`, n(N / PAGE_READS)),
    );
    expect(doc).toContain(
      `${PER_PAGE} because ${PAGE_LIMIT} objects are ${PAGE_LIMIT / 2} uploads`,
    );
    expect(doc).toContain(
      `More than ${n(MAX_LIST_PAGES * PAGE_READS)} sidecars without a summary** take more than ${n(MAX_LIST_PAGES)} pages at ${PAGE_READS} a page`,
    );
    expect(doc).toContain(
      `${n(MAX_LIST_PAGES)} pages hold about ${n(MAX_LIST_PAGES * PER_PAGE)} uploads`,
    );
    expect(doc).toContain(
      `The cron gives ${CLEANUP_SUMMARIES} an hour (${24 * CLEANUP_SUMMARIES} a day)`,
    );
    expect(doc).toMatch(row("5,000 uploads with a summary", "[^|]+", n(Math.ceil(N / PER_RUN))));
    expect(doc).toMatch(row("1,000 uploads with a summary", "[^|]+", n(Math.ceil(1000 / PER_RUN))));
    expect(doc).toMatch(
      row(
        "1,000 uploads, none with a summary",
        `${CLEANUP_SUMMARIES} summaries[^|]*`,
        n(Math.ceil(1000 / CLEANUP_SUMMARIES)),
      ),
    );
    expect(doc).toMatch(
      row(
        "5,000 uploads, none with a summary",
        `${CLEANUP_SUMMARIES} summaries[^|]*`,
        n(Math.ceil(N / CLEANUP_SUMMARIES)),
      ),
    );
    expect(doc).toContain(`gone through in ceil(N / ${PER_RUN}) hours`);
    expect(doc).toContain(`one without summaries in ceil(N / ${CLEANUP_SUMMARIES}) hours`);
    expect(doc).toContain(
      `at most **${1 + CLEANUP_JUMPS} list calls, of at most ${CLEANUP_LIST_LIMIT} and ${JUMP_LIMIT} objects**`,
    );
    expect(doc).toContain(
      `so at most ${CLEANUP_LIST_LIMIT + CLEANUP_JUMPS * JUMP_LIMIT} objects examined`,
    );
    expect(doc).toContain(`\`limit: ${DELETE_LIMIT}\` (\`DELETE_LIMIT\`,`);
    expect(doc).toContain(`at most ${CLEANUP_SUMMARIES} summaries written`);
    expect(doc).toContain(`**At most ${PAGE_READS} reads**`);
    expect(doc).toContain(`**at most ${1 + PAGE_READS} R2 calls** per page`);
    expect(doc).toContain(`**Limit: at most ${MAX_UNSIZED_PARTS} part records**`);
    expect(doc).toContain(
      `(at most ${MAX_UNSIZED_PARTS}); start the upload again and send its size`,
    );
  });

  test("README: page size, cleanup pace and limits", async () => {
    const readme = await read("../../../README.md");
    expect(readme).toContain(`pages of about ${PAGE_LIMIT / 2}`);
    expect(readme).toContain(`about ${CLEANUP_LIST_LIMIT / 2} uploads per run`);
    expect(readme).toContain(`pages of them hold ${PAGE_READS}`);
    expect(readme).toContain(`${CLEANUP_SUMMARIES} per run`);
    expect(readme).toContain(`more than ${n(MAX_LIST_PAGES * PAGE_READS)} of them`);
    expect(readme).toContain(`at most ${MAX_UNSIZED_PARTS} parts`);
    // "about four days" for 5,000 uploads: ceil(N / PER_RUN) hours.
    expect(readme).toContain("5,000 uploads is gone through in about four days");
    expect(Math.round(Math.ceil(N / PER_RUN) / 24)).toBe(4);
  });
});
