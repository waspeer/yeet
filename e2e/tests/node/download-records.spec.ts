// Legacy download records: the pre-release versions 1D/1E wrote one empty
// object per download (`uploads/<id>/.downloads/<at>_<random>`). Nothing
// writes or counts them any more. A page of the listing jumps over them (one extra
// list call per upload at most), the cron deletes them, and DELETE removes
// them with their upload. (How many R2 calls each takes is counted in
// r2-budget.spec.ts; this checks the same code against wrangler's R2.)
//
// Every test holds the run-wide "cron" lock: a cron run started by another
// test would delete these records while they are being looked at.

import { randomBytes } from "node:crypto";
import {
  deleteUpload,
  eventually,
  exclusive,
  expect,
  listObjects,
  listUploads,
  putObject,
  randomId,
  readUploadMeta,
  seedLegacyUpload,
  server,
  submitDownloadForm,
  test,
  cronUntil,
  uploadObjects,
  uploadViaApi,
  writeUploadMeta,
  type BucketObject,
} from "../../lib/index.js";

function records(objects: BucketObject[]): BucketObject[] {
  return objects.filter((object) => object.key.includes("/.downloads/"));
}

async function recordCount(id: string): Promise<number> {
  return records(await uploadObjects(id)).length;
}

async function listed(id: string) {
  return (await listUploads()).find((upload) => upload.id === id);
}

/** `n` legacy download records written straight into the bucket. */
async function seedRecords(id: string, n: number): Promise<void> {
  const start = Date.UTC(2026, 5, 1);
  const keys = Array.from({ length: n }, (_, i) => {
    const at = new Date(start + i).toISOString();
    return `${server.uploadsPrefix}/${id}/.downloads/${at}_${randomBytes(4).toString("hex")}`;
  });
  for (let i = 0; i < keys.length; i += 50) {
    await Promise.all(keys.slice(i, i + 50).map((key) => putObject(key, "")));
  }
}

test.describe("legacy download records", () => {
  test("are not counted, and the cron deletes them but keeps the upload", () =>
    exclusive("cron", async () => {
      test.setTimeout(120_000);
      // Two uploads with more records than one list page holds, and uploads
      // around them: the listing jumps over the records and still finds every upload.
      const before = await seedLegacyUpload({ filename: "before.bin", data: randomBytes(8) });
      const heavy = await uploadViaApi({ filename: "heavy.bin", data: randomBytes(32) });
      const meta = (await readUploadMeta(heavy.id))!;
      await writeUploadMeta(heavy.id, { ...meta, download_count: 3 });
      await seedRecords(heavy.id, 1200);
      const second = await uploadViaApi({ filename: "second.bin", data: randomBytes(32) });
      await seedRecords(second.id, 700);

      expect((await listed(before.id))?.filename).toBe("before.bin");
      expect((await listed(heavy.id))?.download_count).toBe(3);
      expect((await listed(second.id))?.download_count).toBe(0);

      // New downloads go into the sidecar, next to the old records.
      expect((await submitDownloadForm(heavy.url)).status).toBe(303);
      await eventually(async () => (await listed(heavy.id))?.download_count === 4, {
        message: "download_count 4",
      });
      expect(await recordCount(heavy.id)).toBe(1200);

      // A run deletes at most 300 records (one deleteUnder() round), so
      // 1,200 take a few runs.
      await cronUntil(
        async () => (await recordCount(heavy.id)) === 0 && (await recordCount(second.id)) === 0,
        { message: `the cron to delete the records of ${heavy.id} and ${second.id}` },
      );
      expect((await uploadObjects(heavy.id)).map((o) => o.key).sort()).toEqual([
        `${server.uploadsPrefix}/${heavy.id}/.meta.json`,
        `${server.uploadsPrefix}/${heavy.id}/heavy.bin`,
      ]);
      expect((await listed(heavy.id))?.download_count).toBe(4);
      for (const id of [before.id, heavy.id, second.id]) {
        expect((await deleteUpload(id)).status).toBe(200);
      }
    }));

  test("the cron removes an expired upload with thousands of them, and stray ones", () =>
    exclusive("cron", async () => {
      test.setTimeout(120_000);
      const { id: expired } = await seedLegacyUpload({
        filename: "expired.bin",
        data: randomBytes(32),
        meta: { expires_at: new Date(Date.now() - 60_000).toISOString() },
      });
      await seedRecords(expired, 2100);
      // Records without an upload, as a download racing a delete could leave.
      const stray = randomId();
      await seedRecords(stray, 150);
      expect((await listUploads()).map((u) => u.id)).not.toContain(stray);

      await cronUntil(
        async () =>
          (await uploadObjects(expired)).length === 0 && (await uploadObjects(stray)).length === 0,
        { message: `the cron to delete uploads/${expired}/ and uploads/${stray}/` },
      );
      for (const id of [expired, stray]) {
        expect(await listObjects(`${server.uploadsPrefix}/${id}/`)).toHaveLength(0);
      }
    }));

  test("DELETE removes an upload with thousands of them", () =>
    exclusive("cron", async () => {
      test.setTimeout(120_000);
      const { id } = await uploadViaApi({ filename: "gone.bin", data: randomBytes(32) });
      await seedRecords(id, 2100);
      expect((await deleteUpload(id)).status).toBe(200);
      expect(await uploadObjects(id)).toHaveLength(0);
    }));
});
