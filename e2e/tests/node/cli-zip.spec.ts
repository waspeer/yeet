// `yeet upload <file1> <file2> …` and `yeet upload <folder>`: zip while
// uploading (packages/cli/src/selection.ts, upload-zip.ts). Three layers:
//
// 1. what gets zipped (planUpload, imported directly);
// 2. the upload against a stand-in server that records every request, with
//    tiny part sizes so small files take many parts: exact part sizes, the
//    size at complete, and every failure path (unreadable file, a file that
//    changes while it is read, a part that keeps failing, Ctrl-C, the
//    150-part limit of uploads of unknown size): DELETE, never complete;
// 3. the real Worker (wrangler dev): zips of several files and of a folder
//    downloaded and checked with check.py and per-entry SHA-256, and a failed
//    upload that leaves nothing in the bucket.

import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  appendFile,
  chmod,
  mkdir,
  readFile,
  stat,
  symlink,
  truncate,
  utimes,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { MAX_UNSIZED_PARTS as CLI_MAX_UNSIZED_PARTS } from "../../../packages/cli/src/limits.js";
import { planUpload, SelectionError, timestampName } from "../../../packages/cli/src/selection.js";
import { MAX_UNSIZED_PARTS } from "../../../packages/worker/src/uploads.js";
import {
  cli,
  describeRun,
  eventually,
  downloadBytes,
  expect,
  expectExitCode,
  FILENAMES,
  fileWith,
  idFromUrl,
  KiB,
  listObjects,
  listUploads,
  MiB,
  newConfigHome,
  randomFile,
  server,
  startServer,
  test,
} from "../../lib/index.js";
import { checkStructure, failures, manifestOfFiles, validateZip } from "../../zip/validate.js";

const plan = async (paths: string[], now?: Date) => {
  const p = await planUpload(paths, now);
  if (p.kind !== "zip") throw new Error(`expected a zip plan, got ${p.kind}`);
  return p;
};

// ---------------------------------------------------------------------------
// 1. What gets zipped
// ---------------------------------------------------------------------------

