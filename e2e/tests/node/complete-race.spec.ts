// The race of a `DELETE /api/uploads/:id` with a `complete` whose multipart
// complete already succeeded (round 2C, found by a verifier). On the
// in-memory strict bucket, step by step as the two requests run in
// packages/worker/src/index.ts: complete reads the pending sidecar
// (readMetaVersion()), R2 completes the multipart upload (the file object
// appears), and complete writes the finished sidecar (finishUpload());
// the DELETE (Uploads.delete()) lands in between.
//
// Before the fix complete wrote its sidecar unconditionally: with at most
// DELETE_LIMIT objects the DELETE removed everything, the file included,
// and the write left a sidecar without its file (listed until it expired,
// its download a 404); with more, it overwrote the DELETE's marker and
// brought the upload back whole.

import {
  DELETE_LIMIT,
  DELETED_UPLOAD_ID,
  MAX_UNSIZED_PARTS,
  Uploads,
  summarize,
  type UploadMeta,
} from "../../../packages/worker/src/uploads.js";
import {
  api,
  deleteUpload,
  expect,
  readUploadMeta,
  startUpload,
  test,
  uploadObjects,
} from "../../lib/index.js";
import { StrictBucket } from "../../lib/strict-r2.js";

const P = "uploads";
const DAY = 86_400_000;

/** A pending upload as POST /api/uploads leaves it, plus `parts` part records (size unknown). */
function seedPending(b: StrictBucket, id: string, parts = 0): UploadMeta {
  const meta: UploadMeta = {
    filename: "f.bin",
    ...(parts === 0 ? { file_size: 1 } : {}),
    uploaded_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 30 * DAY).toISOString(),
    pending_upload_id: `mp-${id}`,
  };
  b.seed(`${P}/${id}/.meta.json`, JSON.stringify(meta), {
    summary: JSON.stringify(summarize(meta)),
  });
  for (let n = 1; n <= parts; n++) b.seed(`${P}/${id}/.parts/${n}`, "", { size: "5" });
  return meta;
}

/** What R2's multipart complete leaves: the file object. */
function completeMultipart(b: StrictBucket, id: string): void {
  b.seed(`${P}/${id}/f.bin`, "x");
}

/** DELETE /api/uploads/:id as index.ts runs it. */
async function deleteRequest(b: StrictBucket, id: string) {
  const uploads = new Uploads(b, P);
  return uploads.delete(id, await uploads.readMeta(id).catch(() => null));
}

async function listed(b: StrictBucket): Promise<string[]> {
  return (await new Uploads(b, P).listPage()).uploads.map((upload) => upload.id);
}

function sidecar(b: StrictBucket, id: string): UploadMeta | null {
  const object = b.objects.get(`${P}/${id}/.meta.json`);
  return object ? (JSON.parse(object.body) as UploadMeta) : null;
}

