import { randomBytes } from "node:crypto";
import {
  deleteUpload,
  downloadBytes,
  eventually,
  exclusive,
  expect,
  forgeDownloadUrl,
  listUploads,
  putObject,
  randomId,
  readUploadMeta,
  seedLegacyUpload,
  server,
  signedDownloadUrl,
  sleep,
  startUpload,
  submitDownloadForm,
  test,
  triggerCron,
  uploadObjects,
  uploadViaApi,
  writeUploadMeta,
} from "../../lib/index.js";

// Every test here holds the run-wide "cron" lock: the cleanup deletes every
// expired upload, so a cron triggered by one test would remove another test's
// expired upload before that test checks it is still there.

const gone = (id: string) => async () => (await uploadObjects(id)).length === 0;

/** Wait until an upload's expires_at has passed (plus a margin). */
async function waitUntilExpired(id: string): Promise<void> {
  const meta = await readUploadMeta(id);
  if (!meta) throw new Error(`No metadata for ${id}`);
  await sleep(Math.max(0, Date.parse(meta.expires_at) - Date.now()) + 300);
}

/** An already expired legacy upload, used to see that a cron run has finished. */
function expiredControl(): Promise<{ id: string }> {
  return seedLegacyUpload({
    filename: "expired-control.txt",
    data: Buffer.from("control\n"),
    meta: { expires_at: new Date(Date.now() - 60_000).toISOString() },
  });
}

test.describe("expiry at request time (no cron)", () => {
  test("an expired upload is refused by /_dl, the page and the form", () =>
    exclusive("cron", async () => {
      const data = randomBytes(1024);
      const forDl = await uploadViaApi({ filename: "a.bin", data, expiresInSeconds: 3 });
      const forPage = await uploadViaApi({ filename: "b.bin", data, expiresInSeconds: 3 });
      const forForm = await uploadViaApi({ filename: "c.bin", data, expiresInSeconds: 3 });

      // Links obtained while the file is still valid.
      const handedOut = await signedDownloadUrl(forDl.url);
      expect((await fetch(handedOut)).status).toBe(200);
      // The server clamps a link's lifetime to the file's; this one claims an
      // hour, so only the file's own expiry check can stop it.
      const longLived = forgeDownloadUrl(forDl.id, Math.floor(Date.now() / 1000) + 3600);
      expect(
        (await fetch(longLived)).status,
        "forgeDownloadUrl() is out of sync with signDownload() in packages/worker/src/crypto.ts",
      ).toBe(200);

      await waitUntilExpired(forForm.id);
      // Still in the bucket: what follows is the request-time check, not cleanup.
      // (forDl also has a download record, `.downloads/…`.)
      for (const { id } of [forDl, forPage, forForm]) {
        const keys = (await uploadObjects(id)).map((o) => o.key);
        expect(keys.filter((key) => !key.includes("/.downloads/"))).toHaveLength(2);
      }

      // /_dl does not delete anything, so check it first.
      expect((await fetch(longLived)).status, "valid signature, expired file").toBe(404);
      expect((await fetch(handedOut)).status, "link clamped to the file's expiry").toBe(403);

      // Page and form each delete the expired upload on the way, so one upload each.
      expect((await fetch(forPage.url)).status, "download page").toBe(404);
      expect((await submitDownloadForm(forForm.url)).status, "download form").toBe(404);

      // ...and that lazy deletion removes all of their objects.
      await eventually(gone(forPage.id), { message: "expired upload deleted by its page" });
      await eventually(gone(forForm.id), { message: "expired upload deleted by its form" });
      expect((await deleteUpload(forDl.id)).status).toBe(200);
    }));
});

