import { CLEANUP_BUDGET, CLEANUP_LIST_BUDGET, runCleanup } from "../../../packages/worker/src/cleanup.js";
import {
  LIST_BUDGET,
  RECORD_ATTEMPTS,
  summarize,
  Uploads,
  type UploadMeta,
} from "../../../packages/worker/src/uploads.js";
import { FakeBucket } from "../../lib/fake-r2.js";
import { expect, test } from "../../lib/index.js";

// The R2 calls of the listing (GET /api/uploads), the cron and the download
// counter, counted on the Worker's own modules with an in-memory bucket that
// follows R2's paging rules (at most 100 objects per list call with
// metadata) and, like the Free plan, throws past 50 calls. `wrangler dev`
// enforces neither, so this cannot be seen end to end.
//
// GET /api/uploads makes one rate-limit call (Bearer) plus listAll(): at most
// 1 + LIST_BUDGET = 41 subrequests.

const PREFIX = "uploads";
const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 8, 3);

/** Upload IDs that sort in index order. */
const idOf = (i: number) => `u${String(i).padStart(5, "0")}`;

interface SeedOptions {
  expired?: boolean;
  /** Sidecar without the summary custom metadata (yeet < 0.2, rclone). */
  legacySidecar?: boolean;
  /** Legacy `.downloads/` records (yeet 1D/1E). */
  records?: number;
  /** `.parts/` records of a pending upload of unknown size. */
  parts?: number;
  pendingSince?: number;
  meta?: Partial<UploadMeta>;
}

function seedUpload(bucket: FakeBucket, id: string, opts: SeedOptions = {}): UploadMeta {
  const dir = `${PREFIX}/${id}/`;
  const meta: UploadMeta = {
    filename: "file.bin",
    file_size: 10,
    uploaded_at: new Date(opts.pendingSince ?? NOW - DAY).toISOString(),
    expires_at: new Date(opts.expired ? NOW - 1000 : NOW + 30 * DAY).toISOString(),
    ...(opts.pendingSince !== undefined ? { pending_upload_id: `mp-${id}` } : {}),
    ...opts.meta,
  };
  if (opts.pendingSince === undefined) bucket.seed(dir + meta.filename, "0123456789");
  bucket.seed(
    dir + ".meta.json",
    JSON.stringify(meta),
    opts.legacySidecar ? {} : { summary: JSON.stringify(summarize(meta)) },
  );
  for (let i = 0; i < (opts.records ?? 0); i++) {
    const at = new Date(Date.UTC(2026, 5, 1) + i).toISOString();
    bucket.seed(`${dir}.downloads/${at}_${i.toString(16).padStart(8, "0")}`);
  }
  for (let n = 1; n <= (opts.parts ?? 0); n++) bucket.seed(`${dir}.parts/${n}`, "", { size: "5" });
  return meta;
}

function listing(bucket: FakeBucket, after?: string) {
  bucket.resetCalls();
  return new Uploads(bucket, PREFIX).listAll(after === undefined ? {} : { after });
}

