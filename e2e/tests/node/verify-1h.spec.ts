import { CLEANUP_BUDGET, runCleanup } from "../../../packages/worker/src/cleanup.js";
import {
  canStoreSummary,
  MAX_SUMMARY_BYTES,
  PART_RECORDS_BUDGET,
  parseUploadMeta,
  summarize,
  summaryFromCustomMetadata,
  Uploads,
  type UploadMeta,
} from "../../../packages/worker/src/uploads.js";
import { expect, test } from "../../lib/index.js";
import { StrictBucket } from "../../lib/strict-r2.js";
import { FakeBucket } from "../../lib/fake-r2.js";

// Written by the independent verifier of round 1H: every sidecar shape a
// released or pre-release yeet ever wrote must still pass parseUploadMeta(),
// be listed, counted and cleaned; the summary cap counts UTF-8 bytes; the
// part-record budget and deleteUnder() hold on short pages.

const P = "uploads";
const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 8, 3);
const iso = (t: number) => new Date(t).toISOString();

/** A bucket that flags a sidecar deleted while other keys of its upload remain. */
class CheckedBucket extends StrictBucket {
  violations: string[] = [];
  override async delete(keys: string | string[]) {
    const list = typeof keys === "string" ? [keys] : keys;
    await super.delete(list);
    for (const k of list) {
      if (!k.endsWith("/.meta.json")) continue;
      const left = this.sorted(k.slice(0, -".meta.json".length));
      if (left.length > 0) this.violations.push(`${k} deleted with ${left.length} keys left`);
    }
  }
}

/**
 * One realistic sidecar per historic writer, as `JSON.stringify(meta, null, 2)`
 * (every writer pretty-printed), with the file it sits next to.
 */
function historic(
  expires: number,
): Record<string, { meta: Record<string, unknown>; summary: boolean; file: boolean }> {
  const up = iso(NOW - 3 * DAY);
  const exp = iso(expires);
  const downloads50 = Array.from({ length: 50 }, (_, i) => ({ at: iso(NOW - 2 * DAY + i * 1000) }));
  return {
    // yeet 0.1 CLI (cf7f56e .. 1d6a39c, rclone): no password.
    cli01: {
      meta: {
        filename: "report final (v2).pdf",
        file_size: 123456,
        uploaded_at: up,
        expires_at: exp,
      },
      summary: false,
      file: true,
    },
    // yeet 0.1 CLI with an argon2id password hash.
    cli01pw: {
      meta: {
        filename: "secret.zip",
        file_size: 9,
        uploaded_at: up,
        expires_at: exp,
        password_hash:
          "$argon2id$v=19$m=65536,t=3,p=4$c29tZXNhbHRzb21lc2FsdA$Zm9vYmFyYmF6cXV4Zm9vYmFyYmF6cXV4",
      },
      summary: false,
      file: true,
    },
    // yeet 0.1 CLI, an empty file.
    cli01empty: {
      meta: { filename: "empty.txt", file_size: 0, uploaded_at: up, expires_at: exp },
      summary: false,
      file: true,
    },
    // yeet 0.2 server (a913cf5 .. 1d6a39c): downloads appended, last 50 kept.
    srv02: {
      meta: {
        filename: "movie.mkv",
        file_size: 7_000_000_000,
        uploaded_at: up,
        expires_at: exp,
        downloads: downloads50,
      },
      summary: false,
      file: true,
    },
    srv02pw: {
      meta: {
        filename: "ünïcødé 文件.txt",
        file_size: 4,
        uploaded_at: up,
        expires_at: exp,
        password_hash: "$argon2id$v=19$m=65536,t=3,p=4$YQ$Yg",
        downloads: [{ at: iso(NOW - DAY) }],
      },
      summary: false,
      file: true,
    },
    // yeet 0.1 CLI with a fractional/odd --expires (still an ISO string).
    cliFarFuture: {
      meta: {
        filename: "far.bin",
        file_size: 1,
        uploaded_at: up,
        expires_at: expires > NOW ? "+010000-01-01T00:00:00.000Z" : exp,
      },
      summary: false,
      file: true,
    },
    // Worker feb7b2f: finished upload with summary.
    wFeb: {
      meta: {
        filename: "a.bin",
        file_size: 3,
        uploaded_at: up,
        expires_at: exp,
        password_hash: "pbkdf2-sha256$100000$c2FsdA$aGFzaA",
      },
      summary: true,
      file: true,
    },
    // Worker 1B..1E: download_count folded, legacy downloads dropped (b858bb3).
    w1E: {
      meta: {
        filename: "b.bin",
        file_size: 3,
        uploaded_at: up,
        expires_at: exp,
        download_count: 1234,
        recent_downloads: [iso(NOW - 5000), iso(NOW - 4000)],
      },
      summary: true,
      file: true,
    },
    // Worker 1F+ (current writeMeta): download_count, recent_downloads (5).
    wNow: {
      meta: {
        filename: "c.bin",
        file_size: 3,
        uploaded_at: up,
        expires_at: exp,
        download_count: 7,
        recent_downloads: [1, 2, 3, 4, 5].map((i) => iso(NOW - i * 1000)),
      },
      summary: true,
      file: true,
    },
    // Worker: still pending, size declared (feb7b2f+) and unknown (c1056ac+).
    wPendSize: {
      meta: {
        filename: "p.bin",
        file_size: 10,
        uploaded_at: up,
        expires_at: exp,
        pending_upload_id: "mp-1",
      },
      summary: true,
      file: false,
    },
    wPendNoSize: {
      meta: { filename: "q.bin", uploaded_at: up, expires_at: exp, pending_upload_id: "mp-2" },
      summary: true,
      file: false,
    },
    // A finished sidecar without file_size (readers default it to 0).
    wNoSize: {
      meta: { filename: "r.bin", uploaded_at: up, expires_at: exp },
      summary: false,
      file: true,
    },
  };
}

