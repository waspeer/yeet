import {
  CLEANUP_BUDGET,
  CLEANUP_LIST_LIMIT,
  runCleanup,
} from "../../../packages/worker/src/cleanup.js";
import { encodeListCursor, parseListCursor } from "../../../packages/worker/src/parse.js";
import {
  JUMP_LIMIT,
  PAGE_JUMPS,
  PAGE_LIMIT,
  PAGE_READS,
  summarize,
  Uploads,
  type UploadMeta,
} from "../../../packages/worker/src/uploads.js";
import { writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { cli, expect, makeTempDir, test } from "../../lib/index.js";
import { byteCompare, REAL_R2_CAPS, StrictBucket, seededRandom } from "../../lib/strict-r2.js";

// Written by the independent verifier of round 1J: property walks of
// GET /api/uploads and cron runs where R2 answers jumps with empty pages at
// random, the sidecar probe's edges (no room, failing read, pending,
// malformed or missing sidecar behind a run), and the CLI's Retry-After
// handling for list pages and upload parts against stand-in servers.

const P = "uploads";
const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 9, 3);

const isJump = (o: { startAfter?: string }) => !!o.startAfter?.endsWith("~");

class ScriptedBucket extends StrictBucket {
  script?: (n: number, options: { include?: string[]; startAfter?: string }) => number | undefined;
  failGet?: (key: string) => boolean;
  private listNo = 0;
  violations: string[] = [];
  live = new Set<string>();
  override reset() {
    super.reset();
    this.listNo = 0;
  }
  override async get(key: string) {
    if (this.failGet?.(key)) {
      this.calls.get = (this.calls.get ?? 0) + 1;
      throw new Error(`injected get failure: ${key}`);
    }
    return super.get(key);
  }
  override async list(options: Parameters<StrictBucket["list"]>[0]) {
    const cap = this.script?.(this.listNo++, options);
    if (cap === undefined) return super.list(options);
    const saved = [this.metadataCap, this.plainCap];
    this.metadataCap = Math.min(this.metadataCap, cap);
    this.plainCap = Math.min(this.plainCap, cap);
    try {
      return await super.list(options);
    } finally {
      [this.metadataCap, this.plainCap] = saved as [number, number];
    }
  }
  override async delete(keys: string | string[]) {
    const list = typeof keys === "string" ? [keys] : keys;
    for (const k of list) {
      const [id, ...rest] = k.slice(P.length + 1).split("/");
      if (this.live.has(id!) && !rest.join("/").startsWith(".downloads/")) {
        this.violations.push(`deleted key of live upload: ${k}`);
      }
    }
    await super.delete(list);
    for (const k of list) {
      if (!k.endsWith("/.meta.json")) continue;
      const dir = k.slice(0, -".meta.json".length);
      const left = this.sorted(dir);
      if (left.length > 0) this.violations.push(`sidecar ${k} deleted, ${left.length} keys left`);
    }
  }
}

interface Shape {
  legacy?: boolean;
  expired?: boolean;
  pendingSince?: number;
  unreadable?: boolean;
  noSidecar?: boolean;
  records?: number;
  parts?: number;
  /** The file's name: "-a.bin" sorts before `.downloads/`, ".e.bin" between it and `.meta.json`. */
  file?: string;
}

