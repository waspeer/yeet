// Validate a zip with every reader available on this Mac and compare the
// extracted contents against an expected manifest (path -> sha256).
//
// Readers: Info-ZIP unzip (test + extract), Python zipfile (testzip + read),
// ditto -x -k (Apple's Bom-based extractor, same engine family as Archive
// Utility), bsdtar (libarchive; streaming reader that walks local headers and
// data descriptors), 7-Zip (7za 16.02 from the 7zip-bin npm package).

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { promisify } from "node:util";
import type { ZipEntry } from "../zip.ts";

const run = promisify(execFile);
const here = new URL(".", import.meta.url).pathname;
const SEVEN_ZIP = join(here, "../node_modules/7zip-bin/mac/arm64/7za");

export type Manifest = Map<string, { sha256: string; size: number } | "dir">;

export interface ReaderResult {
  ok: boolean;
  detail: string;
}

/** Compute the expected manifest by reading each entry's stream once. */
export async function manifestOf(entries: Iterable<ZipEntry>): Promise<Manifest> {
  const manifest: Manifest = new Map();
  for (const e of entries) {
    if (e.path.endsWith("/")) {
      manifest.set(e.path, "dir");
      continue;
    }
    const hash = createHash("sha256");
    let size = 0;
    for await (const chunk of e.stream!() as unknown as AsyncIterable<Uint8Array>) {
      hash.update(chunk);
      size += chunk.length;
    }
    manifest.set(e.path, { sha256: hash.digest("hex"), size });
  }
  return manifest;
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path, { highWaterMark: 1 << 20 })) hash.update(chunk);
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
    if (mtime !== undefined && Math.abs(st.mtimeMs - mtime) > 2000) {
      skew.push(`${path}: ${((st.mtimeMs - mtime) / 3_600_000).toFixed(2)} h`);
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

export interface ValidateOptions {
  /** Expected mtime for extracted files (ms); checked for extractors that set it. */
  mtime?: number;
  /** Skip extraction-based checks (for huge archives, compare via streaming hash instead). */
  extract?: boolean;
  readers?: string[];
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
  const big = { maxBuffer: 64 * 1024 * 1024 };
  const checkDir = async (dir: string) => {
    const { problems, skew } = await compareDir(dir, manifest, opts.mtime);
    if (problems.length) throw new Error(problems.slice(0, 5).join("; "));
    const mtimeNote = skew.length
      ? ` — MTIME SKEW on ${skew.length} files (e.g. ${skew[0]})`
      : opts.mtime
        ? ", mtimes ok"
        : "";
    return `${manifest.size} entries match${mtimeNote}`;
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
        const obj = Object.fromEntries([...manifest].map(([k, v]) => [k, v]));
        await import("node:fs/promises").then((fs) =>
          fs.writeFile(manifestPath, JSON.stringify(obj)),
        );
        const { stdout } = await run("python3", ["-c", PY_CHECK, zipPath, manifestPath], big);
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
        await import("node:fs/promises").then((fs) => fs.mkdir(dir));
        await run("bsdtar", ["-xf", zipPath, "-C", dir], big);
        return checkDir(dir);
      });
    }
    if (extract && want("bsdtar (stdin)")) {
      // Streaming mode: libarchive cannot seek to the central directory and
      // must rely on local headers + data descriptors, like a pipe reader.
      results["bsdtar (stdin)"] = await attempt(async () => {
        const dir = join(work, "bsdtar-stdin");
        await import("node:fs/promises").then((fs) => fs.mkdir(dir));
        await run("sh", ["-c", 'bsdtar -xf - -C "$1" < "$2"', "sh", dir, zipPath], big);
        return checkDir(dir);
      });
    }
    if (want("7za t")) {
      results["7za t"] = await attempt(async () => {
        const { stdout } = await run(SEVEN_ZIP, ["t", zipPath], big);
        if (!/Everything is Ok/.test(stdout)) throw new Error(stdout.slice(-300));
        const warn = /Warnings?:\s*\d+/.exec(stdout);
        return "Everything is Ok" + (warn ? ` (${warn[0]})` : "");
      });
    }
    if (extract && want("7za x")) {
      results["7za x"] = await attempt(async () => {
        const dir = join(work, "7za");
        await run(SEVEN_ZIP, ["x", "-y", `-o${dir}`, zipPath], big);
        return checkDir(dir);
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
  expectFail: string[] = [],
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
