import {
  CLEANUP_BUDGET,
  CLEANUP_JUMPS,
  CLEANUP_LIST_LIMIT,
  CLEANUP_SUMMARIES,
  runCleanup,
} from "../../../packages/worker/src/cleanup.js";
import { encodeListCursor, parseListCursor } from "../../../packages/worker/src/parse.js";
import {
  JUMP_LIMIT,
  PAGE_JUMPS,
  PAGE_LIMIT,
  PAGE_READS,
  summarize,
  Uploads,
  type UploadMeta,
} from "../../../packages/worker/src/uploads.js";
import { expect, test } from "../../lib/index.js";
import { REAL_R2_CAPS, StrictBucket, seededRandom } from "../../lib/strict-r2.js";

// A deterministic stand-in for the CPU limit, which cannot be measured
// locally. Phase 1H measured on a real Workers Free deploy that CPU grows
// with the objects a request processes (GET /api/uploads: 43–103 ms with
// about 2,200 uploads, 225–320 ms with about 8,200; the cron 141–179 ms per
// run), and that R2 calls are not the limit (1,000 per invocation). So these
// tests bound the work of one GET /api/uploads and one cron run: the objects
// their list calls return, the list calls, the reads and all R2 calls, on
// the strict bucket returning as many objects per list call as real R2 did
// (REAL_R2_CAPS: 415 with metadata, 848 without), so the `limit` the Worker
// asks for is what bounds a page. They also give how many pages and hourly
// cron runs a bucket of N uploads takes (docs/design/api.md quotes them).

const P = "uploads";
const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 8, 3);
const idOf = (i: number) => `u${String(i).padStart(5, "0")}`;

interface Shape {
  legacy?: boolean; // sidecar without a summary (yeet < 0.2)
  expired?: boolean;
  pendingSince?: number;
  unreadable?: boolean;
  records?: number; // legacy `.downloads/` records (1D/1E)
  parts?: number; // `.parts/` records of an upload of unknown size
}

function seed(b: StrictBucket, id: string, s: Shape = {}): void {
  const dir = `${P}/${id}/`;
  const meta: UploadMeta = {
    filename: "f.bin",
    file_size: 1,
    uploaded_at: new Date(
      (s.pendingSince ?? NOW - DAY) + (Number.parseInt(id.slice(1), 36) % 997),
    ).toISOString(),
    expires_at: new Date(s.expired ? NOW - 1 : NOW + 30 * DAY).toISOString(),
    ...(s.pendingSince !== undefined ? { pending_upload_id: `mp-${id}` } : {}),
  };
  if (s.pendingSince === undefined) b.seed(`${dir}f.bin`, "x");
  b.seed(
    `${dir}.meta.json`,
    s.unreadable ? "{not json" : JSON.stringify(meta),
    s.legacy || s.unreadable ? {} : { summary: JSON.stringify(summarize(meta)) },
  );
  for (let i = 0; i < (s.records ?? 0); i++)
    b.seed(`${dir}.downloads/2026-06-01T00:00:00.${String(i).padStart(6, "0")}Z_x`);
  for (let n = 1; n <= (s.parts ?? 0); n++) b.seed(`${dir}.parts/${n}`, "", { size: "5" });
}

/** Seed n uploads of the given shape (or a shape per index). */
function bucketOf(
  n: number,
  shape: (i: number) => Shape,
  opts: ConstructorParameters<typeof StrictBucket>[0] = {},
) {
  const b = new StrictBucket({ ...REAL_R2_CAPS, maxCalls: Infinity, ...opts });
  const finished: string[] = [];
  for (let i = 0; i < n; i++) {
    const s = shape(i);
    seed(b, idOf(i), s);
    if (s.pendingSince === undefined && !s.unreadable) finished.push(idOf(i));
  }
  return { b, finished };
}

interface PageWork {
  lists: number;
  listed: number;
  maxListed: number;
  gets: number;
  total: number;
}

/**
 * Every page of GET /api/uploads as the route makes them (listPage(), the
 * cursor through its encoding and strict parsing), with each page's work.
 */
