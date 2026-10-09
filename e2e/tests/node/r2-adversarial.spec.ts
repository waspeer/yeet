import {
  CLEANUP_BUDGET,
  CLEANUP_LIST_LIMIT,
  runCleanup,
} from "../../../packages/worker/src/cleanup.js";
import {
  LIST_BUDGET,
  summarize,
  Uploads,
  type UploadMeta,
} from "../../../packages/worker/src/uploads.js";
import { expect, test } from "../../lib/index.js";
import { StrictBucket, byteCompare, seededRandom } from "../../lib/strict-r2.js";

// Adversarial tests of the listing, the cron and the download count on the
// stricter in-memory bucket of lib/strict-r2.ts, written by the independent
// verifier of round 1F and adopted into the suite: junk keys, IDs that are
// prefixes of each other, odd filenames, short and empty list pages, legacy
// records and parts by the thousand, and writes racing a run. Together with
// r2-budget.spec.ts they pin down that no upload is skipped or deleted by
// mistake and that no request exceeds its R2 call budget.

// Run counts below were set for round 1I's CLEANUP_LIST_LIMIT of 200; a run
// does work in proportion to the limit, so they scale with it (round 1J:
// lowering the limit after a measurement must need no test change).
const runsAt200 = (runs: number) => Math.ceil((runs * 200) / CLEANUP_LIST_LIMIT);
const P = "uploads";
const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 8, 3);

interface Opt {
  expired?: boolean;
  legacy?: boolean;
  records?: number;
  parts?: number;
  pending?: number; // pendingSince
  filename?: string;
  junkInside?: number;
}
function seed(b: StrictBucket, id: string, o: Opt = {}): UploadMeta {
  const dir = `${P}/${id}/`;
  const meta: UploadMeta = {
    filename: o.filename ?? "file.bin",
    file_size: 10,
    uploaded_at: new Date(o.pending ?? NOW - DAY).toISOString(),
    expires_at: new Date(o.expired ? NOW - 1000 : NOW + 30 * DAY).toISOString(),
    ...(o.pending !== undefined ? { pending_upload_id: `mp-${id}` } : {}),
  };
  if (o.pending === undefined) b.seed(dir + meta.filename, "x");
  b.seed(
    dir + ".meta.json",
    JSON.stringify(meta),
    o.legacy ? {} : { summary: JSON.stringify(summarize(meta)) },
  );
  for (let i = 0; i < (o.records ?? 0); i++)
    b.seed(
      `${dir}.downloads/${new Date(Date.UTC(2026, 5, 1) + i).toISOString()}_${i.toString(16).padStart(8, "0")}`,
    );
  for (let n = 1; n <= (o.parts ?? 0); n++) b.seed(`${dir}.parts/${n}`, "", { size: "5" });
  for (let n = 0; n < (o.junkInside ?? 0); n++) b.seed(`${dir}zz-junk/${n}`);
  return meta;
}

const validId = (s: string) => /^[A-Za-z0-9_-]+$/.test(s);
function truthIds(b: StrictBucket): string[] {
  const ids = new Set<string>();
  for (const k of b.sorted(`${P}/`)) {
    const [id, ...rest] = k.slice(P.length + 1).split("/");
    if (id && validId(id) && rest.length) ids.add(id);
  }
  return [...ids].sort((a, c) => byteCompare(`${P}/${a}/`, `${P}/${c}/`));
}

async function chain(b: StrictBucket, budget = LIST_BUDGET, maxRounds = 500) {
  const seen: string[] = [];
  const perCall: number[] = [];
  let after: string | undefined;
  let rounds = 0;
  let stalls = 0;
  for (;;) {
    b.reset();
    b.maxCalls = 50;
    const r = await new Uploads(b, P).listAll({
      budget,
      ...(after !== undefined ? { after } : {}),
    });
    expect(b.total).toBe(r.subrequests);
    expect(r.subrequests).toBeLessThanOrEqual(budget);
    perCall.push(r.subrequests);
    // complete uploads list exactly their keys
    for (const u of r.uploads) {
      if (u.complete) expect(u.keys.sort(byteCompare)).toEqual(b.sorted(`${P}/${u.id}/`));
    }
    seen.push(...r.uploads.map((u) => u.id));
    if (!r.truncated) break;
    if (r.resumeAfter === after) {
      // Round 1I: an upload cut off by short pages after at most 2 of its
      // keys is not skipped; the listing returns nothing and the next one
      // retries from the same place (R2 may return short pages, even
      // empty ones). Random page lengths get past it within a few tries.
      expect(r.uploads, "a listing that does not advance returns nothing").toEqual([]);
      expect(++stalls, "resumeAfter must advance eventually").toBeLessThan(50);
    } else {
      stalls = 0;
      if (after !== undefined) expect(byteCompare(r.resumeAfter!, after)).toBeGreaterThan(0);
    }
    after = r.resumeAfter;
    if (++rounds > maxRounds) throw new Error("no termination");
  }
  return { seen, perCall, rounds };
}