function seed(
  b: StrictBucket,
  id: string,
  s: { meta: Record<string, unknown>; summary: boolean; file: boolean },
) {
  const meta = s.meta as unknown as UploadMeta;
  if (s.file) b.seed(`${P}/${id}/${meta.filename}`, "xyz");
  b.seed(
    `${P}/${id}/.meta.json`,
    JSON.stringify(meta, null, 2),
    s.summary ? { summary: JSON.stringify(summarize(meta)) } : {},
  );
}

test.describe("1H verifier: historic sidecar formats", () => {
  test("every historic shape is accepted, listed, counted", async () => {
    const b = new StrictBucket({ maxCalls: 10_000 });
    const shapes = historic(NOW + 30 * DAY);
    for (const [id, s] of Object.entries(shapes)) seed(b, id, s);
    for (const [id, s] of Object.entries(shapes)) {
      expect(parseUploadMeta(JSON.parse(JSON.stringify(s.meta))), id).not.toBeNull();
      expect(canStoreSummary(s.meta as unknown as UploadMeta), id).toBe(true);
    }
    const u = new Uploads(b, P);
    const listing = await u.listAll({ budget: 1000 });
    expect(listing.uploads.map((x) => x.id).sort()).toEqual(Object.keys(shapes).sort());
    for (const x of listing.uploads) {
      expect(x.meta, x.id).toEqual(summarize(shapes[x.id]!.meta as unknown as UploadMeta));
    }
    // Counted: finished ones gain a download, pending ones are not counted.
    for (const [id, s] of Object.entries(shapes)) {
      const counted = await u.recordDownload(id, iso(NOW));
      expect(counted, id).toBe(!s.meta.pending_upload_id);
      const sc = b.objects.get(`${P}/${id}/.meta.json`)!;
      if (counted) {
        const before = summarize(s.meta as unknown as UploadMeta).download_count;
        expect(JSON.parse(sc.body).download_count, id).toBe(before + 1);
        expect(summaryFromCustomMetadata(sc.meta), id).toEqual(summarize(JSON.parse(sc.body)));
      }
    }
  });

  test("every historic shape is cleaned when expired (pending: when abandoned) and the cron gives the rest summaries", async () => {
    const b = new CheckedBucket();
    const expired = historic(NOW - 1000);
    const live = historic(NOW + 30 * DAY);
    for (const [id, s] of Object.entries(expired)) seed(b, `e-${id}`, s);
    for (const [id, s] of Object.entries(live)) seed(b, `l-${id}`, s);
    for (let run = 0; run < 10; run++) {
      b.reset();
      b.maxCalls = CLEANUP_BUDGET;
      await runCleanup(b, P, NOW);
    }
    expect(b.violations).toEqual([]);
    // Expired: all gone (pending ones were uploaded 3 days ago: abandoned too).
    expect(b.sorted(`${P}/e-`)).toEqual([]);
    // Live finished ones kept; abandoned pending ones (3 days old) deleted.
    for (const [id, s] of Object.entries(live)) {
      const keys = b.sorted(`${P}/l-${id}/`);
      if (s.meta.pending_upload_id) expect(keys, id).toEqual([]);
      else {
        expect(keys.length, id).toBe(s.file ? 2 : 1);
        const sc = b.objects.get(`${P}/l-${id}/.meta.json`)!;
        expect(summaryFromCustomMetadata(sc.meta), id).toEqual(summarize(JSON.parse(sc.body)));
      }
    }
  });
});

