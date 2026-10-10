// The streaming zip writer (packages/cli/src/zip.ts, identical in
// packages/worker/src/zip.ts): the must-test list of docs/design/zip.md,
// except the >4 GiB archives (zip-big.spec.ts), the other runtimes
// (zip-runtime.spec.ts, tests/browser/zip-runtime.spec.ts) and the tooling
// (zip-tooling.spec.ts). Items are numbered as in that list.
//
// check.py (e2e/zip/check.py, the independent verifier's parser, verbatim)
// is the structural oracle; e2e/zip/parse.ts asserts the bytes check.py does
// not report. scripts/mutate.mjs runs these tests against mutants of zip.ts
// and checks that each mutant is caught.

import { expect, test } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Duplex } from "node:stream";
import zlib from "node:zlib";
import { fixtureEntries, generatedStream, noise } from "../../zip/fixtures.js";
import {
  drain,
  writeZip,
  zip,
  zipBytes,
  ZIP_MODULE_PATH,
  zeroStream,
  type ByteTransform,
  type ZipEntry,
  type ZipOptions,
} from "../../zip/module.js";
import { dosParts, parseZip, utSeconds } from "../../zip/parse.js";
import { run, withScratch } from "../../zip/scratch.js";
import {
  checkStructure,
  failures,
  manifestOf,
  validateZip,
  type Manifest,
} from "../../zip/validate.js";

const MTIME = Date.UTC(2026, 9, 7, 12, 34, 56);
/**
 * A minute ago, on an even second: for tests that extract with ditto, which
 * applies the UTC offset in effect now to the DOS time (see the DST test), so
 * a fixed date would fail on the other side of the next transition.
 */
const RECENT = Math.floor((Date.now() - 60_000) / 2000) * 2000;
const MiB = 1024 * 1024;
const MAX32 = 0xffffffff;

const zlibDeflate = (level: number) => (): ByteTransform =>
  Duplex.toWeb(zlib.createDeflateRaw({ level })) as unknown as ByteTransform;
const zlibCrc32 = (zlib as unknown as { crc32: (d: Uint8Array, p: number) => number }).crc32;

const bytesEntry = (path: string, data: Uint8Array | string, extra: Partial<ZipEntry> = {}) => {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  return {
    path,
    lastModified: MTIME,
    size: bytes.length,
    stream: () =>
      new ReadableStream<Uint8Array>({
        start(c) {
          if (bytes.length) c.enqueue(bytes);
          c.close();
        },
      }),
    ...extra,
  } satisfies ZipEntry;
};

/** Write a zip to a temp file and run check.py on it with the manifest of the same entries. */
async function checkWith(
  entries: () => ZipEntry[],
  options?: ZipOptions,
): Promise<{ ok: boolean; output: string; manifest: Manifest; bytes: Uint8Array }> {
  return withScratch(async (dir) => {
    const path = join(dir, "t.zip");
    await writeZip(path, entries(), options);
    const manifest = await manifestOf(entries());
    const r = await checkStructure(path, manifest);
    return { ...r, manifest, bytes: new Uint8Array(await readFile(path)) };
  });
}

test.describe("zip: the module under test", () => {
  test("is the CLI copy (or a mutant named by YEET_ZIP_MODULE)", () => {
    expect(ZIP_MODULE_PATH).toMatch(/zip\.ts$/);
    expect(typeof zip.createZip).toBe("function");
  });
});

