// ZIP64: archives past the 4 GiB limits, validated with every local reader.
// Writes ~15 GB of zips (one at a time) to the OS temp dir and deletes them.
// Usage: node scripts/zip64-test.ts [filter]
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Duplex } from "node:stream";
import zlib from "node:zlib";
import { generatedStream, noise } from "../fixtures.ts";
import type { ZipEntry, ZipOptions } from "../zip.ts";
import { writeZip } from "./node-test.ts";
import { manifestOf, printResults, validateZip } from "./validate.ts";

const GiB = 1024 ** 3;
const MiB = 1024 ** 2;
const MTIME = Date.UTC(2026, 9, 7, 12, 34, 56);

/** Fast fill: a fixed 1 MiB random block, each 64 KiB chunk stamped with its offset so misordering is detectable. */
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
  for (let i = 0; i < chunk.length; i++) chunk[i] = LINE[(offset + i) % LINE.length];
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
  lastModified: MTIME,
  compress,
  stream: () => generatedStream(size, fill, 1024 * 1024),
});

const zlib1 = () =>
  Duplex.toWeb(zlib.createDeflateRaw({ level: 1 })) as unknown as {
    writable: WritableStream<Uint8Array>;
    readable: ReadableStream<Uint8Array>;
  };

const cases: {
  label: string;
  entries: () => ZipEntry[];
  options?: ZipOptions;
  expectFail?: string[];
}[] = [
  {
    label: "stored 4.5 GiB entry (size known) + small file at offset > 4 GiB",
    entries: () => [
      entry("big.bin", 4.5 * GiB, stampedFill, false),
      entry("after.txt", 1000, textFill, true),
    ],
  },
  {
    label: "deflated 4.5 GiB entry (compresses to < 4 GiB) + small file",
    entries: () => [
      entry("big.txt", 4.5 * GiB, textFill, true),
      entry("after.txt", 1000, textFill, true),
    ],
    options: { deflateRaw: zlib1, crc32: zlib.crc32 },
  },
  {
    label:
      "4 x 1.2 GiB stored (no ZIP64 local headers), 5th entry and central directory past 4 GiB",
    entries: () => [
      ...[1, 2, 3, 4].map((i) => entry(`part${i}.bin`, Math.floor(1.2 * GiB), stampedFill, false)),
      entry("last.txt", 1000, textFill, true),
    ],
  },
  {
    label: "deflated incompressible 4.5 GiB entry (compressed size > 4 GiB), size unknown",
    entries: () => [
      entry("noise.bin", 4.5 * GiB, stampedFill, true, false),
      entry("after.txt", 1000, textFill, true, false),
    ],
    options: { deflateRaw: zlib1, crc32: zlib.crc32 },
  },
  {
    // Found by the independent verifier: all sizes above are 1 MiB multiples,
    // which hid a ditto bug with stored data-descriptor entries past 4 GiB.
    label: "stored odd-size entries (262,140 B + 5 x (1000 MiB - 1)) past 4 GiB",
    entries: () => [
      entry("small-odd.bin", 262_140, stampedFill, false),
      ...[1, 2, 3, 4, 5].map((i) =>
        entry(`odd${i}.bin`, 1000 * 1024 * 1024 - 1, stampedFill, false),
      ),
      entry("after.txt", 1000, textFill, true),
    ],
    expectFail: ["ditto -x -k"],
  },
  {
    label: "stored 4.5 GiB entry, size unknown",
    entries: () => [
      entry("big.bin", 4.5 * GiB, stampedFill, false, false),
      entry("after.txt", 1000, textFill, true, false),
    ],
  },
];

const filter = process.argv[2];
for (const c of cases) {
  if (filter && !c.label.includes(filter)) continue;
  const dir = await mkdtemp(join(tmpdir(), "yeet-zip64-"));
  try {
    const path = join(dir, "test.zip");
    const t0 = performance.now();
    const manifest = await manifestOf(c.entries());
    const t1 = performance.now();
    const size = await writeZip(path, c.entries(), { crc32: zlib.crc32, ...c.options });
    const t2 = performance.now();
    console.log(
      `\n${c.label}: zip ${(size / GiB).toFixed(3)} GiB (${size} bytes), manifest ${((t1 - t0) / 1000).toFixed(1)} s, zip ${((t2 - t1) / 1000).toFixed(1)} s`,
    );
    const results: Record<string, { ok: boolean; detail: string }> = {};
    for (const reader of [
      "unzip -t",
      "unzip -x",
      "python zipfile",
      "ditto -x -k",
      "bsdtar",
      "bsdtar (stdin)",
      "7za t",
      "7za x",
      "structural",
    ]) {
      const r0 = performance.now();
      const r = await validateZip(path, manifest, { mtime: MTIME, readers: [reader] });
      for (const [k, v] of Object.entries(r))
        results[k] = {
          ...v,
          detail: `${v.detail} [${((performance.now() - r0) / 1000).toFixed(0)} s]`,
        };
    }
    printResults(c.label, results, c.expectFail);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