async function allPages(b: StrictBucket) {
  const uploads = new Uploads(b, P);
  const seen: string[] = [];
  const work: PageWork[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 10_000; page++) {
    const after = cursor === null ? undefined : parseListCursor(cursor, uploads.listPrefix);
    expect(after, "a cursor the server made parses back").not.toBeNull();
    b.reset();
    b.maxCalls = 1 + PAGE_READS; // throws past the page's R2 calls
    const result = await uploads.listPage(after ?? undefined);
    work.push({
      lists: b.calls.list ?? 0,
      listed: b.listed,
      maxListed: b.maxListed,
      gets: b.calls.get ?? 0,
      total: b.total,
    });
    expect(Object.keys(b.calls).every((name) => name === "list" || name === "get")).toBe(true);
    // Newest first within the page.
    const times = result.uploads.map((u) => u.uploaded_at);
    expect(times).toEqual([...times].sort().reverse());
    seen.push(...result.uploads.map((u) => u.id));
    if (result.next === null) return { seen, work };
    cursor = encodeListCursor(result.next);
  }
  throw new Error("more than 10,000 pages");
}

function expectPageBounds(work: PageWork[]) {
  for (const [i, w] of work.entries()) {
    expect(w.lists, `page ${i}: list calls`).toBeLessThanOrEqual(1 + PAGE_JUMPS);
    expect(w.maxListed, `page ${i}: objects per list call`).toBeLessThanOrEqual(PAGE_LIMIT);
    // Round 1L: a jump lists at most JUMP_LIMIT objects (200 a page, not 300).
    expect(w.listed, `page ${i}: objects examined`).toBeLessThanOrEqual(
      PAGE_LIMIT + PAGE_JUMPS * JUMP_LIMIT,
    );
    expect(w.gets, `page ${i}: sidecar reads`).toBeLessThanOrEqual(PAGE_READS);
    expect(w.total, `page ${i}: R2 calls`).toBeLessThanOrEqual(1 + PAGE_READS);
  }
}

const max = <T>(work: T[], key: keyof T) => Math.max(...work.map((w) => Number(w[key])));

