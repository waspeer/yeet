// Validate a zip with the readers available on this Mac and compare the
// extracted contents against an expected manifest (path -> sha256).
//
// Readers: Info-ZIP unzip (test + extract), Python zipfile (testzip + read),
// ditto -x -k (Apple's Bom-based extractor; NOT a stand-in for Archive
// Utility past 4 GiB, see docs/design/zip.md), bsdtar (libarchive, also as a
// pure streaming reader from stdin), 7-Zip (7za 16.02 from the 7zip-bin npm
// package) and "structural": the independent verifier's strict parser
// check.py (kept verbatim). A wrong mtime after extraction is a failure.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { access, mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { ZipEntry } from "../../packages/cli/src/zip.js";

const run = promisify(execFile);
export const CHECK_PY = fileURLToPath(new URL("check.py", import.meta.url));

/** Path of the 7za binary of the 7zip-bin package (a dev dependency of e2e/). */
export function sevenZipPath(): string {
  const require = createRequire(import.meta.url);
  return (require("7zip-bin") as { path7za: string }).path7za;
}

/**
 * The 7zip-bin binary ships without the exec bit when npm install scripts are
 * blocked (npm 12's default). Fail with the fix instead of a cryptic EACCES.
 */
export async function assertSevenZip(path = sevenZipPath()): Promise<string> {
  try {
    await access(path, constants.X_OK);
  } catch {
    throw new Error(`${path} is missing or not executable; run: chmod +x "${path}"`);
  }
  return path;
}

export type Manifest = Map<string, { sha256: string; size: number } | "dir"> & {
  /** Per-entry facts for the structural check: whether `size` was declared, and the mtime. */
  meta?: Map<string, { sizeKnown: boolean; mtime?: number }>;
};

export interface ReaderResult {
  ok: boolean;
  detail: string;
}

/** Compute the expected manifest by reading each entry's stream once (independently of zip.ts). */
export async function manifestOf(
  entries: Iterable<ZipEntry> | AsyncIterable<ZipEntry>,
): Promise<Manifest> {
  const manifest: Manifest = new Map();
  manifest.meta = new Map();
  for await (const e of entries) {
    const path = e.path.normalize("NFC");
    manifest.meta.set(path, { sizeKnown: e.size !== undefined, mtime: e.lastModified });
    if (path.endsWith("/")) {
      manifest.set(path, "dir");
      continue;
    }
    const hash = createHash("sha256");
    let size = 0;
    for await (const chunk of e.stream!() as unknown as AsyncIterable<Uint8Array>) {
      hash.update(chunk);
      size += chunk.length;
    }
    manifest.set(path, { sha256: hash.digest("hex"), size });
  }
  return manifest;
}

/**
 * The manifest of a zip the CLI made from files on disk: each file's SHA-256,
 * size and mtime read here, independently of the CLI. `dirs` are the empty
 * directories the zip should hold ("a/empty/").
 */
export async function manifestOfFiles(
  files: { path: string; source: string }[],
  dirs: { path: string; source: string }[] = [],
): Promise<Manifest> {
  const manifest: Manifest = new Map();
  manifest.meta = new Map();
  for (const f of files) {
    const st = await stat(f.source);
    manifest.set(f.path, { sha256: await sha256File(f.source), size: st.size });
    manifest.meta.set(f.path, { sizeKnown: true, mtime: st.mtimeMs });
  }
  for (const d of dirs) {
    manifest.set(d.path, "dir");
    manifest.meta.set(d.path, { sizeKnown: true, mtime: (await stat(d.source)).mtimeMs });
  }
  return manifest;
}

/** The manifest format check.py reads: {path: {sha256, size, sizeKnown, mtime}}, dirs {mtime}. */
export function checkManifest(manifest: Manifest): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [path, value] of manifest) {
    const meta = manifest.meta?.get(path);
    out[path] =
      value === "dir"
        ? { mtime: meta?.mtime }
        : { ...value, sizeKnown: meta?.sizeKnown ?? true, mtime: meta?.mtime };
  }
  return out;
}

export interface StructureResult {
  ok: boolean;
  /** check.py's output (one summary line, then up to 15 errors). */
  output: string;
}

/**
 * Run check.py on a zip, with a manifest (then it also checks SHA-256, the
 * ZIP64 policy, UT and DOS times) or without. `tzMinutes`: the zone the DOS
 * times were written in; default: the zone of the Python process, which
 * `env.TZ` sets.
 */
