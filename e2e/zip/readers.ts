// Opt-in: the full reader matrix of docs/design/zip.md on real files, with
// real (noise) data and the CLI's zlib level 1: unzip -t/-x, Python zipfile,
// ditto, bsdtar (file and stdin), 7za t/x and check.py. Ported from the 0c
// prototype's node-test.ts and zip64-test.ts.
//
//   node e2e/zip/readers.ts            fixtures and the entry-count boundaries (a few minutes)
//   node e2e/zip/readers.ts --big      also the six >4 GiB archives (~5 GB in the OS temp dir
//                                      per case, one at a time, deleted afterwards; ~10 min)
//   node e2e/zip/readers.ts <filter>   only cases whose label contains <filter>
//
// Needs `npm install` in e2e/ (7zip-bin); if 7za lacks the exec bit the 7za
// readers fail with the chmod command to run. The suite's own checks run in
// `npm run verify` (tests/node/zip-*.spec.ts); this is the slow,
// every-reader version, run before a release and when zip.ts changes.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Duplex } from "node:stream";
import zlib from "node:zlib";
import { fixtureEntries, generatedStream, noise } from "./fixtures.ts";
import { writeZip, type ZipEntry, type ZipOptions } from "./module.ts";
import { ALL_READERS, manifestOf, printResults, validateZip } from "./validate.ts";

const GiB = 1024 ** 3;
const MiB = 1024 ** 2;
// ditto applies the UTC offset in effect now to DOS times, so extracted
// mtimes are only right for a date on the same side of a DST transition.
const RECENT = Math.floor((Date.now() - 60_000) / 2000) * 2000;
const zlibCrc32 = (zlib as unknown as { crc32: (d: Uint8Array, p: number) => number }).crc32;
const zlib1 = () =>
  Duplex.toWeb(zlib.createDeflateRaw({ level: 1 })) as unknown as {
    writable: WritableStream<Uint8Array>;
    readable: ReadableStream<Uint8Array>;
  };

/** A fixed 1 MiB random block, each chunk stamped with its offset so misordering is detectable. */
const BLOCK = new Uint8Array(MiB);
noise(42)(BLOCK);
function stampedFill(chunk: Uint8Array, offset: number) {
  const start = offset % MiB;
  const first = Math.min(chunk.length, MiB - start);
  chunk.set(BLOCK.subarray(start, start + first));
  if (first < chunk.length) chunk.set(BLOCK.subarray(0, chunk.length - first), first);
  if (chunk.length >= 8) new DataView(chunk.buffer, chunk.byteOffset).setFloat64(0, offset);
}
/** Highly compressible text-like data. */
const LINE = new TextEncoder().encode("0123456789 yeet zip64 compressible line of text\n");
function textFill(chunk: Uint8Array, offset: number) {
  for (let i = 0; i < chunk.length; i++) chunk[i] = LINE[(offset + i) % LINE.length]!;
}

const entry = (
  path: string,
  size: number,
  fill: typeof textFill,
  compress: boolean,
  knownSize = true,
): ZipEntry => ({
  path,
  size: knownSize ? size : undefined,
  lastModified: RECENT,
  compress,
  stream: () => generatedStream(size, fill, MiB),
});

const many = (n: number): ZipEntry[] =>
  Array.from({ length: n }, (_, i) => ({
    path: `many/${String(i).padStart(6, "0")}.txt`,
    lastModified: RECENT,
    size: 4,
    compress: false,
    stream: () => generatedStream(4, (c) => c.set([0x61 + (i % 26), 0x62, 0x63, 0x0a])),
  }));

interface Case {
  label: string;
  entries: () => ZipEntry[];
  options?: ZipOptions;
  readers?: readonly string[];
  /** Readers known to reject this layout (documented in docs/design/zip.md). */
  expectFail?: string[];
  big?: boolean;
}

