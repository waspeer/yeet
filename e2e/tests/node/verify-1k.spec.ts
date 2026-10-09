// Independent verifier of round 1K: the MAX_UNSIZED_PARTS boundaries of
// `complete` (array length and record count, at the limit and one past it), and the CLI's
// Retry-After parsing and "Try again" wording at their edges.

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";
import { MAX_UNSIZED_PARTS, Uploads } from "../../../packages/worker/src/uploads.js";
import {
  api,
  apiJson,
  cli,
  expect,
  listObjects,
  putObject,
  readUploadMeta,
  server,
  test,
} from "../../lib/index.js";
import { StrictBucket } from "../../lib/strict-r2.js";

const PART_SIZE = 50 * 1024 * 1024;
const TOO_MANY =
  `Too many parts to complete an upload of unknown size (at most ${MAX_UNSIZED_PARTS}); ` +
  `start the upload again and send its size ("size" in POST /api/uploads)`;

async function create(body: Record<string, unknown>): Promise<string> {
  const { id } = await apiJson<{ id: string }>("/api/uploads", {
    method: "POST",
    body: JSON.stringify({ expires_in: 3600, ...body }),
  });
  return id;
}

function complete(id: string, body: unknown): Promise<Response> {
  return api(`/api/uploads/${id}/complete`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

/** Part records `from`..`to` (inclusive), size PART_SIZE except `lastSize` for `to`. */
async function seedRecords(id: string, from: number, to: number, lastSize = PART_SIZE) {
  const all: Promise<unknown>[] = [];
  for (let n = from; n <= to; n++) {
    const size = String(n === to ? lastSize : PART_SIZE);
    all.push(
      putObject(`${server.uploadsPrefix}/${id}/.parts/${n}`, "", { customMetadata: { size } }),
    );
    if (all.length >= 50) await Promise.all(all.splice(0));
  }
  await Promise.all(all);
}

const madeUp = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ part_number: i + 1, etag: `made-up-${i + 1}` }));