test.describe("zip 1: check.py as the structural oracle", () => {
  const variants: { label: string; sizes: "known" | "unknown" | "mixed"; options?: ZipOptions }[] =
    [
      { label: "sizes known, CompressionStream, crc32Js", sizes: "known" },
      { label: "sizes unknown (ZIP64 local headers), CompressionStream", sizes: "unknown" },
      {
        label: "sizes mixed, zlib level 1, zlib.crc32",
        sizes: "mixed",
        options: { deflateRaw: zlibDeflate(1), crc32: zlibCrc32 },
      },
      {
        label: "sizes mixed, zlib level 6, crc32Js",
        sizes: "mixed",
        options: { deflateRaw: zlibDeflate(6) },
      },
      { label: "store everything (--store)", sizes: "known", options: { compress: false } },
      { label: "store everything, sizes unknown", sizes: "unknown", options: { compress: false } },
    ];
  for (const v of variants) {
    test(`check.py passes: fixtures, ${v.label}`, async () => {
      const r = await checkWith(() => fixtureEntries({ sizes: v.sizes }), v.options);
      expect(r.ok, r.output).toBe(true);
      expect(r.output).toContain("9 entries, zip64eocd=no, OK");
    });
  }

  test("every local reader accepts the fixtures (sizes known and unknown)", async () => {
    for (const sizes of ["known", "unknown"] as const) {
      await withScratch(async (dir) => {
        const path = join(dir, "t.zip");
        const entries = () => fixtureEntries({ sizes, lastModified: RECENT });
        await writeZip(path, entries());
        const results = await validateZip(path, await manifestOf(entries()), {
          readers: [
            "unzip -t",
            "unzip -x",
            "python zipfile",
            "ditto -x -k",
            "bsdtar",
            "bsdtar (stdin)",
            "structural",
          ],
        });
        expect(failures(results), `sizes ${sizes}`).toEqual([]);
      });
    }
  });

  test("check.py is not vacuous: it rejects broken archives", async () => {
    await withScratch(async (dir) => {
      const entries = () => [
        bytesEntry("a.txt", "hello hello hello hello\n"),
        bytesEntry("b.bin", new Uint8Array([1, 2, 3]), { compress: false }),
      ];
      const good = await zipBytes(entries());
      const manifest = await manifestOf(entries());
      const parsed = parseZip(good);
      const a = parsed.local[0]!;
      const b = parsed.local[1]!;
      const broken: [string, (z: Uint8Array) => void, RegExp][] = [
        ["UTF-8 flag cleared", (z) => (z[a.offset + 7]! &= ~0x08), /flags|UTF-8/],
        ["descriptor signature", (z) => (z[b.dataOffset + 3]! ^= 0xff), /descriptor/],
        ["stored data byte (CRC)", (z) => (z[b.dataOffset]! ^= 1), /CRC mismatch/],
        [
          "local version needed",
          (z) => new DataView(z.buffer).setUint16(a.offset + 4, 45, true),
          /version needed/,
        ],
      ];
      for (const [label, corrupt, message] of broken) {
        const z = good.slice();
        corrupt(z);
        const path = join(dir, "broken.zip");
        await writeFile(path, z);
        const r = await checkStructure(path, manifest);
        expect(r.ok, `${label}: ${r.output}`).toBe(false);
        expect(r.output, label).toMatch(message);
      }
      // The ZIP64 policy: an entry announced as "size unknown" must have a ZIP64 local header.
      const path = join(dir, "good.zip");
      await writeFile(path, good);
      manifest.meta!.get("a.txt")!.sizeKnown = false;
      const r = await checkStructure(path, manifest);
      expect(r.output).toMatch(/zip64 local False, expected True/);
    });
  });
});

test.describe("zip 2: descriptor width", () => {
  test("24 bytes iff the local header has a ZIP64 extra, else 16; local ZIP64 iff size unknown", async () => {
    for (const sizes of ["known", "unknown", "mixed"] as const) {
      const entries = fixtureEntries({ sizes });
      const parsed = parseZip(await zipBytes(fixtureEntries({ sizes })));
      expect(parsed.local).toHaveLength(entries.length);
      for (const [i, e] of parsed.local.entries()) {
        const declared = entries[i]!;
        const zip64 = e.extras.some((x) => x.id === 1);
        if (e.name.endsWith("/")) {
          expect(e.descriptor, e.name).toBeNull();
          expect(zip64, e.name).toBe(false);
          continue;
        }
        expect(zip64, `${sizes} ${e.name}: ZIP64 local iff size unknown`).toBe(
          declared.size === undefined,
        );
        expect(e.descriptor?.width, `${sizes} ${e.name}`).toBe(zip64 ? 24 : 16);
        const central = parsed.central[i]!;
        expect(e.descriptor).toMatchObject({
          crc: central.crc,
          compressedSize: central.compressedSize,
          size: central.size,
        });
        // Version needed and the 32-bit sizes follow the ZIP64 decision.
        expect(e.versionNeeded).toBe(zip64 ? 45 : 20);
        expect([e.size32, e.compressedSize32]).toEqual(zip64 ? [MAX32, MAX32] : [0, 0]);
        expect(e.crc).toBe(0);
        expect(e.flags).toBe(0x0808);
      }
    }
  });
});

