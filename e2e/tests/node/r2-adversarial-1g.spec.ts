import { CLEANUP_BUDGET, runCleanup } from "../../../packages/worker/src/cleanup.js";
import { backfillSummaries } from "../../../packages/worker/src/backfill.js";
import { LIST_BUDGET, summarize, Uploads, withDownload, type UploadMeta } from "../../../packages/worker/src/uploads.js";
import { expect, test } from "../../lib/index.js";
import { StrictBucket, seededRandom } from "../../lib/strict-r2.js";

// Independent verifier of round 1G: adversarial checks of the resume logic,
// sidecar-last deletion, stray detection, summary-first cron and backfill.

const P = "uploads";
const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 8, 3);

/** A bucket that checks invariants on every delete call. */
class CheckedBucket extends StrictBucket {
  violations: string[] = [];
  /** dir -> "live" (must keep everything but .downloads/) */
  live = new Set<string>();
  override async delete(keys: string | string[]) {
    const list = typeof keys === "string" ? [keys] : keys;
    for (const k of list) {
      const [id, ...rest] = k.slice(P.length + 1).split("/");
      if (this.live.has(id!) && !rest.join("/").startsWith(".downloads/")) {
        this.violations.push(`deleted key of live upload: ${k}`);
      }
    }
    await super.delete(list);
    // A sidecar deleted while other keys of its upload remain?
    for (const k of list) {
      if (!k.endsWith("/.meta.json")) continue;
      const dir = k.slice(0, -".meta.json".length);
      const left = this.sorted(dir);
      if (left.length > 0) this.violations.push(`sidecar ${k} deleted, ${left.length} keys left e.g. ${left[0]}`);
    }
  }
}

interface Shape {
  legacy?: boolean; // no summary
  expired?: boolean;
  pendingSince?: number;
  noFile?: boolean;
  noSidecar?: boolean;
  unreadable?: boolean;
  records?: number;
  parts?: number;
  junkAfter?: number; // non-bulk keys sorting after .meta.json
  junkBefore?: number; // non-bulk keys sorting before .meta.json
  filename?: string;
}

function seedUpload(b: StrictBucket, id: string, s: Shape) {
  const dir = `${P}/${id}/`;
  const meta: UploadMeta = {
    filename: s.filename ?? "file.bin",
    file_size: 3,
    uploaded_at: new Date(s.pendingSince ?? NOW - DAY).toISOString(),
    expires_at: new Date(s.expired ? NOW - 1000 : NOW + 30 * DAY).toISOString(),
    ...(s.pendingSince !== undefined ? { pending_upload_id: `mp-${id}` } : {}),
  };
  if (!s.noFile && s.pendingSince === undefined) b.seed(dir + meta.filename, "xyz");
  if (!s.noSidecar) {
    b.seed(
      dir + ".meta.json",
      s.unreadable ? "{not json" : JSON.stringify(meta),
      s.legacy || s.unreadable ? {} : { summary: JSON.stringify(summarize(meta)) },
    );
  }
  for (let i = 0; i < (s.records ?? 0); i++) b.seed(`${dir}.downloads/2026-06-01T00:00:00.${String(i).padStart(6, "0")}Z_x`);
  for (let n = 1; n <= (s.parts ?? 0); n++) b.seed(`${dir}.parts/${n}`, "", { size: "5" });
  for (let n = 0; n < (s.junkAfter ?? 0); n++) b.seed(`${dir}zz/${n}`);
  for (let n = 0; n < (s.junkBefore ?? 0); n++) b.seed(`${dir}-j/${n}`);
  return meta;
}

function isStaleShape(s: Shape) {
  if (s.noSidecar || s.unreadable) return false;
  return !!s.expired || (s.pendingSince !== undefined && NOW - s.pendingSince > DAY);
}

