// Independent verifier of round 1L, against wrangler dev: the "deletion
// under way" sidecar seen by every HTTP reader (download page with and
// without a download pass, the password form, a signed link made before,
// the list, part PUT, complete, DELETE again), the sized-complete part cap
// at its edges and with the real CLI, and the CLI's wording and delete loop
// at their edges against stand-in servers.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DELETE_LIMIT } from "../../../packages/worker/src/uploads.js";
import {
  api,
  apiJson,
  cli,
  cliUpload,
  cookiePair,
  cronUntil,
  deleteUpload,
  downloadSha256,
  exclusive,
  expect,
  expectExitCode,
  listUploads,
  makeTempDir,
  putObject,
  readUploadMeta,
  server,
  sha256,
  submitDownloadForm,
  test,
  uploadObjects,
  uploadViaApi,
} from "../../lib/index.js";

const PART_SIZE = 50 * 1024 * 1024;

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

test.describe("1L verifier: every HTTP reader of a deletion under way", () => {
  test("password upload, pass cookie and signed link from before: all 404, nothing counted", () =>
    exclusive("cron", async () => {
      const data = randomBytes(64);
      const password = "correct horse";
      const { id, url } = await uploadViaApi({ filename: "secret.bin", data, password });
      // Before: a signed link and a download pass.
      const form = await submitDownloadForm(url, password);
      expect(form.status).toBe(303);
      const signed = new URL(form.headers.get("Location")!, url).toString();
      const pass = cookiePair(form.headers.get("Set-Cookie"));
      expect(pass).toBeTruthy();
      await expect.poll(async () => (await readUploadMeta(id))?.download_count ?? 0).toBe(1);
      // Legacy records sort before the sidecar: the first DELETE lists only records.
      await seedRecords(id, 2 * DELETE_LIMIT + 30);
      const first = await deleteUpload(id);
      expect(first.status).toBe(202);
      const marker = await readUploadMeta(id);
      expect(marker?.pending_upload_id).toBe("deleted");
      expect(marker?.password_hash).toBeUndefined();
      // Every reader.
      expect((await fetch(url)).status).toBe(404);
      expect((await fetch(url, { headers: { Cookie: pass } })).status).toBe(404);
      expect((await submitDownloadForm(url, password)).status).toBe(404);
      expect((await submitDownloadForm(url, undefined, { cookie: pass })).status).toBe(404);
      expect((await fetch(signed)).status).toBe(404);
      expect((await fetch(signed, { headers: { Range: "bytes=0-1" } })).status).toBe(404);
      expect((await listUploads()).some((u) => u.id === id)).toBe(false);
      const put = await api(`/api/uploads/${id}/parts/1`, {
        method: "PUT",
        body: data,
        headers: { "Content-Type": "application/octet-stream" },
      });
      expect(put.status).toBe(404);
      const complete = await api(`/api/uploads/${id}/complete`, {
        method: "POST",
        body: JSON.stringify({ parts: [{ part_number: 1, etag: "x" }] }),
        headers: { "Content-Type": "application/json" },
      });
      expect(complete.status).toBe(404);
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect((await readUploadMeta(id))?.download_count).toBeUndefined();
      expect((await readUploadMeta(id))?.pending_upload_id).toBe("deleted");
      // DELETE again until done, then 404 (idempotent end).
      const statuses: number[] = [];
      for (let i = 0; i < 10; i++) {
        const res = await deleteUpload(id);
        statuses.push(res.status);
        if (res.status !== 202) break;
      }
      console.log(`further DELETEs: ${statuses.join(", ")}`);
      expect(statuses.at(-1)).toBe(200);
      expect(statuses.slice(0, -1).every((s) => s === 202)).toBe(true);
      expect(await uploadObjects(id)).toHaveLength(0);
      expect((await deleteUpload(id)).status).toBe(404);
      expect((await deleteUpload(id)).status).toBe(404);
    }));

  test("the cron finishes a marked upload and never stalls on it", () =>
    exclusive("cron", async () => {
      test.setTimeout(240_000);
      const { id } = await uploadViaApi({ filename: "cron.bin", data: randomBytes(8) });
      await seedRecords(id, 3 * DELETE_LIMIT);
      expect((await deleteUpload(id)).status).toBe(202);
      const runs = await cronUntil(async () => (await uploadObjects(id)).length === 0, {
        maxRuns: 400,
      });
      console.log(`marked upload with ${3 * DELETE_LIMIT} records: gone after ${runs} cron runs`);
    }));
});

test.describe("1L verifier: sized complete, the part count cap", () => {
  const madeUp = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ part_number: i + 1, etag: `made-up-${i + 1}` }));
  async function create(size: number): Promise<string> {
    const { id } = await apiJson<{ id: string }>("/api/uploads", {
      method: "POST",
      body: JSON.stringify({ filename: "cap.bin", size, expires_in: 3600 }),
    });
    return id;
  }
  const complete = (id: string, n: number) =>
    api(`/api/uploads/${id}/complete`, {
      method: "POST",
      body: JSON.stringify({ parts: madeUp(n) }),
      headers: { "Content-Type": "application/json" },
    });

  for (const [size, count] of [
    [0, 1],
    [1, 1],
    [PART_SIZE - 1, 1],
    [PART_SIZE, 1],
    [PART_SIZE + 1, 2],
    [2 * PART_SIZE, 2],
    [2 * PART_SIZE + 1, 3],
    [10_000 * PART_SIZE, 10_000],
  ] as const) {
    test(`size ${size}: ${count} part(s) go on to R2, ${count + 1} are refused`, async () => {
      const id = await create(size);
      const over = await complete(id, count + 1);
      expect(over.status).toBe(400);
      const overBody = (await over.json()) as { error: string };
      expect(overBody.error).toMatch(
        count + 1 > 10_000 ? /at most 10000/ : /^Invalid parts: an upload of/,
      );
      const exact = await complete(id, count);
      expect(exact.status).toBe(400);
      expect(((await exact.json()) as { error: string }).error).toMatch(
        /^Could not complete the upload/,
      );
      expect((await readUploadMeta(id))?.pending_upload_id).toBeTruthy();
      expect((await deleteUpload(id)).status).toBe(200);
    });
  }

  test("the real CLI: empty file, exactly part_size, part_size + 1", async () => {
    test.setTimeout(180_000);
    const dir = await makeTempDir("cap-");
    for (const size of [0, PART_SIZE, PART_SIZE + 1]) {
      const file = join(dir, `f${size}.bin`);
      const data = randomBytes(size);
      await writeFile(file, data);
      const { url, id } = await cliUpload(file);
      const got = await downloadSha256(url);
      expect(got).toEqual({ sha256: await sha256(data), size });
      expect((await deleteUpload(id)).status).toBe(200);
    }
  });
});