function seed(b: StrictBucket, id: string, s: Shape = {}, t = 0): UploadMeta {
  const dir = `${P}/${id}/`;
  const file = s.file ?? "f.bin";
  const meta: UploadMeta = {
    filename: file,
    file_size: 1,
    uploaded_at: new Date((s.pendingSince ?? NOW - DAY) + t).toISOString(),
    expires_at: new Date(s.expired ? NOW - 1 : NOW + 30 * DAY).toISOString(),
    ...(s.pendingSince !== undefined ? { pending_upload_id: `mp-${id}` } : {}),
  };
  if (s.pendingSince === undefined && !s.noSidecar) b.seed(`${dir}${file}`, "x");
  if (!s.noSidecar) {
    b.seed(
      `${dir}.meta.json`,
      s.unreadable ? "{not json" : JSON.stringify(meta),
      s.legacy || s.unreadable ? {} : { summary: JSON.stringify(summarize(meta)) },
    );
  }
  for (let i = 0; i < (s.records ?? 0); i++)
    b.seed(`${dir}.downloads/2026-06-01T00:00:00.${String(i).padStart(6, "0")}Z_x`);
  for (let n = 1; n <= (s.parts ?? 0); n++) b.seed(`${dir}.parts/${n}`, "", { size: "5" });
  return meta;
}

const listable = (s: Shape) => !s.noSidecar && !s.unreadable && s.pendingSince === undefined;

async function walk(b: ScriptedBucket, maxPages = 20_000) {
  const uploads = new Uploads(b, P);
  const seen: string[] = [];
  const work: { lists: number; listed: number; gets: number; total: number }[] = [];
  let cursor: string | null = null;
  let stalls = 0;
  for (let page = 0; page < maxPages; page++) {
    const after = cursor === null ? undefined : parseListCursor(cursor, uploads.listPrefix);
    expect(after).not.toBeNull();
    b.reset();
    b.maxCalls = 1 + PAGE_READS;
    const result = await uploads.listPage(after ?? undefined);
    work.push({
      lists: b.calls.list ?? 0,
      listed: b.listed,
      gets: b.calls.get ?? 0,
      total: b.total,
    });
    seen.push(...result.uploads.map((u) => u.id));
    if (result.next === null) return { seen, work, pages: page + 1, stalls, done: true };
    if (after != null) expect(byteCompare(result.next, after)).toBeGreaterThanOrEqual(0);
    if (result.next === (after ?? uploads.listPrefix)) stalls++;
    cursor = encodeListCursor(result.next);
  }
  return { seen, work, pages: maxPages, stalls, done: false };
}

function expectBounds(work: { lists: number; listed: number; gets: number; total: number }[]) {
  for (const [i, w] of work.entries()) {
    expect(w.lists, `page ${i}: lists`).toBeLessThanOrEqual(1 + PAGE_JUMPS);
    expect(w.listed, `page ${i}: objects`).toBeLessThanOrEqual(
      PAGE_LIMIT + PAGE_JUMPS * JUMP_LIMIT,
    );
    expect(w.gets, `page ${i}: reads`).toBeLessThanOrEqual(PAGE_READS);
    expect(w.total, `page ${i}: R2 calls`).toBeLessThanOrEqual(1 + PAGE_READS);
  }
}

function randomShape(rnd: () => number): Shape {
  const r = rnd();
  const records = () => 1 + Math.floor(rnd() * 1200);
  const file = ["f.bin", "-a.bin", ".e.bin"][Math.floor(rnd() * 3)];
  return r < 0.12
    ? { records: records(), file }
    : r < 0.18
      ? { legacy: true, records: records(), file }
      : r < 0.22
        ? { unreadable: true, records: records() }
        : r < 0.26
          ? { pendingSince: NOW - 1000, records: records(), parts: Math.floor(rnd() * 600) }
          : r < 0.3
            ? { noSidecar: true, records: records() }
            : r < 0.34
              ? { pendingSince: NOW - 2 * DAY, parts: Math.floor(rnd() * 700) }
              : r < 0.4
                ? { expired: true, records: rnd() < 0.5 ? records() : 0 }
                : r < 0.5
                  ? { legacy: true, file }
                  : { file };
}