test.describe("zip 3: timestamps (a wrong mtime is a failure)", () => {
  /** Expected DOS fields for `mtime` shown in a zone `offset` minutes east of UTC (seconds rounded down to even). */
  const dosAt = (mtime: number, offset: number) => {
    const d = new Date(mtime + offset * 60_000);
    return [
      d.getUTCFullYear(),
      d.getUTCMonth() + 1,
      d.getUTCDate(),
      d.getUTCHours(),
      d.getUTCMinutes(),
      d.getUTCSeconds() - (d.getUTCSeconds() % 2),
    ];
  };

  test("timeZoneOffset: DOS time in that zone, UT in UTC, local and central agree", async () => {
    for (const offset of [0, 120, -300, 330, 840, -720]) {
      const parsed = parseZip(
        await zipBytes([bytesEntry("t.txt", "x"), bytesEntry("d/", "", { size: undefined })], {
          timeZoneOffset: offset,
        }),
      );
      for (const [i, e] of parsed.local.entries()) {
        const c = parsed.central[i]!;
        expect(dosParts(e.dosTime, e.dosDate), `offset ${offset}`).toEqual(dosAt(MTIME, offset));
        expect([c.dosTime, c.dosDate]).toEqual([e.dosTime, e.dosDate]);
        expect(utSeconds(e.extras)).toBe(Math.floor(MTIME / 1000));
        expect(utSeconds(c.extras)).toBe(Math.floor(MTIME / 1000));
      }
      // The independent check, with the zone the DOS times were written in.
      await withScratch(async (dir) => {
        const entries = () => [bytesEntry("t.txt", "x")];
        const path = join(dir, "t.zip");
        await writeZip(path, entries(), { timeZoneOffset: offset });
        const r = await checkStructure(path, await manifestOf(entries()), { tzMinutes: offset });
        expect(r.ok, r.output).toBe(true);
      });
    }
  });

  // Europe/Amsterdam: CET (+60) to CEST (+120) at 2026-03-29 01:00 UTC, back at 2026-10-25 01:00 UTC.
  const DST = [
    {
      path: "march-before.txt",
      mtime: Date.UTC(2026, 2, 29, 0, 59, 58),
      dos: [2026, 3, 29, 1, 59, 58],
    },
    { path: "march-after.txt", mtime: Date.UTC(2026, 2, 29, 1, 0, 0), dos: [2026, 3, 29, 3, 0, 0] },
    {
      path: "october-before.txt",
      mtime: Date.UTC(2026, 9, 25, 0, 59, 58),
      dos: [2026, 10, 25, 2, 59, 58],
    },
    {
      path: "october-after.txt",
      mtime: Date.UTC(2026, 9, 25, 1, 0, 0),
      dos: [2026, 10, 25, 2, 0, 0],
    },
    {
      path: "summer-odd-second.txt",
      mtime: Date.UTC(2026, 6, 1, 10, 0, 59, 999),
      dos: [2026, 7, 1, 12, 0, 58],
    },
    { path: "winter.txt", mtime: Date.UTC(2026, 0, 15, 23, 30, 0), dos: [2026, 1, 16, 0, 30, 0] },
  ];

  test("process TZ, both sides of both DST transitions (TZ=Europe/Amsterdam, default offset)", async () => {
    await withScratch(async (dir) => {
      const path = join(dir, "dst.zip");
      const env = { ...process.env, TZ: "Europe/Amsterdam", YEET_ZIP_MODULE: ZIP_MODULE_PATH };
      await run(
        process.execPath,
        [
          "--experimental-strip-types",
          "--no-warnings",
          join(import.meta.dirname, "../../zip/tz-child.ts"),
          path,
          JSON.stringify(DST.map(({ path, mtime }) => ({ path, mtime }))),
        ],
        { env },
      );
      const parsed = parseZip(new Uint8Array(await readFile(path)));
      for (const [i, want] of DST.entries()) {
        const e = parsed.local[i]!;
        expect(e.name).toBe(want.path);
        expect(dosParts(e.dosTime, e.dosDate), want.path).toEqual(want.dos);
        expect(utSeconds(e.extras), want.path).toBe(Math.floor(want.mtime / 1000));
      }
      // check.py computes local time in its own process: give it the same TZ.
      const manifest: Manifest = new Map();
      manifest.meta = new Map();
      for (const { path: p, mtime } of DST) {
        const data = new TextEncoder().encode(`${p}\n`);
        const { createHash } = await import("node:crypto");
        manifest.set(p, {
          sha256: createHash("sha256").update(data).digest("hex"),
          size: data.length,
        });
        manifest.meta.set(p, { sizeKnown: true, mtime });
      }
      const r = await checkStructure(path, manifest, { env: { TZ: "Europe/Amsterdam" } });
      expect(r.ok, r.output).toBe(true);
      // After extraction: unzip and bsdtar use the UT extra. ditto is left out:
      // it reads the DOS fields with the UTC offset in effect when it runs, not
      // the one at the file's date (measured on 2026-10-10, in CEST: the
      // winter-time entries came out 1 h early), so no zip can make it right
      // on both sides of a transition.
      const results = await validateZip(path, manifest, {
        readers: ["unzip -x", "bsdtar", "bsdtar (stdin)", "structural"],
        env: { TZ: "Europe/Amsterdam" },
      });
      expect(failures(results)).toEqual([]);
    });
  });

  test("odd seconds round down (2 s resolution); UT keeps the exact second", async () => {
    for (const ms of [57_000, 57_999, 59_999, 1_000, 0]) {
      const mtime = Date.UTC(2026, 5, 1, 12, 0, 0) + ms;
      const e = parseZip(
        await zipBytes([bytesEntry("t", "x", { lastModified: mtime })], { timeZoneOffset: 0 }),
      ).local[0]!;
      const seconds = Math.floor(ms / 1000);
      expect(dosParts(e.dosTime, e.dosDate)).toEqual([2026, 6, 1, 12, 0, seconds - (seconds % 2)]);
      expect(utSeconds(e.extras)).toBe(Math.floor(mtime / 1000));
    }
  });

  test("pre-1980 clamps DOS to 1980-01-01 00:00; UT clamps to 0 before 1970 and 2^31-1 after 2038", async () => {
    const cases: [number, number[], number][] = [
      [Date.UTC(1975, 5, 1, 12, 0, 0), [1980, 1, 1, 0, 0, 0], Date.UTC(1975, 5, 1, 12) / 1000],
      [Date.UTC(1960, 0, 1), [1980, 1, 1, 0, 0, 0], 0],
      [
        Date.UTC(1979, 11, 31, 23, 59, 59),
        [1980, 1, 1, 0, 0, 0],
        Date.UTC(1979, 11, 31, 23, 59, 59) / 1000,
      ],
      [Date.UTC(1980, 0, 1, 0, 0, 0), [1980, 1, 1, 0, 0, 0], Date.UTC(1980, 0, 1) / 1000],
      [Date.UTC(2038, 0, 19, 3, 14, 7), [2038, 1, 19, 3, 14, 6], 0x7fffffff],
      [Date.UTC(2038, 0, 19, 3, 14, 8), [2038, 1, 19, 3, 14, 8], 0x7fffffff],
      [Date.UTC(2040, 5, 1, 12, 0, 0), [2040, 6, 1, 12, 0, 0], 0x7fffffff],
      [Date.UTC(2107, 11, 31, 23, 59, 58), [2107, 12, 31, 23, 59, 58], 0x7fffffff],
      [Date.UTC(2110, 5, 1, 12, 0, 0), [2107, 6, 1, 12, 0, 0], 0x7fffffff],
    ];
    for (const [mtime, dos, ut] of cases) {
      const label = new Date(mtime).toISOString();
      const parsed = parseZip(
        await zipBytes([bytesEntry("t", "x", { lastModified: mtime })], { timeZoneOffset: 0 }),
      );
      for (const e of [parsed.local[0]!, parsed.central[0]!]) {
        expect(dosParts(e.dosTime, e.dosDate), label).toEqual(dos);
        expect(utSeconds(e.extras), label).toBe(ut);
      }
    }
  });

  test("extracted mtimes match in the machine's own zone (default offset)", async () => {
    await withScratch(async (dir) => {
      const path = join(dir, "t.zip");
      const entries = () => fixtureEntries({ sizes: "known", lastModified: RECENT });
      await writeZip(path, entries());
      const results = await validateZip(path, await manifestOf(entries()), {
        mtime: RECENT,
        readers: ["unzip -x", "ditto -x -k", "bsdtar"],
      });
      expect(failures(results)).toEqual([]);
    });
  });
});