test.describe("1K verifier: complete of unknown size at the limit", () => {
  test(`exactly ${MAX_UNSIZED_PARTS} parts listed and recorded: past the limit, up to R2's complete`, async () => {
    const id = await create({ filename: "exact-limit.bin" });
    await seedRecords(id, 1, MAX_UNSIZED_PARTS, 10);
    const res = await complete(id, { parts: madeUp(MAX_UNSIZED_PARTS) });
    const body = (await res.json()) as { error: string };
    console.log(
      `${MAX_UNSIZED_PARTS}/${MAX_UNSIZED_PARTS}: ${res.status} ${body.error.slice(0, 60)}`,
    );
    expect(res.status).toBe(400);
    // Reached multipart.complete (made-up etags), not the limit's refusal.
    expect(body.error).toMatch(/^Could not complete the upload/);
    expect((await api(`/api/uploads/${id}`, { method: "DELETE" })).status).toBe(200);
  });

  test(`${MAX_UNSIZED_PARTS} parts listed, ${MAX_UNSIZED_PARTS + 1} records (one not in the request): refused, nothing changed`, async () => {
    const id = await create({ filename: "extra-record.bin" });
    await seedRecords(id, 1, MAX_UNSIZED_PARTS + 1, 10);
    const res = await complete(id, { parts: madeUp(MAX_UNSIZED_PARTS) });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: TOO_MANY });
    const meta = await readUploadMeta(id);
    expect(meta?.pending_upload_id).toBeTruthy();
    expect(meta?.file_size).toBeUndefined();
    const keys = (await listObjects(`${server.uploadsPrefix}/${id}/`)).map((o) => o.key);
    // Records intact, no file object (the multipart upload was not completed).
    expect(keys.filter((k) => k.includes("/.parts/"))).toHaveLength(MAX_UNSIZED_PARTS + 1);
    expect(keys.filter((k) => !k.includes("/.parts/") && !k.endsWith("/.meta.json"))).toEqual([]);
    expect((await api(`/api/uploads/${id}`, { method: "DELETE" })).status).toBe(200);
  });

  test("a parts array with a duplicate is refused for that, whatever its length", async () => {
    const id = await create({ filename: "dup.bin" });
    const parts = [...madeUp(MAX_UNSIZED_PARTS + 5), { part_number: 3, etag: "again" }];
    const res = await complete(id, { parts });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe(
      "Invalid parts: part 3 is listed twice",
    );
    expect((await readUploadMeta(id))?.pending_upload_id).toBeTruthy();
    expect((await api(`/api/uploads/${id}`, { method: "DELETE" })).status).toBe(200);
  });

  test("a sized upload with 1,000 parts listed is not refused by the unsized limit", async () => {
    const id = await create({ filename: "sized-many.bin", size: 1000 * PART_SIZE });
    const res = await complete(id, { parts: madeUp(1000) });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/^Could not complete/);
    expect((await api(`/api/uploads/${id}`, { method: "DELETE" })).status).toBe(200);
  });

  test("readPartSizes: one record per list call runs out of calls first and refuses (never wrong)", async () => {
    for (const n of [MAX_UNSIZED_PARTS, MAX_UNSIZED_PARTS + 1]) {
      const b = new StrictBucket({ maxCalls: 1000 });
      b.metadataCap = 1;
      for (let i = 1; i <= n; i++) b.seed(`uploads/x/.parts/${i}`, "", { size: "5" });
      b.reset();
      const r = await new Uploads(b, "uploads").readPartSizes("x", 46, MAX_UNSIZED_PARTS);
      expect(r, `${n}`).toBeNull();
      expect(b.calls["list"] ?? 0).toBeLessThanOrEqual(46);
    }
    // And on full pages, the limit is read whole in one call, one more refused after that many listed.
    for (const [n, ok] of [
      [MAX_UNSIZED_PARTS, true],
      [MAX_UNSIZED_PARTS + 1, false],
      [MAX_UNSIZED_PARTS + 500, false],
    ] as const) {
      const b = new StrictBucket({ maxCalls: 1000 });
      b.metadataCap = 1000;
      for (let i = 1; i <= n; i++) b.seed(`uploads/x/.parts/${i}`, "", { size: "5" });
      b.reset();
      const r = await new Uploads(b, "uploads").readPartSizes("x", 46, MAX_UNSIZED_PARTS);
      expect(!!r, `${n}`).toBe(ok);
      expect(b.listed, `${n}`).toBe(Math.min(n, MAX_UNSIZED_PARTS + 1));
      expect(b.calls["list"], `${n}`).toBe(1);
    }
  });
});

// ---------------------------------------------------------------------------
// CLI: Retry-After edges, against a stand-in server
// ---------------------------------------------------------------------------

/** yeet list where page 2 first answers 503 with `retryAfter`, then a last page. */
async function listWith(retryAfter: string, env: Record<string, string> = {}) {
  const hits: { cursor: string | null; at: number }[] = [];
  const upload = (n: number) => ({
    id: `k${n}`,
    filename: `f${n}.bin`,
    file_size: 1,
    uploaded_at: new Date(Date.UTC(2026, 0, 1) + n * 60_000).toISOString(),
    expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    has_password: false,
    download_count: 0,
    recent_downloads: [],
    url: `http://127.0.0.1/k${n}/f${n}.bin`,
  });
  const fake = createServer((req, res) => {
    const cursor = new URL(req.url!, "http://x").searchParams.get("cursor");
    hits.push({ cursor, at: Date.now() });
    const tries = hits.filter((h) => h.cursor === cursor).length;
    if (cursor === null) {
      res.writeHead(200, { "Content-Type": "application/json" });
      return void res.end(JSON.stringify({ uploads: [upload(0)], cursor: "two" }));
    }
    if (tries === 1) {
      res.writeHead(503, { "Content-Type": "application/json", "Retry-After": retryAfter });
      return void res.end(JSON.stringify({ error: "Service unavailable" }));
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ uploads: [upload(1)], cursor: null }));
  });
  await new Promise<void>((resolve) => fake.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = fake.address() as AddressInfo;
    const r = await cli(["list"], {
      env: {
        YEET_URL: `http://127.0.0.1:${port}`,
        YEET_TOKEN: "a-token-of-16-chars-or-more",
        ...env,
      },
    });
    const two = hits.filter((h) => h.cursor === "two");
    return { ...r, tries: two.length, gap: two.length > 1 ? two[1]!.at - two[0]!.at : undefined };
  } finally {
    fake.closeAllConnections();
    await new Promise((resolve) => fake.close(resolve));
  }
}

