import { randomBytes } from "node:crypto";
import {
  deleteUpload,
  downloadBytes,
  eventually,
  expect,
  listUploads,
  server,
  startUpload,
  submitDownloadForm,
  test,
  uploadObjects,
  uploadViaApi,
} from "../../lib/index.js";

test.describe("download form", () => {
  test("a protected upload: no or wrong password → 401, right one → 303", async () => {
    const data = randomBytes(2048);
    const { url } = await uploadViaApi({ filename: "locked.bin", data, password: "s3cret" });

    const missing = await submitDownloadForm(url);
    expect(missing.status, "no password field").toBe(401);
    expect(missing.headers.get("location")).toBeNull();
    expect(await missing.text()).toContain("Incorrect password");

    const empty = await submitDownloadForm(url, "");
    expect(empty.status, "empty password").toBe(401);

    const wrong = await submitDownloadForm(url, "S3cret");
    expect(wrong.status, "wrong password").toBe(401);
    expect(wrong.headers.get("location")).toBeNull();

    const right = await submitDownloadForm(url, "s3cret");
    expect(right.status, "right password").toBe(303);
    expect(right.headers.get("location")).toMatch(/^\/_dl\/[A-Za-z0-9_-]+\?expires=\d+&sig=/);
    expect((await downloadBytes(url, "s3cret")).equals(data)).toBe(true);
  });

  test("an unprotected upload redirects without a password", async () => {
    const { url } = await uploadViaApi({ filename: "open.bin", data: randomBytes(16) });
    expect((await submitDownloadForm(url)).status).toBe(303);
  });

  test("a download is recorded in GET /api/uploads", async () => {
    const { id, url } = await uploadViaApi({ filename: "counted.bin", data: randomBytes(1024) });
    const count = async () => (await listUploads()).find((u) => u.id === id)?.download_count;
    expect(await count()).toBe(0);

    await downloadBytes(url);
    // Recorded in waitUntil(), after the redirect has been sent.
    await eventually(async () => (await count()) === 1, { message: "download_count 1" });
    const upload = (await listUploads()).find((u) => u.id === id)!;
    expect(upload.recent_downloads).toHaveLength(1);
  });
});

test.describe("DELETE /api/uploads/:id", () => {
  test("removes every object of a finished upload", async () => {
    const { id, url } = await uploadViaApi({ filename: "doomed.bin", data: randomBytes(4096) });
    expect(await uploadObjects(id)).toHaveLength(2);

    const res = await deleteUpload(id);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: id });

    await eventually(async () => (await uploadObjects(id)).length === 0, {
      message: `uploads/${id}/ to be empty`,
    });
    expect((await fetch(url)).status).toBe(404);
    expect((await deleteUpload(id)).status).toBe(404);
  });
});

test.describe("pending uploads", () => {
  test("are not listed and have no download page until completed", async () => {
    const id = await startUpload({ filename: "in-progress.bin", size: 10 });

    expect((await uploadObjects(id)).map((o) => o.key)).toEqual([`uploads/${id}/.meta.json`]);
    expect((await listUploads()).map((u) => u.id)).not.toContain(id);
    const pageUrl = `${server.baseURL}/${id}/in-progress.bin`;
    expect((await fetch(pageUrl)).status).toBe(404);
    expect((await submitDownloadForm(pageUrl)).status).toBe(404);

    expect((await deleteUpload(id)).status).toBe(200);
  });
});