test.describe("adversarial listing", () => {
  test("junk pages then unsummarized sidecars: resume chain must not skip uploads", async () => {
    for (const budget of [40, 25]) {
      const b = new StrictBucket();
      for (let i = 0; i < (budget - 1) * 100; i++)
        b.seed(`${P}/a${String(i).padStart(5, "0")}.junk`);
      for (let i = 0; i < 200; i++) seed(b, `m${String(i).padStart(4, "0")}`, { legacy: true });
      const seen: string[] = [];
      let after: string | undefined;
      for (let r = 0; r < 20; r++) {
        b.reset();
        const res = await new Uploads(b, P).listAll({ budget, ...(after ? { after } : {}) });
        seen.push(...res.uploads.map((u) => u.id));
        if (!res.truncated) break;
        after = res.resumeAfter;
      }
      expect(seen, `budget ${budget}`).toEqual(truthIds(b));
    }
  });

  test("10,000 plain uploads, random page sizes: exact chain", async () => {
    const b = new StrictBucket({ randomPages: true });
    for (let i = 0; i < 10000; i++) seed(b, `u${String(i).padStart(5, "0")}`);
    const { seen, perCall } = await chain(b);
    expect(seen).toEqual(truthIds(b));
    console.log("10k random pages: rounds", perCall.length, "max calls", Math.max(...perCall));
  });

  test("IDs differing late / prefix-related, tiny budgets", async () => {
    const chars = "-0189AZ_az".split("");
    const ids = new Set<string>([
      "a",
      "a-",
      "a0",
      "a_",
      "aa",
      "ab",
      "a--",
      "a-0",
      "abc",
      "abc-",
      "abc0",
      "abc_",
      "abcA",
      "abc-x",
      "ab-",
      "Z",
      "_",
      "-",
      "0",
    ]);
    for (const c1 of chars) for (const c2 of chars) ids.add(`xyzxy${c1}${c2}`);
    for (const c1 of chars) ids.add(`xyzxy${c1}`);
    const failures: string[] = [];
    for (const budget of [2, 3, 5, 40]) {
      for (const rp of [false, true]) {
        const b = new StrictBucket({ randomPages: rp });
        let i = 0;
        for (const id of ids) {
          const fn = [
            "file.bin",
            "-dash",
            "!bang",
            " space",
            "~tilde",
            "\u{1F600}.png",
            "é.txt",
            ".hidden",
            "0zero",
            "￿",
          ][i++ % 10]!;
          seed(b, id, {
            filename: fn,
            legacy: i % 7 === 0,
            records: i % 11 === 0 ? 150 : 0,
            parts: 0,
          });
        }
        // junk around
        b.seed(`${P}/.cleanup-cursor`, "{}");
        b.seed(`${P}/a.b/x`);
        b.seed(`${P}/a/`); // empty-name key in a valid dir
        b.seed(`${P}/~/x`);
        b.seed(`${P}/toplevel`);
        b.seed(`${P}//double`);
        try {
          const { seen } = await chain(b, budget, 5000);
          const truth = truthIds(b);
          const missing = truth.filter((x) => !seen.includes(x));
          const dup = seen.length - new Set(seen).size;
          console.log(
            `budget ${budget} rp ${rp}: missing ${missing.length} dup ${dup} order ${JSON.stringify(seen) === JSON.stringify(truth)}`,
          );
          failures.push(...(missing.length || dup ? [`b${budget} rp${rp}`] : []));
        } catch (e) {
          console.log(`budget ${budget} rp ${rp}: ERROR ${String(e).slice(0, 200)}`);
          failures.push(`b${budget} rp${rp} error`);
        }
      }
    }
    expect(failures).toEqual([]);
  });

  test("heavy legacy records and parts, adversarial", async () => {
    const b = new StrictBucket({ randomPages: true });
    for (let i = 0; i < 300; i++) {
      seed(b, `r${String(i).padStart(4, "0")}`, { records: 1200 + (i % 3) * 100 });
    }
    for (let i = 0; i < 50; i++)
      seed(b, `p${String(i).padStart(4, "0")}`, {
        pending: NOW - 1000,
        parts: 2000,
        filename: "!a",
      });
    for (let i = 0; i < 3000; i++) seed(b, `s${String(i).padStart(4, "0")}`, { legacy: true });
    for (let i = 0; i < 20; i++) seed(b, `j${String(i).padStart(4, "0")}`, { junkInside: 2500 });
    for (let i = 0; i < 6000; i++) b.seed(`${P}/k${i}.junk`);
    const { seen, perCall } = await chain(b, LIST_BUDGET, 5000);
    expect(seen).toEqual(truthIds(b));
    console.log("heavy: rounds", perCall.length, "max", Math.max(...perCall));
  });
});

