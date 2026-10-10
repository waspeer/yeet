import { CLEANUP_LIST_LIMIT, runCleanup } from "../../../packages/worker/src/cleanup.js";
import {
  DELETE_LIMIT,
  DELETED_UPLOAD_ID,
  isUploading,
  PAGE_LIMIT,
  summarize,
  Uploads,
  type UploadMeta,
} from "../../../packages/worker/src/uploads.js";
import { expect, test } from "../../lib/index.js";
import { REAL_R2_CAPS, StrictBucket } from "../../lib/strict-r2.js";

// Regressions found in round 1L, and the per-request bound of a DELETE.

const P = "uploads";
const NOW = Date.UTC(2026, 9, 8, 3);
const DAY = 86_400_000;

const meta = (filename: string): UploadMeta => ({
  filename,
  file_size: 3,
  uploaded_at: new Date(NOW - DAY).toISOString(),
  expires_at: new Date(NOW + DAY).toISOString(),
});

/** Every page of GET /api/uploads from the start: the IDs shown, in page order. */
async function walk(b: StrictBucket): Promise<string[]> {
  const uploads = new Uploads(b, P);
  const seen: string[] = [];
  let after: string | undefined;
  for (let page = 0; page < 100; page++) {
    const result = await uploads.listPage(after);
    seen.push(...result.uploads.map((u) => u.id));
    if (result.next === null) return seen;
    after = result.next;
  }
  throw new Error("more than 100 pages");
}

test("a page whose jump R2 answers with only the sidecar still shows an upload of yeet < 0.2", async () => {
  // Found by the random short pages of r2-work-bounds.spec.ts (seed 2) once
  // the jump got its own, smaller limit: the first upload of a page has
  // more legacy records than the page lists, the jump over them returns
  // only its sidecar (a short page, as R2 may return), and that sidecar has
  // no summary. The page returned the upload "unread" so that the next
  // page would get past it, and so left it out: skipped for the whole walk.
  // Its sidecar was listed and its read fits in the page's reads.
  const b = new StrictBucket({ maxCalls: Infinity, metadataCap: 415 });
  b.seed(`${P}/a/a.bin`, "abc");
  b.seed(`${P}/a/.meta.json`, JSON.stringify(meta("a.bin"))); // no summary
  for (let i = 0; i < PAGE_LIMIT + 20; i++) {
    b.seed(`${P}/a/.downloads/2026-06-01T00:00:00.${String(i).padStart(6, "0")}Z_x`);
  }
  const later = meta("b.bin");
  b.seed(`${P}/b/b.bin`, "abc");
  b.seed(`${P}/b/.meta.json`, JSON.stringify(later), { summary: JSON.stringify(summarize(later)) });
  // The jump (startAfter …/~) returns one object, truncated.
  const list = b.list.bind(b);
  b.list = async (options) => {
    if (options.startAfter?.endsWith("/~")) return list({ ...options, limit: 1 });
    return list(options);
  };
  expect(await walk(b)).toEqual(["a", "b"]);
});

// ---------------------------------------------------------------------------
// Round 1L: DELETE /api/uploads/:id (Uploads.delete()) is bounded per request.

/** A pending upload of unknown size with `parts` part records, as `PUT` leaves them. */
function seedPartRecords(b: StrictBucket, id: string, parts: number): UploadMeta {
  const meta: UploadMeta = {
    filename: "big.bin",
    uploaded_at: new Date(NOW - 1000).toISOString(),
    expires_at: new Date(NOW + DAY).toISOString(),
    pending_upload_id: `mp-${id}`,
  };
  b.seed(`${P}/${id}/.meta.json`, JSON.stringify(meta), {
    summary: JSON.stringify(summarize(meta)),
  });
  for (let n = 1; n <= parts; n++) b.seed(`${P}/${id}/.parts/${n}`, "", { size: "5" });
  return meta;
}