test.describe("R2 calls of a listing", () => {
  test("12 uploads with 1,000 legacy download records each: listed in a few calls", async () => {
    const bucket = new FakeBucket();
    for (let i = 0; i < 12; i++)
      seedUpload(bucket, idOf(i), { records: 1000, meta: { download_count: i } });
    const result = await listing(bucket);
    expect(bucket.total).toBe(result.subrequests);
    expect(result.subrequests).toBeLessThanOrEqual(2 * 12 + 1);
    expect(result.truncated).toBe(false);
    expect(result.uploads.map((u) => u.id)).toEqual(Array.from({ length: 12 }, (_, i) => idOf(i)));
    for (const [i, upload] of result.uploads.entries()) {
      // The count comes from the sidecar; legacy records are not counted.
      expect(upload.meta?.download_count).toBe(i);
      expect(upload.legacyRecords).toBe(true);
    }
  });

  test(`5,000 uploads: at most ${LIST_BUDGET} calls, truncated, and resumable without gaps`, async () => {
    const bucket = new FakeBucket();
    const total = 5000;
    for (let i = 0; i < total; i++) seedUpload(bucket, idOf(i));
    const first = await listing(bucket);
    expect(bucket.total).toBe(first.subrequests);
    expect(first.subrequests).toBeLessThanOrEqual(LIST_BUDGET);
    expect(first.truncated).toBe(true);
    // 40 pages of 100 objects, 2 per upload, the last one partly listed and left out.
    expect(first.uploads).toHaveLength(LIST_BUDGET * 50 - 1);

    // Following resumeAfter visits every upload exactly once, in order.
    const seen = first.uploads.map((u) => u.id);
    let after = first.resumeAfter;
    for (let round = 0; after !== undefined && round < 10; round++) {
      const next = await listing(bucket, after);
      expect(next.subrequests).toBeLessThanOrEqual(LIST_BUDGET);
      seen.push(...next.uploads.map((u) => u.id));
      after = next.truncated ? next.resumeAfter : undefined;
    }
    expect(after).toBeUndefined();
    expect(seen).toEqual(Array.from({ length: total }, (_, i) => idOf(i)));
  });

  test("old sidecars without a summary: their reads count towards the budget", async () => {
    const bucket = new FakeBucket();
    for (let i = 0; i < 300; i++) seedUpload(bucket, idOf(i), { legacySidecar: true });
    const result = await listing(bucket);
    expect(bucket.total).toBe(result.subrequests);
    expect(result.subrequests).toBeLessThanOrEqual(LIST_BUDGET);
    expect(result.truncated).toBe(true);
    expect(result.uploads.length).toBeGreaterThan(0);
    for (const upload of result.uploads) expect(upload.meta?.filename).toBe("file.bin");
    expect(result.uploads.length + (bucket.calls["list"] ?? 0)).toBe(result.subrequests);
  });

  test("fewer objects per page than asked: still within the budget", async () => {
    const bucket = new FakeBucket({ pageSize: 7 });
    for (let i = 0; i < 1000; i++) seedUpload(bucket, idOf(i));
    const result = await listing(bucket);
    expect(result.subrequests).toBeLessThanOrEqual(LIST_BUDGET);
    expect(result.truncated).toBe(true);
    expect(result.uploads.length).toBeGreaterThan(100);
  });

  test("jumps over the part records of a pending upload and junk at the top level", async () => {
    const bucket = new FakeBucket();
    seedUpload(bucket, idOf(0));
    seedUpload(bucket, idOf(1), { pendingSince: NOW - 1000, parts: 5000 });
    seedUpload(bucket, idOf(2));
    const result = await listing(bucket);
    expect(result.subrequests).toBeLessThanOrEqual(3);
    expect(result.uploads.map((u) => [u.id, u.complete])).toEqual([
      [idOf(0), true],
      [idOf(1), false],
      [idOf(2), true],
    ]);

    // Thousands of keys that are no upload: the listing stops, and resuming gets further.
    const junk = new FakeBucket();
    for (let i = 0; i < 5000; i++) junk.seed(`${PREFIX}/${idOf(i)}.txt`);
    seedUpload(junk, "zzzzzz");
    const stopped = await listing(junk);
    expect(stopped.subrequests).toBeLessThanOrEqual(LIST_BUDGET);
    expect(stopped.truncated).toBe(true);
    const resumed = await listing(junk, stopped.resumeAfter);
    expect(resumed.truncated).toBe(false);
    expect(resumed.uploads.map((u) => u.id)).toEqual(["zzzzzz"]);
  });

  test("junk pages, then sidecars without a summary: resuming skips no upload", async () => {
    // 39 pages of keys that are no upload use all but one call; the 40th page
    // holds 50 uploads that each need a read the budget has no room for. The
    // next listing must start before the first of them, not after the page.
    const bucket = new FakeBucket();
    for (let i = 0; i < (LIST_BUDGET - 1) * 100; i++) bucket.seed(`${PREFIX}/a${i}.junk`);
    const ids = Array.from({ length: 200 }, (_, i) => `m${String(i).padStart(4, "0")}`);
    for (const id of ids) seedUpload(bucket, id, { legacySidecar: true });
    const seen: string[] = [];
    let after: string | undefined;
    for (let round = 0; round < 20; round++) {
      const result = await listing(bucket, after);
      expect(result.subrequests).toBeLessThanOrEqual(LIST_BUDGET);
      for (const upload of result.uploads) {
        // A resumed listing never starts inside an upload.
        expect(upload.keys, upload.id).toEqual(bucket.keys(`${PREFIX}/${upload.id}/`));
      }
      seen.push(...result.uploads.map((u) => u.id));
      if (!result.truncated) break;
      expect(result.resumeAfter).not.toBe(after);
      after = result.resumeAfter;
    }
    expect(seen).toEqual(ids);
  });
});

