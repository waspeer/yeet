// Independent verifier of round 2B.1 (no cap on compressed CLI zips): the
// gaps its mutants slipped through in cli-zip-tempfile.spec.ts.
//
// - zipSizeBound() is a true worst case (every byte the CLI's zip writes,
//   for long names, many empty files, empty folders and random data), and
//   is the documented formula (ceil, per entry, 64 per deflated file).
// - The threshold is "at most MAX_UNSIZED_PARTS - 1 parts" (<=, not <).
// - The test hooks cannot raise the cap or be fed a malformed bound.
// - A disk that fills up while the temporary zip is written (ENOSPC, stubbed)
//   gives the message suggesting --store and leaves nothing behind.
// - A file removed before the temporary zip reaches it leaves no file behind.
// - Every run gets a fresh, unpredictable temporary folder; others in TMPDIR
//   are left alone.
// - Ctrl-C while the unused first upload is being deleted.

import { createReadStream } from "node:fs";
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { MAX_UNSIZED_PARTS, maxUnsizedParts } from "../../../packages/cli/src/limits.js";
import { planUpload } from "../../../packages/cli/src/selection.js";
import * as uploadZip from "../../../packages/cli/src/upload-zip.js";
import { cliZipOptions, zipSizeBound } from "../../../packages/cli/src/upload-zip.js";
import { createZip } from "../../../packages/cli/src/zip.js";
import {
  cli,
  describeRun,
  expect,
  expectExitCode,
  fileWith,
  KiB,
  newConfigHome,
  randomFile,
  server,
  sleep,
  spawnCli,
  standIn,
  test,
  type StandIn,
} from "../../lib/index.js";

async function zipPlan(paths: string[]) {
  const plan = await planUpload(paths);
  if (plan.kind !== "zip") throw new Error("expected a zip");
  return plan;
}

/** The size of the zip the CLI writes for `paths` (its own options), made in-process. */
async function actualZipSize(paths: string[], store: boolean) {
  const plan = await zipPlan(paths);
  const entries = [
    ...plan.files.map((f) => ({
      path: f.path,
      size: f.size,
      lastModified: f.mtimeMs,
      stream: () => Readable.toWeb(createReadStream(f.source)) as ReadableStream<Uint8Array>,
    })),
    ...plan.dirs.map((d) => ({ path: d.path, lastModified: d.mtimeMs })),
  ];
  let size = 0;
  const reader = createZip(entries, cliZipOptions(store)).getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
  }
  return { size, bound: zipSizeBound(plan, store) };
}

/** A small folder of compressible, incompressible and stored files (about 45 KB). */
async function album(tmp: string) {
  const root = join(tmp, "album");
  await mkdir(join(root, "sub"), { recursive: true });
  await randomFile(root, 20 * KiB, "noise.bin");
  await fileWith(root, "notes.txt", "yeet ".repeat(4000));
  await randomFile(join(root, "sub"), 3 * KiB, "photo.jpg");
  return root;
}

async function cliTmpDir(tmp: string) {
  const dir = join(tmp, "cli-tmp");
  await mkdir(dir);
  return dir;
}

const contents = async (dir: string) =>
  (await readdir(dir, { recursive: true })).map(String).sort();

/** A part size at which `bound` no longer fits in MAX_UNSIZED_PARTS - 1 parts. */
const partSizeAbove = (bound: number) => Math.ceil(bound / (MAX_UNSIZED_PARTS - 1)) - 1;

function expectNothingKept(s: StandIn, code: number | null, out: string, expected: number) {
  expect(code, out).toBe(expected);
  expect(s.completes(), out).toEqual([]);
  const created = s.creates().map((_, i) => `/api/uploads/up${i + 1}`);
  expect(new Set(s.deletes().map((d) => d.path)), out).toEqual(new Set(created));
}