async function runUntil(b: CheckedBucket, maxRuns: number, done: () => boolean) {
  let maxCalls = 0;
  for (let run = 1; run <= maxRuns; run++) {
    b.reset();
    b.maxCalls = CLEANUP_BUDGET; // throw past 45, not 50
    const r = await runCleanup(b, P, NOW);
    expect(r.subrequests, `run ${run}: report vs bucket`).toBe(b.total);
    maxCalls = Math.max(maxCalls, b.total);
    if (done()) return { run, maxCalls };
  }
  return { run: Infinity, maxCalls };
}

test.describe("1G verifier: cron on adversarial buckets", () => {
  for (const seedNo of [1, 2, 3, 4]) {
    test(`random mix (seed ${seedNo}): <=45 calls, live untouched, no orphan, converges`, async () => {
      test.setTimeout(240_000);
      const rnd = seededRandom(seedNo);
      const b = new CheckedBucket({ randomPages: seedNo % 2 === 0, seed: seedNo });
      const shapes = new Map<string, Shape>();
      const pick = (p: number) => rnd() < p;
      for (let i = 0; i < 1500; i++) {
        const id = `i${String(i).padStart(5, "0")}${pick(0.05) ? "-" : ""}`;
        const s: Shape = {
          legacy: pick(0.6),
          expired: pick(0.3),
          ...(pick(0.05) ? { pendingSince: pick(0.5) ? NOW - 2 * DAY : NOW - 1000 } : {}),
          noSidecar: pick(0.02),
          unreadable: pick(0.04),
          records: pick(0.05) ? Math.floor(rnd() * 2500) : 0,
          parts: pick(0.03) ? Math.floor(rnd() * 2500) : 0,
          junkAfter: pick(0.02) ? Math.floor(rnd() * 3000) : 0,
          filename: pick(0.1) ? "-early.bin" : "file.bin",
        };
        if (s.noSidecar) s.records = Math.max(s.records ?? 0, 1); // stray records
        seedUpload(b, id, s);
        shapes.set(id, s);
        if (!isStaleShape(s) && !s.noSidecar) b.live.add(id);
        if (pick(0.01)) for (let j = 0; j < 300; j++) b.seed(`${P}/${id}~junk${j}`); // top-level junk
      }
      const { run, maxCalls } = await runUntil(b, 2000, () => {
        for (const [id, s] of shapes) {
          const keys = b.sorted(`${P}/${id}/`);
          if (isStaleShape(s) && keys.length) return false;
          if (keys.some((k) => k.includes("/.downloads/"))) return false;
          if (!isStaleShape(s) && s.legacy && !s.unreadable && !s.noSidecar && !b.objects.get(`${P}/${id}/.meta.json`)!.meta.summary) return false;
        }
        return true;
      });
      console.log(`seed ${seedNo}: converged after ${run} runs, max calls ${maxCalls}`);
      expect(b.violations).toEqual([]);
      expect(run).toBeLessThan(2000);
      // Live uploads keep their file and sidecar; summaries match bodies.
      for (const id of b.live) {
        const s = shapes.get(id)!;
        const sc = b.objects.get(`${P}/${id}/.meta.json`)!;
        expect(sc, id).toBeTruthy();
        if (!s.unreadable) expect(JSON.parse(sc.meta.summary!)).toEqual(summarize(JSON.parse(sc.body)));
      }
    });
  }

  test("thousands of consecutive unreadable sidecars, then stale uploads: all stale deleted", async () => {
    const b = new CheckedBucket();
    for (let i = 0; i < 3000; i++) seedUpload(b, `a${String(i).padStart(5, "0")}`, { unreadable: true });
    for (let i = 0; i < 300; i++) seedUpload(b, `b${String(i).padStart(5, "0")}`, { expired: true, legacy: i % 2 === 0 });
    const { run, maxCalls } = await runUntil(b, 500, () => b.sorted(`${P}/b`).length === 0);
    console.log(`unreadable run: ${run} runs, max ${maxCalls}`);
    expect(run).toBeLessThan(500);
    expect(b.sorted(`${P}/a`).length).toBe(6000);
  });

  test("sidecar-only legacy uploads, all expired: all deleted, never >45", async () => {
    const b = new CheckedBucket({ randomPages: true, seed: 9 });
    for (let i = 0; i < 2000; i++) seedUpload(b, `s${String(i).padStart(5, "0")}`, { expired: true, legacy: true, noFile: true });
    const { run } = await runUntil(b, 1000, () => b.sorted(`${P}/`).filter((k) => !k.endsWith("cleanup-cursor")).length === 0);
    expect(run).toBeLessThan(1000);
  });

  test("one stale upload with 30,000 keys after its sidecar, between live uploads", async () => {
    const b = new CheckedBucket();
    for (let i = 0; i < 30; i++) { seedUpload(b, `a${i}`, { legacy: true }); b.live.add(`a${i}`); }
    seedUpload(b, "big", { expired: true, junkAfter: 30000, records: 3000 });
    for (let i = 0; i < 30; i++) { seedUpload(b, `c${i}`, { legacy: true }); b.live.add(`c${i}`); }
    const { run } = await runUntil(b, 100, () => b.sorted(`${P}/big/`).length === 0);
    console.log(`big stale upload gone after ${run} runs`);
    expect(b.violations).toEqual([]);
    expect(run).toBeLessThan(100);
  });

  test("one stale upload whose 30,000 non-bulk keys sort BEFORE its sidecar (not a yeet upload)", async () => {
    const b = new CheckedBucket();
    seedUpload(b, "big", { expired: true, junkBefore: 30000 });
    seedUpload(b, "next", { expired: true });
    const { run } = await runUntil(b, 30, () => b.sorted(`${P}/big/`).length === 0);
    console.log(`junk-before stale upload: gone after ${run} runs; keys left ${b.sorted(`${P}/big/`).length}; next left ${b.sorted(`${P}/next/`).length}`);
    // Next upload must still be reached.
    expect(b.sorted(`${P}/next/`).length).toBe(0);
    // Document (not assert) whether the big one is ever cleaned up.
  });

  test("cron summary step never clobbers a download counted between its get and put", async () => {
    const b = new CheckedBucket();
    for (let i = 0; i < 10; i++) { seedUpload(b, `r${i}`, { legacy: true }); b.live.add(`r${i}`); }
    const raced = new Set<string>();
    b.beforePut = (key) => {
      if (!key.endsWith("/.meta.json") || raced.has(key)) return;
      raced.add(key);
      const cur = JSON.parse(b.objects.get(key)!.body) as UploadMeta;
      const next = withDownload(cur, new Date(NOW).toISOString());
      b.seed(key, JSON.stringify(next), { summary: JSON.stringify(summarize(next)) });
    };
    await runCleanup(b, P, NOW);
    for (let i = 0; i < 10; i++) {
      const o = b.objects.get(`${P}/r${i}/.meta.json`)!;
      expect(JSON.parse(o.body).download_count, `r${i}`).toBe(1);
      expect(JSON.parse(o.meta.summary!).download_count).toBe(1);
    }
  });

  test("e2e/README claim: <=21 unsummarized sidecars plus one expired upload in one run?", async () => {
    const out: string[] = [];
    for (const k of [19, 20, 21]) {
      const b = new CheckedBucket();
      for (let i = 0; i < k; i++) seedUpload(b, `a${String(i).padStart(3, "0")}`, { legacy: true });
      seedUpload(b, "zexp", { expired: true });
      const r = await runCleanup(b, P, NOW);
      out.push(`${k} unsummarized + 1 expired: summarized ${r.summarized}, deleted ${r.deleted}, cursor ${r.cursor}`);
    }
    console.log(out.join("\n"));
  });

  test("stall branch: listing of a single huge upload returns it once and resumes after it", async () => {
    const b = new StrictBucket();
    seedUpload(b, "huge", { junkBefore: 5000 });
    seedUpload(b, "z1", {});
    const u = new Uploads(b, P);
    const r = await u.listAll();
    expect(r.truncated).toBe(true);
    expect(r.uploads.map((x) => [x.id, x.complete, x.stray])).toEqual([["huge", false, false]]);
    b.reset();
    const r2 = await u.listAll({ after: r.resumeAfter });
    expect(r2.uploads.map((x) => x.id)).toEqual(["z1"]);
  });

  test("records-only upload whose sidecar is on a later page: never stray, never deleted", async () => {
    for (let seed = 1; seed <= 40; seed++) {
      const b = new CheckedBucket({ randomPages: true, seed });
      for (let i = 0; i < 10; i++) seedUpload(b, `p${i}`, { expired: true, legacy: true });
      seedUpload(b, "live", { records: 150 + seed * 7, filename: "zz.bin" });
      b.live.add("live");
      for (let r = 0; r < 20; r++) { b.reset(); b.maxCalls = CLEANUP_BUDGET; await runCleanup(b, P, NOW); }
      expect(b.violations, `seed ${seed}`).toEqual([]);
      expect(b.objects.has(`${P}/live/.meta.json`) && b.objects.has(`${P}/live/zz.bin`)).toBe(true);
    }
  });
});