test.describe("1H verifier: MAX_SUMMARY_BYTES", () => {
  const base: UploadMeta = {
    filename: "",
    file_size: 3,
    uploaded_at: iso(NOW - DAY),
    expires_at: iso(NOW + DAY),
  };
  const total = (m: UploadMeta) =>
    Buffer.byteLength("summary") + Buffer.byteLength(JSON.stringify(summarize(m)));
  const empty = total(base);

  test("exactly the cap is stored, one byte more is not (ASCII)", async () => {
    const at = { ...base, filename: "x".repeat(MAX_SUMMARY_BYTES - empty) };
    const over = { ...base, filename: "x".repeat(MAX_SUMMARY_BYTES - empty + 1) };
    expect(total(at)).toBe(MAX_SUMMARY_BYTES);
    expect(canStoreSummary(at)).toBe(true);
    expect(canStoreSummary(over)).toBe(false);
    const b = new StrictBucket();
    const u = new Uploads(b, P);
    await u.writeMeta("at", at);
    await u.writeMeta("ov", over);
    expect(b.objects.get(`${P}/at/.meta.json`)!.meta).toHaveProperty("summary");
    expect(b.objects.get(`${P}/ov/.meta.json`)!.meta).toEqual({});
  });

  test("bytes, not characters: a multi-byte filename under the cap in characters is refused", () => {
    // "é" is 2 bytes in UTF-8, "😀" 4 bytes (2 UTF-16 units).
    const room = MAX_SUMMARY_BYTES - empty;
    const e = { ...base, filename: "é".repeat(Math.floor(room / 2)) };
    const e1 = { ...base, filename: "é".repeat(Math.floor(room / 2) + 1) };
    expect(canStoreSummary(e)).toBe(true);
    expect(canStoreSummary(e1)).toBe(false);
    expect(JSON.stringify(summarize(e1)).length + "summary".length).toBeLessThanOrEqual(
      MAX_SUMMARY_BYTES,
    );
    const emoji = { ...base, filename: "😀".repeat(Math.floor(room / 4) + 1) };
    expect(JSON.stringify(summarize(emoji)).length + 7).toBeLessThan(MAX_SUMMARY_BYTES);
    expect(canStoreSummary(emoji)).toBe(false);
  });

  test("an over-cap sidecar is listed (one read each listing), counted, and deleted when expired", async () => {
    const b = new CheckedBucket({ maxCalls: 10_000 });
    const long = "y".repeat(3000);
    b.seed(`${P}/big/${long}`, "x");
    b.seed(`${P}/big/.meta.json`, JSON.stringify({ ...base, filename: long }));
    const u = new Uploads(b, P);
    for (let i = 0; i < 2; i++) {
      b.reset();
      const l = await u.listAll();
      expect(l.uploads[0]!.meta?.filename).toBe(long);
      expect(b.calls["get"]).toBe(1); // read again every listing
    }
    expect(await u.recordDownload("big", iso(NOW))).toBe(true);
    const sc = b.objects.get(`${P}/big/.meta.json`)!;
    expect(JSON.parse(sc.body).download_count).toBe(1);
    expect(sc.meta).toEqual({});
    // Expire it: the cron deletes it without ever writing a summary.
    b.seed(
      `${P}/big/.meta.json`,
      JSON.stringify({ ...base, filename: long, expires_at: iso(NOW - 1) }),
    );
    b.reset();
    b.maxCalls = CLEANUP_BUDGET;
    const r = await runCleanup(b, P, NOW);
    expect(r.deleted).toBe(1);
    expect(r.summarized).toBe(0);
    expect(b.sorted(`${P}/big/`)).toEqual([]);
    expect(b.violations).toEqual([]);
  });

  test("60 live over-cap sidecars before an expired upload: the cron still reaches it, <=45 calls a run", async () => {
    const b = new CheckedBucket();
    const long = "z".repeat(3000);
    for (let i = 0; i < 60; i++) {
      b.seed(`${P}/a${String(i).padStart(3, "0")}/f`, "x");
      b.seed(
        `${P}/a${String(i).padStart(3, "0")}/.meta.json`,
        JSON.stringify({ ...base, filename: long }),
      );
    }
    b.seed(`${P}/zz/f.bin`, "x");
    b.seed(
      `${P}/zz/.meta.json`,
      JSON.stringify({ ...base, filename: "f.bin", expires_at: iso(NOW - 1) }),
    );
    let runs = 0;
    while (b.sorted(`${P}/zz/`).length > 0 && runs < 20) {
      b.reset();
      b.maxCalls = CLEANUP_BUDGET;
      const r = await runCleanup(b, P, NOW);
      expect(r.subrequests).toBe(b.total);
      runs++;
    }
    console.log(`over-cap: expired upload reached after ${runs} runs`);
    expect(runs).toBeLessThan(20);
    expect(b.sorted(`${P}/a`)).toHaveLength(120);
  });
});