// ---------------------------------------------------------------------------

async function runs(b: StrictBucket, n: number, now = NOW, hook?: (i: number) => void) {
  const cursors: (string | null)[] = [];
  for (let i = 0; i < n; i++) {
    hook?.(i);
    b.reset();
    b.maxCalls = 50;
    const r = await runCleanup(b, P, now);
    expect(b.total).toBe(r.subrequests);
    expect(r.subrequests, `run ${i}`).toBeLessThanOrEqual(CLEANUP_BUDGET);
    cursors.push(r.cursor);
  }
  return cursors;
}

test.describe("adversarial cron", () => {
  test("adversarial bucket converges, never deletes valid uploads, cursor wraps", async () => {
    test.setTimeout(300_000);
    const b = new StrictBucket({ randomPages: true });
    const keep = new Map<string, number>();
    const stale = new Set<string>();
    // Round 1I: legacy records and part records scaled down (from 1,100,
    // 1,300, 2,100, 1,500): a run now deletes at most CLEANUP_LIST_LIMIT keys of an upload
    // it lists on its own (one deleteUnder() round), so the original counts
    // took about 5,000 runs. Still several pages and runs per upload.
    for (let i = 0; i < 2500; i++) {
      const id = `c${String(i).padStart(4, "0")}`;
      const m = i % 9;
      if (m === 0) {
        seed(b, id, { expired: true, records: i % 4 === 0 ? 400 : 0 });
        stale.add(id);
      } else if (m === 1) {
        seed(b, id, { pending: NOW - 2 * DAY, parts: i % 2 ? 500 : 2 });
        stale.add(id);
      } else if (m === 2) seed(b, id, { records: i % 5 === 0 ? 700 : 150 });
      else if (m === 3) seed(b, id, { legacy: true });
      else if (m === 4) seed(b, id, { pending: NOW - 1000, parts: 600 });
      else if (m === 5) {
        seed(b, id, { legacy: true, expired: true });
        stale.add(id);
      } else seed(b, id, { filename: ["\u{1F600}", "-x", "é", "~"][i % 4] });
      if (!stale.has(id)) keep.set(id, 0);
    }
    for (let i = 0; i < 5; i++)
      for (let r = 0; r < 600; r++)
        b.seed(`${P}/zstray${i}/.downloads/2026-06-01T00:00:00.${r}Z_0`);
    for (let i = 0; i < 3000; i++) b.seed(`${P}/k${i}.junk`);
    const keepKeys = new Map<string, string[]>();
    for (const id of keep.keys())
      keepKeys.set(
        id,
        b.sorted(`${P}/${id}/`).filter((k) => !k.includes("/.downloads/")),
      );

    let i = 0;
    let maxCalls = 0;
    const maxRuns = runsAt200(3000);
    for (; i < maxRuns; i++) {
      b.reset();
      const r = await runCleanup(b, P, NOW);
      maxCalls = Math.max(maxCalls, r.subrequests);
      expect(r.subrequests).toBeLessThanOrEqual(CLEANUP_BUDGET);
      if (i % 10 !== 9) continue;
      for (const ks of keepKeys.values())
        for (const k of ks)
          if (!b.objects.has(k)) throw new Error(`valid key deleted: ${k} run ${i}`);
      const keys = b.sorted(`${P}/`);
      const st = [...stale].filter((id) => b.sorted(`${P}/${id}/`).length > 0).length;
      const rec = keys.filter((k) => k.includes("/.downloads/")).length;
      const un = [...keep.keys()].filter(
        (id) => !b.objects.get(`${P}/${id}/.meta.json`)!.meta.summary,
      ).length;
      if (i % 100 === 99)
        console.log(
          `run ${i + 1}: stale ${st} records ${rec} unsummarized ${un} keys ${keys.length}`,
        );
      if (i === maxRuns - 1) {
        const left = [...stale].filter((id) => b.sorted(`${P}/${id}/`).length > 0);
        throw new Error(
          `not converged after ${maxRuns} runs; stale uploads left: ${left.slice(0, 20).join(" ")}`,
        );
      }
      if (st === 0 && rec === 0 && un === 0) break;
    }
    console.log("max calls per run", maxCalls);
    console.log("cron converged after runs:", i + 1);
    expect(i).toBeLessThan(maxRuns);
    for (const id of keep.keys()) {
      const s = b.objects.get(`${P}/${id}/.meta.json`)!;
      expect(JSON.parse(s.meta.summary!)).toEqual(summarize(JSON.parse(s.body)));
    }
    // multipart aborted for every abandoned
    // wrap: on a now-clean bucket, cursors advance and reach null
    // Round 1I: a run covers about 25 uploads on these random pages of up
    // to 100 objects, and at most one run of part records: hundreds of runs.
    const cursors = await runs(b, 1000);
    const firstNull = cursors.indexOf(null);
    expect(firstNull).toBeGreaterThanOrEqual(0);
    const cycle = cursors.slice(0, firstNull);
    // Never backwards. Round 1I: a run cut short by a short page (at most 2
    // keys of the next upload listed) keeps the cursor and the next retries.
    let same = 0;
    for (let j = 1; j < cycle.length; j++) {
      const order = byteCompare(cycle[j]!, cycle[j - 1]!);
      expect(order).toBeGreaterThanOrEqual(0);
      same = order === 0 ? same + 1 : 0;
      expect(same, "the cursor advances within a few runs").toBeLessThan(20);
    }
    console.log("clean cycle length", firstNull + 1);
  });

  for (const [name, body] of [
    ["garbage", "not json"],
    ["empty object", "{}"],
    ["number", '{"after":5}'],
    ["past end", '{"after":"uploads/~~~~"}'],
    ["outside prefix", '{"after":"zzz"}'],
    ["inside bulk", '{"after":"uploads/c0002/.downloads/2026"}'],
    ["null", "null"],
  ] as const) {
    test(`cursor ${name}`, async () => {
      const b = new StrictBucket();
      seed(b, "c0001", { expired: true });
      seed(b, "c0002", { records: 50 });
      seed(b, "c0003");
      b.seed(`${P}/.cleanup-cursor`, body);
      const cs = await runs(b, 3);
      expect(b.sorted(`${P}/c0001/`)).toEqual([]);
      expect(b.sorted(`${P}/c0002/.downloads/`)).toEqual([]);
      expect(b.sorted(`${P}/c0003/`).length).toBe(2);
      expect(cs.at(-1)).toBeNull();
    });
  }

  test("bucket emptied between runs; uploads created during a run", async () => {
    const b = new StrictBucket();
    for (let i = 0; i < 3000; i++) seed(b, `e${String(i).padStart(4, "0")}`);
    await runs(b, 1);
    for (const k of b.sorted(`${P}/e`)) b.remove(k);
    const cs = await runs(b, 2);
    expect(cs.at(-1)).toBeNull();
    // creation during runs
    const b2 = new StrictBucket({ randomPages: true });
    for (let i = 0; i < 3000; i++)
      seed(b2, `f${String(i).padStart(4, "0")}`, { expired: i % 3 === 0 });
    let n = 0;
    const created: string[] = [];
    const random = seededRandom(2);
    b2.onList = () => {
      const id = `f${String(Math.floor(random() * 3000)).padStart(4, "0")}x${n++}`;
      // a new pending upload being created (sidecar first, no summary of a finished file)
      seed(b2, id, { pending: NOW - 1000 });
      created.push(id);
    };
    // Round 1I: about 25 uploads a run on random pages of up to 100 objects.
    await runs(b2, 250);
    for (const id of created) expect(b2.objects.has(`${P}/${id}/.meta.json`), id).toBe(true);
    expect(
      b2
        .sorted(`${P}/`)
        .filter((k) => k.endsWith(".meta.json"))
        .every((k) => !JSON.parse(b2.objects.get(k)!.body).expires_at.startsWith("2026-10-08T02")),
    ).toBe(true);
  });

  test("junk keys right before a legacy-record upload: valid upload not deleted as stray", async () => {
    const b = new StrictBucket();
    // 24 pages of junk with invalid IDs sorting just before "v0001", then an upload with records.
    for (let i = 0; i < 2450; i++) b.seed(`${P}/v0000.junk${String(i).padStart(5, "0")}`);
    // place records so the 25th page ends inside the .downloads run
    seed(b, "v0001", { records: 500 });
    seed(b, "v0002");
    const fileKey = `${P}/v0001/file.bin`;
    const r = await new Uploads(b, P).listAll({ budget: 25 });
    console.log(
      "junk-before-legacy listing:",
      JSON.stringify(
        r.uploads.map((u) => ({
          id: u.id,
          stray: u.stray,
          complete: u.complete,
          n: u.keys.length,
        })),
      ),
      r.truncated,
    );
    b.reset();
    await runCleanup(b, P, NOW);
    expect(b.objects.has(fileKey), "valid upload deleted").toBe(true);
  });

  test("abandoned pending: multipart aborted, keys gone; recent pending kept", async () => {
    const b = new StrictBucket();
    seed(b, "a0001", { pending: NOW - 2 * DAY, parts: 3 });
    seed(b, "a0002", { pending: NOW - 2 * DAY, parts: 2500 });
    seed(b, "a0003", { pending: NOW - DAY + 60_000, parts: 3 });
    // Round 1I: a run deletes at most CLEANUP_LIST_LIMIT keys of an upload it
    // has to list on its own, so 2,500 parts take 13 runs at 200, 25 at 100.
    await runs(b, runsAt200(16));
    // Round 1I: an abandoned upload whose deletion takes several runs has
    // its (already aborted) multipart upload aborted again in each, 1 call.
    expect([...new Set(b.aborted)].sort()).toEqual(["mp-a0001", "mp-a0002"]);
    expect(b.sorted(`${P}/a0001/`)).toEqual([]);
    expect(b.sorted(`${P}/a0002/`)).toEqual([]);
    expect(b.sorted(`${P}/a0003/`).length).toBe(4);
  });
});

