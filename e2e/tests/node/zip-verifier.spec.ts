// Gaps found by the round 2B verification's own mutants (zip.ts), kept as
// fast tests so e2e/zip/mutate.mjs-style runs catch them without the @slow
// >4 GiB specs:
//
// - the end record's entry counts saturate at 0xFFFF past 65,535 entries
//   (zip-format's zip 4 stops at 65,535, where saturating and truncating
//   to 16 bits give the same bytes);
// - storedZipSize() is exact for stored entries at and around the ZIP64
//   local-header threshold (4 GiB - 16 MiB) and past 4 GiB. Only zip-big
//   (@slow) checked this; here the archive is only counted, never written,
//   from zero-filled streams in 64 MiB chunks with a stubbed CRC, so it
//   takes a few seconds and no disk.

import { expect, test } from "@playwright/test";
import { drain, zip, zeroStream, type ZipEntry } from "../../zip/module.js";
import { parseZip } from "../../zip/parse.js";

const MiB = 1024 ** 2;
const MAX32 = 0xffffffff;
const THRESHOLD = MAX32 - 16 * MiB; // first size written with a ZIP64 local header

test.describe("zip (verifier): end record counts past 65,535 entries", () => {
  test("65,536 entries: 16-bit counts are 0xFFFF, the ZIP64 end record has the real count", async () => {
    const n = 65_536;
    const entries = (): ZipEntry[] =>
      Array.from({ length: n }, (_, i) => ({
        path: `many/${String(i).padStart(6, "0")}.txt`,
        size: 1,
        compress: false,
        lastModified: Date.UTC(2026, 9, 7),
        stream: () => new Blob(["x"]).stream(),
      }));
    const bytes = new Uint8Array(await new Response(zip.createZip(entries())).arrayBuffer());
    const eocd = new DataView(bytes.buffer, bytes.byteOffset + bytes.length - 22, 22);
    expect(eocd.getUint32(0, true)).toBe(0x06054b50);
    expect(eocd.getUint16(8, true)).toBe(0xffff); // entries on this disk
    expect(eocd.getUint16(10, true)).toBe(0xffff); // entries in total
    const parsed = parseZip(bytes);
    expect(parsed.zip64End).toBe(true);
    expect(parsed.count).toBe(n);
    expect(zip.storedZipSize(entries())).toBe(bytes.length);
  });
});

test.describe("zip (verifier): storedZipSize around the ZIP64 thresholds", () => {
  test.setTimeout(120_000);
  const sizes = [THRESHOLD - 1, THRESHOLD, MAX32 - 1, MAX32, MAX32 + 1];
  for (const size of sizes) {
    test(`one stored entry of 0x${size.toString(16)} bytes (counted, not written)`, async () => {
      const entries = (): ZipEntry[] => [
        { path: "small.txt", size: 3, compress: false, stream: () => new Blob(["abc"]).stream() },
        {
          path: "big.bin",
          size,
          compress: false,
          lastModified: Date.UTC(2026, 9, 7),
          stream: () => zeroStream(size, 64 * MiB),
        },
        { path: "after/", lastModified: Date.UTC(2026, 9, 7) },
      ];
      const actual = await drain(zip.createZip(entries(), { crc32: () => 0 }));
      expect(actual).toBeGreaterThan(size);
      expect(zip.storedZipSize(entries())).toBe(actual);
    });
  }
});