test.describe("verifier 2B.1: zipSizeBound()", () => {
  test("is never below the zip the CLI writes: long names, empty files and folders, random data", async ({
    tmp,
  }) => {
    // Paths of about 800 bytes (three nested 200-character folders), 300
    // empty deflated files, 50 empty folders, random data deflated and
    // stored: every per-entry overhead the zip has, many times over.
    const long = (c: string) => c.repeat(200);
    const root = join(tmp, "worst");
    const deep = join(root, long("a"), long("b"), long("c"));
    await mkdir(deep, { recursive: true });
    for (let i = 0; i < 300; i++) await writeFile(join(deep, `${i}`.padStart(200, "e")), "");
    for (let i = 0; i < 50; i++) await mkdir(join(deep, `${i}`.padStart(200, "d")));
    await randomFile(deep, 1024 * KiB, "noise.bin");
    await randomFile(deep, 1025, "odd.txt");
    await randomFile(deep, 64 * KiB, "photo.jpg");
    for (const store of [false, true]) {
      const { size, bound } = await actualZipSize([root], store);
      expect(size, `store=${store}`).toBeLessThanOrEqual(bound);
      // Headroom (bound - size) stays small: at most 162 bytes per entry
      // (a folder: 94 of its 256), 256 for the end, and the deflate allowance.
      expect(bound - size, `store=${store}`).toBeLessThan(
        354 * 162 + 256 + (store ? 0 : 400 * KiB),
      );
    }
  });

  test("is the documented formula: ceil(size/1024) + 64 per deflated file, 256 + 2 × name per entry, + 256", async ({
    tmp,
  }) => {
    const root = join(tmp, "f");
    await mkdir(join(root, "e"), { recursive: true });
    await randomFile(root, 1025, "a.txt"); // "f/a.txt", 7 bytes; ceil(1025/1024) = 2
    await randomFile(root, 10, "b.jpg"); // "f/b.jpg", stored by its extension
    const plan = await zipPlan([root]);
    const entry = (name: string) => 256 + 2 * Buffer.byteLength(name);
    const expected = 256 + entry("f/a.txt") + 1025 + 2 + 64 + entry("f/b.jpg") + 10 + entry("f/e/");
    expect(zipSizeBound(plan, false)).toBe(expected);
    expect(zipSizeBound(plan, true)).toBe(expected - 2 - 64);
  });
});

test.describe("verifier 2B.1: threshold and hooks (stand-in server)", () => {
  const streamed = MAX_UNSIZED_PARTS - 1;
  test(`a bound of exactly ${streamed} parts is streamed (at most, not below)`, async ({ tmp }) => {
    const root = await album(tmp);
    // A stored file's size adds 1:1 to the bound: pad it to a multiple of
    // `streamed`.
    const pad = join(root, "pad.jpg");
    await writeFile(pad, Buffer.alloc(1000, 7));
    const bound0 = zipSizeBound(await zipPlan([root]), false);
    await writeFile(pad, Buffer.alloc(1000 + ((streamed - (bound0 % streamed)) % streamed), 7));
    const bound = zipSizeBound(await zipPlan([root]), false);
    expect(bound % streamed).toBe(0);
    const cliTmp = await cliTmpDir(tmp);
    const s = await standIn(bound / streamed);
    try {
      const r = await cli(["upload", root], { env: { ...s.env, TMPDIR: cliTmp } });
      expectExitCode(r, 0);
      expect(r.stderr).not.toContain("temporary file");
      expect(s.creates()).toHaveLength(1);
      expect(s.create()!.json).not.toHaveProperty("size");
      expect(s.deletes()).toEqual([]);
    } finally {
      await s.close();
    }
  });

  test("YEET_TEST_MAX_UNSIZED_PARTS only lowers the cap; malformed values are ignored", () => {
    const saved = process.env.YEET_TEST_MAX_UNSIZED_PARTS;
    try {
      const max = MAX_UNSIZED_PARTS;
      expect(max).toBe(100); // round 2F
      const cases: [string | undefined, number][] = [
        [undefined, max],
        ["", max],
        [`${max}`, max],
        [`${max + 1}`, max],
        ["150", max], // the cap before round 2F
        ["1000", max],
        ["1e9", max],
        ["Infinity", max],
        ["0", max],
        ["-1", max],
        ["1.5", max],
        ["abc", max],
        ["1", 1],
        [`${max - 1}`, max - 1],
      ];
      for (const [value, expected] of cases) {
        if (value === undefined) delete process.env.YEET_TEST_MAX_UNSIZED_PARTS;
        else process.env.YEET_TEST_MAX_UNSIZED_PARTS = value;
        expect(maxUnsizedParts(), String(value)).toBe(expected);
      }
    } finally {
      if (saved === undefined) delete process.env.YEET_TEST_MAX_UNSIZED_PARTS;
      else process.env.YEET_TEST_MAX_UNSIZED_PARTS = saved;
    }
  });

  for (const env of [
    { YEET_TEST_MAX_UNSIZED_PARTS: "1000" },
    { YEET_TEST_ZIP_SIZE_BOUND: "-1" },
    { YEET_TEST_ZIP_SIZE_BOUND: "abc" },
  ]) {
    test(`the CLI ignores ${JSON.stringify(env)}: a zip over the threshold still takes the temporary file`, async ({
      tmp,
    }) => {
      const root = await album(tmp);
      const cliTmp = await cliTmpDir(tmp);
      const s = await standIn(partSizeAbove(zipSizeBound(await zipPlan([root]), false)));
      try {
        const r = await cli(["upload", root], { env: { ...s.env, ...env, TMPDIR: cliTmp } });
        expectExitCode(r, 0);
        expect(r.stderr).toContain("zipping it to a temporary file");
        expect(s.creates()).toHaveLength(2);
        expect(s.creates()[1]!.json).toHaveProperty("size");
        expect(await contents(cliTmp)).toEqual([]);
      } finally {
        await s.close();
      }
    });
  }
});