// ---------------------------------------------------------------------------

test.describe("adversarial download count", () => {
  test("injected conflicts: never overcount; metadata matches body", async () => {
    const random = seededRandom(3);
    for (let trial = 0; trial < 50; trial++) {
      const b = new StrictBucket({ maxCalls: Infinity });
      const legacy = trial % 2 === 0;
      const meta = seed(b, "d0001");
      const key = `${P}/d0001/.meta.json`;
      if (legacy) {
        const m = {
          ...meta,
          downloads: Array.from({ length: 50 }, (_, i) => ({
            at: `2026-01-01T00:00:${String(i).padStart(2, "0")}.000Z`,
          })),
        };
        b.seed(key, JSON.stringify(m), {});
      }
      let injected = 0;
      // Another writer (a correct one) bumps the count between read and write half the time.
      b.beforePut = (k) => {
        if (k === key && random() < 0.5) {
          const cur = JSON.parse(b.objects.get(k)!.body) as UploadMeta;
          const base = cur.download_count ?? cur.downloads?.length ?? 0;
          const { downloads: _d, ...rest } = cur;
          const next = {
            ...rest,
            download_count: base + 1,
            recent_downloads: [...(cur.recent_downloads ?? []), new Date(NOW).toISOString()]
              .sort()
              .slice(-5),
          };
          b.seed(k, JSON.stringify(next), { summary: JSON.stringify(summarize(next)) });
          injected++;
        }
      };
      const u = new Uploads(b, P);
      const res = await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          u.recordDownload("d0001", new Date(NOW + i).toISOString()),
        ),
      );
      const ok = res.filter(Boolean).length;
      const stored = JSON.parse(b.objects.get(key)!.body) as UploadMeta;
      expect(stored.download_count).toBe((legacy ? 50 : 0) + ok + injected);
      expect(stored.downloads).toBeUndefined();
      expect(stored.recent_downloads!.length).toBeLessThanOrEqual(5);
      expect([...stored.recent_downloads!].sort()).toEqual(stored.recent_downloads);
      expect(JSON.parse(b.objects.get(key)!.meta.summary!)).toEqual(summarize(stored));
      expect(b.total).toBeLessThanOrEqual(10 * 6);
    }
  });

  test("deleted mid-way or pending: never resurrected", async () => {
    const b = new StrictBucket();
    seed(b, "d0002");
    const key = `${P}/d0002/.meta.json`;
    b.beforePut = (k) => {
      if (k === key) b.remove(k);
    };
    expect(await new Uploads(b, P).recordDownload("d0002", "2026-10-08T00:00:00.000Z")).toBe(false);
    expect(b.objects.has(key)).toBe(false);
    // deleted then re-created (same id, new upload): conditional put fails on new etag
    const b2 = new StrictBucket();
    const m = seed(b2, "d0003");
    const k2 = `${P}/d0003/.meta.json`;
    let once = true;
    b2.beforePut = (k) => {
      if (k === k2 && once) {
        once = false;
        b2.seed(k, JSON.stringify({ ...m, pending_upload_id: "new" }), {});
      }
    };
    expect(await new Uploads(b2, P).recordDownload("d0003", "2026-10-08T00:00:00.000Z")).toBe(
      false,
    );
    expect(JSON.parse(b2.objects.get(k2)!.body).pending_upload_id).toBe("new");
  });

  test("sequential 30: exact", async () => {
    const b = new StrictBucket({ maxCalls: Infinity });
    seed(b, "d0004");
    const u = new Uploads(b, P);
    for (let i = 0; i < 30; i++)
      expect(await u.recordDownload("d0004", new Date(NOW + i * 1000).toISOString())).toBe(true);
    const s = JSON.parse(b.objects.get(`${P}/d0004/.meta.json`)!.body);
    expect(s.download_count).toBe(30);
    expect(s.recent_downloads).toEqual(
      Array.from({ length: 5 }, (_, i) => new Date(NOW + (25 + i) * 1000).toISOString()),
    );
  });
});

