import { randomBytes } from "node:crypto";
import {
  clientIp,
  deleteUpload,
  downloadBytes,
  eventually,
  expect,
  listUploads,
  readUploadMeta,
  server,
  sleep,
  startUpload,
  submitDownloadForm,
  test,
  uploadObjects,
  uploadViaApi,
  writeUploadMeta,
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

test.describe("download count", () => {
  const listed = async (id: string) => (await listUploads()).find((u) => u.id === id);

  test("10 downloads at once are all counted, and delete removes their records", async () => {
    const started = new Date().toISOString();
    const { id, url } = await uploadViaApi({ filename: "popular.bin", data: randomBytes(512) });

    const responses = await Promise.all(
      Array.from({ length: 10 }, () => submitDownloadForm(url, undefined, { ip: clientIp() })),
    );
    expect(responses.map((res) => res.status)).toEqual(Array(10).fill(303));

    // Recorded in waitUntil(), after the redirects have been sent.
    await eventually(async () => (await listed(id))?.download_count === 10, {
      message: "download_count 10",
    });
    await sleep(500); // and no more than that
    const upload = (await listed(id))!;
    expect(upload.download_count).toBe(10);
    expect(upload.recent_downloads).toHaveLength(5);
    for (const at of upload.recent_downloads) {
      expect(at >= started && at <= new Date().toISOString(), at).toBe(true);
    }
    expect([...upload.recent_downloads].sort()).toEqual(upload.recent_downloads);

    expect((await deleteUpload(id)).status).toBe(200);
    await eventually(async () => (await uploadObjects(id)).length === 0, {
      message: `uploads/${id}/ to be empty, download records included`,
    });
    expect(await listed(id)).toBeUndefined();
  });

  test("downloads recorded in an older sidecar still count, without the old cap of 50", async () => {
    const old = Array.from({ length: 50 }, (_, i) => ({
      at: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
    }));
    // Both kinds of older sidecars: with the summary custom metadata and without.
    for (const withSummary of [true, false]) {
      const { id, url } = await uploadViaApi({ filename: "veteran.bin", data: randomBytes(64) });
      const meta = (await readUploadMeta(id))!;
      await writeUploadMeta(id, { ...meta, downloads: old }, { withSummary });
      expect((await listed(id))?.download_count).toBe(50);

      for (let i = 0; i < 3; i++) expect((await submitDownloadForm(url)).status).toBe(303);
      await eventually(async () => (await listed(id))?.download_count === 53, {
        message: "download_count 53",
      });
      const recent = (await listed(id))!.recent_downloads;
      expect(recent.slice(0, 2)).toEqual(old.slice(-2).map((d) => d.at));
      expect(recent.slice(2).every((at) => at > "2026-01-02")).toBe(true);
      // The sidecar itself is no longer rewritten per download.
      expect((await readUploadMeta(id))?.downloads).toEqual(old);
    }
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