test.describe("1G verifier: deleteUnder sidecar-last", () => {
  test("every maxCalls, random pages: sidecar never deleted while keys remain", async () => {
    for (const fname of ["-a.bin", "zz.bin"]) {
      for (let maxCalls = 0; maxCalls <= 14; maxCalls++) {
        const b = new CheckedBucket({ randomPages: true, seed: maxCalls + 1 });
        seedUpload(b, "x", { filename: fname, records: 2500, junkAfter: 2500, junkBefore: 500 });
        const r = await new Uploads(b, P).deleteUnder(`${P}/x/`, maxCalls);
        expect(r.calls).toBeLessThanOrEqual(maxCalls);
        expect(b.violations).toEqual([]);
        const left = b.sorted(`${P}/x/`);
        expect(r.done).toBe(left.length === 0);
        if (left.length) expect(left).toContain(`${P}/x/.meta.json`);
      }
    }
  });

  test("short page holding only the sidecar, truncated: how many calls are wasted", async () => {
    // A bucket that returns one object per list without metadata.
    class OnePerPage extends StrictBucket {
      override async list(o: Parameters<StrictBucket["list"]>[0]) {
        const r = await super.list(o);
        if (o.include) return r;
        const objects = r.objects.slice(0, 1);
        return { objects, truncated: r.objects.length > 1 || r.truncated, ...(r.cursor ? { cursor: r.cursor } : {}) };
      }
    }
    const b = new OnePerPage();
    seedUpload(b, "x", { filename: "zz.bin" }); // sidecar sorts first
    const r = await new Uploads(b, P).deleteUnder(`${P}/x/`, 10);
    console.log(`one-per-page deleteUnder: ${JSON.stringify(r)}, left ${b.sorted(`${P}/x/`).length}`);
  });
});