test.describe("complete racing a DELETE", () => {
  test(`at most ${DELETE_LIMIT} objects: a DELETE between R2's complete and the sidecar write leaves nothing`, async () => {
    const b = new StrictBucket({ maxCalls: Infinity });
    seedPending(b, "r1");
    const uploads = new Uploads(b, P);
    const read = (await uploads.readMetaVersion("r1"))!;
    completeMultipart(b, "r1");

    const del = await deleteRequest(b, "r1");
    expect(del).toMatchObject({ found: true, done: true });
    expect(b.sorted(`${P}/r1/`)).toEqual([]);

    // Before the fix a sidecar without its file was back, and listed.
    const outcome = await uploads.finishUpload("r1", read.meta, read.etag, 1);
    expect(b.sorted(`${P}/r1/`)).toEqual([]);
    expect(await listed(b)).not.toContain("r1");
    expect(outcome).toBe("deleted");
  });

  test(`more than ${DELETE_LIMIT} objects: complete never overwrites the DELETE's marker`, async () => {
    // Size unknown, MAX_UNSIZED_PARTS part records (the most a complete
    // accepts; with the sidecar and the file more than DELETE_LIMIT
    // objects): the DELETE lists 100 keys, deletes them and marks the
    // sidecar as a deletion under way (202).
    expect(MAX_UNSIZED_PARTS + 2).toBeGreaterThan(DELETE_LIMIT);
    const b = new StrictBucket({ maxCalls: Infinity });
    seedPending(b, "r2", MAX_UNSIZED_PARTS);
    const uploads = new Uploads(b, P);
    const read = (await uploads.readMetaVersion("r2"))!;
    completeMultipart(b, "r2");

    const del = await deleteRequest(b, "r2");
    expect(del).toMatchObject({ found: true, done: false });
    expect(sidecar(b, "r2")?.pending_upload_id).toBe(DELETED_UPLOAD_ID);

    // Before the fix the marker was overwritten and the upload listed again.
    const outcome = await uploads.finishUpload("r2", read.meta, read.etag, 1);
    expect(sidecar(b, "r2")?.pending_upload_id).toBe(DELETED_UPLOAD_ID);
    expect(await listed(b)).not.toContain("r2");
    expect(outcome).toBe("deleted");
    // The file R2 made is gone too; the marker and the records left go with
    // the next DELETE or the cron (the marker is expired).
    expect(b.objects.has(`${P}/r2/f.bin`)).toBe(false);
    for (let i = 0; i < 5 && b.sorted(`${P}/r2/`).length > 0; i++) await deleteRequest(b, "r2");
    expect(b.sorted(`${P}/r2/`)).toEqual([]);
  });

  test("a sidecar deleted before R2's object was listed: the file is not left without one", async () => {
    // The DELETE removed the sidecar but never saw the file: complete must
    // not leave a file that no sidecar points to (nothing would clean it up).
    const b = new StrictBucket({ maxCalls: Infinity });
    seedPending(b, "r3");
    const uploads = new Uploads(b, P);
    const read = (await uploads.readMetaVersion("r3"))!;
    await deleteRequest(b, "r3");
    completeMultipart(b, "r3");

    const outcome = await uploads.finishUpload("r3", read.meta, read.etag, 1);
    expect(b.sorted(`${P}/r3/`)).toEqual([]);
    expect(outcome).toBe("deleted");
  });

  test("a DELETE after the sidecar write deletes the finished upload as usual", async () => {
    for (const parts of [0, MAX_UNSIZED_PARTS]) {
      const b = new StrictBucket({ maxCalls: Infinity });
      seedPending(b, "r4", parts);
      const uploads = new Uploads(b, P);
      const read = (await uploads.readMetaVersion("r4"))!;
      completeMultipart(b, "r4");
      expect(await uploads.finishUpload("r4", read.meta, read.etag, 1)).toBe("finished");
      expect(await listed(b)).toContain("r4");

      await deleteRequest(b, "r4");
      expect(await listed(b), `parts ${parts}`).not.toContain("r4");
    }
  });

  test("two completes of one upload: the second finds it finished, not deleted", async () => {
    const b = new StrictBucket({ maxCalls: Infinity });
    seedPending(b, "r5");
    const uploads = new Uploads(b, P);
    const first = (await uploads.readMetaVersion("r5"))!;
    const second = (await uploads.readMetaVersion("r5"))!;
    completeMultipart(b, "r5");
    expect(await uploads.finishUpload("r5", first.meta, first.etag, 1)).toBe("finished");
    expect(await uploads.finishUpload("r5", second.meta, second.etag, 1)).toBe("finished");
    expect(b.sorted(`${P}/r5/`)).toEqual([`${P}/r5/.meta.json`, `${P}/r5/f.bin`]);
    expect(sidecar(b, "r5")).toMatchObject({ filename: "f.bin", file_size: 1 });
    expect(sidecar(b, "r5")?.pending_upload_id).toBeUndefined();
    expect(await listed(b)).toEqual(["r5"]);
  });

  test("without a DELETE: one conditional write, no extra R2 call", async () => {
    const b = new StrictBucket({ maxCalls: Infinity });
    seedPending(b, "r6");
    const uploads = new Uploads(b, P);
    const read = (await uploads.readMetaVersion("r6"))!;
    completeMultipart(b, "r6");
    b.reset();
    expect(await uploads.finishUpload("r6", read.meta, read.etag, 1)).toBe("finished");
    expect(b.calls).toEqual({ put: 1 });
  });
});

function sendComplete(id: string, etag: string): Promise<Response> {
  return api(`/api/uploads/${id}/complete`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ parts: [{ part_number: 1, etag }], size: 3 }),
  });
}

/** A 3-byte upload with its one part sent, ready to complete. */
async function oneUploadedPart(filename: string): Promise<{ id: string; etag: string }> {
  const id = await startUpload({ filename, size: 3 });
  const res = await api(`/api/uploads/${id}/parts/1`, { method: "PUT", body: "abc" });
  expect(res.status).toBe(200);
  const { etag } = (await res.json()) as { etag: string };
  return { id, etag };
}

// The same race over HTTP, on `wrangler dev`: the harness cannot time a
// DELETE into the window between R2's complete and the sidecar write, so
// this sends both at once many times and checks that every outcome is
// whole: either a finished upload with its file, or nothing at all; never
// a sidecar without its file, or a file without its sidecar.
test.describe("complete and DELETE at once, on wrangler dev", () => {
  test("every outcome is whole", async () => {
    test.setTimeout(120_000);
    const TRIALS = 40;
    const outcomes: Record<string, number> = {};
    const broken: string[] = [];
    const trial = async (i: number) => {
      const filename = `race ${i}.bin`;
      const { id, etag } = await oneUploadedPart(filename);
      const [completed, deleted] = await Promise.all([sendComplete(id, etag), deleteUpload(id)]);
      const keys = (await uploadObjects(id)).map((o) => o.key.split("/").slice(2).join("/"));
      const meta = await readUploadMeta(id);
      const whole =
        keys.length === 0 ||
        (keys.length === 2 && keys.includes(filename) && !!meta && !meta.pending_upload_id);
      const outcome =
        `complete ${completed.status}, delete ${deleted.status}, ` +
        (keys.length ? "kept" : "gone");
      outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
      if (!whole) broken.push(`${id}: ${outcome}, keys ${JSON.stringify(keys)}`);
      if (keys.length) await deleteUpload(id);
    };
    for (let i = 0; i < TRIALS; i += 4) await Promise.all([0, 1, 2, 3].map((k) => trial(i + k)));
    console.log(`complete + DELETE x${TRIALS}: ${JSON.stringify(outcomes)}`);
    expect(broken).toEqual([]);
  });

  test("a complete sent again after it succeeded answers with the same link", async () => {
    // The page retries a complete whose answer was lost; by then the upload
    // is finished, which is no reason for an error.
    const { id, etag } = await oneUploadedPart("twice.bin");
    const first = await sendComplete(id, etag);
    expect(first.status).toBe(200);
    const second = await sendComplete(id, etag);
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual(await first.json());
    expect((await deleteUpload(id)).status).toBe(200);
    // A deleted upload is still none.
    expect((await sendComplete(id, etag)).status).toBe(404);
  });
});