export async function checkStructure(
  zipPath: string,
  manifest?: Manifest,
  opts: { tzMinutes?: number; env?: Record<string, string> } = {},
): Promise<StructureResult> {
  const args = ["-I", CHECK_PY, zipPath];
  let dir: string | undefined;
  try {
    if (manifest) {
      dir = await mkdtemp(join(tmpdir(), "yeet-zip-check-"));
      const manifestPath = join(dir, "manifest.json");
      await writeFile(manifestPath, JSON.stringify(checkManifest(manifest)));
      args.push(manifestPath);
    }
    if (opts.tzMinutes !== undefined) args.push("--tz-minutes", String(opts.tzMinutes));
    try {
      const { stdout } = await run("python3", args, {
        maxBuffer: 64 * 1024 * 1024,
        env: { ...process.env, ...opts.env },
      });
      return { ok: true, output: stdout.trim() };
    } catch (error) {
      const e = error as { stdout?: string; stderr?: string; message: string };
      return { ok: false, output: `${e.stdout ?? ""}${e.stderr ?? ""}`.trim() || e.message };
    }
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true });
  }
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path, { highWaterMark: 1 << 20 })) {
    hash.update(chunk as Buffer);
  }
  return hash.digest("hex");
}

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const d of await readdir(dir, { withFileTypes: true, recursive: true })) {
    const full = join(d.parentPath, d.name);
    const rel = relative(dir, full).normalize("NFC");
    if (rel.startsWith("__MACOSX")) continue;
    out.push(d.isDirectory() ? rel + "/" : rel);
  }
  return out;
}

/** Compare an extraction directory against the manifest. */
export async function compareDir(
  dir: string,
  manifest: Manifest,
  mtime?: number,
): Promise<{ problems: string[]; skew: string[] }> {
  const problems: string[] = [];
  const skew: string[] = [];
  const found = new Set(await walk(dir));
  for (const [path, want] of manifest) {
    const p = path.normalize("NFC");
    if (!found.has(p)) {
      problems.push(`missing ${path}`);
      continue;
    }
    found.delete(p);
    if (want === "dir") continue;
    const file = join(dir, p);
    const st = await stat(file);
    if (st.size !== want.size) problems.push(`size ${path}: ${st.size} != ${want.size}`);
    else if ((await sha256File(file)) !== want.sha256) problems.push(`sha256 mismatch ${path}`);
    const expected = mtime ?? manifest.meta?.get(path)?.mtime;
    if (expected !== undefined && Math.abs(st.mtimeMs - expected) > 2000) {
      skew.push(`${path}: ${((st.mtimeMs - expected) / 3_600_000).toFixed(2)} h`);
    }
  }
  // Intermediate directories are created implicitly; only report unexpected files.
  for (const p of found) {
    if (!p.endsWith("/")) problems.push(`unexpected ${p}`);
  }
  return { problems, skew };
}

async function attempt(fn: () => Promise<string>): Promise<ReaderResult> {
  try {
    return { ok: true, detail: await fn() };
  } catch (error) {
    const e = error as { stderr?: string; stdout?: string; message: string };
    const text = (e.stderr || e.stdout || e.message).trim().split("\n").slice(-4).join(" | ");
    return { ok: false, detail: text.slice(0, 400) };
  }
}

export const ALL_READERS = [
  "unzip -t",
  "unzip -x",
  "python zipfile",
  "ditto -x -k",
  "bsdtar",
  "bsdtar (stdin)",
  "7za t",
  "7za x",
  "structural",
] as const;

export interface ValidateOptions {
  /** Expected mtime for extracted files (ms); default: each entry's own mtime from the manifest. */
  mtime?: number;
  /** Skip extraction-based checks. */
  extract?: boolean;
  readers?: readonly string[];
  /** Zone (minutes east of UTC) the DOS times were written in; default: this machine's. */
  tzMinutes?: number;
  /** Environment for the readers (e.g. TZ). */
  env?: Record<string, string>;
}

const PY_CHECK = `
import hashlib, json, sys, zipfile
path, manifest = sys.argv[1], json.load(open(sys.argv[2]))
with zipfile.ZipFile(path) as z:
    bad = z.testzip()
    if bad: sys.exit("testzip: bad member " + bad)
    names = z.namelist()
    if sorted(names) != sorted(manifest): sys.exit("names differ: %r vs %r" % (sorted(names), sorted(manifest)))
    for info in z.infolist():
        if not info.flag_bits & 0x800 and not info.filename.isascii(): sys.exit("utf-8 flag missing " + info.filename)
        want = manifest[info.filename]
        if want == "dir":
            if not info.is_dir(): sys.exit("not a dir " + info.filename)
            continue
        h = hashlib.sha256()
        with z.open(info) as f:
            for block in iter(lambda: f.read(1 << 20), b""): h.update(block)
        if h.hexdigest() != want["sha256"]: sys.exit("sha256 mismatch " + info.filename)
    print("%d entries ok, python %s" % (len(names), sys.version.split()[0]))
`;