test.describe("yeet upload: what gets zipped", () => {
  test("one file is uploaded as-is; a missing path is an error", async ({ tmp }) => {
    const f = await fileWith(tmp, "song.wav", "RIFF");
    expect(await planUpload([f.path])).toEqual({
      kind: "file",
      source: f.path,
      name: "song.wav",
      size: 4,
    });
    await expect(planUpload([join(tmp, "nope.txt")])).rejects.toThrow(/File not found: .*nope/);
    await expect(planUpload([])).rejects.toBeInstanceOf(SelectionError);
  });

  test("a folder: <folder>.zip with the folder as the single top-level entry", async ({ tmp }) => {
    const root = join(tmp, "Stems v2");
    await mkdir(join(root, "b/deeper"), { recursive: true });
    await mkdir(join(root, "empty/also-empty"), { recursive: true });
    await mkdir(join(root, "only-ds"), { recursive: true });
    await writeFile(join(root, "a.txt"), "a");
    await writeFile(join(root, "b/deeper/c.txt"), "cc");
    await writeFile(join(root, ".DS_Store"), "junk");
    await writeFile(join(root, "b/.DS_Store"), "junk");
    await writeFile(join(root, "only-ds/.DS_Store"), "junk");
    await writeFile(join(tmp, "outside.txt"), "outside");
    await symlink(join(tmp, "outside.txt"), join(root, "link-to-file.txt"));
    await symlink(tmp, join(root, "link-to-folder"));
    await symlink(join(tmp, "gone"), join(root, "broken-link"));
    const p = await plan([root]);
    expect(p.name).toBe("Stems v2.zip");
    expect(p.files.map((f) => [f.path, f.size])).toEqual([
      ["Stems v2/a.txt", 1],
      ["Stems v2/b/deeper/c.txt", 2],
      ["Stems v2/link-to-file.txt", 7],
    ]);
    expect(p.dirs.map((d) => d.path)).toEqual(["Stems v2/empty/also-empty/", "Stems v2/only-ds/"]);
    expect(p.totalSize).toBe(10);
    expect(p.warnings.join("\n")).toMatch(/Skipped .*broken-link: a symbolic link to nothing/);
    expect(p.warnings.join("\n")).toMatch(/Skipped .*link-to-folder: a symbolic link to a folder/);
    // A trailing slash and "." name the same folder.
    expect((await plan([root + "/"])).name).toBe("Stems v2.zip");
    expect((await plan(["."].map((d) => join(root, d)))).name).toBe("Stems v2.zip");
  });

  test("several paths: yeet-<timestamp>.zip, files at the top level, folders as entries", async ({
    tmp,
  }) => {
    const a = await fileWith(tmp, FILENAMES.unicode, "u");
    const b = await fileWith(tmp, FILENAMES.spaces, "s");
    await mkdir(join(tmp, "folder"));
    await writeFile(join(tmp, "folder", FILENAMES.punctuation), "p");
    const now = new Date(2026, 9, 10, 9, 5, 7);
    expect(timestampName(now)).toBe("yeet-20261010-090507.zip");
    const p = await plan([a.path, b.path, join(tmp, "folder")], now);
    expect(p.name).toBe("yeet-20261010-090507.zip");
    expect(p.files.map((f) => f.path)).toEqual([
      FILENAMES.unicode,
      FILENAMES.spaces,
      `folder/${FILENAMES.punctuation}`,
    ]);
  });

  test("paths are NFC and made safe for Windows, with a note", async ({ tmp }) => {
    const root = join(tmp, "names");
    await mkdir(root);
    for (const name of ["café.txt", "a:b.txt", "CON.txt", "trailing. ", "ok.txt"]) {
      await writeFile(join(root, name), name);
    }
    const p = await plan([root]);
    expect(p.files.map((f) => f.path).sort()).toEqual(
      [
        "names/_CON.txt",
        "names/a_b.txt",
        "names/café.txt",
        "names/ok.txt",
        "names/trailing",
      ].sort(),
    );
    expect(p.files.every((f) => f.path === f.path.normalize("NFC"))).toBe(true);
    expect(p.warnings[0]).toMatch(/^Renamed 3 names so Windows can unzip them: /);
  });

  test("names that collide in the zip are an error naming both", async ({ tmp }) => {
    const pairs: [string, string, boolean][] = [
      ["Readme.txt", "readme.txt", false], // case
      ["café.txt", "café.txt", false], // NFC vs NFD
      ["x:y.txt", "x?y.txt", false], // both become x_y.txt
      ["data", "data", true], // a file and a folder of the same name
    ];
    for (const [i, [first, second, secondIsDir]] of pairs.entries()) {
      const one = join(tmp, `c${i}`, "one");
      const two = join(tmp, `c${i}`, "two");
      await mkdir(one, { recursive: true });
      await mkdir(two, { recursive: true });
      await writeFile(join(one, first), "1");
      if (secondIsDir) {
        await mkdir(join(two, second));
        await writeFile(join(two, second, "inside.txt"), "2");
      } else await writeFile(join(two, second), "2");
      const err = await planUpload([join(one, first), join(two, second)]).catch((e) => e);
      expect(err, `${first} / ${second}`).toBeInstanceOf(SelectionError);
      expect(String(err)).toMatch(/would both be .* in the zip .*Rename one of them/);
      expect(String(err)).toContain(join(one, first));
    }
  });

  test("an empty selection is refused", async ({ tmp }) => {
    const onlyJunk = join(tmp, "junk");
    await mkdir(join(onlyJunk, "empty"), { recursive: true });
    await writeFile(join(onlyJunk, ".DS_Store"), "x");
    await expect(planUpload([onlyJunk])).rejects.toThrow(
      /Nothing to upload: .*junk contains no files \(\.DS_Store is skipped\)/,
    );
    await expect(planUpload([onlyJunk, join(onlyJunk, ".DS_Store")])).rejects.toThrow(
      /contain no files/,
    );
  });

  test("a path of 260+ characters gets a warning (Windows Explorer)", async ({ tmp }) => {
    const deep = join(tmp, "long", ...Array.from({ length: 6 }, (_, i) => `${i}`.repeat(50)));
    await mkdir(deep, { recursive: true });
    await writeFile(join(deep, "file.txt"), "x");
    const p = await plan([join(tmp, "long")]);
    expect(p.warnings.join("\n")).toMatch(/is \d{3} characters long; Windows Explorer/);
  });

  test("the CLI's 150-part limit for zips of unknown size is the server's", () => {
    expect(CLI_MAX_UNSIZED_PARTS).toBe(MAX_UNSIZED_PARTS);
  });
});

// ---------------------------------------------------------------------------
// 2. Against a stand-in server
// ---------------------------------------------------------------------------

interface Recorded {
  method: string;
  path: string;
  body: Buffer;
  json?: Record<string, unknown>;
}