test.describe("work of one GET /api/uploads page (real R2 page sizes)", () => {
  test(`5,000 uploads with summaries: 1 list call of at most ${PAGE_LIMIT} objects per page, every upload once`, async () => {
    const { b, finished } = bucketOf(5000, () => ({}));
    const { seen, work } = await allPages(b);
    expectPageBounds(work);
    expect(max(work, "lists")).toBe(1);
    expect(max(work, "listed")).toBe(PAGE_LIMIT);
    expect(max(work, "gets")).toBe(0);
    expect([...seen].sort()).toEqual(finished);
    // PAGE_LIMIT objects are PAGE_LIMIT / 2 uploads, the last one left for
    // the next page: 74 a page at 150 (round 1K), 149 at 300.
    console.log(`5,000 uploads: ${work.length} pages`);
    expect(work.length).toBe(Math.ceil(5000 / (PAGE_LIMIT / 2 - 1)));
  });

  test(`sidecars without a summary: at most ${PAGE_READS} reads per page`, async () => {
    const { b, finished } = bucketOf(1000, (i) => ({ legacy: i % 2 === 0 }));
    const { seen, work } = await allPages(b);
    expectPageBounds(work);
    expect(max(work, "gets")).toBe(PAGE_READS);
    expect([...seen].sort()).toEqual(finished);
    console.log(`1,000 uploads, half without a summary: ${work.length} pages`);

    const all = bucketOf(1000, () => ({ legacy: true }));
    const pages = await allPages(all.b);
    expectPageBounds(pages.work);
    expect([...pages.seen].sort()).toEqual(all.finished);
    console.log(`1,000 uploads, none with a summary: ${pages.work.length} pages`);
    expect(pages.work.length).toBe(1000 / PAGE_READS);
  });

  test("legacy records and part records: one jump per page at most, no upload missed", async () => {
    const { b, finished } = bucketOf(400, (i) =>
      i % 7 === 0
        ? { records: 1500 }
        : i % 11 === 0
          ? { pendingSince: NOW - 1000, parts: 1500 }
          : {},
    );
    const { seen, work } = await allPages(b);
    expectPageBounds(work);
    expect(max(work, "lists")).toBe(1 + PAGE_JUMPS);
    // The bound is reached: a full first call and a full jump.
    expect(max(work, "listed")).toBe(PAGE_LIMIT + PAGE_JUMPS * JUMP_LIMIT);
    expect([...seen].sort()).toEqual(finished);
    console.log(
      `400 uploads with records and parts: ${work.length} pages, max ${max(work, "listed")} objects`,
    );
  });

  for (const seedNo of [1, 2, 3]) {
    test(`random mix and random short pages (seed ${seedNo}): bounded, every finished upload once`, async () => {
      const rnd = seededRandom(seedNo);
      const { b, finished } = bucketOf(
        1500,
        () => ({
          legacy: rnd() < 0.3,
          unreadable: rnd() < 0.03,
          records: rnd() < 0.03 ? Math.floor(rnd() * 2000) : 0,
          ...(rnd() < 0.03 ? { pendingSince: NOW - 1000, parts: Math.floor(rnd() * 2000) } : {}),
        }),
        { randomPages: true, seed: seedNo },
      );
      for (let j = 0; j < 700; j++) b.seed(`${P}/u00700~junk${j}`); // keys that are no upload
      const { seen, work } = await allPages(b);
      expectPageBounds(work);
      // Unreadable sidecars are left out, and nothing else.
      const readable = finished.filter(
        (id) => !b.objects.get(`${P}/${id}/.meta.json`)!.body.startsWith("{not"),
      );
      expect([...seen].sort()).toEqual(readable);
      console.log(
        `seed ${seedNo}: ${work.length} pages, max ${max(work, "listed")} objects, ${max(work, "total")} calls`,
      );
    });
  }
});

interface RunWork {
  lists: number;
  listed: number;
  maxListed: number;
  summaries: number;
  total: number;
}

/** Run the cron until `done` (checked after each run), recording each run's work. */
async function cronRuns(b: StrictBucket, done: () => boolean, maxRuns: number) {
  const work: RunWork[] = [];
  for (let run = 1; run <= maxRuns; run++) {
    b.reset();
    b.maxCalls = CLEANUP_BUDGET; // throws past the run's budget
    const report = await runCleanup(b, P, NOW);
    expect(report.subrequests).toBe(b.total);
    work.push({
      lists: b.calls.list ?? 0,
      listed: b.listed,
      maxListed: b.maxListed,
      summaries: b.log.filter((line) => line.startsWith("put ") && line.endsWith("/.meta.json"))
        .length,
      total: b.total,
    });
    if (done()) return { runs: run, work };
  }
  return { runs: Infinity, work };
}

function expectRunBounds(work: RunWork[]) {
  for (const [i, w] of work.entries()) {
    // The slice and a jump (round 1L: no deleteUnder() round any more).
    expect(w.lists, `run ${i + 1}: list calls`).toBeLessThanOrEqual(1 + CLEANUP_JUMPS);
    expect(w.maxListed, `run ${i + 1}: objects per list call`).toBeLessThanOrEqual(
      CLEANUP_LIST_LIMIT,
    );
    expect(w.listed, `run ${i + 1}: objects examined`).toBeLessThanOrEqual(
      CLEANUP_LIST_LIMIT + CLEANUP_JUMPS * JUMP_LIMIT,
    );
    expect(w.summaries, `run ${i + 1}: summaries written`).toBeLessThanOrEqual(CLEANUP_SUMMARIES);
    expect(w.total, `run ${i + 1}: R2 calls`).toBeLessThanOrEqual(CLEANUP_BUDGET);
  }
}

const expiredLeft = (b: StrictBucket) =>
  b
    .sorted(`${P}/`)
    .filter((k) => k.endsWith("/.meta.json"))
    .some((k) => JSON.parse(b.objects.get(k)!.body).expires_at < new Date(NOW).toISOString());
