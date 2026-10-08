// Download records (`uploads/<id>/.downloads/<at>_<random>`, one per
// download) stay bounded: the daily cron folds them into the sidecar and
// deletes them, at most 1,000 are written per upload between two folds, and
// the listing stops counting an upload's records past 2,000.
//
// Every test holds the run-wide "cron" lock: a cron run started by another
// test would fold these records while they are being counted.

import { randomBytes } from "node:crypto";
import {
  deleteUpload,
  eventually,
  exclusive,
  expect,
  headObject,
  listObjects,
  listUploads,
  putObject,
  readUploadMeta,
  seedLegacyUpload,
  server,
  sleep,
  submitDownloadForm,
  test,
  triggerCron,
  uploadObjects,
  uploadViaApi,
  writeUploadMeta,
  type BucketObject,
} from "../../lib/index.js";

const RECORD_CAP = 1000;
const LISTED_RECORDS_LIMIT = 2000;

function records(objects: BucketObject[]): BucketObject[] {
  return objects.filter((object) => object.key.includes("/.downloads/"));
}

async function recordCount(id: string): Promise<number> {
  return records(await uploadObjects(id)).length;
}

async function listed(id: string) {
  return (await listUploads()).find((upload) => upload.id === id);
}

/** `n` download records written straight into the bucket, a millisecond apart from `start`. */
async function seedRecords(id: string, n: number, start = Date.UTC(2026, 5, 1)): Promise<void> {
  const keys = Array.from({ length: n }, (_, i) => {
    const at = new Date(start + i).toISOString();
    return `${server.uploadsPrefix}/${id}/.downloads/${at}_${randomBytes(4).toString("hex")}`;
  });
  for (let i = 0; i < keys.length; i += 50) {
    await Promise.all(keys.slice(i, i + 50).map((key) => putObject(key, "")));
  }
}

/** The summary in the sidecar's custom metadata. */
async function summaryOf(id: string): Promise<Record<string, unknown>> {
  const sidecar = await headObject(`${server.uploadsPrefix}/${id}/.meta.json`);
  return JSON.parse(sidecar!.custom_metadata["summary"]!) as Record<string, unknown>;
}

/** Download `n` times through the form and wait until the listing shows `total`. */
async function download(id: string, url: string, n: number, total: number): Promise<void> {
  for (let i = 0; i < n; i++) expect((await submitDownloadForm(url)).status).toBe(303);
  await eventually(async () => (await listed(id))?.download_count === total, {
    message: `download_count ${total}`,
  });
}

/** Run the cron and wait until it has folded every record of `id` (none left). */
async function foldAll(id: string): Promise<void> {
  await triggerCron();
  await eventually(async () => (await recordCount(id)) === 0, {
    message: `the cron to fold the download records of ${id}`,
  });
}

