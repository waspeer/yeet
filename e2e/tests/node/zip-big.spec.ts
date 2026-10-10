// Archives past the 4 GiB limits (must-test items 4, 5, 8, 9 and 10 of
// docs/design/zip.md), checked with check.py without writing gigabytes:
// the entries are zero-filled synthetic streams and the zip goes into a
// sparse file (writeSparseZip), so a 5 GB archive takes a few KB on disk and
// check.py still reads every byte (holes read as zeros), recomputing CRC and
// SHA-256. Each check.py run holds an entry in memory (up to ~9 GB for the
// deflated case), so the tests take turns ("zip-big" lock).
//
// Real data on disk through every reader (unzip, Python, ditto, bsdtar, 7za,
// check.py) and Archive Utility: e2e/zip/readers.ts --big and
// e2e/zip/archive-utility.ts --big (opt-in, see docs/design/zip.md).

import { expect, test } from "@playwright/test";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { Duplex } from "node:stream";
import zlib from "node:zlib";
import {
  writeSparseZip,
  zeroStream,
  zip,
  type ByteTransform,
  type ZipEntry,
  type ZipOptions,
} from "../../zip/module.js";
import { readCentralFromFile, readLocalFromFile } from "../../zip/parse.js";
import { withScratch, zipLock } from "../../zip/scratch.js";
import { checkStructure, type Manifest } from "../../zip/validate.js";

test.describe.configure({ timeout: 10 * 60_000 });

const MTIME = Date.UTC(2026, 9, 7, 12, 34, 56);
const MiB = 1024 ** 2;
const GiB = 1024 ** 3;
const MAX32 = 0xffffffff;
const zlibCrc32 = (zlib as unknown as { crc32: (d: Uint8Array, p: number) => number }).crc32;
const zlibLevel = (level: number) => (): ByteTransform =>
  Duplex.toWeb(zlib.createDeflateRaw({ level })) as unknown as ByteTransform;

/** SHA-256 of `size` zero bytes, computed here (independently of the zip). */
const zeroHashes = new Map<number, string>();
function sha256OfZeros(size: number): string {
  let hex = zeroHashes.get(size);
  if (!hex) {
    const hash = createHash("sha256");
    const block = new Uint8Array(16 * MiB);
    for (let left = size; left > 0; left -= block.length) {
      hash.update(left >= block.length ? block : block.subarray(0, left));
    }
    hex = hash.digest("hex");
    zeroHashes.set(size, hex);
  }
  return hex;
}

interface Spec {
  path: string;
  size: number;
  compress?: boolean;
  sizeKnown?: boolean;
}

const entriesOf = (specs: Spec[]): ZipEntry[] =>
  specs.map((s) => ({
    path: s.path,
    size: s.sizeKnown === false ? undefined : s.size,
    compress: s.compress ?? false,
    lastModified: MTIME,
    stream: () => zeroStream(s.size),
  }));

function manifestOf(specs: Spec[]): Manifest {
  const manifest: Manifest = new Map();
  manifest.meta = new Map();
  for (const s of specs) {
    manifest.set(s.path, { sha256: sha256OfZeros(s.size), size: s.size });
    manifest.meta.set(s.path, { sizeKnown: s.sizeKnown !== false, mtime: MTIME });
  }
  return manifest;
}

/** Zip `specs` into a sparse file, run check.py on it, and return what a test asserts on. */
async function bigZip(specs: Spec[], options: ZipOptions = {}) {
  return zipLock("zip-big", () =>
    withScratch(async (dir) => {
      const path = join(dir, "big.zip");
      const { size, written } = await writeSparseZip(
        path,
        zip.createZip(entriesOf(specs), { crc32: zlibCrc32, ...options }),
      );
      const check = await checkStructure(path, manifestOf(specs));
      const end = await readCentralFromFile(path);
      const locals = await Promise.all(end.central.map((c) => readLocalFromFile(path, c.offset)));
      return { size, written, check, end, locals };
    }),
  );
}

test.describe("zip 4: central-directory offset at the 4 GiB boundary", { tag: "@slow" }, () => {
  // One stored entry "a" of size S >= the ZIP64 threshold: local header 30 + 1
  // + 29 (UT + ZIP64 extras) = 60 bytes, descriptor 24, so the central
  // directory starts at S + 84.
  for (const [cdOffset, zip64End] of [
    [MAX32 - 1, false],
    [MAX32, true],
  ] as const) {
    test(`central directory at 0x${cdOffset.toString(16)}: ZIP64 end record ${zip64End ? "present" : "absent"}`, async () => {
      const specs = [{ path: "a", size: cdOffset - 84 }];
      const r = await bigZip(specs);
      expect(r.check.ok, r.check.output).toBe(true);
      expect(r.check.output).toContain(`1 entries, zip64eocd=${zip64End ? "yes" : "no"}, OK`);
      expect(r.end.centralOffset).toBe(cdOffset);
      expect(r.end.zip64End).toBe(zip64End);
      expect(zip.storedZipSize(entriesOf(specs))).toBe(r.size);
    });
  }
});

test.describe("zip 5: the 16 MiB ZIP64 margin, written in full", { tag: "@slow" }, () => {
  for (const [size, zip64] of [
    [MAX32 - 16 * MiB - 1, false],
    [MAX32 - 16 * MiB, true],
  ] as const) {
    test(`declared size 0x${size.toString(16)}: ZIP64 local header ${zip64 ? "and 24-byte descriptor" : "absent, 16-byte descriptor"}`, async () => {
      // check.py's manifest check asserts the policy (local ZIP64 iff size
      // unknown or >= 4 GiB - 16 MiB) and the descriptor width that follows.
      const specs = [{ path: "edge.bin", size }];
      const r = await bigZip(specs);
      expect(r.check.ok, r.check.output).toBe(true);
      const local = r.locals[0]!;
      expect(local.extras.map((x) => x.id)).toEqual(zip64 ? [0x0001, 0x5455] : [0x5455]);
      expect(local.versionNeeded).toBe(zip64 ? 45 : 20);
      expect(r.size).toBe(
        30 + 8 + 9 + (zip64 ? 20 : 0) + size + (zip64 ? 24 : 16) + 46 + 8 + 9 + 22,
      );
      expect(zip.storedZipSize(entriesOf(specs))).toBe(r.size);
    });
  }
});