test.describe("1G verifier: backfill", () => {
  test("touches nothing but upload sidecars; races are not overwritten", async () => {
    const b = new StrictBucket({ maxCalls: Infinity, randomPages: true, seed: 5 });
    const meta: UploadMeta = { filename: "f", file_size: 1, uploaded_at: new Date(NOW).toISOString(), expires_at: new Date(NOW + DAY).toISOString() };
    const body = JSON.stringify(meta);
    const others = [
      `${P}/.meta.json`, `${P}/x/y/.meta.json`, `${P}/a.b/.meta.json`, `${P}X/a/.meta.json`, `other/a/.meta.json`,
      `${P}/a/.meta.json/x`, `${P}/a/.meta.jsonx`, `${P}/a/f`, `${P}/a/.parts/1`, `${P}/a/.downloads/1`, `${P}/.cleanup-cursor`,
    ];
    for (const k of others) b.seed(k, body);
    b.seed(`${P}/a/.meta.json`, body);
    b.seed(`${P}/race/.meta.json`, body);
    b.seed(`${P}/gone/.meta.json`, body);
    const before = new Map(others.map((k) => [k, { ...b.objects.get(k)! }]));
    b.beforePut = (key) => {
      if (key === `${P}/race/.meta.json`) {
        const cur = JSON.parse(b.objects.get(key)!.body) as UploadMeta;
        const next = withDownload(cur, new Date(NOW).toISOString());
        b.seed(key, JSON.stringify(next), { summary: JSON.stringify(summarize(next)) });
      }
      if (key === `${P}/gone/.meta.json`) b.remove(key);
    };
    const dry = await backfillSummaries(b, "/uploads/", { apply: false });
    expect(b.calls.put ?? 0).toBe(0);
    expect(b.calls.get ?? 0).toBe(0);
    expect(dry).toMatchObject({ sidecars: 3, missing: 3, written: 0 });
    const rep = await backfillSummaries(b, "/uploads/", { apply: true });
    expect(rep).toMatchObject({ sidecars: 3, missing: 3, written: 1, changed: 2 });
    for (const [k, o] of before) expect(b.objects.get(k), k).toEqual(o);
    expect(b.objects.has(`${P}/gone/.meta.json`)).toBe(false);
    expect(JSON.parse(b.objects.get(`${P}/race/.meta.json`)!.body).download_count).toBe(1);
  });

  test("summary 'null': backfill and listing disagree", async () => {
    const b = new StrictBucket({ maxCalls: Infinity });
    const meta: UploadMeta = { filename: "f", file_size: 1, uploaded_at: new Date(NOW).toISOString(), expires_at: new Date(NOW + DAY).toISOString() };
    b.seed(`${P}/a/.meta.json`, JSON.stringify(meta), { summary: "null" });
    const rep = await backfillSummaries(b, P, { apply: true });
    const l = await new Uploads(b, P).listAll();
    console.log(`summary null: backfill missing=${rep.missing}; listing unsummarized=${l.uploads[0]!.unsummarized}`);
  });

  test("malformed legacy sidecar (downloads: 5): does the cron survive?", async () => {
    const b = new StrictBucket({ maxCalls: 45 });
    const bad = { filename: "f", file_size: 1, uploaded_at: new Date(NOW).toISOString(), expires_at: new Date(NOW - 1).toISOString(), downloads: 5 };
    b.seed(`${P}/a/.meta.json`, JSON.stringify(bad));
    seedUpload(b, "b", { expired: true });
    let error = "";
    for (let r = 0; r < 3; r++) await runCleanup(b, P, NOW).catch((e) => { error = String(e); });
    console.log(`malformed sidecar: cron error=${error || "none"}; b left=${b.sorted(`${P}/b/`).length}`);
  });
});

test("1G verifier: GET listing never exceeds 40 calls on adversarial shapes", async () => {
  for (const seed of [11, 12, 13]) {
    const b = new StrictBucket({ randomPages: true, seed, maxCalls: LIST_BUDGET });
    const rnd = seededRandom(seed);
    for (let i = 0; i < 800; i++) seedUpload(b, `g${String(i).padStart(4, "0")}`, {
      legacy: rnd() < 0.5, unreadable: rnd() < 0.1, records: rnd() < 0.05 ? 1500 : 0, parts: rnd() < 0.05 ? 1500 : 0, junkAfter: rnd() < 0.02 ? 300 : 0,
    });
    let after: string | undefined;
    for (let r = 0; r < 200; r++) {
      b.reset();
      const l = await new Uploads(b, P).listAll(after ? { after } : {});
      expect(b.total).toBe(l.subrequests);
      expect(l.subrequests).toBeLessThanOrEqual(LIST_BUDGET);
      if (!l.truncated) break;
      expect(l.resumeAfter! > (after ?? "")).toBe(true);
      after = l.resumeAfter;
    }
  }
});
