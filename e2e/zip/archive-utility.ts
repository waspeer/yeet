// Opt-in, macOS only, must-test item 8 (docs/design/zip.md): the real
// Archive Utility (launched in the background with `open -g -a`) expands
// zips written by zip.ts next to the archive (its default "same folder"
// setting); the result is compared with the manifest, mtimes included (a
// wrong mtime is a failure). A failure usually leaves an error dialog; the
// script kills the app after a timeout. Ported from the 0c prototype.
//
//   node e2e/zip/archive-utility.ts          fixtures (sizes known/unknown, store, UTC DOS
//                                            times, the CLI's zlib) and 70,000 entries
//   node e2e/zip/archive-utility.ts --big    also four >4 GiB archives (~5 GB temp each)
//
// Close Archive Utility first. Human in the loop: if an error dialog shows,
// note it, and dismiss it.

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Duplex } from "node:stream";
import { promisify } from "node:util";
import zlib from "node:zlib";
import { fixtureEntries, generatedStream, noise } from "./fixtures.ts";
import { writeZip, type ZipEntry, type ZipOptions } from "./module.ts";
import { compareDir, manifestOf } from "./validate.ts";

const run = promisify(execFile);
const MTIME = Date.UTC(2026, 9, 7, 12, 34, 56);
const GiB = 1024 ** 3;
const zlibCrc32 = (zlib as unknown as { crc32: (d: Uint8Array, p: number) => number }).crc32;

async function running(): Promise<boolean> {
  try {
    await run("pgrep", ["-x", "Archive Utility"]);
    return true;
  } catch {
    return false;
  }
}

const zlib1 = () => Duplex.toWeb(zlib.createDeflateRaw({ level: 1 })) as never;
const BLOCK = new Uint8Array(1 << 20);
noise(42)(BLOCK);
const blockFill = (c: Uint8Array, o: number) => {
  c.set(BLOCK.subarray(0, c.length));
  if (c.length >= 8) new DataView(c.buffer, c.byteOffset).setFloat64(0, o);
};
const big = (path: string, compress: boolean, known: boolean): ZipEntry => ({
  path,
  compress,
  lastModified: MTIME,
  size: known ? 4.5 * GiB : undefined,
  stream: () => generatedStream(4.5 * GiB, blockFill, 1 << 20),
});
const small: ZipEntry = {
  path: "after.txt",
  lastModified: MTIME,
  size: 3,
  stream: () => generatedStream(3, (c) => c.set([0x61, 0x62, 0x0a])),
};
const oddEntry = (path: string, size: number): ZipEntry => ({
  path,
  compress: false,
  lastModified: MTIME,
  size,
  stream: () => generatedStream(size, blockFill, 1 << 20),
});

const cases: { label: string; entries: () => ZipEntry[]; options?: ZipOptions; timeout: number }[] =
  [
    {
      label: "fixtures, sizes known",
      entries: () => fixtureEntries({ sizes: "known" }),
      timeout: 30,
    },
    {
      label: "fixtures, sizes unknown (ZIP64 local)",
      entries: () => fixtureEntries({ sizes: "unknown" }),
      timeout: 30,
    },
    {
      label: "fixtures, sizes mixed, zlib level 1 (the CLI)",
      entries: () => fixtureEntries({ sizes: "mixed" }),
      options: { deflateRaw: zlib1 },
      timeout: 30,
    },
    {
      label: "fixtures, store",
      entries: () => fixtureEntries({ sizes: "known" }),
      options: { compress: false },
      timeout: 30,
    },
    {
      label: "fixtures, DOS time in UTC (as produced in workerd)",
      entries: () => fixtureEntries({ sizes: "known" }),
      options: { timeZoneOffset: 0 },
      timeout: 30,
    },
    {
      label: "70,000 entries (ZIP64 end record by count)",
      // A second top-level entry so Archive Utility wraps the output in "case/".
      entries: () => [
        small,
        ...Array.from({ length: 70_000 }, (_, i) => ({
          path: `many/${String(i).padStart(6, "0")}.txt`,
          lastModified: MTIME,
          size: 4,
          compress: false,
          stream: () => generatedStream(4, (c) => c.set([0x61 + (i % 26), 0x62, 0x63, 0x0a])),
        })),
      ],
      timeout: 600,
    },
  ];
if (process.argv.includes("--big")) {
  cases.push(
    {
      label: "stored 4.5 GiB, size known",
      entries: () => [big("big.bin", false, true), small],
      timeout: 300,
    },
    {
      label: "stored 4.5 GiB, size unknown",
      entries: () => [big("big.bin", false, false), small],
      timeout: 300,
    },
    {
      label: "deflated incompressible 4.5 GiB (csize > 4 GiB), size unknown",
      entries: () => [big("noise.bin", true, false), small],
      options: { deflateRaw: zlib1 },
      timeout: 300,
    },
    {
      // The layout ditto fails on (stored, odd sizes, past 4 GiB).
      label: "stored odd sizes (262,140 B + 5 x (1000 MiB - 1)) past 4 GiB",
      entries: () => [
        oddEntry("small-odd.bin", 262_140),
        ...[1, 2, 3, 4, 5].map((i) => oddEntry(`odd${i}.bin`, 1000 * 1024 * 1024 - 1)),
        small,
      ],
      timeout: 300,
    },
  );
}

if (await running()) throw new Error("Archive Utility is already running; close it first");
let allOk = true;
for (const c of cases) {
  const dir = await mkdtemp(join(tmpdir(), "yeet-zip-au-"));
  try {
    const zip = join(dir, "case.zip");
    await writeZip(zip, c.entries(), { crc32: zlibCrc32, ...c.options });
    const manifest = await manifestOf(c.entries());
    const t0 = performance.now();
    await run("open", ["-g", "-a", "Archive Utility", zip]);
    // Wait for the app to start, finish and quit (it quits by itself on success).
    let started = false;
    let timedOut = false;
    for (;;) {
      const r = await running();
      started ||= r;
      if (started && !r) break;
      if ((performance.now() - t0) / 1000 > c.timeout) {
        timedOut = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    const seconds = ((performance.now() - t0) / 1000).toFixed(1);
    if (timedOut) await run("killall", ["Archive Utility"]).catch(() => {});
    const out = join(dir, "case");
    if (!existsSync(out)) {
      allOk = false;
      console.log(
        `  FAIL  ${c.label}: no output folder after ${seconds} s${timedOut ? " (app still running: likely an error dialog)" : ""}`,
      );
      continue;
    }
    const { problems, skew } = await compareDir(out, manifest, MTIME);
    const ok = problems.length === 0 && skew.length === 0; // wrong mtime is a failure
    allOk &&= ok;
    console.log(
      `  ${ok ? "PASS" : "FAIL"}  ${c.label} [${seconds} s]${ok ? "" : ": " + problems.slice(0, 3).join("; ")}${skew.length ? ` (mtime skew on ${skew.length}: ${skew[0]})` : ""}`,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
console.log(allOk ? "\nALL PASS" : "\nSOME FAILURES");
process.exitCode = allOk ? 0 : 1;