test.describe("zip 4: ZIP64 end record by entry count", () => {
  const many = (n: number): ZipEntry[] =>
    Array.from({ length: n }, (_, i) =>
      bytesEntry(
        `many/${String(i).padStart(6, "0")}.txt`,
        String.fromCharCode(0x61 + (i % 26)) + "bc\n",
        {
          compress: false,
        },
      ),
    );
  for (const [n, zip64] of [
    [65_534, false],
    [65_535, true],
  ] as const) {
    test(`${n} entries: ZIP64 end record ${zip64 ? "present" : "absent"} (check.py and bytes)`, async () => {
      await withScratch(async (dir) => {
        const path = join(dir, "many.zip");
        const size = await writeZip(path, many(n));
        const r = await checkStructure(path, await manifestOf(many(n)));
        expect(r.ok, r.output).toBe(true);
        expect(r.output).toContain(`${n} entries, zip64eocd=${zip64 ? "yes" : "no"}, OK`);
        const bytes = new Uint8Array(await readFile(path));
        const parsed = parseZip(bytes);
        expect(parsed.zip64End).toBe(zip64);
        expect(parsed.count).toBe(n);
        const eocd = new DataView(bytes.buffer, bytes.length - 22);
        expect(eocd.getUint16(10, true)).toBe(Math.min(n, 0xffff));
        expect(zip.storedZipSize(many(n))).toBe(size);
      });
    });
  }
});