test.describe("verifier 2B.1: the temporary file (stand-in server)", () => {
  test("a disk that fills up while zipping (ENOSPC): the --store advice, nothing kept", async ({
    tmp,
  }) => {
    const root = await album(tmp);
    const cliTmp = await cliTmpDir(tmp);
    const s = await standIn(100);
    try {
      const r = await cli(["upload", root], {
        env: { ...s.env, TMPDIR: cliTmp, YEET_STUB_ENOSPC_AFTER: "1000" },
        stubs: true,
      });
      expectNothingKept(s, r.code, describeRun(r), 1);
      expect(r.stderr).toContain(
        `Upload of album.zip failed: The disk holding the temporary zip (${cliTmp}) is full. ` +
          `Use --store (no compression: no temporary file), free up space, or set TMPDIR to a ` +
          `folder on a disk with more room.`,
      );
      expect(s.creates()).toHaveLength(1);
      expect(s.puts()).toEqual([]);
      expect(await contents(cliTmp)).toEqual([]);
    } finally {
      await s.close();
    }
  });

  test("a file removed before the temporary zip reaches it: exit 1, no file left behind", async ({
    tmp,
  }) => {
    const root = await album(tmp);
    const gone = join(root, "sub", "zz-gone.txt");
    await writeFile(gone, "soon gone");
    const cliTmp = await cliTmpDir(tmp);
    // The DELETE of the unused first upload comes just before zipping starts.
    const s = await standIn(100, async (r) => {
      if (r.method === "DELETE") await rm(gone);
    });
    try {
      const r = await cli(["upload", root], { env: { ...s.env, TMPDIR: cliTmp } });
      expectNothingKept(s, r.code, describeRun(r), 1);
      expect(r.stderr).toMatch(/Upload of album\.zip failed: .*zz-gone\.txt/);
      expect(s.creates()).toHaveLength(1);
      expect(await contents(cliTmp)).toEqual([]);
    } finally {
      await s.close();
    }
  });

  test("each run gets a fresh, unpredictable folder; other folders in TMPDIR are left alone", async ({
    tmp,
  }) => {
    const root = await album(tmp);
    const cliTmp = await cliTmpDir(tmp);
    const planted = join(cliTmp, "yeet-upload");
    await mkdir(planted);
    await writeFile(join(planted, "upload.zip"), "not yours");
    const folders: string[] = [];
    const s = await standIn(
      partSizeAbove(zipSizeBound(await zipPlan([root]), false)),
      async (r) => {
        if (r.method === "PUT" && r.path.endsWith("/parts/1")) {
          const now = (await readdir(cliTmp)).filter((n) => n !== "yeet-upload");
          folders.push(...now);
        }
      },
    );
    try {
      for (let i = 0; i < 2; i++) {
        const r = await cli(["upload", root], { env: { ...s.env, TMPDIR: cliTmp } });
        expectExitCode(r, 0);
      }
      expect(folders).toHaveLength(2);
      for (const f of folders) expect(f).toMatch(/^yeet-[A-Za-z0-9]{6}$/);
      expect(folders[0]).not.toBe(folders[1]);
      expect(await contents(cliTmp)).toEqual(["yeet-upload", "yeet-upload/upload.zip"]);
      expect((await stat(join(planted, "upload.zip"))).size).toBe(9);
    } finally {
      await s.close();
    }
  });

  test("Ctrl-C while the unused first upload is deleted: exit 130, no zip written", async ({
    tmp,
  }) => {
    const root = await album(tmp);
    const cliTmp = await cliTmpDir(tmp);
    let sawDelete!: () => void;
    const deleteArrived = new Promise<void>((resolve) => (sawDelete = resolve));
    const s = await standIn(100, async (r) => {
      if (r.method !== "DELETE" || r.path !== "/api/uploads/up1") return;
      sawDelete();
      await sleep(800);
    });
    const home = await newConfigHome();
    try {
      const child = spawnCli([server.cliPath, "upload", root], {
        env: {
          ...process.env,
          ...s.env,
          TMPDIR: cliTmp,
          HOME: home,
          XDG_CONFIG_HOME: home,
          NO_COLOR: "1",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stderr = "";
      child.stderr!.setEncoding("utf-8").on("data", (c: string) => (stderr += c));
      const closed = new Promise<number | null>((resolve) => child.on("close", resolve));
      await deleteArrived;
      child.kill("SIGINT");
      const exit = await Promise.race([closed, sleep(10_000).then(() => "running")]);
      expectNothingKept(s, exit as number, stderr, 130);
      expect(stderr).toContain("Upload of album.zip cancelled; nothing was kept.");
      expect(s.creates()).toHaveLength(1);
      expect(s.puts()).toEqual([]);
      expect(await contents(cliTmp)).toEqual([]);
    } finally {
      await s.close();
    }
  });
});

// Round 2D (leftovers of 2B.1): YEET_TEST_ZIP_SIZE_BOUND could raise the
// bound as well as lower it, and the docs and --help said the temporary
// file "needs that much free disk space", which read as about 7.8 GB (the
// 150-part cap of the time).
test.describe("round 2D: the zip size hook and the free space wording", () => {
  test("YEET_TEST_ZIP_SIZE_BOUND only lowers the bound; malformed values are ignored", () => {
    const saved = process.env.YEET_TEST_ZIP_SIZE_BOUND;
    try {
      const cases: [string | undefined, number][] = [
        [undefined, 5000],
        ["", 5000],
        ["abc", 5000],
        ["-1", 5000],
        ["1.5", 5000],
        ["Infinity", 5000],
        ["5001", 5000],
        ["1000000000000", 5000],
        ["5000", 5000],
        ["4999", 4999],
        ["0", 0],
      ];
      for (const [value, expected] of cases) {
        if (value === undefined) delete process.env.YEET_TEST_ZIP_SIZE_BOUND;
        else process.env.YEET_TEST_ZIP_SIZE_BOUND = value;
        // Through the namespace, so this file still loads where it is missing.
        expect(uploadZip.testZipSizeBound(5000), String(value)).toBe(expected);
      }
    } finally {
      if (saved === undefined) delete process.env.YEET_TEST_ZIP_SIZE_BOUND;
      else process.env.YEET_TEST_ZIP_SIZE_BOUND = saved;
    }
  });

  test("a raised YEET_TEST_ZIP_SIZE_BOUND cannot send a zip that fits to the temporary file", async ({
    tmp,
  }) => {
    const root = await album(tmp);
    const cliTmp = await cliTmpDir(tmp);
    // 1 MiB parts: the album's zip (about 45 KB) streams.
    const s = await standIn(1024 * 1024);
    try {
      const r = await cli(["upload", root], {
        env: { ...s.env, TMPDIR: cliTmp, YEET_TEST_ZIP_SIZE_BOUND: "1000000000000" },
      });
      expectExitCode(r, 0);
      expect(r.stderr).not.toContain("temporary file");
      expect(s.creates()).toHaveLength(1);
      expect(s.create()!.json).not.toHaveProperty("size");
      expect(s.deletes()).toEqual([]);
      expect(await contents(cliTmp)).toEqual([]);
    } finally {
      await s.close();
    }
  });

  test("--help says how much free space the temporary file needs", async () => {
    const r = await cli(["--help"]);
    expectExitCode(r, 0);
    const help = r.stdout.replace(/\s+/g, " ");
    expect(help).toContain("(it needs about the files' size plus 256 MiB of free space)");
    expect(help).not.toContain("that much");
  });
});
