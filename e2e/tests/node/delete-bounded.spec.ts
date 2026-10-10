// Round 1L: DELETE /api/uploads/:id deletes at most DELETE_LIMIT objects per
// request (202 with `done: false` while more is left, the upload gone for
// users at once), and `yeet delete` asks again until it is done, up to
// MAX_DELETE_ROUNDS requests. The per-request bound on the bucket is tested
// in r2-regressions-1l.spec.ts; the HTTP side with legacy records in
// download-records.spec.ts.

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { MAX_DELETE_ROUNDS } from "../../../packages/cli/src/limits.js";
import { DELETE_LIMIT } from "../../../packages/worker/src/uploads.js";
import {
  api,
  apiJson,
  cli,
  deleteUpload,
  exclusive,
  expect,
  expectExitCode,
  describeRun,
  listUploads,
  putObject,
  readUploadMeta,
  server,
  test,
  uploadObjects,
} from "../../lib/index.js";

/** A pending upload of unknown size with `n` part records written straight into the bucket. */
async function pendingWithRecords(n: number): Promise<string> {
  const { id } = await apiJson<{ id: string }>("/api/uploads", {
    method: "POST",
    body: JSON.stringify({ filename: "many-parts.bin", expires_in: 3600 }),
  });
  for (let i = 1; i <= n; i += 50) {
    await Promise.all(
      Array.from({ length: Math.min(50, n - i + 1) }, (_, j) =>
        putObject(`${server.uploadsPrefix}/${id}/.parts/${i + j}`, "", {
          customMetadata: { size: "10" },
        }),
      ),
    );
  }
  return id;
}

test.describe("DELETE in bounded requests (wrangler dev)", () => {
  test("one DELETE of a large pending upload: 202, gone for users, nothing accepted any more", () =>
    exclusive("cron", async () => {
      // What an old CLI (one request, any 2xx is success) leaves behind.
      const records = 2 * DELETE_LIMIT + 50;
      const id = await pendingWithRecords(records);
      const res = await deleteUpload(id);
      expect(res.status).toBe(202);
      expect(await res.json()).toEqual({ deleted: id, done: false });
      // DELETE_LIMIT listed, the sidecar (`.meta.json` sorts before
      // `.parts/`) among them and kept.
      expect(await uploadObjects(id)).toHaveLength(records + 1 - (DELETE_LIMIT - 1));
      // Gone for users: not listed, no page, no part or complete accepted.
      expect((await listUploads()).some((upload) => upload.id === id)).toBe(false);
      expect((await fetch(`${server.baseURL}/${id}/many-parts.bin`)).status).toBe(404);
      const part = await api(`/api/uploads/${id}/parts/1`, {
        method: "PUT",
        body: "0123456789",
        headers: { "Content-Type": "application/octet-stream" },
      });
      expect(part.status).toBe(404);
      const complete = await api(`/api/uploads/${id}/complete`, {
        method: "POST",
        body: JSON.stringify({ parts: [{ part_number: 1, etag: "x" }] }),
        headers: { "Content-Type": "application/json" },
      });
      expect(complete.status).toBe(404);
      // The sidecar marks it as a deletion under way, expired, for the cron.
      const meta = await readUploadMeta(id);
      expect(meta?.pending_upload_id).toBe("deleted");
      expect(new Date(meta!.expires_at).getTime()).toBeLessThanOrEqual(Date.now());
      // The rest: the next requests.
      for (let i = 0; i < 10; i++) if ((await deleteUpload(id)).status === 200) break;
      expect(await uploadObjects(id)).toHaveLength(0);
    }));

  test("`yeet delete` deletes a large upload completely, in several requests", () =>
    exclusive("cron", async () => {
      const id = await pendingWithRecords(3 * DELETE_LIMIT + 10);
      const r = await cli(["delete", id], { auth: true });
      expectExitCode(r, 0);
      expect(r.stderr, describeRun(r)).toBe(`Deleted ${id}\n`);
      expect(await uploadObjects(id)).toHaveLength(0);
    }));
});

/** `yeet delete` against a stand-in server answering DELETE with `respond(n)`. */
async function deleteWith(respond: (n: number) => { status: number; body: unknown }) {
  let requests = 0;
  const fake = createServer((req, res) => {
    requests++;
    const { status, body } = respond(requests);
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => fake.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = fake.address() as AddressInfo;
    const r = await cli(["delete", "abc123"], {
      env: { YEET_URL: `http://127.0.0.1:${port}`, YEET_TOKEN: "a-token-of-16-chars-or-more" },
    });
    return { ...r, requests };
  } finally {
    fake.closeAllConnections();
    await new Promise((resolve) => fake.close(resolve));
  }
}

test.describe("`yeet delete` against a stand-in server", () => {
  const more = { status: 202, body: { deleted: "abc123", done: false } };
  const done = { status: 200, body: { deleted: "abc123" } };
  const gone = { status: 404, body: { error: "Not found" } };

  test("asks again while the server says done: false, then stops", async () => {
    const r = await deleteWith((n) => (n < 4 ? more : done));
    expect(r.code).toBe(0);
    expect(r.requests).toBe(4);
    expect(r.stderr).toBe("Deleted abc123\n");
  });

  test(`stops after ${MAX_DELETE_ROUNDS} requests, saying the server finishes the rest`, async () => {
    const r = await deleteWith(() => more);
    expect(r.code).toBe(0);
    expect(r.requests).toBe(MAX_DELETE_ROUNDS);
    expect(r.stderr).toBe(
      "Deleted abc123 (the server removes the rest of its storage in its hourly cleanup)\n",
    );
  });

  test("a 404 after the first request: deleted meanwhile, done", async () => {
    const r = await deleteWith((n) => (n === 1 ? more : gone));
    expect(r.code).toBe(0);
    expect(r.requests).toBe(2);
    expect(r.stderr).toBe("Deleted abc123\n");
  });

  test("an error after the first request: deleted for users, the rest left to the server", async () => {
    const r = await deleteWith((n) =>
      n === 1 ? more : { status: 400, body: { error: "Something else" } },
    );
    expect(r.code).toBe(0);
    expect(r.requests).toBe(2);
    expect(r.stderr).toContain("hourly cleanup");
  });

  test("a 404 on the first request is still an error; an old server's 200 is one request", async () => {
    const missing = await deleteWith(() => gone);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toBe("Could not delete abc123: Not found\n");
    const old = await deleteWith(() => done);
    expect(old.code).toBe(0);
    expect(old.requests).toBe(1);
  });
});
