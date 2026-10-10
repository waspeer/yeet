// Independent verifier of round 1L, on the in-memory strict bucket (no
// wrangler): the "deletion under way" sidecar (DELETED_UPLOAD_ID) against
// every reader the Uploads class has, races of a bounded DELETE with a
// counted download, a complete and another DELETE, the cron's "delete what
// it saw" on random buckets with DELETE requests interleaved, and page walks
// with random short (and empty) pages and the 50-object jump.

import {
  CLEANUP_BUDGET,
  CLEANUP_JUMPS,
  CLEANUP_LIST_LIMIT,
  runCleanup,
} from "../../../packages/worker/src/cleanup.js";
import {
  DELETE_LIMIT,
  DELETED_UPLOAD_ID,
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

const P = "uploads";
const DAY = 86_400_000;
// Tombstones are written with the real clock; the cron runs a minute later.
const NOW = Date.now() + 60_000;

/** A bucket that checks the cleanup invariants on every delete and abort. */
class CheckedBucket extends StrictBucket {
  violations: string[] = [];
  /** IDs of uploads that must keep every key but legacy `.downloads/` records. */
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
    for (const k of list) {
      if (!k.endsWith("/.meta.json")) continue;
      const left = this.sorted(k.slice(0, -".meta.json".length));
      if (left.length > 0) this.violations.push(`sidecar ${k} deleted, ${left.length} keys left`);
    }
  }
  override resumeMultipartUpload(key: string, uploadId: string) {
    if (uploadId === DELETED_UPLOAD_ID) this.violations.push(`abort of "deleted" for ${key}`);
    const id = key.slice(P.length + 1).split("/")[0]!;
    if (this.live.has(id)) this.violations.push(`abort of a live upload ${key}`);
    return super.resumeMultipartUpload(key, uploadId);
  }
}

interface Shape {
  legacy?: boolean;
  expired?: boolean;
  pendingSince?: number;
  unreadable?: boolean;
  noSidecar?: boolean;
  records?: number;
  parts?: number;
  filename?: string;
}

function seedUpload(b: StrictBucket, id: string, s: Shape): UploadMeta {
  const dir = `${P}/${id}/`;
  const meta: UploadMeta = {
    filename: s.filename ?? "f.bin",
    file_size: 1,
    uploaded_at: new Date(s.pendingSince ?? NOW - DAY).toISOString(),
    expires_at: new Date(s.expired ? NOW - 1000 : NOW + 30 * DAY).toISOString(),
    ...(s.pendingSince !== undefined ? { pending_upload_id: `mp-${id}` } : {}),
  };
  if (s.pendingSince === undefined) b.seed(dir + meta.filename, "x");
  if (!s.noSidecar) {
    b.seed(
      `${dir}.meta.json`,
      s.unreadable ? "{not json" : JSON.stringify(meta),
      s.legacy || s.unreadable ? {} : { summary: JSON.stringify(summarize(meta)) },
    );
  }
  for (let i = 0; i < (s.records ?? 0); i++)
    b.seed(`${dir}.downloads/2026-06-01T00:00:00.${String(i).padStart(6, "0")}Z_x`);
  for (let n = 1; n <= (s.parts ?? 0); n++) b.seed(`${dir}.parts/${n}`, "", { size: "5" });
  return meta;
}

const sidecarOf = (b: StrictBucket, id: string) => {
  const o = b.objects.get(`${P}/${id}/.meta.json`);
  return o ? { body: JSON.parse(o.body) as UploadMeta, meta: o.meta } : null;
};

/** One DELETE /api/uploads/:id as the route makes it, with its per-request bounds checked. */
async function deleteRequest(b: StrictBucket, id: string) {
  const uploads = new Uploads(b, P);
  const saved = b.maxCalls;
  b.maxCalls = Infinity;
  b.reset();
  const meta = await uploads.readMeta(id).catch(() => null);
  const result = await uploads.delete(id, meta);
  const work = {
    lists: b.calls.list ?? 0,
    listed: b.listed,
    deletes: b.calls.delete ?? 0,
    puts: b.calls.put ?? 0,
    aborts: b.calls.abort ?? 0,
    total: b.total,
  };
  b.maxCalls = saved;
  expect(work.lists, `DELETE ${id}`).toBe(1);
  expect(work.listed, `DELETE ${id}`).toBeLessThanOrEqual(DELETE_LIMIT);
  expect(work.deletes + work.puts, `DELETE ${id}`).toBeLessThanOrEqual(2);
  // The sidecar read, the abort, and three.
  expect(work.total, `DELETE ${id}`).toBeLessThanOrEqual(1 + work.aborts + 3);
  return { result, work };
}

