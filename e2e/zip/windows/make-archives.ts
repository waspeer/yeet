// Test zips for the Windows workflow (.github/workflows/windows.yml), made
// with the CLI's built zip.ts and its zlib options (packages/cli/dist, so
// run `npm run build` in packages/cli first). Each archive gets a manifest
// in check.py's format, {path: {sha256, size, sizeKnown, mtime}} and
// directories {mtime}, computed from the bytes fed into the zip. The readers
// (run-readers.mjs) compare what they extract against it.
//
//   node e2e/zip/windows/make-archives.ts --out <dir> [--no-big] [--only <name,...>]
//
// Node >= 22.18 (it imports e2e/lib/fixtures.ts). The two big archives are
// big-stored.zip (~4.3 GB on disk, an entry past the 4 GiB offset) and
// big-deflated.zip (a few MB, an entry of more than 4 GiB uncompressed).
// Their content is zeros; off Windows the big stored one is written as a
// sparse file so a local run takes almost no disk.

import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { FILENAMES } from "../../lib/fixtures.ts";

type ZipModule = typeof import("../../../packages/cli/src/zip.ts");
type ZipEntry = import("../../../packages/cli/src/zip.ts").ZipEntry;
type ZipOptions = import("../../../packages/cli/src/zip.ts").ZipOptions;

const dist = new URL("../../../packages/cli/dist/", import.meta.url);
const zip: ZipModule = await import(new URL("zip.js", dist).href).catch((err: Error) => {
  throw new Error(`${err.message}\nBuild the CLI first: (cd packages/cli && npm run build)`);
});
const { cliZipOptions } = (await import(new URL("upload-zip.js", dist).href)) as {
  cliZipOptions: (store: boolean) => ZipOptions;
};

const KiB = 1024;
const MiB = 1024 * KiB;
const GiB = 1024 * MiB;
/** Fixed and even (DOS times have 2 s resolution), so readers can be checked exactly. */
const MTIME = Date.UTC(2026, 9, 7, 12, 34, 56);

interface Def {
  /** As given to sanitizeForWindows() and createZip (which NFC-normalizes it). */
  path: string;
  /** Text, bytes, or that many zero bytes, or a seeded noise of that size. */
  data?: string | Uint8Array | { zeros: number } | { noise: number; seed: number };
  sizeKnown?: boolean;
  compress?: boolean;
}

export interface ArchiveInfo {
  name: string;
  file: string;
  manifest: string;
  title: string;
  /** The archive or an entry is bigger than 4 GiB (extraction takes minutes). */
  big: boolean;
  bytes: number;
  entries: number;
  /** For the sanitized archive: raw name -> name in the zip. */
  renames?: Record<string, string>;
}

const text = (name: string, repeat = 40) =>
  `This is ${name}.\n` + "yeet zips files while streaming. ".repeat(repeat) + "\nThe end.\n";

function noiseBytes(size: number, seed: number): Uint8Array {
  const out = new Uint8Array(size);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < size; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    out[i] = x & 0xff;
  }
  return out;
}

function source(data: Def["data"]): { size: number; stream: () => ReadableStream<Uint8Array> } {
  if (data === undefined || typeof data === "string" || data instanceof Uint8Array) {
    const bytes =
      typeof data === "string" ? new TextEncoder().encode(data) : (data ?? new Uint8Array());
    return {
      size: bytes.length,
      stream: () => chunks(bytes.length, (o, n) => bytes.subarray(o, o + n)),
    };
  }
  if ("zeros" in data) {
    const zeros = new Uint8Array(MiB);
    return { size: data.zeros, stream: () => chunks(data.zeros, (_o, n) => zeros.subarray(0, n)) };
  }
  const bytes = noiseBytes(data.noise, data.seed);
  return {
    size: bytes.length,
    stream: () => chunks(bytes.length, (o, n) => bytes.subarray(o, o + n)),
  };
}

function chunks(
  size: number,
  at: (offset: number, n: number) => Uint8Array,
): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= size) return controller.close();
      const n = Math.min(MiB, size - offset);
      controller.enqueue(at(offset, n));
      offset += n;
    },
  });
}

type ManifestEntry =
  | { sha256: string; size: number; sizeKnown: boolean; mtime: number }
  | { mtime: number };