/**
 * A stand-in yeet server with a tiny part size. `onRequest` may act on a
 * request (change a file, hold the answer) and return a status to send
 * instead of the normal answer.
 */
async function standIn(
  partSize: number,
  onRequest?: (
    r: Recorded,
  ) => Promise<number | "hold" | undefined | void> | number | "hold" | undefined | void,
) {
  const requests: Recorded[] = [];
  const srv = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("error", () => {});
    req.on("end", async () => {
      const path = new URL(req.url!, "http://x").pathname;
      const body = Buffer.concat(chunks);
      const r: Recorded = { method: req.method!, path, body };
      if (req.headers["content-type"] === "application/json" && body.length)
        r.json = JSON.parse(body.toString());
      requests.push(r);
      const override = await onRequest?.(r);
      if (override === "hold") return;
      const part = path.match(/\/parts\/(\d+)$/);
      const status =
        typeof override === "number"
          ? override
          : req.method === "POST" && path === "/api/uploads"
            ? 201
            : 200;
      const reply =
        status >= 400
          ? { error: "stand-in error" }
          : req.method === "POST" && path === "/api/uploads"
            ? { id: "up1", part_size: partSize }
            : part
              ? { part_number: Number(part[1]), etag: `e${part[1]}` }
              : path.endsWith("/complete")
                ? { url: "http://127.0.0.1/up1/stand-in.zip" }
                : { deleted: "up1" };
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(reply));
    });
  });
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  return {
    url,
    requests,
    env: { YEET_URL: url, YEET_TOKEN: "a-token-of-16-chars-or-more" },
    puts: () => requests.filter((r) => r.method === "PUT"),
    create: () => requests.find((r) => r.method === "POST" && r.path === "/api/uploads"),
    completes: () => requests.filter((r) => r.path.endsWith("/complete")),
    deletes: () => requests.filter((r) => r.method === "DELETE"),
    /** The parts in order, concatenated: the zip as the server would store it. */
    zip: () =>
      Buffer.concat(
        requests
          .filter((r) => r.method === "PUT")
          .sort((a, b) => Number(a.path.split("/").pop()) - Number(b.path.split("/").pop()))
          .map((r) => r.body),
      ),
    close: async () => {
      srv.closeAllConnections();
      await new Promise((resolve) => srv.close(resolve));
    },
  };
}

/** A folder `<tmp>/album` with a mix of compressible, incompressible and stored files. */
async function album(tmp: string) {
  const root = join(tmp, "album");
  await mkdir(join(root, "sub"), { recursive: true });
  const files = [
    await randomFile(root, 20 * KiB, "noise.bin"),
    await fileWith(root, "notes.txt", "yeet ".repeat(4000)),
    await randomFile(join(root, "sub"), 3 * KiB, "photo.jpg"),
    await fileWith(join(root, "sub"), FILENAMES.unicode, "ü".repeat(1000)),
  ];
  const zipFiles = files.map((f) => ({
    source: f.path,
    path: `album/${f.path.slice(root.length + 1)}`,
  }));
  return { root, files, zipFiles };
}