test.describe("daily cleanup (cron)", () => {
  test("removes an upload once it has expired", () =>
    exclusive("cron", async () => {
      const { id, url } = await uploadViaApi({
        filename: "short-lived.bin",
        data: randomBytes(4096),
        expiresInSeconds: 2,
      });
      expect((await uploadObjects(id)).map((o) => o.key).sort()).toEqual([
        `uploads/${id}/.meta.json`,
        `uploads/${id}/short-lived.bin`,
      ]);

      await waitUntilExpired(id);
      // Expired but untouched: still in the bucket until the cleanup runs. (Do not
      // open the page here: that deletes expired uploads on its own.)
      expect(await uploadObjects(id)).toHaveLength(2);

      await triggerCron();
      await eventually(gone(id), { message: `cleanup to delete uploads/${id}/` });
      expect((await listUploads()).map((u) => u.id)).not.toContain(id);
      expect((await fetch(url)).status).toBe(404);
    }));

  test("removes the download records of an expired upload, and stray ones", () =>
    exclusive("cron", async () => {
      const { id, url } = await uploadViaApi({
        filename: "downloaded.bin",
        data: randomBytes(256),
        expiresInSeconds: 3,
      });
      for (let i = 0; i < 2; i++) expect((await submitDownloadForm(url)).status).toBe(303);
      await eventually(
        async () => (await listUploads()).find((u) => u.id === id)?.download_count === 2,
        { message: "download_count 2" },
      );

      // Download records without an upload, as a download racing a delete can leave.
      const stray = randomId();
      const strayKey = `uploads/${stray}/.downloads/${new Date().toISOString()}_0a1b2c3d`;
      await putObject(strayKey, "");
      expect((await listUploads()).map((u) => u.id)).not.toContain(stray);

      await waitUntilExpired(id);
      await triggerCron();
      await eventually(gone(id), { message: `cleanup to delete uploads/${id}/` });
      await eventually(gone(stray), { message: `cleanup to delete stray uploads/${stray}/` });
    }));

  test("removes an expired legacy upload that has no custom metadata", () =>
    exclusive("cron", async () => {
      const { id } = await expiredControl();
      expect(await uploadObjects(id)).toHaveLength(2);

      await triggerCron();
      await eventually(gone(id), { message: `cleanup to delete legacy uploads/${id}/` });
    }));

  test("removes uploads left pending for over 24 hours, keeps recent ones", () =>
    exclusive("cron", async () => {
      const abandonedAt = new Date(Date.now() - 25 * 3600_000).toISOString();
      const inAWeek = new Date(Date.now() + 7 * 86400_000).toISOString();

      // Real multipart uploads, backdated: one with the summary custom metadata
      // the Worker writes, one without (as an older sidecar would be).
      const abandoned: string[] = [];
      for (const withSummary of [true, false]) {
        const id = await startUpload({ filename: "abandoned.bin", size: 100 });
        const meta = (await readUploadMeta(id))!;
        expect(meta.pending_upload_id).toBeTruthy();
        await writeUploadMeta(
          id,
          { ...meta, uploaded_at: abandonedAt, expires_at: inAWeek },
          { withSummary },
        );
        abandoned.push(id);
      }
      const recent = await startUpload({ filename: "still-uploading.bin", size: 100 });

      for (const id of [...abandoned, recent]) {
        expect((await listUploads()).map((u) => u.id)).not.toContain(id);
        expect((await fetch(`${server.baseURL}/${id}/abandoned.bin`)).status).toBe(404);
      }

      await triggerCron();
      for (const id of abandoned) {
        await eventually(gone(id), { message: `cleanup to delete abandoned uploads/${id}/` });
      }
      // The same run kept the upload that is still in progress.
      expect(await uploadObjects(recent)).toHaveLength(1);
      expect((await deleteUpload(recent)).status).toBe(200);
    }));

  test("keeps a valid legacy (rclone-style) upload, which still downloads", () =>
    exclusive("cron", async () => {
      const data = randomBytes(64 * 1024);
      const { id, url } = await seedLegacyUpload({ filename: "legacy upload.bin", data });
      const control = await expiredControl();

      // Seeded like rclone does: no R2 custom metadata on either object.
      const objects = await uploadObjects(id);
      expect(objects).toHaveLength(2);
      for (const object of objects) expect(object.custom_metadata).toEqual({});

      await triggerCron();
      // Once the expired control is gone, this cleanup run has done its deleting.
      await eventually(gone(control.id), { message: "the cron run to remove the control" });
      expect(await uploadObjects(id)).toHaveLength(2);

      const listed = (await listUploads()).find((u) => u.id === id);
      expect(listed).toMatchObject({ filename: "legacy upload.bin", file_size: data.length, url });

      const page = await fetch(url);
      expect(page.status).toBe(200);
      expect(await page.text()).toContain("legacy upload.bin");
      expect((await downloadBytes(url)).equals(data)).toBe(true);
    }));
});