test.describe("1L verifier: the deletion-under-way sidecar", () => {
  test("its summary hides it from a page without a read, even if the upload had no summary", async () => {
    const b = new StrictBucket({ maxCalls: Infinity });
    seedUpload(b, "aaa", { legacy: true, parts: 0, records: 300 });
    seedUpload(b, "bbb", {});
    const { result } = await deleteRequest(b, "aaa");
    expect(result).toMatchObject({ found: true, done: false });
    const sc = sidecarOf(b, "aaa")!;
    expect(sc.body.pending_upload_id).toBe(DELETED_UPLOAD_ID);
    expect(JSON.parse(sc.meta.summary!).pending_upload_id).toBe(DELETED_UPLOAD_ID);
    b.reset();
    const page = await new Uploads(b, P).listPage();
    expect(page.uploads.map((u) => u.id)).toEqual(["bbb"]);
    expect(b.calls.get ?? 0).toBe(0);
  });

  test("legacy records before the sidecar: every request bounded, sidecar last, then 404", async () => {
    const b = new CheckedBucket({ ...REAL_R2_CAPS, maxCalls: Infinity });
    seedUpload(b, "rec", { legacy: true, records: 1234 });
    let requests = 0;
    for (;;) {
      requests++;
      const { result } = await deleteRequest(b, "rec");
      expect(result.found).toBe(true);
      if (result.done) break;
      expect(sidecarOf(b, "rec")!.body.pending_upload_id).toBe(DELETED_UPLOAD_ID);
      expect(requests).toBeLessThan(100);
    }
    expect(b.violations).toEqual([]);
    expect(b.sorted(`${P}/rec/`)).toEqual([]);
    // 1,234 records, the sidecar and the file: 100 a request, the last up to 100.
    expect(requests).toBe(Math.ceil((1234 + 2) / DELETE_LIMIT));
    expect((await deleteRequest(b, "rec")).result).toEqual({
      found: false,
      done: true,
      deleted: 0,
    });
  });

  test("keys without a sidecar (over the limit): a sidecar is written for them, hidden, cleaned", async () => {
    const b = new CheckedBucket({ maxCalls: Infinity });
    seedUpload(b, "orph", { noSidecar: true, pendingSince: NOW - 1000, parts: 250 });
    const { result } = await deleteRequest(b, "orph");
    expect(result).toMatchObject({ found: true, done: false });
    const sc = sidecarOf(b, "orph")!;
    console.log(`orphan keys: DELETE wrote a sidecar ${JSON.stringify(sc.body)}`);
    expect(sc.body.pending_upload_id).toBe(DELETED_UPLOAD_ID);
    expect((await new Uploads(b, P).listPage()).uploads).toEqual([]);
    // The cron finishes it (expired), never aborting "deleted".
    for (let run = 0; run < 20 && b.sorted(`${P}/orph/`).length > 0; run++) {
      b.reset();
      b.maxCalls = CLEANUP_BUDGET;
      await runCleanup(b, P, NOW);
    }
    expect(b.sorted(`${P}/orph/`)).toEqual([]);
    expect(b.violations).toEqual([]);
    expect(b.aborted).toEqual([]);
  });

  test("an unreadable sidecar over the limit is replaced by the deletion marker and finished", async () => {
    const b = new CheckedBucket({ maxCalls: Infinity });
    seedUpload(b, "bad", { unreadable: true, parts: 300, pendingSince: NOW - 1000 });
    const { result } = await deleteRequest(b, "bad");
    expect(result).toMatchObject({ found: true, done: false });
    expect(sidecarOf(b, "bad")!.body.pending_upload_id).toBe(DELETED_UPLOAD_ID);
    for (let i = 0; i < 10 && b.sorted(`${P}/bad/`).length > 0; i++) await deleteRequest(b, "bad");
    expect(b.sorted(`${P}/bad/`)).toEqual([]);
    expect(b.violations).toEqual([]);
  });

  test("a download counted between its read and its write never overwrites the marker", async () => {
    const b = new StrictBucket({ maxCalls: Infinity });
    seedUpload(b, "dl", { records: 400 });
    const uploads = new Uploads(b, P);
    let fired = false;
    b.beforePut = (key) => {
      if (fired || !key.endsWith("dl/.meta.json")) return;
      fired = true;
      // The DELETE's marker lands between recordDownload's get and its
      // conditional put (written here as Uploads.delete() writes it).
      const marker: UploadMeta = {
        filename: "f.bin",
        uploaded_at: new Date().toISOString(),
        expires_at: new Date().toISOString(),
        pending_upload_id: DELETED_UPLOAD_ID,
      };
      b.seed(key, JSON.stringify(marker), { summary: JSON.stringify(summarize(marker)) });
    };
    const counted = await uploads.recordDownload("dl", new Date().toISOString());
    console.log(`download raced with DELETE: counted=${counted}`);
    expect(counted).toBe(false);
    expect(b.calls.put).toBe(1); // re-read the marker and stopped
    const sc = sidecarOf(b, "dl")!;
    expect(sc.body.pending_upload_id).toBe(DELETED_UPLOAD_ID);
    expect(sc.body.download_count ?? 0).toBe(0);
  });

  test("concurrent DELETEs of one upload: sidecar last, all gone at the end", async () => {
    for (let seed = 1; seed <= 20; seed++) {
      const b = new CheckedBucket({ maxCalls: Infinity, randomPages: false, seed });
      seedUpload(b, "cc", { records: 50 + seed * 37, pendingSince: NOW - 1000 });
      const uploads = new Uploads(b, P);
      let lone = 0;
      for (let round = 0; round < 50 && b.sorted(`${P}/cc/`).length > 0; round++) {
        const meta = await uploads.readMeta("cc").catch(() => null);
        await Promise.all([uploads.delete("cc", meta), uploads.delete("cc", meta)]);
        const left = b.sorted(`${P}/cc/`);
        if (left.length === 1 && left[0]!.endsWith(".meta.json")) lone++;
      }
      expect(b.sorted(`${P}/cc/`), `seed ${seed}`).toEqual([]);
      expect(b.violations, `seed ${seed}`).toEqual([]);
      if (lone)
        console.log(`seed ${seed}: a lone marker sidecar was left ${lone} time(s), removed later`);
    }
  });

  test("FINDING: an empty first list page answers done: false without marking the upload", async () => {
    // R2 may return a truncated page with fewer objects than asked, even
    // none (the listing code handles that everywhere). Uploads.delete() then
    // reports found and not done (the route answers 202, "gone for users
    // already"), but writes no marker, as nothing was listed. An old CLI
    // (one DELETE) reports "Deleted", and the upload stays listed and
    // downloadable; not expired, so the cron does not delete it either.
    const b = new StrictBucket({ maxCalls: Infinity });
    seedUpload(b, "emp", {});
    const uploads = new Uploads(b, P);
    const list = b.list.bind(b);
    let first = true;
    b.list = async (options) => {
      if (first && !options.include) {
        first = false;
        const page = await list({ ...options, limit: 1 });
        return { ...page, objects: [], truncated: true };
      }
      return list(options);
    };
    const result = await uploads.delete("emp", await uploads.readMeta("emp"));
    expect(result).toEqual({ found: true, done: false, deleted: 0 });
    expect(sidecarOf(b, "emp")!.body.pending_upload_id).toBeUndefined();
    expect((await uploads.listPage()).uploads.map((u) => u.id)).toEqual(["emp"]);
  });

  test("race: a complete that lands after the marker brings the upload back (documented)", async () => {
    // Size unknown, 150 part records: complete reads the sidecar (pending),
    // R2 completes, the DELETE then lists 100 keys and writes the marker, and
    // complete's own (unconditional) sidecar write lands last.
    const b = new StrictBucket({ maxCalls: Infinity });
    const meta = seedUpload(b, "cx", { pendingSince: NOW - 1000, parts: 150 });
    b.seed(`${P}/cx/f.bin`, "x"); // the object complete() made
    const uploads = new Uploads(b, P);
    const del = await uploads.delete("cx", meta);
    expect(del.done).toBe(false);
    const { pending_upload_id: _, ...finished } = meta;
    await uploads.writeMeta("cx", { ...finished, file_size: 1 });
    const listed = (await uploads.listPage()).uploads.map((u) => u.id);
    console.log(
      `complete after the marker: listed=${JSON.stringify(listed)}, keys left ${b.sorted(`${P}/cx/`).length}`,
    );
    // Listed and downloadable again (the file sorts after `.parts/`): the
    // DELETE answered 202; a client that asks again (yeet delete) removes it.
    expect(listed).toEqual(["cx"]);
    for (let i = 0; i < 5 && b.sorted(`${P}/cx/`).length > 0; i++) await deleteRequest(b, "cx");
    expect(b.sorted(`${P}/cx/`)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The cron on random buckets, with DELETE requests between its runs.

const RUN_LISTED = CLEANUP_LIST_LIMIT + CLEANUP_JUMPS * JUMP_LIMIT;

for (const seedNo of [11, 12, 13, 14, 15, 16]) {
  test(`1L verifier: cron + interleaved DELETEs, seed ${seedNo}: bounded, live untouched, converges`, async () => {
    test.setTimeout(300_000);
    const rnd = seededRandom(seedNo);
    const real = seedNo % 3 === 0;
    const b = new CheckedBucket({
      randomPages: seedNo % 2 === 0,
      seed: seedNo,
      ...(real ? REAL_R2_CAPS : {}),
    });
    const shapes = new Map<string, Shape>();
    const deleting = new Set<string>();
    const pick = (p: number) => rnd() < p;
    for (let i = 0; i < 600; i++) {
      const id = `v${String(i).padStart(4, "0")}`;
      const s: Shape = {
        legacy: pick(0.4),
        expired: pick(0.25),
        ...(pick(0.08) ? { pendingSince: pick(0.5) ? NOW - 2 * DAY : NOW - 1000 } : {}),
        unreadable: pick(0.03),
        records: pick(0.06) ? Math.floor(rnd() * 900) : 0,
        parts: pick(0.06) ? Math.floor(rnd() * 900) : 0,
        filename: pick(0.1) ? "-early.bin" : "f.bin",
      };
      seedUpload(b, id, s);
      shapes.set(id, s);
    }
    const stale = (id: string) => {
      const s = shapes.get(id)!;
      if (s.unreadable) return false;
      return !!s.expired || (s.pendingSince !== undefined && NOW - s.pendingSince > DAY);
    };
    for (const id of shapes.keys()) if (!stale(id) && !shapes.get(id)!.unreadable) b.live.add(id);
    const ids = [...shapes.keys()];
    let maxListed = 0;
    let maxCalls = 0;
    let runs = 0;
    const done = () =>
      ids.every((id) => {
        const keys = b.sorted(`${P}/${id}/`);
        if ((stale(id) || deleting.has(id)) && keys.length > 0) return false;
        return !keys.some((k) => k.includes("/.downloads/"));
      });
    for (runs = 1; runs <= 3000 && !done(); runs++) {
      // Now and then a DELETE request (an old CLI: one only), of any upload.
      if (pick(0.3)) {
        const id = ids[Math.floor(rnd() * ids.length)]!;
        b.live.delete(id);
        deleting.add(id);
        await deleteRequest(b, id);
      }
      b.reset();
      b.maxCalls = CLEANUP_BUDGET;
      const r = await runCleanup(b, P, NOW);
      expect(r.subrequests, `run ${runs}`).toBe(b.total);
      expect(b.calls.list ?? 0, `run ${runs}: lists`).toBeLessThanOrEqual(1 + CLEANUP_JUMPS);
      expect(b.maxListed, `run ${runs}: per list`).toBeLessThanOrEqual(CLEANUP_LIST_LIMIT);
      expect(b.listed, `run ${runs}: listed`).toBeLessThanOrEqual(RUN_LISTED);
      maxListed = Math.max(maxListed, b.listed);
      maxCalls = Math.max(maxCalls, b.total);
    }
    console.log(
      `seed ${seedNo} (${real ? "real caps" : "100"}${seedNo % 2 === 0 ? ", random pages" : ""}): ` +
        `converged after ${runs - 1} runs, ${deleting.size} deleted by request, max listed ${maxListed}, max calls ${maxCalls}`,
    );
    expect(done()).toBe(true);
    expect(b.violations).toEqual([]);
    for (const id of b.live) expect(b.objects.has(`${P}/${id}/.meta.json`), id).toBe(true);
  });
}

// ---------------------------------------------------------------------------
// Page walks: random short and empty pages, the 50-object jump.

for (const seedNo of [21, 22, 23, 24, 25, 26, 27, 28]) {
  test(`1L verifier: page walk, seed ${seedNo}: every finished upload shown, bounded, no loop`, async () => {
    test.setTimeout(120_000);
    const rnd = seededRandom(seedNo);
    const b = new StrictBucket({
      randomPages: true,
      seed: seedNo,
      maxCalls: Infinity,
      ...(seedNo % 2 ? REAL_R2_CAPS : {}),
    });
    const finished = new Set<string>();
    const hidden = new Set<string>();
    for (let i = 0; i < 300; i++) {
      const id = `w${String(i).padStart(4, "0")}`;
      const s: Shape = {
        legacy: rnd() < 0.5,
        records: rnd() < 0.1 ? Math.floor(rnd() * 600) : 0,
        parts: rnd() < 0.05 ? Math.floor(rnd() * 600) : 0,
        unreadable: rnd() < 0.02,
        ...(rnd() < 0.05 ? { pendingSince: NOW - 1000 } : {}),
      };
      seedUpload(b, id, s);
      if (s.unreadable || s.pendingSince !== undefined) hidden.add(id);
      else finished.add(id);
    }
    // Some deletions under way among them.
    const uploads = new Uploads(b, P);
    let unmarked = 0;
    for (const id of [...finished].filter(() => rnd() < 0.05)) {
      const r = await uploads.delete(id, await uploads.readMeta(id), 5);
      if (r.done) {
        finished.delete(id);
      } else if (sidecarOf(b, id)?.body.pending_upload_id === DELETED_UPLOAD_ID) {
        finished.delete(id);
        hidden.add(id);
      } else {
        // `done: false` (202) but no marker: R2 returned an empty page (see
        // the FINDING test above). The upload is still a live one.
        unmarked++;
      }
    }
    if (unmarked) console.log(`seed ${seedNo}: ${unmarked} DELETE(s) done: false without a marker`);
    const seen = new Map<string, number>();
    let after: string | undefined;
    let pages = 0;
    for (;;) {
      pages++;
      expect(pages, "pages").toBeLessThan(20_000);
      b.reset();
      b.maxCalls = 1 + PAGE_READS;
      const page = await uploads.listPage(after);
      expect(b.calls.list ?? 0).toBeLessThanOrEqual(1 + PAGE_JUMPS);
      expect(b.listed).toBeLessThanOrEqual(PAGE_LIMIT + PAGE_JUMPS * JUMP_LIMIT);
      expect(b.calls.get ?? 0).toBeLessThanOrEqual(PAGE_READS);
      for (const u of page.uploads) seen.set(u.id, (seen.get(u.id) ?? 0) + 1);
      if (page.next === null) break;
      after = page.next;
    }
    const missing = [...finished].filter((id) => !seen.has(id));
    const shownHidden = [...hidden].filter((id) => seen.has(id));
    const twice = [...seen].filter(([, n]) => n > 1).length;
    console.log(`seed ${seedNo}: ${pages} pages, ${seen.size} shown, ${twice} shown twice`);
    expect(missing).toEqual([]);
    expect(shownHidden).toEqual([]);
  });
}