test.describe("zip 5: the 16 MiB ZIP64 margin (local header only, no data written)", () => {
  const firstHeader = async (size: number) => {
    const reader = zip
      .createZip([
        {
          path: "big.bin",
          size,
          compress: false,
          lastModified: MTIME,
          stream: () => zeroStream(size),
        },
      ])
      .getReader();
    const { value } = await reader.read();
    await reader.cancel();
    const v = new DataView(value!.buffer, value!.byteOffset, value!.byteLength);
    expect(v.getUint32(0, true)).toBe(0x04034b50);
    const nameLength = v.getUint16(26, true);
    const extraLength = v.getUint16(28, true);
    const firstExtra = v.getUint16(30 + nameLength, true);
    return {
      version: v.getUint16(4, true),
      sizes: [v.getUint32(18, true), v.getUint32(22, true)],
      zip64: extraLength > 9 && firstExtra === 1,
    };
  };
  test("0xFFFFFFFF - 16 MiB - 1: no ZIP64; 0xFFFFFFFF - 16 MiB: ZIP64", async () => {
    const below = await firstHeader(MAX32 - 16 * MiB - 1);
    expect(below).toEqual({ version: 20, sizes: [0, 0], zip64: false });
    const at = await firstHeader(MAX32 - 16 * MiB);
    expect(at).toEqual({ version: 45, sizes: [MAX32, MAX32], zip64: true });
    expect(await firstHeader(MAX32)).toEqual({ version: 45, sizes: [MAX32, MAX32], zip64: true });
    expect(await firstHeader(0)).toEqual({ version: 20, sizes: [0, 0], zip64: false });
  });
});

test.describe("zip 6: the 'exceeds 4 GiB without ZIP64 local header' guard", () => {
  /** A fake raw deflater that ignores its input and emits `chunks` MiB of zeros (no real deflate stream). */
  const inflating = (chunks: number) => (): ByteTransform => {
    const block = new Uint8Array(MiB);
    return new TransformStream<Uint8Array, Uint8Array>({
      transform() {},
      flush(controller) {
        for (let i = 0; i < chunks; i++) controller.enqueue(block);
      },
    }) as unknown as ByteTransform;
  };
  /** Consume the zip and report the byte count and whether a data descriptor signature chunk went out. */
  const consume = async (entries: ZipEntry[], options: ZipOptions) => {
    const reader = zip.createZip(entries, options).getReader();
    let bytes = 0;
    let descriptors: Uint8Array[] = [];
    let error: unknown;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.length;
        if (
          value.length <= 24 &&
          value[0] === 0x50 &&
          value[1] === 0x4b &&
          value[2] === 7 &&
          value[3] === 8
        )
          descriptors.push(value.slice());
      }
    } catch (e) {
      error = e;
    }
    return { bytes, descriptors, error };
  };

  test("a 1-byte entry whose deflater emits more than 4 GiB errors instead of writing a 32-bit descriptor", async () => {
    const r = await consume([bytesEntry("x.bin", "x", { compress: true })], {
      deflateRaw: inflating(4097),
    });
    expect(String(r.error)).toMatch(/exceeds 4 GiB without ZIP64 local header/);
    expect(r.descriptors).toEqual([]);
    expect(r.bytes).toBeGreaterThan(4096 * MiB);
  });

  test("not over-eager: just below 4 GiB passes, and with the size unknown (ZIP64 local) any size passes", async () => {
    // 4095 MiB + header < 0xFFFFFFFF: a 16-byte descriptor.
    const below = await consume([bytesEntry("x.bin", "x", { compress: true })], {
      deflateRaw: inflating(4095),
    });
    expect(below.error).toBeUndefined();
    expect(below.descriptors.map((d) => d.length)).toEqual([16]);
    const unknown = await consume([bytesEntry("x.bin", "x", { compress: true, size: undefined })], {
      deflateRaw: inflating(4097),
    });
    expect(unknown.error).toBeUndefined();
    expect(unknown.descriptors.map((d) => d.length)).toEqual([24]);
    const d = new DataView(unknown.descriptors[0]!.buffer);
    expect(d.getUint32(8, true) + d.getUint32(12, true) * 2 ** 32).toBe(4097 * MiB);
    expect(d.getUint32(16, true) + d.getUint32(20, true) * 2 ** 32).toBe(1);
  });
});

