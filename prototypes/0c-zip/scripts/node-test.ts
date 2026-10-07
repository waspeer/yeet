// Node: write fixture zips in several configurations and validate each with
// every local reader. Usage: node scripts/node-test.ts
import { createWriteStream } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Duplex, Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import zlib from "node:zlib";
import { fixtureEntries, generatedStream } from "../fixtures.ts";
import { createZip, type ZipEntry, type ZipOptions } from "../zip.ts";
import { manifestOf, printResults, validateZip, type Manifest } from "./validate.ts";

const zlibDeflate = (level: number) => () =>
  Duplex.toWeb(zlib.createDeflateRaw({ level })) as unknown as {
    writable: WritableStream<Uint8Array>;
    readable: ReadableStream<Uint8Array>;
  };

export async function writeZip(
  path: string,
  entries: Iterable<ZipEntry>,
  options?: ZipOptions,
): Promise<number> {
  await pipeline(Readable.fromWeb(createZip(entries, options) as never), createWriteStream(path));
  return (await stat(path)).size;
}

const MTIME = Date.UTC(2026, 9, 7, 12, 34, 56);

interface Case {
  label: string;
  entries: () => ZipEntry[];
  options?: ZipOptions;
  mtime?: number;
  readers?: string[];
  /** Readers known to reject this variant (documented in docs/design/zip.md). */
  expectFail?: string[];
}

const many = (n: number): ZipEntry[] =>
  Array.from({ length: n }, (_, i) => ({
    path: `many/${String(i).padStart(6, "0")}.txt`,
    lastModified: MTIME,
    size: 4,
    compress: false,
    stream: () => generatedStream(4, (c) => c.set([0x61 + (i % 26), 0x62, 0x63, 0x0a])),
  }));

const cases: Case[] = [
  {
    label: "sizes known, zip64 auto, CompressionStream, JS crc",
    entries: () => fixtureEntries({ sizes: "known" }),
    mtime: MTIME,
  },
  {
    label: "sizes unknown (ZIP64 local headers), CompressionStream",
    entries: () => fixtureEntries({ sizes: "unknown" }),
    mtime: MTIME,
  },
  {
    label: "sizes mixed, zlib level 1, zlib.crc32",
    entries: () => fixtureEntries({ sizes: "mixed" }),
    options: { deflateRaw: zlibDeflate(1), crc32: zlib.crc32 },
    mtime: MTIME,
  },
  {
    label: "zip64 always",
    entries: () => fixtureEntries({ sizes: "known" }),
    options: { zip64: "always" },
    // Not the policy: ditto rejects it, and check.py flags unneeded ZIP64.
    expectFail: ["ditto -x -k", "structural"],
    mtime: MTIME,
  },
  {
    label: "sizes unknown, central ZIP64 mirrors local (experimental)",
    entries: () => fixtureEntries({ sizes: "unknown" }),
    options: { experimental: { centralZip64: "mirror" } },
    expectFail: ["ditto -x -k", "structural"],
    mtime: MTIME,
  },
  {
    label: "sizes unknown, ZIP64 local with zero 32-bit sizes (experimental)",
    entries: () => fixtureEntries({ sizes: "unknown" }),
    options: { experimental: { localSizes: "zero" } },
    // Readers accept it, but ZIP64 fields behind non-0xFFFFFFFF values violate APPNOTE.
    expectFail: ["structural"],
    mtime: MTIME,
  },
  {
    label: "store everything (--store)",
    entries: () => fixtureEntries({ sizes: "known" }),
    options: { compress: false },
    mtime: MTIME,
  },
  {
    label: "empty archive (byte-identical to Python's empty ZipFile)",
    entries: () => [],
    expectFail: ["unzip -t", "unzip -x", "ditto -x -k", "7za x"],
  },
  {
    label: "70,000 entries (ZIP64 end record by count)",
    entries: () => many(70_000),
    mtime: MTIME,
    // p7zip 16.02 extraction of 70k files into one directory takes >10 min; `7za t` covers it.
    readers: [
      "unzip -t",
      "unzip -x",
      "python zipfile",
      "ditto -x -k",
      "bsdtar",
      "bsdtar (stdin)",
      "7za t",
      "structural",
    ],
  },
];

async function main() {
  const dir = await mkdtemp(join(tmpdir(), "yeet-zip-node-"));
  let allOk = true;
  const only = process.argv[2];
  try {
    for (const [i, c] of cases.entries()) {
      if (only && !c.label.includes(only)) continue;
      const path = join(dir, `case-${i}.zip`);
      const manifest: Manifest = await manifestOf(c.entries());
      const t0 = performance.now();
      const size = await writeZip(path, c.entries(), c.options);
      const ms = performance.now() - t0;
      const results = await validateZip(path, manifest, { mtime: c.mtime, readers: c.readers });
      allOk =
        printResults(`${c.label} — ${size} bytes in ${ms.toFixed(0)} ms`, results, c.expectFail) &&
        allOk;
    }
    // Error paths
    console.log("\n## error paths");
    const sizeLie: ZipEntry = {
      path: "a.txt",
      size: 10,
      stream: () => generatedStream(5, () => {}),
    };
    await expectError("size hint mismatch", () => writeZip(join(dir, "x.zip"), [sizeLie]));
    await expectError("duplicate path", () =>
      writeZip(join(dir, "x.zip"), [
        { path: "a", size: 0, stream: () => generatedStream(0, () => {}) },
        { path: "./a", size: 0, stream: () => generatedStream(0, () => {}) },
      ]),
    );
    await expectError("path traversal", () =>
      writeZip(join(dir, "x.zip"), [
        { path: "../etc/passwd", stream: () => generatedStream(0, () => {}) },
      ]),
    );
    await expectError("source stream error", () =>
      writeZip(join(dir, "x.zip"), [
        {
          path: "boom",
          stream: () =>
            new ReadableStream({
              pull(c) {
                c.error(new Error("disk on fire"));
              },
            }),
        },
      ]),
    );
    // Cancellation propagates to the entry source (store and deflate paths).
    for (const compress of [false, true]) {
      let cancelled = false;
      const zip = createZip([
        {
          path: "endless.bin",
          compress,
          stream: () =>
            new ReadableStream({
              pull(c) {
                c.enqueue(new Uint8Array(65536));
              },
              cancel() {
                cancelled = true;
              },
            }),
        },
      ]);
      const reader = zip.getReader();
      await reader.read();
      await reader.read();
      await reader.cancel("stop");
      // pipeThrough propagates cancellation asynchronously.
      await new Promise((r) => setTimeout(r, 50));
      console.log(
        `  ${cancelled ? "PASS" : "FAIL"}  cancel propagates to entry source (compress: ${compress})`,
      );
      allOk &&= cancelled;
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  console.log(allOk ? "\nALL PASS" : "\nSOME FAILURES");
  process.exitCode = allOk ? 0 : 1;

  async function expectError(label: string, fn: () => Promise<unknown>) {
    try {
      await fn();
      console.log(`  FAIL  ${label}: no error`);
      allOk = false;
    } catch (error) {
      console.log(`  PASS  ${label}: ${(error as Error).message}`);
    }
  }
}

if (import.meta.main) await main();