test.describe("1H verifier: malformed sidecars", () => {
  const ok = { filename: "f", file_size: 1, uploaded_at: iso(NOW - DAY), expires_at: iso(NOW - 1) };
  const bad: Record<string, unknown> = {
    noFilename: { ...ok, filename: undefined },
    numExpiry: { ...ok, expires_at: NOW - 1 },
    nullExpiry: { ...ok, expires_at: null },
    strSize: { ...ok, file_size: "1" },
    negSize: { ...ok, file_size: -1 },
    floatCount: { ...ok, download_count: 1.5 },
    recentNums: { ...ok, recent_downloads: [1] },
    dlNoAt: { ...ok, downloads: [{}] },
    pwNull: { ...ok, password_hash: null },
    array: [ok],
    nul: null,
  };
  test("rejected, never crash the listing, cron or count; left alone", async () => {
    const b = new CheckedBucket({ maxCalls: 100_000 });
    for (const [id, m] of Object.entries(bad)) {
      expect(parseUploadMeta(m), id).toBeNull();
      b.seed(`${P}/${id}/f`, "x");
      b.seed(`${P}/${id}/.meta.json`, JSON.stringify(m));
    }
    b.seed(`${P}/zz/f`, "x");
    b.seed(`${P}/zz/.meta.json`, JSON.stringify(ok));
    const u = new Uploads(b, P);
    const l = await u.listAll();
    for (const x of l.uploads) if (x.id !== "zz") expect(x.meta, x.id).toBeNull();
    for (const id of Object.keys(bad)) expect(await u.recordDownload(id, iso(NOW)), id).toBe(false);
    // Round 1I: a run tries at most CLEANUP_SUMMARIES (10) sidecars without
    // a summary, so the malformed ones before zz take two runs.
    let deleted = 0;
    for (let run = 0; run < 2; run++) {
      b.reset();
      b.maxCalls = CLEANUP_BUDGET;
      deleted += (await runCleanup(b, P, NOW)).deleted;
    }
    expect(deleted).toBe(1);
    expect(b.sorted(`${P}/zz/`)).toEqual([]);
    for (const id of Object.keys(bad)) expect(b.sorted(`${P}/${id}/`), id).toHaveLength(2);
  });
});