test.describe("cron: targeted checks", () => {
  test("cron stopped mid-way resumes at the first unfinished upload", async () => {
    const b = new StrictBucket();
    for (let i = 0; i < 3000; i++)
      seed(b, `u${String(i).padStart(5, "0")}`, i < 20 ? { expired: true, records: 1500 } : {});
    const r = await runCleanup(b, P, NOW);
    const unfinished = Array.from(
      { length: 20 },
      (_, i) => `u${String(i).padStart(5, "0")}`,
    ).filter((id) => b.sorted(`${P}/${id}/`).length > 0);
    console.log("cursor", r.cursor, "unfinished", unfinished.length);
    expect(unfinished.length).toBeGreaterThan(0);
    for (const id of unfinished)
      expect(
        r.cursor === null || byteCompare(`${P}/${id}/`, r.cursor) > 0,
        `${id} after ${r.cursor}`,
      ).toBe(true);
  });
  test("an upload dir with a file but no sidecar is left alone", async () => {
    const b = new StrictBucket();
    b.seed(`${P}/x0001/file.bin`, "data");
    seed(b, "x0002", { expired: true });
    await runs(b, 2);
    expect(b.objects.has(`${P}/x0001/file.bin`)).toBe(true);
  });
  test("summary step keeps a legacy downloads array's count", async () => {
    const b = new StrictBucket();
    const m = {
      filename: "f",
      file_size: 1,
      uploaded_at: new Date(NOW - DAY).toISOString(),
      expires_at: new Date(NOW + DAY).toISOString(),
      downloads: [{ at: "2026-01-01T00:00:00.000Z" }, { at: "2026-01-02T00:00:00.000Z" }],
    };
    b.seed(`${P}/y0001/f`, "x");
    b.seed(`${P}/y0001/.meta.json`, JSON.stringify(m));
    await runs(b, 1);
    const s = b.objects.get(`${P}/y0001/.meta.json`)!;
    expect(JSON.parse(s.meta.summary!).download_count).toBe(2);
    expect(summarize(JSON.parse(s.body)).download_count).toBe(2);
  });
});