test.describe("zip 8: stored odd-size entries past 4 GiB", { tag: "@slow" }, () => {
  test("262,140 B + 5 × (1000 MiB − 1) + a deflated file: check.py passes, offsets past 4 GiB", async () => {
    const specs: Spec[] = [
      { path: "small-odd.bin", size: 262_140 },
      ...[1, 2, 3, 4, 5].map((i) => ({ path: `odd${i}.bin`, size: 1000 * MiB - 1 })),
      { path: "after.txt", size: 1000, compress: true },
    ];
    const r = await bigZip(specs, { deflateRaw: zlibLevel(1) });
    expect(r.check.ok, r.check.output).toBe(true);
    expect(r.size).toBeGreaterThan(4 * GiB);
    // odd5.bin ends past 4 GiB and after.txt starts there: its offset alone
    // goes into the central ZIP64 extra.
    const past = r.end.central.filter((c) => c.offset >= MAX32);
    expect(past.map((c) => c.name)).toEqual(["after.txt"]);
    for (const c of past) {
      expect(c.offset32).toBe(MAX32);
      expect(c.extras.map((x) => [x.id, x.data.length])).toEqual([
        [0x0001, 8],
        [0x5455, 5],
      ]);
      expect(c.versionNeeded).toBe(45);
    }
    // No ZIP64 local headers: every size was declared and below the threshold.
    expect(r.locals.every((l) => l.extras.every((x) => x.id !== 1))).toBe(true);
    expect(r.end.zip64End).toBe(true);
  });
});

test.describe("zip 9 and 10: entries of 4 GiB and more", { tag: "@slow" }, () => {
  test("deflated, compressed size over 4 GiB (zlib level 0: stored blocks), size unknown", async () => {
    const size = 4.5 * GiB;
    const specs: Spec[] = [
      { path: "noise.bin", size, compress: true, sizeKnown: false },
      { path: "after.txt", size: 1000, compress: true, sizeKnown: false },
    ];
    const r = await bigZip(specs, { deflateRaw: zlibLevel(0) });
    expect(r.check.ok, r.check.output).toBe(true);
    const big = r.end.central[0]!;
    expect(big.compressedSize).toBeGreaterThan(size);
    // Both sizes overflow: both in the ZIP64 extra, which comes first.
    expect([big.size32, big.compressedSize32, big.offset32]).toEqual([MAX32, MAX32, 0]);
    expect(big.extras.map((x) => [x.id, x.data.length])).toEqual([
      [0x0001, 16],
      [0x5455, 5],
    ]);
    expect(r.locals[0]!.extras.map((x) => x.id)).toEqual([0x0001, 0x5455]);
  });

  test("deflated 4.5 GiB to a few MB: only the uncompressed size is in the central ZIP64 extra", async () => {
    const size = 4.5 * GiB;
    const r = await bigZip([{ path: "zeros.bin", size, compress: true }], {
      deflateRaw: zlibLevel(1),
    });
    expect(r.check.ok, r.check.output).toBe(true);
    const c = r.end.central[0]!;
    expect(c.size).toBe(size);
    expect(c.compressedSize).toBeLessThan(MAX32);
    expect([c.size32, c.offset32]).toEqual([MAX32, 0]);
    expect(c.compressedSize32).toBe(c.compressedSize);
    expect(c.extras.map((x) => [x.id, x.data.length])).toEqual([
      [0x0001, 8],
      [0x5455, 5],
    ]);
  });

  for (const sizeKnown of [true, false]) {
    test(`stored 4.5 GiB entry (size ${sizeKnown ? "known" : "unknown"}) + an entry past 4 GiB`, async () => {
      const specs: Spec[] = [
        { path: "big.bin", size: 4.5 * GiB, sizeKnown },
        { path: "after.txt", size: 1000, sizeKnown },
      ];
      const r = await bigZip(specs);
      expect(r.check.ok, r.check.output).toBe(true);
      const [big, after] = r.end.central;
      expect(big!.extras.map((x) => [x.id, x.data.length])).toEqual([
        [0x0001, 16],
        [0x5455, 5],
      ]);
      expect(after!.extras.map((x) => [x.id, x.data.length])).toEqual([
        [0x0001, 8],
        [0x5455, 5],
      ]);
      expect(zip.storedZipSize(entriesOf(specs))).toBe(sizeKnown ? r.size : undefined);
    });
  }

  test("4 × 1.2 GiB stored, no ZIP64 local headers; 5th entry and central directory past 4 GiB", async () => {
    const specs: Spec[] = [
      ...[1, 2, 3, 4].map((i) => ({ path: `part${i}.bin`, size: Math.floor(1.2 * GiB) })),
      { path: "last.txt", size: 1000 },
    ];
    const r = await bigZip(specs);
    expect(r.check.ok, r.check.output).toBe(true);
    expect(r.end.zip64End).toBe(true);
    expect(r.end.centralOffset).toBeGreaterThan(MAX32);
    expect(r.locals.every((l) => l.extras.every((x) => x.id !== 1))).toBe(true);
    expect(zip.storedZipSize(entriesOf(specs))).toBe(r.size);
  });
});