test.describe("zip 7: size hint mismatch errors the stream", () => {
  for (const compress of [false, true]) {
    for (const [declared, actual] of [
      [10, 5],
      [5, 10],
      [0, 1],
      [1, 0],
    ] as const) {
      test(`declared ${declared}, yields ${actual} (${compress ? "deflate" : "store"})`, async () => {
        const entry: ZipEntry = {
          path: "a.txt",
          size: declared,
          compress,
          stream: () => generatedStream(actual, (c) => c.fill(0x61)),
        };
        await expect(drain(zip.createZip([entry]))).rejects.toThrow(
          `"a.txt" yielded ${actual} bytes, expected ${declared}`,
        );
      });
    }
  }
});

test.describe("zip 10: extra-field order", () => {
  test("ZIP64 (0x0001) is the first extra, UT (0x5455) second, in local and central headers", async () => {
    const parsed = parseZip(
      await zipBytes([
        bytesEntry("unknown.txt", "x", { size: undefined }),
        bytesEntry("known.txt", "x"),
      ]),
    );
    expect(parsed.local[0]!.extras.map((x) => [x.id, x.data.length])).toEqual([
      [0x0001, 16],
      [0x5455, 5],
    ]);
    expect(parsed.local[1]!.extras.map((x) => x.id)).toEqual([0x5455]);
    // Below 4 GiB nothing overflows: no ZIP64 extra in the central directory at all.
    expect(parsed.central.map((c) => c.extras.map((x) => x.id))).toEqual([[0x5455], [0x5455]]);
    // Central ZIP64 extras of entries past 4 GiB: zip-big.spec.ts and the guard test below.
  });

  test("central: ZIP64 first, holding only the overflowing field (compressed size)", async () => {
    // A 1-byte entry whose (fake) deflate output is 4097 MiB: only the compressed size overflows.
    const block = new Uint8Array(MiB);
    const deflateRaw = (): ByteTransform =>
      new TransformStream<Uint8Array, Uint8Array>({
        transform() {},
        flush(c) {
          for (let i = 0; i < 4097; i++) c.enqueue(block);
        },
      }) as unknown as ByteTransform;
    const reader = zip
      .createZip([bytesEntry("x.bin", "x", { compress: true, size: undefined })], { deflateRaw })
      .getReader();
    let central: Uint8Array | undefined;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (
        value.length < 1024 &&
        new DataView(value.buffer, value.byteOffset).getUint32(0, true) === 0x02014b50
      )
        central = value.slice();
    }
    const [c] = (await import("../../zip/parse.js")).parseCentralDirectory(central!, 1);
    expect(c!.extras.map((x) => [x.id, x.data.length])).toEqual([
      [0x0001, 8],
      [0x5455, 5],
    ]);
    expect([c!.size32, c!.compressedSize32, c!.offset32]).toEqual([1, MAX32, 0]);
    expect(c!.compressedSize).toBe(4097 * MiB);
    expect(c!.versionNeeded).toBe(45);
  });
});

