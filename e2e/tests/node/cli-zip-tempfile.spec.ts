// No cap on compressed zip uploads (round 2B.1, packages/cli/src/upload-zip.ts):
// a compressed zip whose worst-case size (zipSizeBound()) fits in the
// server's MAX_UNSIZED_PARTS parts of unknown size (100 since round 2F), a
// part to spare, is streamed; a larger
// one is zipped to a temporary file first and uploaded with its exact size
// at create.
//
// Against the stand-in server, whose part size the test picks, so a few KB
// stand in for 5.24 GB: the threshold from both sides (byte-identical zips,
// check.py), the temporary file (mode 600 in a mode-700 folder, in TMPDIR)
// and its removal on every way out (success, a server error, a file that
// changes size, Ctrl-C, SIGTERM, SIGHUP, a second Ctrl-C), the free-space
// check (statfs stubbed) and both progress lines (on a pseudo-terminal).
// Against the real Worker, with YEET_TEST_MAX_UNSIZED_PARTS=1 lowering the
// CLI's cap: the temporary-file path end to end.

import { spawn } from "node:child_process";
import { appendFile, mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { MAX_UNSIZED_PARTS } from "../../../packages/cli/src/limits.js";
import { planUpload } from "../../../packages/cli/src/selection.js";
import { formatSize } from "../../../packages/cli/src/transfer.js";
import { FREE_SPACE_MARGIN, zipSizeBound } from "../../../packages/cli/src/upload-zip.js";
import {
  cli,
  CLI_PRELOAD,
  describeRun,
  downloadBytes,
  eventually,
  expect,
  expectExitCode,
  FILENAMES,
  fileWith,
  idFromUrl,
  KiB,
  listUploads,
  newConfigHome,
  randomFile,
  server,
  sleep,
  spawnCli,
  standIn,
  test,
  type StandIn,
} from "../../lib/index.js";
import { checkStructure, failures, manifestOfFiles, validateZip } from "../../zip/validate.js";

/** A folder `<tmp>/album` (about 45 KB) with compressible, incompressible and stored files. */
async function album(tmp: string, extra: { name: string; size: number }[] = []) {
  const root = join(tmp, "album");
  await mkdir(join(root, "sub"), { recursive: true });
  const files = [
    await randomFile(root, 20 * KiB, "noise.bin"),
    await fileWith(root, "notes.txt", "yeet ".repeat(4000)),
    await randomFile(join(root, "sub"), 3 * KiB, "photo.jpg"),
    await fileWith(join(root, "sub"), FILENAMES.unicode, "ü".repeat(1000)),
  ];
  for (const e of extra) files.push(await randomFile(root, e.size, e.name));
  const zipFiles = files.map((f) => ({
    source: f.path,
    path: `album/${f.path.slice(root.length + 1)}`,
  }));
  return { root, zipFiles };
}

/** The bound the CLI computes for `paths` (deflated). */
async function boundOf(paths: string[]) {
  const plan = await planUpload(paths);
  if (plan.kind !== "zip") throw new Error("expected a zip");
  return zipSizeBound(plan, false);
}

/** A fresh folder to be the CLI's TMPDIR (os.tmpdir()), so its temporary zip can be watched. */
async function cliTmpDir(tmp: string) {
  const dir = join(tmp, "cli-tmp");
  await mkdir(dir);
  return dir;
}

/** Everything under `dir`, as relative paths ("yeet-abc123", "yeet-abc123/upload.zip"). */
async function contents(dir: string): Promise<string[]> {
  return (await readdir(dir, { recursive: true })).map(String).sort();
}

/** The temporary zip, while it exists: its folder and file, with their modes and the file's size. */
async function tempZip(dir: string) {
  const [folder, ...rest] = await readdir(dir);
  if (!folder || rest.length) return undefined;
  const file = join(dir, folder, "upload.zip");
  const [d, f] = await Promise.all([stat(join(dir, folder)), stat(file).catch(() => undefined)]);
  if (!f) return undefined;
  return { folder, dirMode: d.mode & 0o777, fileMode: f.mode & 0o777, size: f.size };
}

/** The zip the stand-in received, checked with check.py against the source files. */
async function expectValidZip(
  s: StandIn,
  tmp: string,
  zipFiles: { path: string; source: string }[],
) {
  const zip = s.zip();
  const path = join(tmp, `got-${Date.now()}.zip`);
  await writeFile(path, zip);
  const check = await checkStructure(path, await manifestOfFiles(zipFiles));
  expect(check.ok, check.output).toBe(true);
  return zip;
}

/** Start `yeet upload <args>` against `s` with TMPDIR=`cliTmp`, for tests that send signals. */
async function start(
  s: StandIn,
  cliTmp: string,
  args: string[],
  { env = {}, stubs = false }: { env?: Record<string, string>; stubs?: boolean } = {},
) {
  const home = await newConfigHome();
  const child = spawnCli(
    [...(stubs ? ["--import", CLI_PRELOAD] : []), server.cliPath, "upload", ...args],
    {
      env: {
        ...process.env,
        ...s.env,
        ...env,
        TMPDIR: cliTmp,
        HOME: home,
        XDG_CONFIG_HOME: home,
        NO_COLOR: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stderr = "";
  child.stderr!.setEncoding("utf-8").on("data", (c: string) => (stderr += c));
  const closed = new Promise<number | null>((resolve) => child.on("close", resolve));
  return { child, closed, stderr: () => stderr };
}

/** Assert a temporary-file upload failed: exit `code`, never completed, every upload deleted. */
function expectNothingKept(s: StandIn, code: number | null, stderr: string, expected: number) {
  expect(code, stderr).toBe(expected);
  expect(s.completes(), stderr).toEqual([]);
  const created = s.creates().map((_, i) => `/api/uploads/up${i + 1}`);
  expect(new Set(s.deletes().map((d) => d.path))).toEqual(new Set(created));
}

test.describe("yeet upload: compressed zips of any size (stand-in server)", () => {
  test("just below the threshold it streams, just above it zips to a temporary file; same bytes", async ({
    tmp,
  }) => {
    const { root, zipFiles } = await album(tmp);
    const bound = await boundOf([root]);
    // Streamed iff bound <= MAX_UNSIZED_PARTS - 1 parts (a part to spare).
    const streamedParts = MAX_UNSIZED_PARTS - 1;
    const below = Math.ceil(bound / streamedParts);
    const above = below - 1;
    expect(bound).toBeLessThanOrEqual(streamedParts * below);
    expect(bound).toBeGreaterThan(streamedParts * above);
    const cliTmp = await cliTmpDir(tmp);

    // Below: one upload of unknown size, its size at complete, no temporary file.
    let tempSeen: string[] = [];
    const streamed = await standIn(below, async (r) => {
      if (r.method === "PUT") tempSeen = tempSeen.concat(await contents(cliTmp));
    });
    let streamedZip: Buffer;
    try {
      const r = await cli(["upload", root], { env: { ...streamed.env, TMPDIR: cliTmp } });
      expectExitCode(r, 0);
      expect(r.stderr).not.toMatch(/temporary file/);
      expect(streamed.creates()).toHaveLength(1);
      expect(streamed.create()!.json).not.toHaveProperty("size");
      streamedZip = await expectValidZip(streamed, tmp, zipFiles);
      expect(streamed.completes()[0]!.json).toMatchObject({ size: streamedZip.length });
      expect(streamed.puts().length).toBe(Math.ceil(streamedZip.length / below));
      expect(streamed.deletes()).toEqual([]);
      expect(tempSeen).toEqual([]);
    } finally {
      await streamed.close();
    }

    // Above: the first upload (no size) is deleted unused; the zip is written
    // to a temporary file (600, in a 700 folder), then uploaded with its size.
    let seen: Awaited<ReturnType<typeof tempZip>>;
    const viaFile = await standIn(above, async (r) => {
      if (r.method === "PUT") seen ??= await tempZip(cliTmp);
    });
    try {
      const r = await cli(["upload", root], { env: { ...viaFile.env, TMPDIR: cliTmp } });
      expectExitCode(r, 0);
      expect(r.stdout).toBe("http://127.0.0.1/up2/stand-in.zip\n");
      expect(r.stderr).toContain(
        `The zip may be larger than ${formatSize(MAX_UNSIZED_PARTS * above)}, the most yeet streams without ` +
          `knowing its size up front: zipping it to a temporary file in ${cliTmp} first.`,
      );
      const [first, second] = viaFile.creates();
      expect(viaFile.creates()).toHaveLength(2);
      expect(first!.json).not.toHaveProperty("size");
      expect(viaFile.deletes().map((d) => d.path)).toEqual(["/api/uploads/up1"]);
      expect(viaFile.deletes()[0]!.receivedAt).toBeLessThan(second!.receivedAt);
      const zip = await expectValidZip(viaFile, tmp, zipFiles);
      expect(second!.json).toMatchObject({ filename: "album.zip", size: zip.length });
      expect(viaFile.completes()[0]!.path).toBe("/api/uploads/up2/complete");
      expect(viaFile.completes()[0]!.json).toMatchObject({ size: zip.length });
      expect(viaFile.puts().every((p) => p.path.startsWith("/api/uploads/up2/"))).toBe(true);
      expect(seen).toMatchObject({ dirMode: 0o700, fileMode: 0o600, size: zip.length });
      expect(seen!.folder).toMatch(/^yeet-/);
      // The same bytes either way, and the temporary file is gone.
      expect(zip.equals(streamedZip)).toBe(true);
      expect(await contents(cliTmp)).toEqual([]);
    } finally {
      await viaFile.close();
    }
  });

  test("stored files alone over the limit (once refused): zipped to a temporary file", async ({
    tmp,
  }) => {
    const root = join(tmp, "photos");
    await mkdir(root);
    const photo = await randomFile(root, 20 * KiB, "IMG_0001.JPG"); // stored by its extension
    const notes = await fileWith(root, "notes.txt", "deflated");
    const cliTmp = await cliTmpDir(tmp);
    const s = await standIn(100);
    try {
      const r = await cli(["upload", root], { env: { ...s.env, TMPDIR: cliTmp } });
      expectExitCode(r, 0);
      const zip = await expectValidZip(s, tmp, [
        { path: "photos/IMG_0001.JPG", source: photo.path },
        { path: "photos/notes.txt", source: notes.path },
      ]);
      expect(s.creates()[1]!.json).toMatchObject({ size: zip.length });
      // More parts than an upload of unknown size may have: no cap.
      expect(s.puts().length).toBeGreaterThan(MAX_UNSIZED_PARTS);
      expect(await contents(cliTmp)).toEqual([]);
    } finally {
      await s.close();
    }
  });

  test("not enough free disk space: a clear message suggesting --store, nothing written", async ({
    tmp,
  }) => {
    const { root } = await album(tmp);
    const bound = await boundOf([root]);
    const cliTmp = await cliTmpDir(tmp);
    const s = await standIn(100);
    try {
      // One byte short of what is needed (statfs stubbed in the CLI).
      const r = await cli(["upload", root], {
        env: {
          ...s.env,
          TMPDIR: cliTmp,
          YEET_STUB_FREE_BYTES: String(bound + FREE_SPACE_MARGIN - 1),
        },
        stubs: true,
      });
      expectExitCode(r, 1);
      expect(r.stderr, describeRun(r)).toMatch(
        new RegExp(
          `Upload of album\\.zip failed: Not enough free disk space\\. A compressed zip that may ` +
            `be larger than ${formatSize(MAX_UNSIZED_PARTS * 100).replace(".", "\\.")} is written to a temporary file before it is uploaded, ` +
            `which needs [\\d.]+ MB free in ${cliTmp} \\([\\d.]+ MB is free\\)\\. Use --store`,
        ),
      );
      expect(s.creates()).toHaveLength(1);
      expect(s.deletes().map((d) => d.path)).toEqual(["/api/uploads/up1"]);
      expect(s.puts()).toEqual([]);
      expect(await contents(cliTmp)).toEqual([]);
      // With exactly enough it goes ahead.
      const ok = await cli(["upload", root], {
        env: {
          ...s.env,
          TMPDIR: cliTmp,
          YEET_STUB_FREE_BYTES: String(bound + FREE_SPACE_MARGIN),
        },
        stubs: true,
      });
      expectExitCode(ok, 0);
    } finally {
      await s.close();
    }
  });

  test("a server error while the temporary zip uploads: deleted, never completed, file removed", async ({
    tmp,
  }) => {
    const { root } = await album(tmp);
    const cliTmp = await cliTmpDir(tmp);
    let during: Awaited<ReturnType<typeof tempZip>>;
    const s = await standIn(100, async (r) => {
      if (r.path === "/api/uploads/up2/parts/2") {
        during = await tempZip(cliTmp);
        return 400;
      }
    });
    try {
      const r = await cli(["upload", root], { env: { ...s.env, TMPDIR: cliTmp } });
      expectNothingKept(s, r.code, describeRun(r), 1);
      expect(r.stderr).toMatch(/Upload of album\.zip failed: stand-in error/);
      expect(r.stderr).toContain("Nothing was kept on the server.");
      expect(during, "the temporary zip existed while it uploaded").toBeDefined();
      expect(await contents(cliTmp)).toEqual([]);
    } finally {
      await s.close();
    }
  });

  test("a file that changes size while it is zipped: no second upload, file removed", async ({
    tmp,
  }) => {
    const { root } = await album(tmp);
    const later = join(root, "sub", "zz-later.txt");
    await writeFile(later, "0123456789");
    const cliTmp = await cliTmpDir(tmp);
    // The DELETE of the unused first upload comes just before zipping starts.
    const s = await standIn(100, async (r) => {
      if (r.method === "DELETE") await appendFile(later, "more");
    });
    try {
      const r = await cli(["upload", root], { env: { ...s.env, TMPDIR: cliTmp } });
      expectNothingKept(s, r.code, describeRun(r), 1);
      expect(r.stderr).toMatch(
        /"album\/sub\/zz-later\.txt" yielded 14 bytes, expected 10 \(changed while reading\?\)/,
      );
      expect(s.creates()).toHaveLength(1);
      expect(s.puts()).toEqual([]);
      expect(await contents(cliTmp)).toEqual([]);
    } finally {
      await s.close();
    }
  });

  for (const [signal, code] of [
    ["SIGINT", 130],
    ["SIGTERM", 143],
    ["SIGHUP", 129],
  ] as const) {
    test(`${signal} while zipping to the temporary file: exit ${code}, file removed`, async ({
      tmp,
    }) => {
      // Reads of "slow*" files wait 200 ms each (stubbed), so zipping its
      // 4 MiB in 1 MiB reads takes about a second.
      const { root } = await album(tmp, [{ name: "slow.bin", size: 4 * 1024 * KiB }]);
      const cliTmp = await cliTmpDir(tmp);
      const s = await standIn(100);
      try {
        const run = await start(s, cliTmp, [root], {
          env: { YEET_STUB_SLOW_READ_MS: "200" },
          stubs: true,
        });
        const during = await eventually(() => tempZip(cliTmp), {
          intervalMs: 20,
          message: "the temporary zip",
        });
        expect(during).toMatchObject({ dirMode: 0o700, fileMode: 0o600 });
        run.child.kill(signal);
        const exit = await Promise.race([run.closed, sleep(10_000).then(() => "running")]);
        expectNothingKept(s, exit as number, run.stderr(), code);
        expect(run.stderr()).toContain("Upload of album.zip cancelled; nothing was kept.");
        expect(s.creates()).toHaveLength(1); // zipping never finished
        expect(await contents(cliTmp)).toEqual([]);
      } finally {
        await s.close();
      }
    });
  }

  for (const [signal, code] of [
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ] as const) {
    test(`${signal} while the temporary zip uploads: parts finish, deleted, file removed`, async ({
      tmp,
    }) => {
      const { root } = await album(tmp);
      const cliTmp = await cliTmpDir(tmp);
      let sawPart!: () => void;
      const partArrived = new Promise<void>((resolve) => (sawPart = resolve));
      let release!: () => void;
      const released = new Promise<void>((resolve) => (release = resolve));
      const s = await standIn(100, async (r) => {
        if (r.method !== "PUT") return;
        sawPart();
        await released;
      });
      try {
        const run = await start(s, cliTmp, [root]);
        await partArrived;
        expect(await tempZip(cliTmp)).toBeDefined();
        run.child.kill(signal);
        await sleep(300);
        release();
        const exit = await Promise.race([run.closed, sleep(10_000).then(() => "running")]);
        expectNothingKept(s, exit as number, run.stderr(), code);
        expect(s.deletes().map((d) => d.path)).toContain("/api/uploads/up2");
        expect(s.puts().length).toBeLessThanOrEqual(3);
        expect(await contents(cliTmp)).toEqual([]);
      } finally {
        await s.close();
      }
    });
  }

  test("a second Ctrl-C quits at once and still removes the temporary file", async ({ tmp }) => {
    const { root } = await album(tmp);
    const cliTmp = await cliTmpDir(tmp);
    let sawPart!: () => void;
    const partArrived = new Promise<void>((resolve) => (sawPart = resolve));
    const s = await standIn(100, (r) => {
      if (r.method !== "PUT") return;
      sawPart();
      return "hold"; // never answered: the first Ctrl-C would wait 30 s
    });
    try {
      const run = await start(s, cliTmp, [root]);
      await partArrived;
      expect(await tempZip(cliTmp)).toBeDefined();
      run.child.kill("SIGINT");
      await sleep(300);
      const sentAt = performance.now();
      run.child.kill("SIGINT");
      const exit = await Promise.race([run.closed, sleep(5000).then(() => "running")]);
      expect(exit, run.stderr()).toBe(130);
      expect(performance.now() - sentAt).toBeLessThan(2000);
      expect(run.stderr()).toContain(
        "Quit without waiting; the server's cleanup removes the unfinished upload.",
      );
      expect(s.completes()).toEqual([]);
      expect(await contents(cliTmp)).toEqual([]);
    } finally {
      await s.close();
    }
  });

  test("on a terminal: a Zipping progress line, then the upload's", async ({ tmp }) => {
    test.skip(process.platform !== "darwin", "uses macOS script(1) for a pseudo-terminal");
    const { root } = await album(tmp, [{ name: "slow.bin", size: 2 * 1024 * KiB }]);
    const cliTmp = await cliTmpDir(tmp);
    const s = await standIn(64 * KiB);
    const home = await newConfigHome();
    try {
      // script(1) runs the CLI on a pseudo-terminal and copies what it writes to stdout.
      const child = spawn(
        "/usr/bin/script",
        [
          "-q",
          "/dev/null",
          process.execPath,
          "--import",
          CLI_PRELOAD,
          server.cliPath,
          "upload",
          root,
        ],
        {
          env: {
            ...process.env,
            ...s.env,
            YEET_TEST_MAX_UNSIZED_PARTS: "1",
            YEET_STUB_SLOW_READ_MS: "300",
            TMPDIR: cliTmp,
            HOME: home,
            XDG_CONFIG_HOME: home,
            NO_COLOR: "1",
          },
          stdio: ["ignore", "pipe", "pipe"],
          detached: true,
        },
      );
      let out = "";
      child.stdout.setEncoding("utf-8").on("data", (c: string) => (out += c));
      try {
        const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
        expect(code, out).toBe(0);
      } finally {
        try {
          process.kill(-child.pid!, "SIGKILL");
        } catch {
          // exited
        }
      }
      const zipping = out.indexOf("Zipping album.zip  ");
      const uploading = out.lastIndexOf("\x1b[Kalbum.zip  ");
      expect(zipping, out).toBeGreaterThanOrEqual(0);
      expect(uploading, out).toBeGreaterThan(zipping);
      expect(out).toMatch(/Zipping album\.zip +\d+% .* file \d of 5/);
      expect(out).toContain("http://127.0.0.1/up2/stand-in.zip");
      expect(await contents(cliTmp)).toEqual([]);
    } finally {
      await s.close();
    }
  });
});

test.describe("yeet upload: a zip through a temporary file on the real server", () => {
  test("downloaded intact and byte-identical to the same folder streamed", async ({ tmp }) => {
    const { root, zipFiles } = await album(tmp, [{ name: "more.bin", size: 300 * KiB }]);
    const cliTmp = await cliTmpDir(tmp);
    const download = async (env: Record<string, string>) => {
      const r = await cli(["upload", root, "--expires", "1d"], {
        auth: true,
        env: { TMPDIR: cliTmp, ...env },
      });
      expectExitCode(r, 0);
      const url = r.stdout.trim();
      const bytes = await downloadBytes(url);
      const listed = (await listUploads()).find((u) => u.id === idFromUrl(url));
      expect(listed?.filename).toBe("album.zip");
      expect(listed?.file_size).toBe(bytes.length);
      return { r, bytes };
    };
    // YEET_TEST_MAX_UNSIZED_PARTS=1: no zip fits "a part below one part", so
    // this one takes the temporary-file path against 50 MiB parts.
    const viaFile = await download({ YEET_TEST_MAX_UNSIZED_PARTS: "1" });
    expect(viaFile.r.stderr).toContain("zipping it to a temporary file");
    expect(await contents(cliTmp)).toEqual([]);
    const streamed = await download({});
    expect(streamed.r.stderr).not.toContain("temporary file");
    expect(viaFile.bytes.equals(streamed.bytes)).toBe(true);
    const path = join(tmp, "download.zip");
    await writeFile(path, viaFile.bytes);
    const results = await validateZip(path, await manifestOfFiles(zipFiles), {
      readers: ["structural", "python zipfile", "unzip -t", "unzip -x", "bsdtar (stdin)"],
    });
    expect(failures(results)).toEqual([]);
  });
});