const asctime = (d: Date) => {
  const [, day, dd, mon, yyyy, time] = d
    .toUTCString()
    .match(/^(\w{3}), (\d{2}) (\w{3}) (\d{4}) (\S+) GMT$/)!;
  return `${day} ${mon} ${String(Number(dd)).padStart(2, " ")} ${time} ${yyyy}`;
};

test.describe("1K verifier: CLI Retry-After edges", () => {
  for (const tz of ["Pacific/Kiritimati", "America/Los_Angeles", "UTC"]) {
    test(`asctime ~3.5 s ahead is read as GMT with TZ=${tz}`, async () => {
      test.setTimeout(30_000);
      const r = await listWith(asctime(new Date(Date.now() + 3500)), { TZ: tz });
      console.log(`asctime TZ=${tz}: gap ${r.gap}`);
      expect(r.code).toBe(0);
      expect(r.gap!).toBeGreaterThanOrEqual(2000);
      expect(r.gap!).toBeLessThan(5500);
    });
  }

  test(`leading zeros: "002" waits 2 s (not the 1 s backoff)`, async () => {
    test.setTimeout(30_000);
    const r = await listWith("002");
    console.log(`RA 002: gap ${r.gap}`);
    expect(r.code).toBe(0);
    expect(r.gap!).toBeGreaterThanOrEqual(1950);
    expect(r.gap!).toBeLessThan(3000);
  });

  test("a lowercase HTTP date is no HTTP date: backoff", async () => {
    test.setTimeout(30_000);
    const r = await listWith(new Date(Date.now() + 5000).toUTCString().toLowerCase());
    console.log(`lowercase date: gap ${r.gap}`);
    expect(r.code).toBe(0);
    expect(r.gap!).toBeGreaterThanOrEqual(950);
    expect(r.gap!).toBeLessThan(1900);
  });

  for (const [value, when] of [
    ["119", "Try again in 119 seconds."],
    ["121", "Try again in 3 minutes."],
    ["7199", "Try again in 120 minutes."],
    ["86400", "Try again in 24 hours."],
    ["86401", "Try again later."],
    ["9".repeat(400), "Try again later."],
    ["Sun, 30 Feb 2099 08:49:37 GMT", "Try again later."],
  ] as const) {
    test(`Retry-After ${value.slice(0, 32)}: no retry, "${when}"`, async () => {
      const r = await listWith(value);
      const note = r.stdout.split("\n").find((l) => /Note/.test(l)) ?? "";
      console.log(`RA ${value.slice(0, 32)}: tries ${r.tries}, ${note.slice(60, 160)}`);
      expect(r.code).toBe(1);
      expect(r.tries).toBe(1);
      expect(note).toContain(`Service unavailable. ${when}`);
    });
  }

  test("RFC 850 two-digit year 60 (Date.parse: 1960): taken as past, retried at once", async () => {
    // RFC 9110 would read it as 2060 (not more than 50 years ahead). Observed,
    // not a requirement: a server never sends a Retry-After decades ahead.
    const r = await listWith("Sunday, 06-Nov-60 08:49:37 GMT");
    console.log(`RFC 850 year 60: tries ${r.tries}, gap ${r.gap}`);
    expect(r.code).toBe(0);
    expect(r.gap!).toBeLessThan(500);
  });

  test("random bytes in Retry-After never crash the CLI", async () => {
    test.setTimeout(60_000);
    for (const value of [" ", "0x10", "1_000", `${randomBytes(4).toString("hex")}`]) {
      const r = await listWith(value);
      expect(r.code, value).toBe(0);
    }
  });
});
