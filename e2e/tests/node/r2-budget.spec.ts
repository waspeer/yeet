import {
  CLEANUP_BUDGET,
  CLEANUP_LIST_LIMIT,
  CLEANUP_SUMMARIES,
  runCleanup,
} from "../../../packages/worker/src/cleanup.js";
import {
  LIST_BUDGET,
  MAX_UNSIZED_PARTS,
  PART_RECORDS_BUDGET,
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
// metadata) and throws past 50 calls (the limit assumed before phase 1H
// measured 1,000 R2 calls and CPU as the binding limit). `wrangler dev`
// enforces neither, so this cannot be seen end to end.
//
// listAll() with its default budget: at most LIST_BUDGET = 40 R2 calls.
// GET /api/uploads lists one page (listPage(), r2-work-bounds.spec.ts).

// Run counts below were set for round 1I's CLEANUP_LIST_LIMIT of 200; a run
// does work in proportion to the limit, so they scale with it (round 1J:
// lowering the limit after a measurement must need no test change).
const runsAt200 = (runs: number) => Math.ceil((runs * 200) / CLEANUP_LIST_LIMIT);
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

/**
 * A bucket whose list calls with metadata after the first (since
 * resetCalls()) return nothing but say there is more, as R2 may: "fewer
 * than asked" includes none.
 */
class StarvedBucket extends FakeBucket {
  private metadataLists = 0;
  override resetCalls(): void {
    super.resetCalls();
    this.metadataLists = 0;
  }
  override async list(options: Parameters<FakeBucket["list"]>[0]) {
    if (!options.include?.length || this.metadataLists++ === 0) return super.list(options);
    await super.list({ ...options, prefix: "\u{10FFFF}" }); // counts the call
    const after = options.cursor
      ? Buffer.from(options.cursor, "base64url").toString("utf-8")
      : (options.startAfter ?? "");
    return { objects: [], truncated: true, cursor: Buffer.from(after).toString("base64url") };
  }
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

  test("an upload of which only legacy records were listed is not stray", async () => {
    const bucket = new FakeBucket();
    seedUpload(bucket, idOf(0), { records: 500 });
    bucket.resetCalls();
    // A page of `.downloads/` records, then the one list call allowed is spent;
    // the sidecar was never listed, so it is read (round 1J; before, the
    // upload was returned without a summary and the next listing started
    // after it).
    const result = await new Uploads(bucket, PREFIX).listAll({ budget: 2, maxListCalls: 1 });
    expect(result.uploads.map((u) => [u.id, u.complete, u.stray, !!u.meta])).toEqual([
      [idOf(0), false, false, true],
    ]);
    expect(bucket.calls.get).toBe(1);
    bucket.resetCalls();
    // Without room for that read, nothing: the next listing starts where this one did.
    const none = await new Uploads(bucket, PREFIX).listAll({ budget: 1 });
    expect(none).toMatchObject({ uploads: [], truncated: true });
    expect(none.resumeAfter).toBeUndefined();

    // Fully listed records without a sidecar or file are stray; the cron
    // deletes them as such.
    const stray = new FakeBucket();
    for (let r = 0; r < 30; r++)
      stray.seed(`${PREFIX}/s0stray/.downloads/2026-06-01T00:00:00.${r}Z_0`);
    seedUpload(stray, idOf(1));
    const listed = await listing(stray);
    expect(listed.uploads.map((u) => [u.id, u.complete, u.stray])).toEqual([
      ["s0stray", true, true],
      [idOf(1), true, false],
    ]);
    stray.resetCalls();
    expect(await runCleanup(stray, PREFIX, NOW)).toMatchObject({ deleted: 1, recordsCleared: 0 });
    expect(stray.keys(`${PREFIX}/s0stray/`)).toEqual([]);
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
    for (; runs < 1000; runs++) {
      const done = left();
      if (Object.values(done).every((n) => n === 0)) break;
      bucket.resetCalls();
      const report = await runCleanup(bucket, PREFIX, NOW);
      expect(bucket.total, `run ${runs + 1}`).toBe(report.subrequests);
      expect(report.subrequests, `run ${runs + 1}`).toBeLessThanOrEqual(CLEANUP_BUDGET);
    }
    console.log(`large bucket: clean after ${runs} runs`);
    // Round 1I: 133 runs (13 before): a run lists 200 objects (100 on this
    // bucket) and deletes at most 200 legacy records, not up to 45 calls' worth.
    expect(runs).toBeLessThanOrEqual(runsAt200(140));
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
    for (let i = 0; i < 200 && cursors.at(-1) !== null; i++) {
      bucket.resetCalls();
      const report = await runCleanup(bucket, PREFIX, NOW);
      expect(report.subrequests).toBeLessThanOrEqual(CLEANUP_BUDGET);
      cursors.push(report.cursor);
    }
    expect(cursors.at(-1)).toBeNull();
    expect(new Set(cursors).size).toBe(cursors.length); // always further, never stuck
  });

  test("short list pages: a current upload with legacy records is not deleted as stray", async () => {
    const bucket = new StarvedBucket();
    const meta = seedUpload(bucket, idOf(0), { records: 500 });
    const fileKey = `${PREFIX}/${idOf(0)}/${meta.filename}`;
    for (let run = 0; run < 3; run++) {
      bucket.resetCalls();
      const report = await runCleanup(bucket, PREFIX, NOW);
      expect(report.subrequests).toBeLessThanOrEqual(CLEANUP_BUDGET);
      expect(report.deleted).toBe(0);
    }
    expect(bucket.objects.has(fileKey)).toBe(true);
    expect(bucket.objects.has(`${PREFIX}/${idOf(0)}/.meta.json`)).toBe(true);
  });

  test("old sidecars: each run gives as many their summary as its budget allows", async () => {
    const bucket = new FakeBucket();
    const ids = Array.from({ length: 300 }, (_, i) => idOf(i));
    for (const id of ids) seedUpload(bucket, id, { legacySidecar: true });
    // Round 1I: CLEANUP_SUMMARIES (3 since 1K) a run, no longer as many as the
    // budget of 45 calls allows ((45 - 3) / 2 = 21 before).
    const perRun = CLEANUP_SUMMARIES;
    let done = 0;
    for (let run = 0; done < ids.length; run++) {
      bucket.resetCalls();
      const report = await runCleanup(bucket, PREFIX, NOW);
      expect(report.subrequests).toBeLessThanOrEqual(CLEANUP_BUDGET);
      expect(report.summarized).toBe(Math.min(perRun, ids.length - done));
      done += report.summarized;
    }
    for (const id of ids) {
      const sidecar = bucket.objects.get(`${PREFIX}/${id}/.meta.json`)!;
      expect(JSON.parse(sidecar.customMetadata["summary"]!)).toEqual(
        summarize(JSON.parse(sidecar.body) as UploadMeta),
      );
    }
  });

  test("junk pages, then sidecars without a summary: the cron gets to all of them", async () => {
    const bucket = new FakeBucket();
    // Runs of nothing but junk, then a slice of 50 junk keys and the first uploads.
    for (let i = 0; i < 3 * CLEANUP_LIST_LIMIT + 50; i++) bucket.seed(`${PREFIX}/a${i}.junk`);
    const ids = Array.from({ length: 200 }, (_, i) => `m${String(i).padStart(4, "0")}`);
    for (const id of ids) seedUpload(bucket, id, { legacySidecar: true });
    const unsummarized = () =>
      ids.filter(
        (id) => !bucket.objects.get(`${PREFIX}/${id}/.meta.json`)!.customMetadata["summary"],
      );
    // 60 runs at 10 summaries a run; scaled for fewer (round 1K: 3).
    const maxRuns = 3 * Math.ceil(200 / CLEANUP_SUMMARIES);
    for (let run = 0; run < maxRuns && unsummarized().length > 0; run++) {
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
    // Cursor read, one list page, a batch delete of the files and one of the
    // sidecars, list + delete of the records.
    expect(report.subrequests).toBe(6);
    expect(bucket.keys()).toEqual([
      `${PREFIX}/.cleanup-cursor`,
      `${PREFIX}/${idOf(1)}/.meta.json`,
      `${PREFIX}/${idOf(1)}/file.bin`,
      `${PREFIX}/${idOf(2)}/.meta.json`,
      `${PREFIX}/${idOf(2)}/file.bin`,
    ]);
  });
});

test.describe("deleting an upload in several calls", () => {
  // The sidecar is what makes the listing and the cron recognize an upload:
  // a directory left without it is never cleaned up. So whatever stops a
  // deletion half-way, the sidecar is deleted last.
  const dirOf = (id: string) => `${PREFIX}/${id}/`;
  const orphaned = (bucket: FakeBucket, id: string) => {
    const left = bucket.keys(dirOf(id));
    return left.length > 0 && !left.includes(`${dirOf(id)}.meta.json`);
  };

  test("the cron's deleteUnder() out of budget: the sidecar stays", async () => {
    for (const kind of ["records", "parts"] as const) {
      for (let maxCalls = 2; maxCalls <= 6; maxCalls++) {
        const bucket = new FakeBucket();
        // 1,999 records sort before .meta.json, 1,500 parts after it.
        seedUpload(
          bucket,
          idOf(0),
          kind === "records" ? { records: 1999 } : { pendingSince: NOW, parts: 1500 },
        );
        const result = await new Uploads(bucket, PREFIX).deleteUnder(dirOf(idOf(0)), maxCalls);
        expect(result.calls).toBeLessThanOrEqual(maxCalls);
        expect(orphaned(bucket, idOf(0)), `${kind}, ${maxCalls} calls`).toBe(false);
        expect(result.done).toBe(bucket.keys(dirOf(idOf(0))).length === 0);
      }
    }
  });

  test("DELETE /api/uploads/:id failing half-way: the sidecar stays", async () => {
    for (let maxCalls = 3; maxCalls <= 6; maxCalls++) {
      const bucket = new FakeBucket({ maxCalls });
      const meta = seedUpload(bucket, idOf(0), { records: 1999 });
      await new Uploads(bucket, PREFIX).delete(idOf(0), meta).catch(() => {});
      expect(orphaned(bucket, idOf(0)), `${maxCalls} calls`).toBe(false);
    }
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

test.describe("R2 calls of completing an upload of unknown size", () => {
  // POST /api/uploads/:id/complete without a size at create, call by call as
  // in packages/worker/src/index.ts: the Bearer rate-limit call (not an R2
  // call: the bucket allows one less), the sidecar read, the part records
  // (readPartSizes(), at most MAX_UNSIZED_PARTS of them), the multipart
  // complete, the sidecar write and the deletion of the records. Returns
  // what happened, the subrequests made and the records listed.
  async function complete(bucket: FakeBucket, id: string, parts: number) {
    bucket.resetCalls();
    bucket.maxCalls = 50 - 1;
    const listed = { n: 0 };
    const list = bucket.list.bind(bucket);
    bucket.list = async (options) => {
      const page = await list(options);
      listed.n += page.objects.length;
      return page;
    };
    const uploads = new Uploads(bucket, PREFIX);
    try {
      const meta = (await uploads.readMeta(id))!;
      if (parts > MAX_UNSIZED_PARTS) return { outcome: "refused", subrequests: 1 + bucket.total };
      const records = await uploads.readPartSizes(id, PART_RECORDS_BUDGET, MAX_UNSIZED_PARTS);
      if (!records) {
        return { outcome: "refused", subrequests: 1 + bucket.total, listed: listed.n };
      }
      await bucket.resumeMultipartUpload(`${PREFIX}/${id}/${meta.filename}`, "mp").complete();
      const { pending_upload_id: _, ...finished } = meta;
      await uploads.writeMeta(id, { ...finished, file_size: records.sizes.size * 5 });
      await uploads.deleteKeys(records.keys);
      return { outcome: "completed", subrequests: 1 + bucket.total, listed: listed.n };
    } catch {
      // Past 50 subrequests (the limit assumed before phase 1H), fail the request.
      const after = bucket.calls["complete"] ? " after complete" : "";
      const written = bucket.calls["put"] ? ", sidecar written" : "";
      return { outcome: `failed${after}${written}`, subrequests: 51 };
    }
  }

  test(`at most ${MAX_UNSIZED_PARTS} part records; more are refused before completing`, async () => {
    // Round 1K: the limit is MAX_UNSIZED_PARTS records (CPU: 4,000 records
    // took 82 to 138 ms on Workers Free in phase 1J), no longer the 4,100
    // that fitted the 46 R2 calls of PART_RECORDS_BUDGET.
    const results: Record<number, unknown> = {};
    for (const parts of [1, 100, 101, 299, 300, 301, 4100, 4101, 10_000]) {
      const bucket = new FakeBucket();
      seedUpload(bucket, idOf(0), { pendingSince: NOW, parts });
      // Every record is a part in the request (the CLI's parts array).
      const result = await complete(bucket, idOf(0), parts);
      results[parts] = result;
      if (result.outcome === "refused") {
        // Nothing changed: still pending, every record still there.
        expect(bucket.calls["complete"] ?? 0).toBe(0);
        expect(bucket.calls["put"] ?? 0).toBe(0);
        expect(bucket.keys(`${PREFIX}/${idOf(0)}/.parts/`)).toHaveLength(parts);
      } else if (result.outcome === "completed") {
        expect(bucket.keys(`${PREFIX}/${idOf(0)}/`)).toEqual([`${PREFIX}/${idOf(0)}/.meta.json`]);
      }
    }
    // Completed: 4 + ceil(parts / 100) list calls + ceil(parts / 1000) deletes.
    // Refused: a parts array over the limit before any listing (2: the
    // rate-limit call and the sidecar read).
    expect(results).toEqual({
      1: { outcome: "completed", subrequests: 6, listed: 1 },
      100: { outcome: "completed", subrequests: 6, listed: 100 },
      101: { outcome: "completed", subrequests: 7, listed: 101 },
      299: { outcome: "completed", subrequests: 8, listed: 299 },
      300: { outcome: "completed", subrequests: 8, listed: 300 },
      301: { outcome: "refused", subrequests: 2 },
      4100: { outcome: "refused", subrequests: 2 },
      4101: { outcome: "refused", subrequests: 2 },
      10_000: { outcome: "refused", subrequests: 2 },
    });
  });

  test(`more than ${MAX_UNSIZED_PARTS} records, fewer parts sent: refused after listing at most ${MAX_UNSIZED_PARTS + 1}`, async () => {
    // Records of parts not in the request count too (a client that sent
    // parts again under other numbers, say). The list calls' limit stops the
    // listing at MAX_UNSIZED_PARTS + 1 records, whatever R2 would return.
    for (const pageSize of [37, 100]) {
      for (const records of [MAX_UNSIZED_PARTS + 1, 4101, 10_000]) {
        const bucket = new FakeBucket({ pageSize });
        seedUpload(bucket, idOf(0), { pendingSince: NOW, parts: records });
        const result = await complete(bucket, idOf(0), 1);
        expect(result, `${pageSize}/${records}`).toEqual({
          outcome: "refused",
          subrequests: 2 + Math.ceil((MAX_UNSIZED_PARTS + 1) / pageSize),
          listed: MAX_UNSIZED_PARTS + 1,
        });
        expect(bucket.calls["complete"] ?? 0).toBe(0);
        expect(bucket.keys(`${PREFIX}/${idOf(0)}/.parts/`)).toHaveLength(records);
      }
    }
  });

  test("fewer records per list call: the R2 call budget still refuses, before completing", async () => {
    // A second guard: at 6 records per call, 300 records take 50 list calls,
    // more than PART_RECORDS_BUDGET (46); at 7, 43 calls and a delete fit.
    const six = new FakeBucket({ pageSize: 6 });
    seedUpload(six, idOf(0), { pendingSince: NOW, parts: MAX_UNSIZED_PARTS });
    const refused = await complete(six, idOf(0), MAX_UNSIZED_PARTS);
    expect(refused.outcome).toBe("refused");
    expect(refused.subrequests).toBeLessThanOrEqual(2 + PART_RECORDS_BUDGET);
    expect(six.keys(`${PREFIX}/${idOf(0)}/.parts/`)).toHaveLength(MAX_UNSIZED_PARTS);
    const seven = new FakeBucket({ pageSize: 7 });
    seedUpload(seven, idOf(0), { pendingSince: NOW, parts: MAX_UNSIZED_PARTS });
    expect(await complete(seven, idOf(0), MAX_UNSIZED_PARTS)).toEqual({
      outcome: "completed",
      subrequests: 4 + Math.ceil(MAX_UNSIZED_PARTS / 7) + 1,
      listed: MAX_UNSIZED_PARTS,
    });
  });
});