export async function validateZip(
  zipPath: string,
  manifest: Manifest,
  opts: ValidateOptions = {},
): Promise<Record<string, ReaderResult>> {
  const extract = opts.extract ?? true;
  const want = (name: string) => !opts.readers || opts.readers.includes(name);
  const work = await mkdtemp(join(tmpdir(), "yeet-zip-validate-"));
  const results: Record<string, ReaderResult> = {};
  const big = { maxBuffer: 64 * 1024 * 1024, env: { ...process.env, ...opts.env } };
  const checkDir = async (dir: string) => {
    const { problems, skew } = await compareDir(dir, manifest, opts.mtime);
    if (skew.length) problems.push(`MTIME SKEW on ${skew.length} files (e.g. ${skew[0]})`);
    if (problems.length) throw new Error(problems.slice(0, 5).join("; "));
    return `${manifest.size} entries match, mtimes ok`;
  };
  try {
    if (want("unzip -t")) {
      results["unzip -t"] = await attempt(async () => {
        const { stdout } = await run("unzip", ["-t", zipPath], big);
        if (!/No errors detected/.test(stdout)) throw new Error(stdout.slice(-300));
        return "No errors detected";
      });
    }
    if (extract && want("unzip -x")) {
      results["unzip -x"] = await attempt(async () => {
        const dir = join(work, "unzip");
        await run("unzip", ["-q", "-o", zipPath, "-d", dir], big);
        return checkDir(dir);
      });
    }
    if (want("python zipfile")) {
      results["python zipfile"] = await attempt(async () => {
        const manifestPath = join(work, "manifest.json");
        await writeFile(manifestPath, JSON.stringify(Object.fromEntries(manifest)));
        const { stdout } = await run("python3", ["-I", "-c", PY_CHECK, zipPath, manifestPath], big);
        return stdout.trim();
      });
    }
    if (extract && want("ditto -x -k")) {
      results["ditto -x -k"] = await attempt(async () => {
        const dir = join(work, "ditto");
        await run("ditto", ["-x", "-k", zipPath, dir], big);
        return checkDir(dir);
      });
    }
    if (extract && want("bsdtar")) {
      results["bsdtar"] = await attempt(async () => {
        const dir = join(work, "bsdtar");
        await mkdir(dir);
        await run("bsdtar", ["-xf", zipPath, "-C", dir], big);
        return checkDir(dir);
      });
    }
    if (extract && want("bsdtar (stdin)")) {
      // Streaming mode: libarchive cannot seek to the central directory and
      // must rely on local headers + data descriptors, like a pipe reader.
      results["bsdtar (stdin)"] = await attempt(async () => {
        const dir = join(work, "bsdtar-stdin");
        await mkdir(dir);
        await run("sh", ["-c", 'bsdtar -xf - -C "$1" < "$2"', "sh", dir, zipPath], big);
        return checkDir(dir);
      });
    }
    if (want("7za t")) {
      results["7za t"] = await attempt(async () => {
        const sevenZip = await assertSevenZip();
        const { stdout } = await run(sevenZip, ["t", zipPath], big);
        if (!/Everything is Ok/.test(stdout)) throw new Error(stdout.slice(-300));
        const warn = /Warnings?:\s*\d+/.exec(stdout);
        return "Everything is Ok" + (warn ? ` (${warn[0]})` : "");
      });
    }
    if (extract && want("7za x")) {
      results["7za x"] = await attempt(async () => {
        const sevenZip = await assertSevenZip();
        const dir = join(work, "7za");
        await run(sevenZip, ["x", "-y", `-o${dir}`, zipPath], big);
        return checkDir(dir);
      });
    }
    if (want("structural")) {
      results["structural"] = await attempt(async () => {
        const r = await checkStructure(zipPath, manifest, {
          tzMinutes: opts.tzMinutes,
          env: opts.env,
        });
        if (!r.ok) throw new Error(r.output);
        return r.output.split("\n").join(" | ");
      });
    }
  } finally {
    await rm(work, { recursive: true, force: true });
  }
  return results;
}

/** Print results; readers in `expectFail` print XFAIL/XPASS and do not fail the run. */
export function printResults(
  label: string,
  results: Record<string, ReaderResult>,
  expectFail: readonly string[] = [],
): boolean {
  let all = true;
  console.log(`\n## ${label}`);
  for (const [reader, r] of Object.entries(results)) {
    const expected = expectFail.includes(reader);
    if (!expected) all &&= r.ok;
    const status = expected ? (r.ok ? "XPASS" : "XFAIL") : r.ok ? "PASS" : "FAIL";
    console.log(`  ${status.padEnd(5)} ${reader.padEnd(16)} ${r.detail}`);
  }
  return all;
}

/** Failed readers as "reader: detail" lines (empty when all passed), for assertion messages. */
export function failures(results: Record<string, ReaderResult>): string[] {
  return Object.entries(results)
    .filter(([, r]) => !r.ok)
    .map(([reader, r]) => `${reader}: ${r.detail}`);
}