/** Write one archive and its manifest; the manifest is computed from the bytes the zip read. */
async function write(
  out: string,
  name: string,
  title: string,
  defs: Def[],
  options: { store?: boolean; big?: boolean; renames?: Record<string, string> } = {},
): Promise<ArchiveInfo> {
  const manifest: Record<string, ManifestEntry> = {};
  const entries: ZipEntry[] = defs.map((d) => {
    const path = zip.sanitizeForWindows(d.path.normalize("NFC"));
    if (path.endsWith("/")) {
      manifest[path] = { mtime: MTIME };
      return { path, lastModified: MTIME };
    }
    const src = source(d.data);
    const record = { sha256: "", size: 0, sizeKnown: d.sizeKnown ?? true, mtime: MTIME };
    manifest[path] = record;
    return {
      path,
      lastModified: MTIME,
      size: record.sizeKnown ? src.size : undefined,
      compress: d.compress,
      stream: () => {
        const hash = createHash("sha256");
        return src.stream().pipeThrough(
          new TransformStream<Uint8Array, Uint8Array>({
            transform(chunk, controller) {
              hash.update(chunk);
              record.size += chunk.length;
              controller.enqueue(chunk);
            },
            flush() {
              record.sha256 = hash.digest("hex");
            },
          }),
        );
      },
    };
  });
  const file = join(out, `${name}.zip`);
  const stream = zip.createZip(entries, cliZipOptions(options.store ?? false));
  const started = Date.now();
  if (options.big && process.platform !== "win32") {
    // Holes read back as zeros: a 4.3 GB archive of zeros takes a few KB on APFS.
    const { writeSparseZip } = await import("../module.ts");
    await writeSparseZip(file, stream);
  } else {
    await pipeline(Readable.fromWeb(stream as never), createWriteStream(file));
  }
  const bytes = (await stat(file)).size;
  const manifestFile = join(out, `${name}.manifest.json`);
  await writeFile(manifestFile, JSON.stringify(manifest, null, 2) + "\n");
  console.log(
    `${name}.zip: ${entries.length} entries, ${bytes.toLocaleString("en")} bytes, ${((Date.now() - started) / 1000).toFixed(1)} s`,
  );
  return {
    name,
    file: `${name}.zip`,
    manifest: `${name}.manifest.json`,
    title,
    big: options.big ?? false,
    bytes,
    entries: entries.length,
    ...(options.renames ? { renames: options.renames } : {}),
  };
}

// (c) Names sanitizeForWindows must fix, and what it must make of them.
// Checked against the real function before anything is written, so the table
// cannot drift from the code.
export const SANITIZE_CASES: [raw: string, expected: string][] = [
  ["sanitize/CON.txt", "sanitize/_CON.txt"],
  ["sanitize/nul", "sanitize/_nul"],
  ["sanitize/COM1.log", "sanitize/_COM1.log"],
  ["sanitize/lpt9", "sanitize/_lpt9"],
  ["sanitize/CON/inside reserved folder.txt", "sanitize/_CON/inside reserved folder.txt"],
  ["sanitize/a:b.txt", "sanitize/a_b.txt"],
  ["sanitize/what?.txt", "sanitize/what_.txt"],
  ["sanitize/pipe|star*.txt", "sanitize/pipe_star_.txt"],
  ['sanitize/quote"lt<gt>.txt', "sanitize/quote_lt_gt_.txt"],
  ["sanitize/back\\slash.txt", "sanitize/back_slash.txt"],
  ["sanitize/tab\there.txt", "sanitize/tab_here.txt"],
  ["sanitize/trailing dot.", "sanitize/trailing dot"],
  ["sanitize/trailing space ", "sanitize/trailing space"],
  ["sanitize/folder./inside dotted folder.txt", "sanitize/folder/inside dotted folder.txt"],
  ["sanitize/dots/...", "sanitize/dots/_"],
  ["sanitize/Ünïcødé – 名前 🎵 stays.txt", "sanitize/Ünïcødé – 名前 🎵 stays.txt"],
];