test.describe("R2 calls of the cron", () => {
  test(`each run stays within ${CLEANUP_BUDGET} calls; runs together clean a large bucket`, async () => {
    test.setTimeout(120_000);
    const bucket = new FakeBucket();
    const keep = new Set<string>();
    const stale = new Set<string>();
    for (let i = 0; i < 3000; i++) {
      const id = idOf(i);
      if (i % 5 === 0) {
        seedUpload(bucket, id, { expired: true, legacySidecar: i % 50 === 0 });
        stale.add(id);
      } else if (i % 301 === 1) {
        seedUpload(bucket, id, { pendingSince: NOW - 2 * DAY, parts: 3 });
        stale.add(id); // abandoned
      } else if (i % 250 === 2) {
        seedUpload(bucket, id, { records: 1000 }); // current, with legacy records
        keep.add(id);
      } else if (i === 1003) {
        seedUpload(bucket, id, { expired: true, records: 2500 });
        stale.add(id);
      } else {
        // A pending upload of unknown size, and some sidecars without a summary.
        seedUpload(
          bucket,
          id,
          i === 7 ? { pendingSince: NOW - 1000, parts: 2000 } : { legacySidecar: i % 97 === 3 },
        );
        keep.add(id);
      }
    }
    // Legacy records without an upload.
    for (let i = 0; i < 3; i++) {
      for (let r = 0; r < 700; r++)
        bucket.seed(`${PREFIX}/s${i}stray/.downloads/2026-06-01T00:00:00.${r}Z_0`);
    }

    const left = () => {
      const keys = bucket.keys(`${PREFIX}/`);
      const ids = new Set(keys.map((key) => key.split("/")[1]!));
      return {
        stale: [...stale].filter((id) => ids.has(id)).length,
        stray: [...ids].filter((id) => id.endsWith("stray")).length,
        records: keys.filter((key) => key.includes("/.downloads/")).length,
        unsummarized: [...keep].filter(
          (id) => !bucket.objects.get(`${PREFIX}/${id}/.meta.json`)?.customMetadata["summary"],
        ).length,
      };
    };

    let runs = 0;
    for (; runs < 20; runs++) {
      const done = left();
      if (Object.values(done).every((n) => n === 0)) break;
      bucket.resetCalls();
      const report = await runCleanup(bucket, PREFIX, NOW);
      expect(bucket.total, `run ${runs + 1}`).toBe(report.subrequests);
      expect(report.subrequests, `run ${runs + 1}`).toBeLessThanOrEqual(CLEANUP_BUDGET);
    }
    expect(left()).toEqual({ stale: 0, stray: 0, records: 0, unsummarized: 0 });
    expect(runs).toBeLessThanOrEqual(12);
    // Nothing current was deleted, and every sidecar now has its summary.
    for (const id of keep) {
      const sidecar = bucket.objects.get(`${PREFIX}/${id}/.meta.json`);
      expect(sidecar, id).toBeDefined();
      expect(JSON.parse(sidecar!.customMetadata["summary"]!), id).toEqual(
        summarize(JSON.parse(sidecar!.body) as UploadMeta),
      );
    }

    // Runs on the clean bucket go through it in slices and then start over.
    const cursors: (string | null)[] = [];
    for (let i = 0; i < 6 && cursors.at(-1) !== null; i++) {
      bucket.resetCalls();
      const report = await runCleanup(bucket, PREFIX, NOW);
      expect(report.subrequests).toBeLessThanOrEqual(CLEANUP_BUDGET);
      cursors.push(report.cursor);
    }
    expect(cursors.at(-1)).toBeNull();
    expect(new Set(cursors).size).toBe(cursors.length); // always further, never stuck
  });

  test("junk pages, then sidecars without a summary: the cron gets to all of them", async () => {
    const bucket = new FakeBucket();
    // The listing's last page holds 50 junk keys and the first 25 uploads.
    for (let i = 0; i < (CLEANUP_LIST_BUDGET - 1) * 100 + 50; i++)
      bucket.seed(`${PREFIX}/a${i}.junk`);
    const ids = Array.from({ length: 200 }, (_, i) => `m${String(i).padStart(4, "0")}`);
    for (const id of ids) seedUpload(bucket, id, { legacySidecar: true });
    const unsummarized = () =>
      ids.filter((id) => !bucket.objects.get(`${PREFIX}/${id}/.meta.json`)!.customMetadata["summary"]);
    for (let run = 0; run < 60 && unsummarized().length > 0; run++) {
      bucket.resetCalls();
      const report = await runCleanup(bucket, PREFIX, NOW);
      expect(report.subrequests).toBeLessThanOrEqual(CLEANUP_BUDGET);
    }
    expect(unsummarized()).toEqual([]);
  });

  test("a small bucket: one run does everything and leaves no cursor", async () => {
    const bucket = new FakeBucket();
    seedUpload(bucket, idOf(0), { expired: true });
    seedUpload(bucket, idOf(1), { records: 30 });
    seedUpload(bucket, idOf(2));
    bucket.seed(`${PREFIX}/.cleanup-cursor`, "not JSON"); // unreadable: start at the beginning
    const report = await runCleanup(bucket, PREFIX, NOW);
    expect(report).toMatchObject({ deleted: 1, recordsCleared: 1, cursor: null });
    // Cursor read, one list page, one batch delete, list + delete of the records.
    expect(report.subrequests).toBe(5);
    expect(bucket.keys()).toEqual([
      `${PREFIX}/.cleanup-cursor`,
      `${PREFIX}/${idOf(1)}/.meta.json`,
      `${PREFIX}/${idOf(1)}/file.bin`,
      `${PREFIX}/${idOf(2)}/.meta.json`,
      `${PREFIX}/${idOf(2)}/file.bin`,
    ]);
  });
});