test.describe("1J verifier: page walks with empty jumps at random", () => {
  for (const pEmpty of [0.3, 0.7, 1]) {
    test(`jumps empty with p=${pEmpty}, random short and empty pages, 5 seeds: every listable upload exactly once`, async () => {
      test.setTimeout(240_000);
      for (const seedNo of [101, 102, 103, 104, 105]) {
        const rnd = seededRandom(seedNo * 7 + Math.round(pEmpty * 10));
        const b = new ScriptedBucket({ ...REAL_R2_CAPS, maxCalls: Infinity, seed: seedNo });
        const expected: string[] = [];
        for (let i = 0; i < 250; i++) {
          const base = `j${Math.floor(i / 3)}`;
          const id = base + ["", "-", "_"][i % 3];
          const s = randomShape(rnd);
          seed(b, id, s, i);
          if (listable(s)) expected.push(id);
        }
        b.script = (_n, o) => {
          if (isJump(o)) return rnd() < pEmpty ? 0 : undefined;
          const r = rnd();
          return r < 0.15 ? 0 : r < 0.4 ? 1 + Math.floor(rnd() * PAGE_LIMIT) : undefined;
        };
        const { seen, work, done, pages, stalls } = await walk(b);
        console.log(
          `p=${pEmpty} seed ${seedNo}: ${pages} pages, ${stalls} stalls, ${seen.length} listed`,
        );
        expect(done, `seed ${seedNo}`).toBe(true);
        expectBounds(work);
        expect(seen.length, "no duplicates").toBe(new Set(seen).size);
        expect([...seen].sort()).toEqual([...expected].sort());
      }
    });
  }

  test("pending, malformed and missing sidecars behind a run whose jump is empty: none listed, the walk moves past", async () => {
    const b = new ScriptedBucket({ ...REAL_R2_CAPS, maxCalls: Infinity });
    seed(b, "a0", { pendingSince: NOW - 1000, records: 500, parts: 3 });
    seed(b, "b0", { unreadable: true, records: 500 });
    seed(b, "c0", { noSidecar: true, records: 500 });
    seed(b, "d0", { records: 500, file: ".e.bin" });
    seed(b, "e0");
    b.script = (_n, o) => (isJump(o) ? 0 : undefined);
    const { seen, work, done, pages } = await walk(b);
    console.log(`probe shapes: ${pages} pages`);
    expect(done).toBe(true);
    expectBounds(work);
    expect(seen).toEqual(["d0", "e0"]);
  });

  test("probe read fails: nothing returned, the next page starts at the same place and lists it", async () => {
    const b = new ScriptedBucket({ ...REAL_R2_CAPS, maxCalls: Infinity });
    seed(b, "a0", { records: 500 });
    seed(b, "b0");
    b.script = (_n, o) => (isJump(o) ? 0 : undefined);
    let failures = 1;
    b.failGet = (k) => k === `${P}/a0/.meta.json` && failures-- > 0;
    const uploads = new Uploads(b, P);
    b.reset();
    const first = await uploads.listPage();
    expect(first.uploads).toEqual([]);
    expect(first.next).toBe(uploads.listPrefix);
    b.reset();
    const second = await uploads.listPage(
      parseListCursor(encodeListCursor(first.next!), uploads.listPrefix)!,
    );
    expect(second.uploads.map((u) => u.id)).toEqual(["a0"]);
    expect(second.next).toBe(`${P}/a00`);
  });

  test("probe read always fails: the walk stalls on it (no skip), bounded by the client's page cap", async () => {
    const b = new ScriptedBucket({ ...REAL_R2_CAPS, maxCalls: Infinity });
    seed(b, "a0", { records: 500 });
    seed(b, "b0");
    b.script = (_n, o) => (isJump(o) ? 0 : undefined);
    b.failGet = (k) => k === `${P}/a0/.meta.json`;
    const { done, stalls, seen } = await walk(b, 50);
    console.log(`always failing probe: done ${done}, stalls ${stalls}, seen ${seen.join(",")}`);
    expect(done).toBe(false);
    expect(stalls).toBe(50);
  });

  test("listAll without room for the probe returns nothing and resumes where it started", async () => {
    const b = new ScriptedBucket({ ...REAL_R2_CAPS, maxCalls: Infinity });
    seed(b, "a0", { records: 500 });
    seed(b, "b0");
    b.script = (_n, o) => (isJump(o) ? 0 : undefined);
    const uploads = new Uploads(b, P);
    const l = await uploads.listAll({ budget: 2, maxListCalls: 1, jumpCalls: 1 });
    expect(l.uploads).toEqual([]);
    expect(l.truncated).toBe(true);
    expect(l.resumeAfter).toBeUndefined();
    expect(l.subrequests).toBe(2);
    const l2 = await uploads.listAll({ budget: 3, maxListCalls: 1, jumpCalls: 1 });
    expect(l2.uploads.map((u) => [u.id, u.complete, !!u.meta])).toEqual([["a0", false, true]]);
    expect(l2.subrequests).toBe(3);
  });
});