test.describe("zip 11: filename policy", () => {
  const empty = (path: string): ZipEntry => bytesEntry(path, "");

  test("paths are NFC-normalized; a backslash stays a literal character; '.' and empty segments are dropped", async () => {
    const nfd = "café-nfd.txt";
    const parsed = parseZip(
      await zipBytes([empty(nfd), empty("back\\slash.txt"), empty("a/./b//c.txt"), empty("dir/")]),
    );
    expect(parsed.central.map((c) => c.name)).toEqual([
      "café-nfd.txt".normalize("NFC"),
      "back\\slash.txt",
      "a/b/c.txt",
      "dir/",
    ]);
    expect(parsed.central[0]!.name).not.toBe(nfd);
    // Python agrees on the names (UTF-8 flag honoured).
    await withScratch(async (dir) => {
      const path = join(dir, "names.zip");
      await writeZip(path, [empty(nfd), empty("back\\slash.txt"), empty("日本語 — 🎵 Ü.txt")]);
      const { stdout } = await run("python3", [
        "-I",
        "-c",
        "import json,sys,zipfile; print(json.dumps(zipfile.ZipFile(sys.argv[1]).namelist()))",
        path,
      ]);
      expect(JSON.parse(stdout)).toEqual([
        "café-nfd.txt".normalize("NFC"),
        "back\\slash.txt",
        "日本語 — 🎵 Ü.txt",
      ]);
    });
  });

  for (const [label, a, b] of [
    ["NFC (é composed vs decomposed)", "café.txt", "cafe\u0301.txt"],
    ["case-insensitive", "Readme.TXT", "readme.txt"],
    ["case-insensitive directories", "Photos/B.JPG/", "photos/b.jpg/"],
    ["NFC + case together", "CAFÉ/x", "cafe\u0301/X"],
    ["'./' prefix", "a", "./a"],
  ] as const) {
    test(`collision throws: ${label}`, async () => {
      await expect(drain(zip.createZip([empty(a), empty(b)]))).rejects.toThrow(/duplicate path/);
    });
  }

  test("sanitizeForWindows table", () => {
    const table: [string, string][] = [
      ["a:b?.txt", "a_b_.txt"],
      ["CON.txt", "_CON.txt"],
      ["con", "_con"],
      ["nul", "_nul"],
      ["NUL.tar.gz", "_NUL.tar.gz"],
      ["COM1", "_COM1"],
      ["lpt9.log", "_lpt9.log"],
      ["COM¹.txt", "_COM¹.txt"],
      ["CONSOLE.txt", "CONSOLE.txt"],
      ["dir./name ", "dir/name"],
      ["trailing. . /x", "trailing/x"],
      ["...", "_"],
      [" ", "_"],
      ["back\\slash", "back_slash"],
      ['<>:"|?*', "_______"],
      ["tab\there", "tab_here"],
      ["a\u0001b\u001f", "a_b_"],
      ["ok/Ünïcödé.wav", "ok/Ünïcödé.wav"],
      ["日本語 — 🎵 ñ.txt", "日本語 — 🎵 ñ.txt"],
      ["dir/", "dir/"],
      ["a/b/c.txt", "a/b/c.txt"],
      ["x".repeat(300), "x".repeat(300)],
    ];
    for (const [input, want] of table)
      expect(zip.sanitizeForWindows(input), JSON.stringify(input)).toBe(want);
  });

  test("collisions created by sanitizeForWindows are caught by createZip", async () => {
    const entries = ["a:b.txt", "a?b.txt"].map((p) => empty(zip.sanitizeForWindows(p)));
    await expect(drain(zip.createZip(entries))).rejects.toThrow(/duplicate path "a_b.txt"/);
  });
});

test.describe("zip 12: errors and cancellation", () => {
  test("a source error errors the zip stream with the source's error", async () => {
    for (const compress of [false, true]) {
      const entry: ZipEntry = {
        path: "boom.bin",
        compress,
        stream: () =>
          new ReadableStream({
            pull(c) {
              c.error(new Error("disk on fire"));
            },
          }),
      };
      await expect(drain(zip.createZip([entry])), `compress ${compress}`).rejects.toThrow(
        "disk on fire",
      );
    }
  });

  test("an error thrown by the entries iterable errors the stream", async () => {
    async function* entries(): AsyncGenerator<ZipEntry> {
      yield bytesEntry("a.txt", "a");
      throw new Error("walk failed");
    }
    await expect(drain(zip.createZip(entries()))).rejects.toThrow("walk failed");
  });

  const deflaters: [string, ZipOptions][] = [
    ["store", { compress: false }],
    ["CompressionStream", {}],
    ["zlib", { deflateRaw: zlibDeflate(1) }],
  ];
  for (const [label, options] of deflaters) {
    test(`cancelling the zip cancels the active source (${label})`, async () => {
      let cancelled: unknown = false;
      let pulled = 0;
      const random = noise(3);
      const zipStream = zip.createZip(
        [
          bytesEntry("first.txt", "first"),
          {
            path: "endless.bin",
            stream: () =>
              new ReadableStream({
                pull(c) {
                  const chunk = new Uint8Array(65536);
                  random(chunk);
                  pulled++;
                  c.enqueue(chunk);
                },
                cancel(reason) {
                  cancelled = reason ?? true;
                },
              }),
          },
        ],
        options,
      );
      const reader = zipStream.getReader();
      while (pulled < 4) await reader.read();
      await reader.cancel("stop");
      // pipeThrough propagates cancellation asynchronously.
      await expect.poll(() => cancelled, { timeout: 2000 }).not.toBe(false);
      const after = pulled;
      await new Promise((r) => setTimeout(r, 50));
      expect(pulled - after).toBeLessThanOrEqual(2);
    });
  }

  test("invalid paths, sizes and chunks throw", async () => {
    const cases: [ZipEntry, RegExp][] = [
      [bytesEntry("../etc/passwd", ""), /invalid path/],
      [bytesEntry("a/../../b", ""), /invalid path/],
      [bytesEntry("/abs.txt", ""), /invalid path/],
      [bytesEntry("", ""), /invalid path/],
      [bytesEntry(".", ""), /invalid path/],
      [bytesEntry("./", ""), /invalid path/],
      [bytesEntry("//", ""), /invalid path/],
      [{ path: "nostream.txt", size: 0 }, /has no stream/],
      [bytesEntry("neg", "", { size: -1 }), /invalid size/],
      [bytesEntry("frac", "", { size: 1.5 }), /invalid size/],
      [bytesEntry("nan", "", { size: Number.NaN }), /invalid size/],
      [bytesEntry("huge", "", { size: 2 ** 53 }), /invalid size/],
      [bytesEntry("long/" + "x".repeat(70_000), ""), /path too long/],
    ];
    for (const [entry, message] of cases) {
      await expect(
        drain(zip.createZip([entry])),
        JSON.stringify(entry.path).slice(0, 40),
      ).rejects.toThrow(message);
    }
    for (const compress of [false, true]) {
      const notBytes: ZipEntry = {
        path: "strings.txt",
        compress,
        stream: () =>
          new ReadableStream({
            start(c) {
              c.enqueue("not bytes" as never);
              c.close();
            },
          }),
      };
      await expect(drain(zip.createZip([notBytes])), `compress ${compress}`).rejects.toThrow(
        TypeError,
      );
    }
  });

  test("an empty archive is the 22-byte end record (callers must refuse an empty selection)", async () => {
    expect(Array.from(await zipBytes([]))).toEqual([
      0x50,
      0x4b,
      5,
      6,
      ...Array.from({ length: 18 }, () => 0),
    ]);
    expect(zip.storedZipSize([])).toBe(22);
  });
});

