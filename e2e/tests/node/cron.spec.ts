import { randomBytes } from "node:crypto";
import {
  downloadBytes,
  eventually,
  expect,
  listUploads,
  seedLegacyUpload,
  sleep,
  test,
  triggerCron,
  uploadObjects,
  uploadViaApi,
} from "../../lib/index.js";

test.describe("daily cleanup (cron)", () => {
  // One at a time: a cron triggered by one test would clean up another test's
  // expired upload before it checks that the upload is still there.
  // Cron is only triggered in this file.
  test.describe.configure({ mode: "default" });

  test("removes an upload once it has expired", async () => {
    const { id, url } = await uploadViaApi({
      filename: "short-lived.bin",
      data: randomBytes(4096),
      expiresInSeconds: 2,
    });
    expect((await uploadObjects(id)).map((o) => o.key).sort()).toEqual([
      `uploads/${id}/.meta.json`,
      `uploads/${id}/short-lived.bin`,
    ]);

    await sleep(2500);
    // Expired but untouched: still in the bucket until the cleanup runs. (Do not
    // open the page here: that deletes expired uploads on its own.)
    expect(await uploadObjects(id)).toHaveLength(2);

    await triggerCron();
    await eventually(async () => (await uploadObjects(id)).length === 0, {
      message: `cleanup to delete uploads/${id}/`,
    });
    expect((await listUploads()).map((u) => u.id)).not.toContain(id);
    expect((await fetch(url)).status).toBe(404);
  });

  test("removes an expired legacy upload that has no custom metadata", async () => {
    const { id } = await seedLegacyUpload({
      filename: "old-and-expired.txt",
      data: Buffer.from("expired legacy file\n"),
      meta: { expires_at: new Date(Date.now() - 60_000).toISOString() },
    });
    expect(await uploadObjects(id)).toHaveLength(2);

    await triggerCron();
    await eventually(async () => (await uploadObjects(id)).length === 0, {
      message: `cleanup to delete legacy uploads/${id}/`,
    });
  });

  test("keeps a valid legacy (rclone-style) upload, which still downloads", async () => {
    const data = randomBytes(64 * 1024);
    const { id, url } = await seedLegacyUpload({ filename: "legacy upload.bin", data });

    // Seeded like rclone does: no R2 custom metadata on either object.
    const objects = await uploadObjects(id);
    expect(objects).toHaveLength(2);
    for (const object of objects) expect(object.custom_metadata).toEqual({});

    await triggerCron();
    // Give the cleanup time to (wrongly) act, then check nothing was removed.
    await sleep(1000);
    expect(await uploadObjects(id)).toHaveLength(2);

    const listed = (await listUploads()).find((u) => u.id === id);
    expect(listed).toMatchObject({ filename: "legacy upload.bin", file_size: data.length, url });

    const page = await fetch(url);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("legacy upload.bin");
    expect((await downloadBytes(url)).equals(data)).toBe(true);
  });
});