test.describe("1J verifier: cron with empty jumps at random", () => {
  test("4 seeds, jumps empty with p=0.6, short pages: live keys untouched, bounded, converges", async () => {
    test.setTimeout(300_000);
    const maxRuns = Math.ceil((4000 * 200) / CLEANUP_LIST_LIMIT);
    for (const seedNo of [61, 62, 63, 64]) {
      const rnd = seededRandom(seedNo);
      const b = new ScriptedBucket({ ...REAL_R2_CAPS, maxCalls: Infinity, seed: seedNo });
      const stale: string[] = [];
      const live: string[] = [];
      for (let i = 0; i < 300; i++) {
        const id = `c${Math.floor(i / 3)}${["", "-", "_"][i % 3]}`;
        const r = rnd();
        const s: Shape =
          r < 0.1
            ? { expired: true, records: Math.floor(rnd() * 1200) }
            : r < 0.2
              ? { records: 1 + Math.floor(rnd() * 1200), file: rnd() < 0.5 ? ".e.bin" : "f.bin" }
              : r < 0.25
                ? { pendingSince: NOW - 2 * DAY, parts: Math.floor(rnd() * 600) }
                : r < 0.3
                  ? {
                      pendingSince: NOW - 1000,
                      parts: Math.floor(rnd() * 600),
                      records: Math.floor(rnd() * 600),
                    }
                  : r < 0.4
                    ? { legacy: true, expired: rnd() < 0.5, records: Math.floor(rnd() * 600) }
                    : r < 0.43
                      ? { unreadable: true, records: Math.floor(rnd() * 600) }
                      : r < 0.47
                        ? { noSidecar: true, records: 1 + Math.floor(rnd() * 600) }
                        : r < 0.6
                          ? { expired: true }
                          : {};
        seed(b, id, s, i);
        const isStale =
          !s.unreadable &&
          (s.noSidecar ||
            s.expired ||
            (s.pendingSince !== undefined && NOW - s.pendingSince > DAY));
        (isStale ? stale : live).push(id);
        if (!isStale) b.live.add(id); // unreadable too: never its non-record keys
      }
      b.script = (_n, o) =>
        isJump(o) ? (rnd() < 0.6 ? 0 : undefined) : rnd() < 0.2 ? Math.floor(rnd() * 5) : undefined;
      const remaining = () =>
        stale.filter((id) => b.sorted(`${P}/${id}/`).length > 0).length +
        live.filter((id) => b.sorted(`${P}/${id}/.downloads/`).length > 0).length;
      let runs = 0;
      let maxCalls = 0;
      let maxLists = 0;
      while (remaining() > 0 && runs < maxRuns) {
        runs++;
        b.reset();
        b.maxCalls = CLEANUP_BUDGET;
        const r = await runCleanup(b, P, NOW);
        expect(r.subrequests).toBe(b.total);
        maxCalls = Math.max(maxCalls, b.total);
        maxLists = Math.max(maxLists, b.calls.list ?? 0);
        expect(b.maxListed).toBeLessThanOrEqual(CLEANUP_LIST_LIMIT);
      }
      console.log(`cron 1J seed ${seedNo}: ${runs} runs, max ${maxCalls} calls, ${maxLists} lists`);
      expect(remaining(), `seed ${seedNo}: converged`).toBe(0);
      expect(b.violations).toEqual([]);
      expect(maxLists).toBeLessThanOrEqual(3);
      expect(maxCalls).toBeLessThanOrEqual(CLEANUP_BUDGET);
      for (const id of live) expect(b.objects.has(`${P}/${id}/.meta.json`), id).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// CLI against stand-in servers
// ---------------------------------------------------------------------------

type Reply =
  | { status: number; body: unknown; headers?: Record<string, string> }
  | "reset"
  | "garbage";

interface Hit {
  method: string;
  path: string;
  cursor: string | null;
  at: number;
}

async function withServer(
  handler: (hit: Hit, attempt: number) => Reply,
  run: (env: Record<string, string>, log: Hit[]) => Promise<void>,
) {
  const log: Hit[] = [];
  const drain = (req: IncomingMessage) =>
    new Promise<void>((resolve) => {
      req.on("data", () => {});
      req.on("end", resolve);
      req.on("error", () => resolve());
    });
  const fake = createServer(async (req, res) => {
    await drain(req);
    const url = new URL(req.url!, "http://x");
    const hit = {
      method: req.method!,
      path: url.pathname,
      cursor: url.searchParams.get("cursor"),
      at: Date.now(),
    };
    log.push(hit);
    const attempt = log.filter(
      (h) => h.method === hit.method && h.path === hit.path && h.cursor === hit.cursor,
    ).length;
    const reply = handler(hit, attempt);
    if (reply === "reset") return void req.socket.destroy();
    if (reply === "garbage") {
      res.writeHead(200, { "Content-Type": "text/html" });
      return void res.end("<html>not json</html>");
    }
    res.writeHead(reply.status, { "Content-Type": "application/json", ...reply.headers });
    res.end(JSON.stringify(reply.body));
  });
  await new Promise<void>((resolve) => fake.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = fake.address() as AddressInfo;
    await run(
      { YEET_URL: `http://127.0.0.1:${port}`, YEET_TOKEN: "a-token-of-16-chars-or-more" },
      log,
    );
  } finally {
    fake.closeAllConnections();
    await new Promise((resolve) => fake.close(resolve));
  }
}

const uploadOf = (n: number) => ({
  id: `v${String(n).padStart(4, "0")}`,
  filename: `g${n}.bin`,
  file_size: 10,
  uploaded_at: new Date(Date.UTC(2026, 0, 1) + n * 60_000).toISOString(),
  expires_at: new Date(Date.now() + 86_400_000).toISOString(),
  has_password: false,
  download_count: 0,
  recent_downloads: [],
  url: `http://127.0.0.1/v${n}/g${n}.bin`,
});
const page = (n: number, next: string | null): Reply => ({
  status: 200,
  body: { uploads: [uploadOf(2 * n), uploadOf(2 * n + 1)], cursor: next },
});

/** yeet list where page 2 answers `fail` on its first `failures` attempts, then a last page. */
async function listWithPage2(fail: Reply, failures = Infinity) {
  let result!: {
    code: number | null;
    stdout: string;
    stderr: string;
    gaps: number[];
    requests: number;
  };
  await withServer(
    (hit, attempt) =>
      hit.cursor === null ? page(0, "two") : attempt <= failures ? fail : page(1, null),
    async (env, log) => {
      const r = await cli(["list"], { env });
      const two = log.filter((h) => h.cursor === "two");
      result = {
        code: r.code,
        stdout: r.stdout,
        stderr: r.stderr,
        requests: log.length,
        gaps: two.slice(1).map((h, i) => h.at - (i === 0 ? two[0]!.at : two[i]!.at)),
      };
    },
  );
  return result;
}

test.describe("1J verifier: Retry-After on list pages", () => {
  test("Retry-After 0 on a 503: retried at once (4 attempts), then partial", async () => {
    const r = await listWithPage2({
      status: 503,
      body: { error: "busy" },
      headers: { "Retry-After": "0" },
    });
    console.log(`503 RA 0: exit ${r.code}, requests ${r.requests}, gaps ${r.gaps}`);
    expect(r.code).toBe(1);
    expect(r.requests).toBe(5);
    for (const g of r.gaps) expect(g).toBeLessThan(500);
    expect(r.stdout).toContain("2 files");
  });

  test("Retry-After exactly MAX (10 s) is waited for; 11 s is not", async () => {
    test.setTimeout(60_000);
    const ten = await listWithPage2(
      { status: 503, body: { error: "busy" }, headers: { "Retry-After": "10" } },
      1,
    );
    console.log(`503 RA 10: exit ${ten.code}, gaps ${ten.gaps}`);
    expect(ten.code).toBe(0);
    expect(ten.gaps[0]).toBeGreaterThanOrEqual(10_000 - 50);
    expect(ten.stdout).toContain("4 files");
    const eleven = await listWithPage2(
      { status: 503, body: { error: "busy" }, headers: { "Retry-After": "11" } },
      1,
    );
    console.log(
      `503 RA 11: exit ${eleven.code}, requests ${eleven.requests}, stdout ${JSON.stringify(eleven.stdout.slice(-200))}`,
    );
    expect(eleven.code).toBe(1);
    expect(eleven.requests).toBe(2);
    expect(eleven.stdout).toContain("2 files");
  });

  // Round 1K: the 1J verifier observed that the note gave the server's error
  // but not when to try again (only a 429 said). Now any status with a
  // Retry-After too long to wait for says when, rounded to a readable unit,
  // and "later" above a day instead of the raw number.
  for (const [value, when] of [
    ["120", "Try again in 2 minutes."],
    ["900", "Try again in 15 minutes."],
    ["7200", "Try again in 2 hours."],
    ["86401", "Try again later."],
    ["100000000000000000000", "Try again later."],
  ] as const) {
    test(`a 503 with Retry-After ${value}: no retry, the note says "${when}"`, async () => {
      const r = await listWithPage2({
        status: 503,
        body: { error: "Service unavailable" },
        headers: { "Retry-After": value },
      });
      const note = r.stdout.split("\n").filter((l) => /Note/.test(l));
      console.log(`503 RA ${value}: exit ${r.code}, requests ${r.requests}, note ${note}`);
      expect(r.code).toBe(1);
      expect(r.requests).toBe(2);
      expect(r.stdout).toContain("2 files");
      expect(note.join("\n")).toContain(`Service unavailable. ${when}`);
      expect(r.stdout).not.toContain("00000");
    });
  }

  test("an HTTP date ~3 s ahead is waited for; a past date retries at once", async () => {
    test.setTimeout(30_000);
    const ahead = await withHttpDate(3500);
    console.log(`HTTP date +3.5 s: gaps ${ahead.gaps}`);
    expect(ahead.code).toBe(0);
    expect(ahead.gaps[0]).toBeGreaterThanOrEqual(2000);
    expect(ahead.gaps[0]).toBeLessThan(5500);
    const past = await withHttpDate(-60_000);
    console.log(`HTTP date in the past: gaps ${past.gaps}`);
    expect(past.code).toBe(0);
    expect(past.gaps[0]).toBeLessThan(500);
  });

  // Round 1K: the other two HTTP date spellings (RFC 9110 §5.6.7). asctime
  // has no zone and means GMT.
  const rfc850 = (d: Date) => {
    const [, day, rest] = d.toUTCString().match(/^(\w{3}), (.*)$/)!;
    const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    const [dd, mon, yyyy, time] = rest!.split(" ");
    return `${days.find((name) => name.startsWith(day!))}, ${dd}-${mon}-${yyyy!.slice(2)} ${time} GMT`;
  };
  const asctime = (d: Date) => {
    const [, day, dd, mon, yyyy, time] = d
      .toUTCString()
      .match(/^(\w{3}), (\d{2}) (\w{3}) (\d{4}) (\S+) GMT$/)!;
    return `${day} ${mon} ${String(Number(dd)).padStart(2, " ")} ${time} ${yyyy}`;
  };
  for (const [name, format] of [
    ["RFC 850", rfc850],
    ["asctime", asctime],
  ] as const) {
    test(`an HTTP date ~3 s ahead in ${name} spelling is waited for`, async () => {
      test.setTimeout(30_000);
      const ahead = await withHttpDate(3500, format);
      console.log(`${name} +3.5 s: gaps ${ahead.gaps}`);
      expect(ahead.code).toBe(0);
      expect(ahead.gaps[0]).toBeGreaterThanOrEqual(2000);
      expect(ahead.gaps[0]).toBeLessThan(5500);
    });
  }

  async function withHttpDate(offsetMs: number, format = (d: Date) => d.toUTCString()) {
    let result!: { code: number | null; gaps: number[] };
    await withServer(
      (hit, attempt) =>
        hit.cursor === null
          ? page(0, "two")
          : attempt === 1
            ? {
                status: 503,
                body: { error: "busy" },
                headers: { "Retry-After": format(new Date(Date.now() + offsetMs)) },
              }
            : page(1, null),
      async (env, log) => {
        const r = await cli(["list"], { env });
        const two = log.filter((h) => h.cursor === "two");
        result = { code: r.code, gaps: [two[1]!.at - two[0]!.at] };
      },
    );
    return result;
  }

  // FINDING (low), fixed in round 1K: values that are no number of seconds
  // and no HTTP date but that Date.parse() still accepts ("-5", "+5", "1.5")
  // were taken as a date in 2001, i.e. "retry now". Now they are ignored like
  // any other unusable value: the backoff (1, 2, 4 s) applies.
  for (const value of ["-5", "+5", "1.5", "abc", "1e3"]) {
    test(`Retry-After ${JSON.stringify(value)} on a 503 is ignored: backoff`, async () => {
      test.setTimeout(30_000);
      const r = await listWithPage2(
        { status: 503, body: { error: "busy" }, headers: { "Retry-After": value } },
        1,
      );
      console.log(`503 RA ${value}: exit ${r.code}, gap ${r.gaps[0]} ms`);
      expect(r.code).toBe(0);
      expect(r.gaps[0]).toBeGreaterThanOrEqual(1000 - 50);
    });
  }

  test("a huge Retry-After on a 429: no retry, says when", async () => {
    const r = await listWithPage2({
      status: 429,
      body: { error: "Too many attempts" },
      headers: { "Retry-After": "99999999999999999999" },
    });
    console.log(
      `429 huge RA: exit ${r.code}, requests ${r.requests}, ${JSON.stringify(r.stdout.split("\n").filter((l) => /Try again/.test(l)))}`,
    );
    expect(r.code).toBe(1);
    expect(r.requests).toBe(2);
    // Round 1K: "later" above a day, not the raw number of seconds.
    expect(r.stdout).toContain("Try again later.");
    expect(r.stdout).not.toContain("99999");
  });

  test("a later page that is JSON but not a page (no uploads array): partial, exit 1", async () => {
    const r = await listWithPage2({ status: 200, body: { hello: 1 } });
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("2 files");
    expect(r.stdout).toContain("only part of your uploads is shown");
  });
});

test.describe("1J verifier: Retry-After on upload parts", () => {
  async function uploadWith(partReply: (part: number, attempt: number) => Reply, size = 30) {
    const dir = await makeTempDir("up-");
    const file = join(dir, "data.bin");
    await writeFile(file, Buffer.alloc(size, 7));
    let result!: { code: number | null; stderr: string; stdout: string; log: Hit[]; took: number };
    await withServer(
      (hit, attempt) => {
        if (hit.method === "POST" && hit.path === "/api/uploads")
          return { status: 200, body: { id: "up1", part_size: 10 } };
        const m = hit.path.match(/^\/api\/uploads\/up1\/parts\/(\d+)$/);
        if (hit.method === "PUT" && m) return partReply(Number(m[1]), attempt);
        if (hit.method === "POST" && hit.path === "/api/uploads/up1/complete")
          return { status: 200, body: { url: "http://127.0.0.1/up1/data.bin" } };
        if (hit.method === "DELETE") return { status: 200, body: { deleted: 1 } };
        return { status: 404, body: { error: "nope" } };
      },
      async (env, log) => {
        const started = Date.now();
        const r = await cli(["upload", file], { env });
        result = {
          code: r.code,
          stderr: r.stderr,
          stdout: r.stdout,
          log: [...log],
          took: Date.now() - started,
        };
      },
    );
    return result;
  }
  const ok = (part: number): Reply => ({
    status: 200,
    body: { part_number: part, etag: `e${part}` },
  });

  test("a part answered 503 with Retry-After 900: upload fails fast, DELETE sent, exit 1", async () => {
    const r = await uploadWith((part) =>
      part === 2
        ? { status: 503, body: { error: "slow down" }, headers: { "Retry-After": "900" } }
        : ok(part),
    );
    const summary = r.log.map((h) => `${h.method} ${h.path.replace("/api/uploads", "")}`);
    console.log(
      `part 503 RA 900: exit ${r.code}, ${r.took} ms, ${summary.join(" | ")}, stderr ${JSON.stringify(r.stderr.slice(0, 200))}`,
    );
    expect(r.code).toBe(1);
    expect(r.took).toBeLessThan(5000);
    expect(r.log.filter((h) => h.path.endsWith("/parts/2"))).toHaveLength(1);
    expect(r.log.some((h) => h.method === "DELETE" && h.path === "/api/uploads/up1")).toBe(true);
    expect(r.log.some((h) => h.path.endsWith("/complete"))).toBe(false);
    // Round 1K: the error says when to try again.
    expect(r.stderr).toContain("slow down. Try again in 15 minutes.");
  });

  test("a part answered 429 with Retry-After 2 once: retried after ~2 s, upload completes", async () => {
    test.setTimeout(30_000);
    const r = await uploadWith((part, attempt) =>
      part === 3 && attempt === 1
        ? { status: 429, body: { error: "slow down" }, headers: { "Retry-After": "2" } }
        : ok(part),
    );
    const p3 = r.log.filter((h) => h.path.endsWith("/parts/3"));
    console.log(`part 429 RA 2: exit ${r.code}, gap ${p3[1] && p3[1].at - p3[0]!.at} ms`);
    expect(r.code).toBe(0);
    expect(p3).toHaveLength(2);
    expect(p3[1]!.at - p3[0]!.at).toBeGreaterThanOrEqual(2000 - 50);
    expect(r.log.some((h) => h.method === "DELETE")).toBe(false);
    expect(r.stdout).toContain("up1");
  });

  // Pre-existing (not 1J): after a part fails for good, the other workers go
  // on uploading the remaining parts, also after the DELETE that abandons
  // the upload. Recorded, not asserted as a defect.
  test("observed: parts PUT after the DELETE of a failed upload", async () => {
    const r = await uploadWith(
      (part) =>
        part === 2
          ? { status: 503, body: { error: "slow down" }, headers: { "Retry-After": "900" } }
          : ok(part),
      90,
    );
    const del = r.log.findIndex((h) => h.method === "DELETE");
    const after = r.log.slice(del + 1).filter((h) => h.method === "PUT").length;
    console.log(
      `9 parts, part 2 fails: DELETE at request ${del}, ${after} part PUTs after it; ${r.log.map((h) => h.method + h.path.replace("/api/uploads/up1", "")).join(" ")}`,
    );
    expect(r.code).toBe(1);
    expect(del).toBeGreaterThan(0);
  });
});