/** A sidecar without a summary is left, other than an unreadable one (which never gets one). */
const unsummarizedLeft = (b: StrictBucket) =>
  b
    .sorted(`${P}/`)
    .some(
      (k) =>
        k.endsWith("/.meta.json") &&
        !b.objects.get(k)!.meta.summary &&
        !b.objects.get(k)!.body.startsWith("{not"),
    );

test.describe("work of one cron run (real R2 page sizes)", () => {
  for (const n of [1000, 5000]) {
    test(`${n.toLocaleString("en")} uploads, every tenth expired: bounded runs, a full pass in about n / ${CLEANUP_LIST_LIMIT / 2 - 1}`, async () => {
      test.setTimeout(120_000);
      const { b } = bucketOf(n, (i) => ({ expired: i % 10 === 9 }));
      let cursor: string | null | undefined;
      const { runs, work } = await cronRuns(
        b,
        () => {
          cursor = b.objects.has(`${P}/.cleanup-cursor`)
            ? JSON.parse(b.objects.get(`${P}/.cleanup-cursor`)!.body).after
            : undefined;
          return cursor === null;
        },
        1000,
      );
      expectRunBounds(work);
      expect(max(work, "lists")).toBe(1);
      expect(expiredLeft(b)).toBe(false);
      // CLEANUP_LIST_LIMIT objects are half as many uploads, the last left
      // for the next run.
      console.log(`${n} uploads: one pass (every expired one deleted) in ${runs} runs`);
      expect(runs).toBe(Math.ceil(n / (CLEANUP_LIST_LIMIT / 2 - 1)));
    });
  }

  test(`sidecars without a summary: ${CLEANUP_SUMMARIES} a run`, async () => {
    test.setTimeout(120_000);
    const { b } = bucketOf(1000, (i) => ({ legacy: true, expired: i % 10 === 9 }));
    const { runs, work } = await cronRuns(b, () => !expiredLeft(b) && !unsummarizedLeft(b), 1000);
    expectRunBounds(work);
    expect(work[0]!.summaries).toBe(CLEANUP_SUMMARIES);
    console.log(`1,000 uploads without a summary, every tenth expired: done in ${runs} runs`);
    expect(runs).toBeLessThanOrEqual(Math.ceil(1000 / CLEANUP_SUMMARIES) + 1);
  });

  test("legacy records, many part records, junk, random short pages: bounded, converges", async () => {
    test.setTimeout(240_000);
    const rnd = seededRandom(7);
    const shapes = new Map<string, Shape>();
    const { b } = bucketOf(
      800,
      (i) => {
        const s: Shape = {
          legacy: rnd() < 0.3,
          expired: rnd() < 0.2,
          unreadable: rnd() < 0.02,
          records: rnd() < 0.04 ? Math.floor(rnd() * 2500) : 0,
          ...(rnd() < 0.04
            ? {
                pendingSince: rnd() < 0.5 ? NOW - 2 * DAY : NOW - 1000,
                parts: Math.floor(rnd() * 2500),
              }
            : {}),
        };
        shapes.set(idOf(i), s);
        return s;
      },
      { randomPages: true, seed: 7 },
    );
    const staleLeft = () =>
      [...shapes].some(([id, s]) => {
        const stale =
          !s.unreadable &&
          (s.expired || (s.pendingSince !== undefined && NOW - s.pendingSince > DAY));
        return (
          (stale && b.sorted(`${P}/${id}/`).length > 0) ||
          b.sorted(`${P}/${id}/.downloads/`).length > 0
        );
      });
    const { runs, work } = await cronRuns(b, () => !staleLeft() && !unsummarizedLeft(b), 3000);
    expectRunBounds(work);
    console.log(
      `800 adversarial uploads: converged in ${runs} runs; max ${Math.max(...work.map((w) => w.listed))} objects, ${Math.max(...work.map((w) => w.total))} calls a run`,
    );
    expect(runs).toBeLessThan(3000);
  });
});