test.describe("1H verifier: readPartSizes budget and deleteUnder on short pages", () => {
  test("readPartSizes never makes more than its budget, and a result fits the budget with its deletes", async () => {
    for (const seedNo of [1, 2, 3, 4, 5, 6]) {
      for (const parts of [0, 1, 99, 100, 101, 999, 1000, 1001, 2500, 4100, 4101]) {
        const b = new StrictBucket({
          randomPages: true,
          seed: seedNo * 1000 + parts,
          maxCalls: 100_000,
        });
        for (let n = 1; n <= parts; n++) b.seed(`${P}/x/.parts/${n}`, "", { size: "5" });
        const u = new Uploads(b, P);
        const r = await u.readPartSizes("x", PART_RECORDS_BUDGET);
        const lists = b.calls["list"] ?? 0;
        expect(lists, `${seedNo}/${parts}`).toBeLessThanOrEqual(PART_RECORDS_BUDGET);
        if (r) {
          expect(r.keys).toHaveLength(parts);
          expect(lists + Math.ceil(parts / 1000), `${seedNo}/${parts}`).toBeLessThanOrEqual(
            PART_RECORDS_BUDGET,
          );
        }
      }
    }
  });

  test("deleteUnder on random short pages: within maxCalls, sidecar last, finishes", async () => {
    for (const seedNo of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const b = new CheckedBucket({ randomPages: true, seed: seedNo, maxCalls: 100_000 });
      // Keys before the sidecar ("-", ".d"), the sidecar, and after (".p", "f", "zz").
      for (let i = 0; i < 1500; i++) b.seed(`${P}/x/-j/${i}`);
      for (let i = 0; i < 1200; i++) b.seed(`${P}/x/.downloads/${i}`);
      b.seed(`${P}/x/.meta.json`, "{}");
      for (let i = 0; i < 800; i++) b.seed(`${P}/x/.parts/${i}`);
      b.seed(`${P}/x/file.bin`, "x");
      for (let i = 0; i < 2500; i++) b.seed(`${P}/x/zz/${i}`);
      const u = new Uploads(b, P);
      let rounds = 0;
      for (;;) {
        rounds++;
        const before = b.total;
        const r = await u.deleteUnder(`${P}/x/`, 7);
        expect(r.calls).toBe(b.total - before);
        expect(r.calls).toBeLessThanOrEqual(7);
        if (r.done) break;
        expect(rounds).toBeLessThan(500);
      }
      expect(b.sorted(`${P}/x/`)).toEqual([]);
      expect(b.violations, `seed ${seedNo}`).toEqual([]);
    }
  });

  test("deleteUnder: a truncated page holding only the sidecar does not stall (R2 returns 1 key)", async () => {
    // A bucket that returns exactly one key per list page.
    class OneKey extends CheckedBucket {
      override async list(o: Parameters<StrictBucket["list"]>[0]) {
        const r = await super.list(o);
        if (r.objects.length <= 1) return r;
        const first = r.objects.slice(0, 1);
        const rest = await super.list({ prefix: o.prefix, startAfter: first[0]!.key });
        this.calls["list"]!--;
        return { objects: first, truncated: rest.objects.length > 0 || r.truncated };
      }
    }
    const b = new OneKey({ maxCalls: 100_000 });
    b.seed(`${P}/x/.meta.json`, "{}");
    for (let i = 0; i < 5; i++) b.seed(`${P}/x/f${i}`);
    const u = new Uploads(b, P);
    let total = 0;
    let done = false;
    for (let run = 0; run < 10 && !done; run++) {
      const r = await u.deleteUnder(`${P}/x/`, 20);
      total += r.calls;
      done = r.done;
    }
    expect(done).toBe(true);
    expect(b.sorted(`${P}/x/`)).toEqual([]);
    expect(b.violations).toEqual([]);
    console.log(`one-key pages: done in ${total} calls`);
  });
});

test.describe("1H verifier: edges the first mutation run missed", () => {
  test("readPartSizes: a last page that crosses a 1,000-record delete batch is refused", async () => {
    // 71 records per list call: 42 calls hold 2,982 records (3 deletes,
    // 42 + 1 + 3 = 46 lets the 43rd call through), which brings 3,010:
    // 43 lists + 4 deletes = 47 > 46. 3,000 records still fit (43 + 3).
    const run = async (parts: number) => {
      const b = new FakeBucket({ pageSize: 71 });
      for (let n = 1; n <= parts; n++) b.seed(`${P}/x/.parts/${n}`, "", { size: "5" });
      b.resetCalls();
      const r = await new Uploads(b, P).readPartSizes("x", PART_RECORDS_BUDGET);
      return { ok: r !== null, lists: b.calls["list"] ?? 0 };
    };
    expect(await run(3000)).toEqual({ ok: true, lists: 43 });
    expect(await run(3010)).toEqual({ ok: false, lists: 43 });
  });

  test("writeMeta of a malformed sidecar (e.g. a pending one completed) writes it without a summary instead of throwing", async () => {
    const b = new StrictBucket();
    const u = new Uploads(b, P);
    const meta = {
      filename: "f",
      uploaded_at: iso(NOW),
      expires_at: iso(NOW + DAY),
      downloads: 5,
    } as unknown as UploadMeta;
    expect(await u.writeMeta("x", meta)).toBe(true);
    expect(b.objects.get(`${P}/x/.meta.json`)!.meta).toEqual({});
  });
});