test.describe("yeet upload <folder>: the upload (stand-in server)", () => {
  test("parts of exactly part_size (the last shorter), the size at complete, a valid zip", async ({
    tmp,
  }) => {
    const { root, zipFiles } = await album(tmp);
    const s = await standIn(1000);
    try {
      const r = await cli(["upload", root], { env: s.env });
      expectExitCode(r, 0);
      expect(r.stdout).toBe("http://127.0.0.1/up1/stand-in.zip\n");
      expect(r.stderr).toContain("Zipping 4 files (");
      // A deflated zip's size is unknown at create: no size there...
      expect(s.create()!.json).toMatchObject({ filename: "album.zip" });
      expect(s.create()!.json).not.toHaveProperty("size");
      const zip = s.zip();
      const sizes = s.puts().map((p) => p.body.length);
      expect(sizes.length).toBe(Math.ceil(zip.length / 1000));
      expect(sizes.slice(0, -1).every((n) => n === 1000)).toBe(true);
      expect(sizes.at(-1)).toBe(zip.length - 1000 * (sizes.length - 1));
      // ...but at complete, with every part in order.
      const [complete] = s.completes();
      expect(complete!.json).toEqual({
        size: zip.length,
        parts: sizes.map((_, i) => ({ part_number: i + 1, etag: `e${i + 1}` })),
      });
      expect(s.deletes()).toEqual([]);
      const path = join(tmp, "got.zip");
      await writeFile(path, zip);
      const check = await checkStructure(path, await manifestOfFiles(zipFiles));
      expect(check.ok, check.output).toBe(true);
    } finally {
      await s.close();
    }
  });

  test("--store: the size is known up front, sent at create and at complete; no part limit", async ({
    tmp,
  }) => {
    const { root, zipFiles } = await album(tmp);
    // 100-byte parts: the ~50 KB zip takes far more than 150 parts.
    const s = await standIn(100);
    try {
      const r = await cli(["upload", root, "--store"], { env: s.env, timeoutMs: 120_000 });
      expectExitCode(r, 0);
      const zip = s.zip();
      expect(s.puts().length).toBeGreaterThan(CLI_MAX_UNSIZED_PARTS);
      expect(s.create()!.json).toMatchObject({ filename: "album.zip", size: zip.length });
      expect(s.completes()[0]!.json).toMatchObject({ size: zip.length });
      const path = join(tmp, "got.zip");
      await writeFile(path, zip);
      const check = await checkStructure(path, await manifestOfFiles(zipFiles));
      expect(check.ok, check.output).toBe(true);
      // Stored: every entry's method is 0 (Python agrees, and the bytes are there as-is).
      const results = await validateZip(path, await manifestOfFiles(zipFiles), {
        readers: ["python zipfile", "unzip -t"],
      });
      expect(failures(results)).toEqual([]);
      expect(zip.includes(await readFile(zipFiles[0]!.source))).toBe(true);
    } finally {
      await s.close();
    }
  });

  test("one file is still uploaded as it is, not zipped", async ({ tmp }) => {
    const f = await randomFile(tmp, 2500, "single.bin");
    const s = await standIn(1000);
    try {
      expectExitCode(await cli(["upload", f.path, "--store"], { env: s.env }), 0);
      expect(s.create()!.json).toMatchObject({ filename: "single.bin", size: 2500 });
      expect(s.zip().equals(await readFile(f.path))).toBe(true);
    } finally {
      await s.close();
    }
  });

  test("an empty selection: exit 1 with a clear message, no request", async ({ tmp }) => {
    const empty = join(tmp, "empty");
    await mkdir(empty);
    await writeFile(join(empty, ".DS_Store"), "x");
    const s = await standIn(1000);
    try {
      const r = await cli(["upload", empty], { env: s.env });
      expectExitCode(r, 1);
      expect(r.stderr).toMatch(/Nothing to upload: .*empty contains no files/);
      expect(s.requests).toEqual([]);
    } finally {
      await s.close();
    }
  });

  /** Assert an upload failed, was deleted and never completed. */
  const expectAborted = (
    s: Awaited<ReturnType<typeof standIn>>,
    r: Awaited<ReturnType<typeof cli>>,
    message: RegExp,
  ) => {
    expectExitCode(r, 1);
    expect(r.stderr, describeRun(r)).toMatch(message);
    expect(r.stderr).toContain("Nothing was kept on the server.");
    expect(s.completes(), describeRun(r)).toEqual([]);
    expect(s.deletes().map((d) => d.path)).toContain("/api/uploads/up1");
    expect(r.stdout).toBe("");
  };

  test("a file that cannot be read: the upload is deleted, never completed", async ({ tmp }) => {
    const { root } = await album(tmp);
    const locked = join(root, "sub", "zz-locked.txt");
    await writeFile(locked, "secret");
    await chmod(locked, 0o000);
    const s = await standIn(1000);
    try {
      const r = await cli(["upload", root], { env: s.env });
      expectAborted(s, r, /Upload of album\.zip failed: .*(EACCES|permission denied)/);
      expect(s.puts().length).toBeGreaterThan(0); // it failed part-way, not up front
    } finally {
      await chmod(locked, 0o644);
      await s.close();
    }
  });

  for (const change of ["grows", "shrinks"] as const) {
    test(`a file that ${change} while the zip is uploading: deleted, never completed`, async ({
      tmp,
    }) => {
      const { root } = await album(tmp);
      // Zipped after noise.bin and notes.txt (sorted), so it is read long after part 1.
      const later = join(root, "sub", "zz-later.txt");
      await writeFile(later, "0123456789");
      const s = await standIn(1000, async (r) => {
        if (r.path.endsWith("/parts/1")) {
          if (change === "grows") await appendFile(later, "more");
          else await truncate(later, 3);
        }
      });
      try {
        const r = await cli(["upload", root], { env: s.env });
        expectAborted(
          s,
          r,
          new RegExp(
            `"album/sub/zz-later.txt" yielded ${change === "grows" ? 14 : 3} bytes, expected 10 \\(changed while reading\\?\\)`,
          ),
        );
      } finally {
        await s.close();
      }
    });
  }

  test("a part that keeps failing (after 4 tries): deleted, never completed", async ({ tmp }) => {
    const { root } = await album(tmp);
    const s = await standIn(1000, (r) => (r.path.endsWith("/parts/2") ? 503 : undefined));
    try {
      const r = await cli(["upload", root], { env: s.env });
      expectAborted(s, r, /Upload of album\.zip failed: stand-in error/);
      expect(s.puts().filter((p) => p.path.endsWith("/parts/2"))).toHaveLength(4);
    } finally {
      await s.close();
    }
  });

  test("a zip of unknown size past 150 parts: stopped before part 151, deleted", async ({
    tmp,
  }) => {
    // 20 KB of noise deflates to about 20 KB: about 200 parts of 100 bytes.
    const root = join(tmp, "big");
    await mkdir(root);
    await randomFile(root, 20 * KiB, "noise.bin");
    const s = await standIn(100);
    try {
      const r = await cli(["upload", root], { env: s.env, timeoutMs: 120_000 });
      expectAborted(s, r, /The zip would be larger than 15\.0 KB \(150 parts of 100 B\).*--store/);
      const numbers = s.puts().map((p) => Number(p.path.split("/").pop()));
      expect(Math.max(...numbers)).toBeLessThanOrEqual(CLI_MAX_UNSIZED_PARTS);
    } finally {
      await s.close();
    }
  });

  test("stored files alone over the limit: refused before any part is sent", async ({ tmp }) => {
    const root = join(tmp, "photos");
    await mkdir(root);
    await randomFile(root, 20 * KiB, "IMG_0001.JPG"); // stored by its extension
    await fileWith(root, "notes.txt", "deflated");
    const s = await standIn(100);
    try {
      const r = await cli(["upload", root], { env: s.env });
      expectAborted(s, r, /The zip would be larger than/);
      expect(s.puts()).toEqual([]);
    } finally {
      await s.close();
    }
  });

  test("Ctrl-C while a part uploads: deleted, never completed, exit 130", async ({ tmp }) => {
    const { root } = await album(tmp);
    let sawPart!: () => void;
    const partArrived = new Promise<void>((resolve) => (sawPart = resolve));
    const s = await standIn(1000, (r) => {
      if (r.method !== "PUT") return;
      sawPart();
      return "hold"; // never answer: the part is in flight when Ctrl-C comes
    });
    const home = await newConfigHome();
    try {
      const child = spawn(process.execPath, [server.cliPath, "upload", root], {
        env: { ...process.env, ...s.env, HOME: home, XDG_CONFIG_HOME: home, NO_COLOR: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stderr = "";
      child.stderr.setEncoding("utf-8").on("data", (c: string) => (stderr += c));
      await partArrived;
      child.kill("SIGINT");
      const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
      expect(code, stderr).toBe(130);
      expect(stderr).toContain("Upload of album.zip cancelled; nothing was kept.");
      expect(s.completes()).toEqual([]);
      expect(s.deletes().map((d) => d.path)).toEqual(["/api/uploads/up1"]);
    } finally {
      await s.close();
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Against the real Worker
// ---------------------------------------------------------------------------

test.describe("yeet upload: zips on the real server", () => {
  test("several files (unicode, spaces, punctuation): one zip link, every entry intact", async ({
    tmp,
  }) => {
    const files = [
      await randomFile(tmp, 300 * KiB, FILENAMES.unicode),
      await fileWith(tmp, FILENAMES.spaces, "holiday ".repeat(10_000)),
      await fileWith(tmp, FILENAMES.punctuation, "done!"),
    ];
    // An mtime with odd seconds and a fraction, checked by check.py (UT and DOS).
    await utimes(files[1]!.path, new Date(), new Date(Date.UTC(2025, 2, 3, 4, 5, 7, 900)));
    const r = await cli(["upload", ...files.map((f) => f.path), "--expires", "1d"], {
      auth: true,
    });
    expectExitCode(r, 0);
    const url = r.stdout.trim();
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[\w-]+\/yeet-\d{8}-\d{6}\.zip$/);
    const listed = (await listUploads()).find((u) => u.id === idFromUrl(url));
    expect(listed?.filename).toMatch(/^yeet-\d{8}-\d{6}\.zip$/);
    const path = join(tmp, "download.zip");
    const bytes = await downloadBytes(url);
    expect(listed?.file_size).toBe(bytes.length);
    await writeFile(path, bytes);
    const manifest = await manifestOfFiles(files.map((f) => ({ path: f.name, source: f.path })));
    const results = await validateZip(path, manifest, {
      readers: ["structural", "python zipfile", "unzip -t", "unzip -x", "bsdtar (stdin)"],
    });
    expect(failures(results)).toEqual([]);
  });

  for (const store of [false, true]) {
    test(`a folder${store ? " with --store (size sent at create)" : ""}: <folder>.zip, .DS_Store skipped, empty folders kept`, async ({
      tmp,
    }) => {
      const name = `Stems – Ünïcødé (v2) #1${store ? " stored" : ""}`;
      const root = join(tmp, name);
      await mkdir(join(root, "drums"), { recursive: true });
      const files = [
        await silentWavFileish(join(root, "drums"), "kick.wav"),
        await randomFile(root, 60 * KiB, FILENAMES.unicode),
        await fileWith(root, FILENAMES.punctuation, "punctuation"),
        await fileWith(join(root, "drums"), FILENAMES.spaces, "spaces"),
      ];
      await writeFile(join(root, ".DS_Store"), "finder junk");
      await mkdir(join(root, "empty"));
      const r = await cli(["upload", root, ...(store ? ["--store"] : [])], { auth: true });
      expectExitCode(r, 0);
      const url = r.stdout.trim();
      const listed = (await listUploads()).find((u) => u.id === idFromUrl(url));
      expect(listed?.filename).toBe(`${name}.zip`);
      const path = join(tmp, "download.zip");
      await writeFile(path, await downloadBytes(url));
      const manifest = await manifestOfFiles(
        files.map((f) => ({ path: `${name}/${f.path.slice(root.length + 1)}`, source: f.path })),
        [{ path: `${name}/empty/`, source: join(root, "empty") }],
      );
      const results = await validateZip(path, manifest, {
        readers: ["structural", "python zipfile", "unzip -t", "unzip -x", "bsdtar (stdin)"],
      });
      expect(failures(results)).toEqual([]);
    });
  }

  test(
    "a failed zip upload leaves nothing in the bucket and is never completed",
    {
      tag: "@slow",
    },
    async ({ tmp }) => {
      test.setTimeout(180_000);
      // Its own server, so the bucket holds nothing but this upload.
      const own = await startServer({ token: "zip-abort-token-0123456789abcdef" });
      try {
        const root = join(tmp, "fails");
        await mkdir(root);
        // Four 50 MiB parts before the unreadable file: with three in flight at
        // most, the zip waits for one to be stored in R2 before it reads on.
        await randomFile(root, 4 * 50 * MiB + 1, "a-big.bin");
        const locked = join(root, "b-locked.txt");
        await writeFile(locked, "secret");
        await chmod(locked, 0o000);
        try {
          const r = await cli(["upload", root], {
            env: { YEET_URL: own.baseURL, YEET_TOKEN: own.token },
            timeoutMs: 120_000,
          });
          expectExitCode(r, 1);
          expect(r.stderr).toMatch(/EACCES|permission denied/);
        } finally {
          await chmod(locked, 0o644);
        }
        // wrangler logs a request after answering it, and the log is piped: poll.
        const log = await eventually(
          async () => {
            const text = await readFile(own.logPath, "utf-8");
            return /DELETE \/api\/uploads\/[\w-]+ 200/.test(text) && text;
          },
          { message: "the DELETE in the server log" },
        );
        expect(log, log).toMatch(/PUT \/api\/uploads\/[\w-]+\/parts\/\d+ 200/);
        expect(log).not.toMatch(/\/complete/);
        expect(await listObjects("uploads/", { baseURL: own.baseURL })).toEqual([]);
      } finally {
        await own.stop();
      }
    },
  );
});

/** A small WAV-like file (mostly silence), so the folder has something that compresses well. */
async function silentWavFileish(dir: string, name: string) {
  const data = Buffer.alloc(200 * KiB);
  data.write("RIFF", 0, "ascii");
  for (let i = 1000; i < data.length; i += 997) data[i] = i & 0xff;
  const f = await fileWith(dir, name, data);
  const st = await stat(f.path);
  expect(st.size).toBe(200 * KiB);
  return f;
}