/** Every archive this script can write, in order. */
const ARCHIVES: Record<string, { big?: boolean; make: (out: string) => Promise<ArchiveInfo> }> = {
  // (a) non-ASCII names: accents, CJK, Hangul, Greek, Cyrillic, RTL, emoji
  // (with a ZWJ sequence), en and em dashes, spaces and punctuation; one name
  // given in NFD, which the zip must store (and readers extract) as NFC.
  names: {
    make: (out) => {
      const names = [
        FILENAMES.spaces,
        FILENAMES.unicode,
        FILENAMES.punctuation,
        "Ünïcödé/日本語 — 🎵 ñ.txt",
        "中文 文件夹/简体中文.txt",
        "한국어/파일 이름.txt",
        "日本語/ファイル名.txt",
        "Ελληνικά/Кириллица.txt",
        "עברית/عربي.txt",
        "emoji 🎉/🦄 unicorn 👩‍👩‍👧.txt",
        "Café déjà vu.txt", // NFD in, "Café déjà vu.txt" in the zip
        "dash – en, — em/spaces & (parens) [brackets] {braces} #1 50% ~tilde 'quote' +plus =eq ,comma;semi.txt",
      ];
      const defs: Def[] = names.map((path, i) => ({ path, data: text(path, 20 + i) }));
      defs.push({ path: "empty folder 空 🗂/" });
      for (const d of defs) {
        if (zip.sanitizeForWindows(d.path.normalize("NFC")) !== d.path.normalize("NFC"))
          throw new Error(
            `names: ${d.path} is not Windows-safe as it is; move it to the sanitize cases`,
          );
      }
      return write(out, "names", "(a) non-ASCII names, sizes known, deflated", defs);
    },
  },
  // (b) a folder tree with empty folders, deflated and stored.
  ...Object.fromEntries(
    (["deflate", "store"] as const).map((mode) => [
      `tree-${mode}`,
      {
        make: (out: string) =>
          write(
            out,
            `tree-${mode}`,
            `(b) folder tree with empty folders, ${mode === "store" ? "everything stored (--store)" : "deflated"}`,
            [
              { path: "tree/readme.txt", data: text("the readme", 2000) },
              { path: "tree/empty.bin", data: "" },
              { path: "tree/noise.bin", data: { noise: MiB + 3, seed: 1 } },
              { path: "tree/photos/IMG_0001.JPG", data: { noise: 256 * KiB, seed: 2 } },
              { path: "tree/a/b/c/deep.txt", data: "deep\n" },
              { path: "tree/a/also empty/" },
              { path: "tree/empty folder/" },
              { path: "tree/z/last.txt", data: text("the last file") },
            ],
            { store: mode === "store" },
          ),
      },
    ]),
  ),
  // (c) names sanitizeForWindows must fix.
  sanitized: {
    make: (out) => {
      const renames: Record<string, string> = {};
      for (const [raw, expected] of SANITIZE_CASES) {
        const got = zip.sanitizeForWindows(raw.normalize("NFC"));
        if (got !== expected)
          throw new Error(
            `sanitizeForWindows(${JSON.stringify(raw)}) = ${JSON.stringify(got)}, expected ${JSON.stringify(expected)}`,
          );
        renames[raw] = got;
      }
      return write(
        out,
        "sanitized",
        "(c) names sanitizeForWindows fixed (CON.txt, a:b, trailing dot, …)",
        SANITIZE_CASES.map(([raw]) => ({ path: raw, data: text(raw, 5) })),
        { renames },
      );
    },
  },
  // (f) sizes unknown: ZIP64 local headers and 24-byte descriptors on small entries.
  unknown: {
    make: (out) =>
      write(out, "unknown", "(f) sizes unknown: ZIP64 local headers, 24-byte descriptors", [
        { path: "unknown/hello.txt", data: text("hello", 500), sizeKnown: false },
        { path: "unknown/noise.bin", data: { noise: 2 * MiB + 1, seed: 3 }, sizeKnown: false },
        { path: "unknown/stored.JPG", data: { noise: 64 * KiB, seed: 4 }, sizeKnown: false },
        {
          path: "unknown/forced store.txt",
          data: text("stored", 50),
          sizeKnown: false,
          compress: false,
        },
        { path: `unknown/${FILENAMES.unicode}`, data: text("unicode"), sizeKnown: false },
        { path: "unknown/empty.bin", data: "", sizeKnown: false },
        { path: "unknown/empty dir/" },
      ]),
  },
  // (d) stored, over 4 GiB: a zero-filled entry of 4 GiB + an odd number of
  // bytes (sizes that are not a multiple of 1 MiB broke ditto, see zip.md),
  // then entries past the 4 GiB offset (one of unknown size).
  "big-stored": {
    big: true,
    make: (out) =>
      write(
        out,
        "big-stored",
        "(d) stored, >4 GiB archive, entries past the 4 GiB offset",
        [
          { path: "big-stored/zeros 4 GiB + odd.bin", data: { zeros: 4 * GiB + 262_141 } },
          {
            path: "big-stored/after 4 GiB – ü 名前.txt",
            data: text("past 4 GiB"),
            sizeKnown: false,
          },
          { path: "big-stored/after 4 GiB, size known.txt", data: text("past 4 GiB, known") },
          { path: "big-stored/empty after/" },
        ],
        { store: true, big: true },
      ),
  },
  // (e) deflated, an entry of more than 4 GiB uncompressed (a few MB compressed).
  "big-deflated": {
    big: true,
    make: (out) =>
      write(
        out,
        "big-deflated",
        "(e) deflated, an entry >4 GiB uncompressed",
        [
          { path: "big-deflated/zeros 4 GiB + 1 MiB.bin", data: { zeros: 4 * GiB + MiB + 3 } },
          { path: "big-deflated/after.txt", data: text("after the big one") },
        ],
        { big: true },
      ),
  },
};

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const outArg = arg("--out");
if (!outArg) {
  console.error(
    "usage: node e2e/zip/windows/make-archives.ts --out <dir> [--no-big] [--only <name,...>]",
  );
  process.exit(2);
}
const out = resolve(outArg);
const only = arg("--only")?.split(",");
const noBig = process.argv.includes("--no-big");
await mkdir(out, { recursive: true });
const made: ArchiveInfo[] = [];
for (const [name, def] of Object.entries(ARCHIVES)) {
  if (only && !only.includes(name)) continue;
  if (noBig && def.big) continue;
  made.push(await def.make(out));
}
await writeFile(join(out, "archives.json"), JSON.stringify(made, null, 2) + "\n");
console.log(`wrote ${made.length} archives and archives.json to ${out}`);