test(`DELETE of an upload with 2,000 part records: at most ${DELETE_LIMIT} objects a request, gone for users at once, all deleted`, async () => {
  // Before round 1L one request listed and deleted every key (2,001 here,
  // and up to about 10,000 part records a client can leave): unbounded CPU.
  const b = new StrictBucket({ ...REAL_R2_CAPS, maxCalls: Infinity });
  const parts = 2000;
  const meta = seedPartRecords(b, "big", parts);
  const other: UploadMeta = { ...meta, file_size: 1 };
  delete other.pending_upload_id;
  b.seed(`${P}/other/o.bin`, "x");
  b.seed(`${P}/other/.meta.json`, JSON.stringify(other), {
    summary: JSON.stringify(summarize(other)),
  });
  const uploads = new Uploads(b, P);
  const sidecar = `${P}/big/.meta.json`;
  let requests = 0;
  for (;;) {
    requests++;
    const read = await uploads.readMeta("big");
    b.reset();
    const result = await uploads.delete("big", read);
    // The per-request bound: one list call of at most DELETE_LIMIT objects
    // (without metadata), one delete of them, and the sidecar's delete or
    // rewrite; the multipart abort on the first request only.
    expect(b.calls.list ?? 0, `request ${requests}`).toBe(1);
    expect(b.listed, `request ${requests}`).toBeLessThanOrEqual(DELETE_LIMIT);
    expect(b.calls.delete ?? 0, `request ${requests}`).toBeLessThanOrEqual(2);
    expect(b.total, `request ${requests}`).toBeLessThanOrEqual(requests === 1 ? 4 : 3);
    expect(b.calls.abort ?? 0).toBe(requests === 1 ? 1 : 0);
    expect(result.found).toBe(true);
    if (result.done) break;
    // Never keys without their sidecar; and the sidecar now says "being
    // deleted": pending and expired, so not listed and cleaned up by the cron.
    expect(b.objects.has(sidecar), `request ${requests}`).toBe(true);
    const deletion = JSON.parse(b.objects.get(sidecar)!.body) as UploadMeta;
    expect(deletion.pending_upload_id).toBe(DELETED_UPLOAD_ID);
    expect(new Date(deletion.expires_at).getTime()).toBeLessThanOrEqual(Date.now());
    expect((await uploads.listPage()).uploads.map((u) => u.id)).toEqual(["other"]);
    expect(requests).toBeLessThan(100);
  }
  // Each request lists the sidecar (`.meta.json` sorts before `.parts/`)
  // and DELETE_LIMIT - 1 records; the last one the rest and the sidecar.
  expect(requests).toBe(Math.ceil(parts / (DELETE_LIMIT - 1)));
  expect(b.sorted(`${P}/big/`)).toEqual([]);
  expect(b.sorted(`${P}/other/`)).toHaveLength(2);
  // Gone: the next request finds nothing (404).
  expect(await uploads.delete("big", null)).toEqual({ found: false, done: true, deleted: 0 });
});

test("an upload left half-deleted by a single DELETE (an old CLI) is finished by the cron", async () => {
  const b = new StrictBucket({ maxCalls: Infinity });
  const meta = seedPartRecords(b, "big", 2000);
  const uploads = new Uploads(b, P);
  expect(await uploads.delete("big", meta)).toMatchObject({ found: true, done: false });
  expect(b.aborted).toEqual(["mp-big"]);
  let runs = 0;
  while (b.sorted(`${P}/big/`).length > 0 && runs < 100) {
    runs++;
    b.reset();
    b.maxCalls = 45;
    await runCleanup(b, P, Date.now() + 1000);
  }
  expect(b.sorted(`${P}/big/`)).toEqual([]);
  // About one run per CLEANUP_LIST_LIMIT records.
  expect(runs).toBeLessThanOrEqual(Math.ceil(2000 / CLEANUP_LIST_LIMIT) + 2);
  // The "deleted" marker is never taken for a multipart upload to abort.
  expect(b.aborted).toEqual(["mp-big"]);
});

test("a deletion under way is no upload: no download counted, no part or complete", async () => {
  const b = new StrictBucket({ maxCalls: Infinity });
  const meta = seedPartRecords(b, "big", 500);
  const uploads = new Uploads(b, P);
  await uploads.delete("big", meta);
  const now = await uploads.readMeta("big");
  expect(now?.pending_upload_id).toBe(DELETED_UPLOAD_ID);
  expect(isUploading(now)).toBe(false); // PUT part and complete answer 404
  expect(isUploading(meta)).toBe(true);
  expect(await uploads.recordDownload("big", new Date().toISOString())).toBe(false);
});