// ---------------------------------------------------------------------------
// The CLI against stand-in servers.

async function withServer<T>(
  handler: (req: IncomingMessage, res: ServerResponse, n: number) => void,
  run: (env: Record<string, string>) => Promise<T>,
): Promise<{ result: T; requests: number }> {
  let requests = 0;
  const fake = createServer((req, res) => handler(req, res, ++requests));
  await new Promise<void>((resolve) => fake.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = fake.address() as AddressInfo;
    const result = await run({
      YEET_URL: `http://127.0.0.1:${port}`,
      YEET_TOKEN: "a-token-of-16-chars-or-more",
    });
    return { result, requests };
  } finally {
    fake.closeAllConnections();
    await new Promise((resolve) => fake.close(resolve));
  }
}

const json = (res: ServerResponse, status: number, body: unknown, headers = {}) => {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(body === undefined ? "" : JSON.stringify(body));
};

test.describe("1L verifier: CLI wording at the unit boundaries", () => {
  for (const [seconds, when] of [
    ["11", "in 11 seconds"],
    ["60", "in 60 seconds"],
    ["90", "in 90 seconds"],
    ["91", "in 2 minutes"],
    ["120", "in 2 minutes"],
    ["121", "in 3 minutes"],
    ["5400", "in 90 minutes"],
    ["5401", "in 2 hours"],
    ["86399", "in 24 hours"],
    ["86400", "in 24 hours"],
    ["86401", "later"],
  ] as const) {
    test(`a 503 with Retry-After ${seconds} on a list: "Try again ${when}." once`, async () => {
      const { result } = await withServer(
        (_req, res) =>
          json(res, 503, { error: "Service unavailable." }, { "Retry-After": seconds }),
        (env) => cli(["list"], { env }),
      );
      const out = result.stdout + result.stderr;
      expect(out).toContain(`Try again ${when}`);
      expect(out).not.toContain("..");
      expect(out).not.toContain(".)");
      expect(out).not.toMatch(/\b(\d{3,}) (seconds|minutes|hours)\b/);
    });
  }

  test("a 429 with Retry-After 91 and 5401: two-digit wording, no doubled period", async () => {
    for (const [ra, when] of [
      ["91", "in 2 minutes"],
      ["5401", "in 2 hours"],
    ]) {
      const { result } = await withServer(
        (_req, res) => json(res, 429, { error: "Too many attempts" }, { "Retry-After": ra }),
        (env) => cli(["list"], { env }),
      );
      const out = result.stdout + result.stderr;
      console.log(`429 RA ${ra}: ${JSON.stringify(out.trim().slice(0, 300))}`);
      expect(out).toContain(`Try again ${when}.`);
      expect(out).not.toContain("..");
      expect(out).not.toContain(".)");
    }
  });
});

test.describe("1L verifier: yeet delete loop edges", () => {
  test("a 202 without a body, or with done: true, is done after one request", async () => {
    for (const body of [undefined, { deleted: "abc123", done: true }, { deleted: "abc123" }]) {
      const { result, requests } = await withServer(
        (_req, res) => json(res, 202, body),
        (env) => cli(["delete", "abc123"], { env }),
      );
      expectExitCode(result, 0);
      expect(requests).toBe(1);
      expect(result.stderr).toBe("Deleted abc123\n");
    }
  });

  test("a 503 midway is not retried: deleted for users, the rest for the cleanup", async () => {
    const { result, requests } = await withServer(
      (_req, res, n) =>
        n <= 2
          ? json(res, 202, { deleted: "abc123", done: false })
          : json(res, 503, { error: "x" }),
      (env) => cli(["delete", "abc123"], { env }),
    );
    expectExitCode(result, 0);
    console.log(`503 midway: ${requests} requests, ${JSON.stringify(result.stderr)}`);
    expect(requests).toBe(3);
    expect(result.stderr).toContain("hourly cleanup");
  });

  test("two IDs: the loop runs per ID, a failure of the second is exit 1", async () => {
    const { result, requests } = await withServer(
      (req, res) => {
        if (req.url?.includes("aaa111")) return json(res, 202, { deleted: "aaa111", done: false });
        return json(res, 404, { error: "Not found" });
      },
      (env) => cli(["delete", "aaa111", "bbb222"], { env }),
    );
    console.log(
      `two IDs: ${requests} requests, exit ${result.code}, ${JSON.stringify(result.stderr)}`,
    );
    expect(result.code).toBe(1);
    expect(requests).toBe(200 + 1);
    expect(result.stderr).toContain("Deleted aaa111 (the server removes the rest");
    expect(result.stderr).toContain("Could not delete bbb222: Not found");
  });
});