test.describe("R2 calls of a download count", () => {
  const meta = (bucket: FakeBucket, id: string) =>
    JSON.parse(bucket.objects.get(`${PREFIX}/${id}/.meta.json`)!.body) as UploadMeta;

  test("one after another: exact, two calls each, summary kept in step", async () => {
    const bucket = new FakeBucket();
    const legacy = Array.from({ length: 7 }, (_, i) => ({ at: `2026-01-01T00:00:0${i}.000Z` }));
    seedUpload(bucket, idOf(0), { meta: { downloads: legacy } });
    const uploads = new Uploads(bucket, PREFIX);
    const times: string[] = [];
    for (let i = 0; i < 12; i++) {
      bucket.resetCalls();
      const at = new Date(NOW + i * 1000).toISOString();
      times.push(at);
      expect(await uploads.recordDownload(idOf(0), at)).toBe(true);
      expect(bucket.calls).toEqual({ get: 1, put: 1 });
    }
    const stored = meta(bucket, idOf(0));
    expect(stored.download_count).toBe(7 + 12);
    expect(stored.recent_downloads).toEqual(times.slice(-5));
    expect(stored.downloads).toBeUndefined();
    const summary = bucket.objects.get(`${PREFIX}/${idOf(0)}/.meta.json`)!.customMetadata[
      "summary"
    ];
    expect(JSON.parse(summary!)).toEqual(summarize(stored));
  });

  test(`concurrent: never overcounted, at most ${2 * RECORD_ATTEMPTS} calls each`, async () => {
    const bucket = new FakeBucket({ maxCalls: Infinity, latencyMs: () => 1 + Math.random() * 4 });
    seedUpload(bucket, idOf(0));
    const uploads = new Uploads(bucket, PREFIX);
    const n = 20;
    const results = await Promise.all(
      Array.from({ length: n }, (_, i) =>
        uploads.recordDownload(idOf(0), new Date(NOW + i).toISOString()),
      ),
    );
    const counted = results.filter(Boolean).length;
    expect(meta(bucket, idOf(0)).download_count).toBe(counted);
    expect(counted).toBeGreaterThanOrEqual(1);
    expect(bucket.total).toBeLessThanOrEqual(n * 2 * RECORD_ATTEMPTS);
  });

  test("a sidecar deleted or still pending is never written", async () => {
    const bucket = new FakeBucket();
    seedUpload(bucket, idOf(0));
    const uploads = new Uploads(bucket, PREFIX);
    // Deleted between the read and the write.
    const get = bucket.get.bind(bucket);
    bucket.get = async (key: string) => {
      const object = await get(key);
      bucket.objects.clear();
      return object;
    };
    expect(await uploads.recordDownload(idOf(0), new Date(NOW).toISOString())).toBe(false);
    expect(bucket.keys()).toEqual([]);
    expect(bucket.calls["put"]).toBe(1);

    const pending = new FakeBucket();
    seedUpload(pending, idOf(1), { pendingSince: NOW });
    expect(await new Uploads(pending, PREFIX).recordDownload(idOf(1), "x")).toBe(false);
    expect(pending.calls).toEqual({ get: 1 });
  });
});
