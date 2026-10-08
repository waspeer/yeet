import { randomBytes } from "node:crypto";
import { api, apiJson, expect, listObjects, putObject, readUploadMeta, server, test } from "../../lib/index.js";

// Round 1H verifier, on wrangler dev: the refused complete of an upload of
// unknown size must not have completed the multipart upload (the existing
// test only checks the sidecar and the records, which a complete before the
// refusal leaves unchanged too).

test("size unknown, too many part records: refused without completing the multipart upload", async () => {
  const { id } = await apiJson<{ id: string }>("/api/uploads", {
    method: "POST",
    body: JSON.stringify({ filename: "refused.bin", expires_in: 3600 }),
  });
  const res1 = await api(`/api/uploads/${id}/parts/1`, { method: "PUT", body: randomBytes(10) });
  expect(res1.status).toBe(200);
  const one = (await res1.json()) as { part_number: number; etag: string };
  const keys = Array.from({ length: 4100 }, (_, i) => `${server.uploadsPrefix}/${id}/.parts/${i + 2}`);
  for (let i = 0; i < keys.length; i += 50) {
    await Promise.all(keys.slice(i, i + 50).map((key) => putObject(key, "", { customMetadata: { size: "10" } })));
  }
  const res = await api(`/api/uploads/${id}/complete`, {
    method: "POST",
    body: JSON.stringify({ parts: [one] }),
    headers: { "Content-Type": "application/json" },
  });
  expect(res.status).toBe(400);
  // No file object: the multipart upload was not completed.
  const dir = `${server.uploadsPrefix}/${id}/`;
  const files = (await listObjects(dir))
    .map((o) => o.key)
    .filter((k) => !k.startsWith(`${dir}.parts/`) && k !== `${dir}.meta.json`);
  expect(files).toEqual([]);
  expect((await readUploadMeta(id))?.pending_upload_id).toBeTruthy();
  expect((await api(`/api/uploads/${id}`, { method: "DELETE" })).status).toBe(200);
});