test.describe("download records", () => {
  test("the cron folds them into the sidecar; counts survive every run", () =>
    exclusive("cron", async () => {
      const old = Array.from({ length: 7 }, (_, i) => ({
        at: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
      }));
      const cases = [
        { name: "a current upload", legacy: 0, withSummary: true },
        { name: "an old sidecar with a downloads array and summary", legacy: 7, withSummary: true },
        {
          name: "an old sidecar with a downloads array, no summary",
          legacy: 7,
          withSummary: false,
        },
      ];
      for (const { name, legacy, withSummary } of cases) {
        const { id, url } = await uploadViaApi({ filename: "folded.bin", data: randomBytes(64) });
        const meta = (await readUploadMeta(id))!;
        if (legacy) await writeUploadMeta(id, { ...meta, downloads: old }, { withSummary });

        await download(id, url, 2, legacy + 2);
        expect(await recordCount(id), name).toBe(2);
        const before = (await listed(id))!.recent_downloads;

        await foldAll(id);
        const folded = (await readUploadMeta(id))!;
        expect(folded.download_count, name).toBe(legacy + 2);
        expect(folded.downloads, name).toBeUndefined();
        expect(folded.recent_downloads, name).toEqual(before);
        // The summary custom metadata says the same, and the listing is unchanged.
        expect(await summaryOf(id), name).toMatchObject({
          download_count: legacy + 2,
          recent_downloads: before,
        });
        expect((await listed(id))?.download_count, name).toBe(legacy + 2);
        expect((await listed(id))?.recent_downloads, name).toEqual(before);

        // New downloads add to the folded count, before and after the next fold.
        await download(id, url, 1, legacy + 3);
        await foldAll(id);
        expect((await readUploadMeta(id))!.download_count, name).toBe(legacy + 3);
        expect((await listed(id))?.download_count, name).toBe(legacy + 3);
        const recent = (await listed(id))!.recent_downloads;
        expect(recent, name).toHaveLength(Math.min(5, legacy + 3));
        expect([...recent].sort(), name).toEqual(recent);

        expect((await deleteUpload(id)).status).toBe(200);
      }
    }));

  test(`at most ${RECORD_CAP} records are written per upload between two folds`, () =>
    exclusive("cron", async () => {
      const { id, url } = await uploadViaApi({ filename: "popular.bin", data: randomBytes(64) });
      await seedRecords(id, RECORD_CAP);
      expect((await listed(id))?.download_count).toBe(RECORD_CAP);

      // The download itself still works; it is just not recorded.
      expect((await submitDownloadForm(url)).status).toBe(303);
      await sleep(1000); // recording happens in waitUntil()
      expect(await recordCount(id)).toBe(RECORD_CAP);
      expect((await listed(id))?.download_count).toBe(RECORD_CAP);

      // After a fold, downloads are recorded again.
      await foldAll(id);
      expect((await readUploadMeta(id))!.download_count).toBe(RECORD_CAP);
      await download(id, url, 1, RECORD_CAP + 1);
      expect(await recordCount(id)).toBe(1);
      expect((await deleteUpload(id)).status).toBe(200);
    }));

  test(`the listing stops counting past ${LISTED_RECORDS_LIMIT} records of one upload`, () =>
    exclusive("cron", async () => {
      test.setTimeout(120_000);
      const extra = 50;
      const { id: heavy, url } = await seedLegacyUpload({
        filename: "heavy.bin",
        data: randomBytes(32),
      });
      await seedRecords(heavy, LISTED_RECORDS_LIMIT + extra);
      // An upload whose keys come right after the heavy one's: still listed, and right.
      const next = await seedLegacyUpload({
        id: `${heavy}0`,
        filename: "next.bin",
        data: randomBytes(32),
        meta: { downloads: [{ at: "2026-01-01T00:00:00.000Z" }] },
      });

      expect((await listed(heavy))?.download_count).toBe(LISTED_RECORDS_LIMIT);
      expect((await listed(next.id))?.download_count).toBe(1);
      expect((await submitDownloadForm(url)).status).toBe(303); // over the cap: not recorded

      // Each cron run folds what it counted; nothing is lost or counted twice.
      await triggerCron();
      await eventually(async () => (await recordCount(heavy)) === extra, {
        message: "the first cron run to fold 2,000 records",
      });
      expect((await readUploadMeta(heavy))!.download_count).toBe(LISTED_RECORDS_LIMIT);
      expect((await listed(heavy))?.download_count).toBe(LISTED_RECORDS_LIMIT + extra);
      await foldAll(heavy);
      expect((await listed(heavy))?.download_count).toBe(LISTED_RECORDS_LIMIT + extra);
      expect((await listed(next.id))?.download_count).toBe(1);

      for (const id of [heavy, next.id]) expect((await deleteUpload(id)).status).toBe(200);
    }));

  test("delete and the cron remove an upload with thousands of records", () =>
    exclusive("cron", async () => {
      test.setTimeout(120_000);
      const total = LISTED_RECORDS_LIMIT + 100;
      const { id: deleted } = await uploadViaApi({ filename: "gone.bin", data: randomBytes(32) });
      await seedRecords(deleted, total);
      expect((await deleteUpload(deleted)).status).toBe(200);
      expect(await uploadObjects(deleted)).toHaveLength(0);

      const { id: expired } = await seedLegacyUpload({
        filename: "expired.bin",
        data: randomBytes(32),
        meta: { expires_at: new Date(Date.now() - 60_000).toISOString() },
      });
      await seedRecords(expired, total);
      // The first run deletes what it listed; what is left over has no sidecar
      // any more and goes as stray records in the next.
      await triggerCron();
      await eventually(async () => (await uploadObjects(expired)).length < total, {
        message: "the first cron run to delete the expired upload",
      });
      await triggerCron();
      await eventually(async () => (await uploadObjects(expired)).length === 0, {
        message: "the second cron run to delete what was left",
      });
      expect(await listObjects(`${server.uploadsPrefix}/${expired}/`)).toHaveLength(0);
    }));
});