const cases: Case[] = [
  {
    label: "fixtures, sizes known, CompressionStream, crc32Js",
    entries: () => fixtureEntries({ sizes: "known", lastModified: RECENT }),
  },
  {
    label: "fixtures, sizes unknown (ZIP64 local headers), CompressionStream",
    entries: () => fixtureEntries({ sizes: "unknown", lastModified: RECENT }),
  },
  {
    label: "fixtures, sizes mixed, zlib level 1, zlib.crc32 (the CLI)",
    entries: () => fixtureEntries({ sizes: "mixed", lastModified: RECENT }),
    options: { deflateRaw: zlib1, crc32: zlibCrc32 },
  },
  {
    label: "fixtures, store everything (--store)",
    entries: () => fixtureEntries({ sizes: "known", lastModified: RECENT }),
    options: { compress: false },
  },
  {
    label: "empty archive (byte-identical to Python's empty ZipFile)",
    entries: () => [],
    expectFail: ["unzip -t", "unzip -x", "ditto -x -k", "7za x"],
  },
  ...[65_534, 65_535].map(
    (n): Case => ({
      label: `${n} entries (ZIP64 end record boundary)`,
      entries: () => many(n),
      readers: ["unzip -t", "python zipfile", "7za t", "structural"],
    }),
  ),
  {
    label: "70,000 entries (ZIP64 end record by count)",
    entries: () => many(70_000),
    // p7zip 16.02 extraction of 70k files into one directory takes >10 min; `7za t` covers it.
    readers: ALL_READERS.filter((r) => r !== "7za x"),
  },
  // >4 GiB (--big)
  {
    big: true,
    label: "stored 4.5 GiB entry (size known) + small file at offset > 4 GiB",
    entries: () => [
      entry("big.bin", 4.5 * GiB, stampedFill, false),
      entry("after.txt", 1000, textFill, true),
    ],
  },
  {
    big: true,
    label: "deflated 4.5 GiB entry (compresses to < 4 GiB) + small file",
    entries: () => [
      entry("big.txt", 4.5 * GiB, textFill, true),
      entry("after.txt", 1000, textFill, true),
    ],
  },
  {
    big: true,
    label:
      "4 x 1.2 GiB stored (no ZIP64 local headers), 5th entry and central directory past 4 GiB",
    entries: () => [
      ...[1, 2, 3, 4].map((i) => entry(`part${i}.bin`, Math.floor(1.2 * GiB), stampedFill, false)),
      entry("last.txt", 1000, textFill, true),
    ],
  },
  {
    big: true,
    label: "deflated incompressible 4.5 GiB entry (compressed size > 4 GiB), size unknown",
    entries: () => [
      entry("noise.bin", 4.5 * GiB, stampedFill, true, false),
      entry("after.txt", 1000, textFill, true, false),
    ],
  },
  {
    big: true,
    // Found by the 0c verifier: ditto fails on stored data-descriptor entries past 4 GiB
    // whose sizes are not 1 MiB multiples (docs/design/zip.md, reader matrix).
    label: "stored odd-size entries (262,140 B + 5 x (1000 MiB - 1)) past 4 GiB",
    entries: () => [
      entry("small-odd.bin", 262_140, stampedFill, false),
      ...[1, 2, 3, 4, 5].map((i) => entry(`odd${i}.bin`, 1000 * MiB - 1, stampedFill, false)),
      entry("after.txt", 1000, textFill, true),
    ],
    expectFail: ["ditto -x -k"],
  },
  {
    big: true,
    label: "stored 4.5 GiB entry, size unknown",
    entries: () => [
      entry("big.bin", 4.5 * GiB, stampedFill, false, false),
      entry("after.txt", 1000, textFill, true, false),
    ],
  },
];

const big = process.argv.includes("--big");
const filter = process.argv.slice(2).find((a) => !a.startsWith("--"));
let allOk = true;
for (const c of cases) {
  if (c.big && !big) continue;
  if (filter && !c.label.includes(filter)) continue;
  const dir = await mkdtemp(join(tmpdir(), "yeet-zip-readers-"));
  try {
    const path = join(dir, "test.zip");
    const t0 = performance.now();
    const manifest = await manifestOf(c.entries());
    const t1 = performance.now();
    const size = await writeZip(path, c.entries(), {
      deflateRaw: zlib1,
      crc32: zlibCrc32,
      ...c.options,
    });
    const t2 = performance.now();
    const results: Record<string, { ok: boolean; detail: string }> = {};
    // One reader at a time, timed, so a >4 GiB extraction's disk use stays bounded.
    for (const reader of c.readers ?? ALL_READERS) {
      const r0 = performance.now();
      const r = await validateZip(path, manifest, { readers: [reader] });
      for (const [k, v] of Object.entries(r)) {
        results[k] = {
          ...v,
          detail: `${v.detail} [${((performance.now() - r0) / 1000).toFixed(1)} s]`,
        };
      }
    }
    allOk =
      printResults(
        `${c.label} — ${size} bytes; manifest ${((t1 - t0) / 1000).toFixed(1)} s, zip ${((t2 - t1) / 1000).toFixed(1)} s`,
        results,
        c.expectFail,
      ) && allOk;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
console.log(allOk ? "\nALL PASS" : "\nSOME FAILURES");
process.exitCode = allOk ? 0 : 1;