test.describe("zip: compression choice, CRC-32 and the stored-size prediction", () => {
  test("isCompressedPath and the per-entry, per-archive and extension defaults", async () => {
    for (const [path, want] of [
      ["photo.JPG", true],
      ["a/b/song.mp3", true],
      ["x.tar.gz", true],
      ["stems.wav", false],
      ["notes", false],
      [".png", false],
      ["dir.jpg/file", false],
      ["report.pdf", true],
    ] as const) {
      expect(zip.isCompressedPath(path), path).toBe(want);
    }
    expect(zip.COMPRESSED_EXTENSIONS.has("zip")).toBe(true);
    const parsed = parseZip(
      await zipBytes([
        bytesEntry("a.txt", "aaaa"),
        bytesEntry("b.jpg", "bbbb"),
        bytesEntry("c.txt", "cccc", { compress: false }),
        bytesEntry("d.jpg", "dddd", { compress: true }),
        bytesEntry("e/", "", { size: undefined }),
      ]),
    );
    expect(parsed.central.map((c) => c.method)).toEqual([8, 0, 0, 8, 0]);
    const stored = parseZip(
      await zipBytes([bytesEntry("a.txt", "aaaa"), bytesEntry("d.txt", "d", { compress: true })], {
        compress: false,
      }),
    );
    expect(stored.central.map((c) => c.method)).toEqual([0, 8]);
  });

  test("crc32Js matches zlib.crc32, in one call and chained over odd splits", () => {
    const data = new Uint8Array(100_003);
    noise(11)(data);
    expect(zip.crc32Js(new Uint8Array(0))).toBe(0);
    expect(zip.crc32Js(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
    expect(zip.crc32Js(data)).toBe(zlibCrc32(data, 0));
    let crc = 0;
    for (let i = 0; i < data.length; ) {
      const n = 1 + ((i * 7919) % 37);
      crc = zip.crc32Js(data.subarray(i, i + n), crc);
      i += n;
    }
    expect(crc).toBe(zlibCrc32(data, 0));
  });

  test("storedZipSize: exact for stored entries with sizes, undefined otherwise", async () => {
    const cases: [string, () => ZipEntry[], ZipOptions][] = [
      ["fixtures, --store", () => fixtureEntries({ sizes: "known" }), { compress: false }],
      [
        "already-compressed extensions only, NFD names, a directory",
        () => [
          bytesEntry("Photos/IMG_1.JPG", new Uint8Array(1000)),
          bytesEntry("Photos/café.png", new Uint8Array(17)),
          bytesEntry("Photos/empty/", "", { size: undefined }),
          bytesEntry("Photos/zero.mp4", new Uint8Array(0)),
        ],
        {},
      ],
    ];
    for (const [label, entries, options] of cases) {
      const predicted = zip.storedZipSize(entries(), options);
      expect(predicted, label).toBe((await zipBytes(entries(), options)).length);
    }
    expect(zip.storedZipSize(fixtureEntries({ sizes: "known" }))).toBeUndefined(); // deflated entries
    expect(
      zip.storedZipSize(fixtureEntries({ sizes: "mixed" }), { compress: false }),
    ).toBeUndefined();
    expect(zip.storedZipSize([bytesEntry("a.jpg", "x", { compress: true })])).toBeUndefined();
    expect(() => zip.storedZipSize([bytesEntry("../x.jpg", "x")])).toThrow(/invalid path/);
  });
});
