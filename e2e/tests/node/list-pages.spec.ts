import { PAGE_LIMIT } from "../../../packages/worker/src/uploads.js";
import { randomBytes } from "node:crypto";
import {
  api,
  cli,
  describeRun,
  expect,
  expectExitCode,
  putObject,
  startServer,
  summarize,
  test,
  type ExtraServer,
  type ListedUpload,
  type UploadsPage,
} from "../../lib/index.js";

// GET /api/uploads in pages, end to end on a `wrangler dev` server with a
// bucket of its own (so the shared test bucket's size does not matter and
// this one's does not leak into other tests): one page per request, an
// opaque `cursor` to continue, strictly checked, and `yeet list` fetching
// every page. How much work a page does is counted in r2-work-bounds.spec.ts.

const UPLOADS = 330; // three pages of at most 149 (miniflare returns up to 100 objects per call)
const prefix = "uploads";

let srv: ExtraServer;
const ids: string[] = [];

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  test.setTimeout(180_000);
  srv = await startServer({ token: randomBytes(24).toString("base64url") });
  const now = Date.now();
  const seeds: Promise<void>[] = [];
  for (let i = 0; i < UPLOADS; i++) {
    const id = `p${String(i).padStart(5, "0")}`;
    ids.push(id);
    const meta = {
      filename: `file-${i}.bin`,
      file_size: 1,
      // Not in ID order, so ordering newest first takes all pages.
      uploaded_at: new Date(now - ((i * 7919) % UPLOADS) * 60_000).toISOString(),
      expires_at: new Date(now + 86_400_000).toISOString(),
    };
    seeds.push(
      putObject(`${prefix}/${id}/${meta.filename}`, "x", { baseURL: srv.baseURL }),
      putObject(`${prefix}/${id}/.meta.json`, JSON.stringify(meta), {
        contentType: "application/json",
        // Every tenth without a summary, as yeet < 0.2 left them: a read each.
        ...(i % 10 === 0 ? {} : { customMetadata: { summary: JSON.stringify(summarize(meta)) } }),
        baseURL: srv.baseURL,
      }),
    );
    if (seeds.length >= 40) await Promise.all(seeds.splice(0));
  }
  await Promise.all(seeds);
});

test.afterAll(async () => {
  await srv?.stop();
});

async function page(
  cursor?: string | null,
  query?: string,
): Promise<{ status: number; body: unknown }> {
  const path =
    query !== undefined
      ? `/api/uploads?${query}`
      : cursor
        ? `/api/uploads?cursor=${encodeURIComponent(cursor)}`
        : "/api/uploads";
  const res = await api(path, { baseURL: srv.baseURL, token: srv.token });
  return { status: res.status, body: await res.json() };
}

test("GET /api/uploads: one page per request, a cursor to continue, every upload once", async () => {
  const seen: ListedUpload[] = [];
  const sizes: number[] = [];
  let cursor: string | null = null;
  for (let n = 0; n < 20; n++) {
    const { status, body } = await page(cursor);
    expect(status).toBe(200);
    const result = body as UploadsPage;
    sizes.push(result.uploads.length);
    // Newest first within a page.
    const times = result.uploads.map((u) => u.uploaded_at);
    expect(times).toEqual([...times].sort().reverse());
    seen.push(...result.uploads);
    if (result.cursor === null) {
      expect(result.truncated, "the last page has no truncated flag").toBeUndefined();
      break;
    }
    // Not the last page: `truncated: true`, which is what yeet 0.2's CLI reads.
    expect(result.truncated).toBe(true);
    expect(result.cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    cursor = result.cursor;
  }
  console.log(`${UPLOADS} uploads in pages of ${sizes.join(", ")}`);
  expect(sizes.length).toBeGreaterThan(1);
  expect(Math.max(...sizes)).toBeLessThanOrEqual(Math.floor(PAGE_LIMIT / 2) - 1);
  expect(seen.map((u) => u.id).sort()).toEqual(ids);
  expect(new Set(seen.map((u) => u.id)).size).toBe(UPLOADS);
  // The sidecars without a summary are listed too (read on their page).
  expect(seen.find((u) => u.id === "p00000")).toMatchObject({
    filename: "file-0.bin",
    file_size: 1,
  });

  // Without a cursor: the first page again, the same as an old client gets.
  const first = (await page()).body as UploadsPage;
  expect(first.uploads.length).toBe(sizes[0]);
  expect(first.truncated).toBe(true);
});

test("GET /api/uploads refuses a cursor it did not make with 400", async () => {
  const b64 = (text: string) => Buffer.from(text, "utf-8").toString("base64url");
  const valid = (await page()).body as UploadsPage;
  for (const [name, query] of [
    ["garbage", "cursor=not%20a%20cursor"],
    ["empty", "cursor="],
    ["without a value", "cursor"],
    ["two cursors", `cursor=${valid.cursor}&cursor=${valid.cursor}`],
    ["outside the prefix", `cursor=${b64("other/p00001")}`],
    ["the prefix without its slash", `cursor=${b64("uploads")}`],
    ["padding", `cursor=${valid.cursor}%3D%3D`],
    ["dot-segments", `cursor=${b64("../uploads/p00001")}`],
    ["too long", `cursor=${b64(`uploads/${"x".repeat(1100)}`)}`],
  ] as const) {
    const { status, body } = await page(undefined, query);
    expect(status, name).toBe(400);
    expect(body, name).toEqual({ error: "Invalid cursor" });
  }
  // Without a token, 401 comes first, as for every API route.
  const res = await api(`/api/uploads?cursor=${valid.cursor}`, {
    baseURL: srv.baseURL,
    token: null,
  });
  expect(res.status).toBe(401);
});

test("yeet list fetches every page and prints all uploads newest first", async () => {
  const list = await cli(["list"], { env: { YEET_URL: srv.baseURL, YEET_TOKEN: srv.token } });
  expectExitCode(list, 0);
  expect(list.stdout).toContain(`${UPLOADS} files (${UPLOADS} active, 0 expired)`);
  expect(list.stdout, describeRun(list)).not.toContain("only part of your uploads");
  // Newest first: file-0 was uploaded last (offset 0), the order of the rest
  // follows uploaded_at across pages.
  const names = [...list.stdout.matchAll(/^ {2}(file-\d+\.bin) ·/gm)].map((m) => m[1]!);
  expect(names).toHaveLength(UPLOADS);
  const offset = (name: string) => (Number(name.match(/\d+/)![0]) * 7919) % UPLOADS;
  expect(names.map(offset)).toEqual(names.map(offset).sort((a, b) => a - b));
});
