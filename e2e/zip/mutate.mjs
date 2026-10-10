#!/usr/bin/env node
// Mutation check for the zip tests: applies one deliberate bug at a time to a
// copy of packages/cli/src/zip.ts, runs the tests meant to catch it against
// that copy (YEET_ZIP_MODULE, see module.ts) and reports whether they failed.
// A mutant that survives means a test is missing or too weak.
//
//   node e2e/zip/mutate.mjs           the mutants caught by the fast tests (a few minutes)
//   node e2e/zip/mutate.mjs --slow    also those only the >4 GiB tests catch (zip-big.spec.ts)
//   node e2e/zip/mutate.mjs M7 M12    only these
//
// It runs Playwright directly (no server, no `npm run verify`), at most 2
// workers. Do not run it at the same time as a verify run.

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const E2E = dirname(dirname(fileURLToPath(import.meta.url)));
const SOURCE = join(E2E, "..", "packages", "cli", "src", "zip.ts");
const FAST = ["tests/node/zip-format.spec.ts"];
const BIG = ["tests/node/zip-big.spec.ts"];

/**
 * Each mutant: what it breaks, the edits (each `find` must occur exactly once
 * in zip.ts), and the tests (title regex, spec files) expected to catch it.
 */
const MUTANTS = [
  {
    id: "M1",
    what: "descriptor always 24 bytes (8-byte sizes) whatever the local header",
    edits: [
      ["new Uint8Array(r.zip64Local ? 24 : 16)", "new Uint8Array(24)"],
      [
        "  if (r.zip64Local) {\n    setUint64(v, 8, r.compressedSize);",
        "  if (true) {\n    setUint64(v, 8, r.compressedSize);",
      ],
    ],
    grep: "zip 2:|check.py passes",
  },
  {
    id: "M2",
    what: "ZIP64 local header only above the threshold (> instead of >=)",
    edits: [["hint >= ZIP64_SIZE_THRESHOLD", "hint > ZIP64_SIZE_THRESHOLD"]],
    grep: "zip 5:",
  },
  {
    id: "M3",
    what: "1 MiB instead of 16 MiB ZIP64 margin",
    edits: [["MAX32 - 0x1000000;", "MAX32 - 0x100000;"]],
    grep: "zip 5:",
  },
  {
    id: "M4",
    what: "ZIP64 end record only past 65,535 entries (> instead of >=)",
    edits: [["records.length >= MAX16 ||", "records.length > MAX16 ||"]],
    grep: "zip 4:",
  },
  {
    id: "M5",
    what: "ZIP64 end record only when the central directory starts past 0xFFFFFFFF (> instead of >=)",
    edits: [["centralOffset >= MAX32 ||", "centralOffset > MAX32 ||"]],
    grep: "zip 4:",
    slow: true,
  },
  {
    id: "M6",
    what: "no 'exceeds 4 GiB without ZIP64 local header' guard",
    edits: [["if (!zip64Local && (size >= MAX32 || compressedSize >= MAX32))", "if (false)"]],
    grep: "zip 6:",
  },
  {
    id: "M7",
    what: "size hint not checked",
    edits: [["if (hint !== undefined && size !== hint)", "if (false)"]],
    grep: "zip 7:",
  },
  {
    id: "M8",
    what: "local header: UT extra before the ZIP64 extra",
    edits: [
      [
        "  let p = 30 + r.name.length;\n  if (r.zip64Local) {\n    v.setUint16(p, EXTRA_ZIP64, true);\n    v.setUint16(p + 2, 16, true);\n    // size and compressed size: zero, the real values follow in the data descriptor\n    p += 20;\n  }\n  writeUt(v, p, r.mtime);",
        "  let p = 30 + r.name.length;\n  writeUt(v, p, r.mtime);\n  p += UT_LENGTH;\n  if (r.zip64Local) {\n    v.setUint16(p, EXTRA_ZIP64, true);\n    v.setUint16(p + 2, 16, true);\n  }",
      ],
    ],
    grep: "zip 10:",
  },
  {
    id: "M9",
    what: "central header: UT extra before the ZIP64 extra",
    edits: [
      [
        "  let p = 46 + r.name.length;\n  if (zip64Length) {",
        "  let p = 46 + r.name.length;\n  writeUt(v, p, r.mtime);\n  p += UT_LENGTH;\n  if (zip64Length) {",
      ],
      [
        "      p += 8;\n    }\n  }\n  writeUt(v, p, r.mtime);\n  return out;",
        "      p += 8;\n    }\n  }\n  return out;",
      ],
    ],
    grep: "zip 10:",
  },
  {
    id: "M10",
    what: "central ZIP64 extra carries both sizes when either overflows (the prototype's behaviour)",
    edits: [
      [
        "const sizeOver = r.size >= MAX32;",
        "const sizeOver = r.size >= MAX32 || r.compressedSize >= MAX32;",
      ],
      [
        "const compressedOver = r.compressedSize >= MAX32;",
        "const compressedOver = r.compressedSize >= MAX32 || r.size >= MAX32;",
      ],
    ],
    grep: "zip 10:",
  },
  {
    id: "M11",
    what: "paths not NFC-normalized",
    edits: [['const normalized = path.normalize("NFC");', "const normalized = path;"]],
    grep: "zip 11:",
  },
  {
    id: "M12",
    what: "duplicate check case-sensitive",
    edits: [["const key = path.toLowerCase();", "const key = path;"]],
    grep: "zip 11:",
  },
  {
    id: "M13",
    what: "backslash treated as a separator",
    edits: [['normalized.split("/")', "normalized.split(/[\\\\/]/)"]],
    grep: "zip 11:",
  },
  {
    id: "M14",
    what: "'..' segments accepted",
    edits: [['kept.includes("..") || ', ""]],
    grep: "zip 12:",
  },
  {
    id: "M15",
    what: "reserved device names with an extension (CON.txt) not prefixed",
    edits: [["lpt[0-9¹²³])(\\.|$)/i", "lpt[0-9¹²³])$/i"]],
    grep: "zip 11:",
  },
  {
    id: "M16",
    what: "trailing dots and spaces not stripped",
    edits: [['.replace(/[. ]+$/, "")', ""]],
    grep: "zip 11:",
  },
  {
    id: "M17",
    what: "cancelling the zip does not cancel the entry's source",
    edits: [["if (!finished) await reader.cancel().catch(() => {});", ""]],
    grep: "zip 12:",
  },
  {
    id: "M18",
    what: "DOS offset of now instead of at the entry's mtime",
    edits: [["-new Date(mtime).getTimezoneOffset()", "-new Date().getTimezoneOffset()"]],
    grep: "zip 3:",
  },
  {
    id: "M19",
    what: "DOS seconds rounded instead of rounded down",
    edits: [["(date.getUTCSeconds() >> 1)", "Math.round(date.getUTCSeconds() / 2)"]],
    grep: "zip 3:",
  },
  {
    id: "M20",
    what: "no pre-1980 clamp",
    edits: [["year < 1980) return", "year < 1900) return"]],
    grep: "zip 3:",
  },
  {
    id: "M21",
    what: "UT not clamped at 2^31-1",
    edits: [
      [
        "Math.min(Math.max(Math.floor(mtime / 1000), 0), 0x7fffffff)",
        "Math.max(Math.floor(mtime / 1000), 0)",
      ],
    ],
    grep: "zip 3:",
  },
  {
    id: "M22",
    what: "UTF-8 flag (bit 11) not set",
    edits: [
      [
        "flags: FLAG_UTF8 | (directory ? 0 : FLAG_DATA_DESCRIPTOR),",
        "flags: directory ? 0 : FLAG_DATA_DESCRIPTOR,",
      ],
    ],
    grep: "zip 1:|zip 2:",
  },
  {
    id: "M23",
    what: "CRC-32 polynomial off by one bit",
    edits: [["c & 1 ? 0xedb88320 ^ (c >>> 1)", "c & 1 ? 0xedb88321 ^ (c >>> 1)"]],
    grep: "crc32Js|check.py passes",
  },
  {
    id: "M24",
    what: "slice-by-8 reads the wrong byte",
    edits: [["t[256 + data[i + 6]!]!", "t[256 + data[i + 5]!]!"]],
    grep: "crc32Js|check.py passes",
  },
  {
    id: "M25",
    what: "deflated entries: CRC of the input not computed",
    edits: [["                crc = crc32(chunk, crc);\n", ""]],
    grep: "check.py passes",
  },
  {
    id: "M26",
    what: "ZIP64 local header written with zero 32-bit sizes (not 0xFFFFFFFF)",
    edits: [
      [
        "  if (r.zip64Local) {\n    v.setUint32(18, MAX32, true);",
        "  if (false) {\n    v.setUint32(18, MAX32, true);",
      ],
    ],
    grep: "zip 2:|check.py passes",
  },
  {
    id: "M27",
    what: "directory entries without the MS-DOS directory attribute",
    edits: [["((mode << 16) | (r.directory ? 0x10 : 0)) >>> 0", "(mode << 16) >>> 0"]],
    grep: "check.py passes",
  },
  {
    id: "M28",
    what: "extension heuristic inverted",
    edits: [[": !isCompressedPath(path));", ": isCompressedPath(path));"]],
    grep: "compression choice",
  },
  {
    id: "M29",
    what: "compress: false (--store) ignored",
    edits: [
      ["(options.compress === false ? false : !isCompressedPath(path))", "!isCompressedPath(path)"],
    ],
    grep: "compression choice",
  },
  {
    id: "M30",
    what: "storedZipSize: ZIP64 end record by count off by one",
    edits: [["const zip64End = count >= MAX16 ||", "const zip64End = count > MAX16 ||"]],
    grep: "zip 4:",
  },
  {
    id: "M31",
    what: "storedZipSize: 16-byte descriptor assumed for ZIP64 entries",
    edits: [["if (!directory) offset += zip64Local ? 24 : 16;", "if (!directory) offset += 16;"]],
    grep: "zip 5:|zip 9 and 10:",
    slow: true,
  },
  {
    id: "M32",
    what: "storedZipSize: central ZIP64 offset field forgotten",
    edits: [["(localOffset >= MAX32 ? 8 : 0)", "0"]],
    grep: "zip 9 and 10:",
    slow: true,
  },
  {
    id: "M33",
    what: "central offset not saturated to 0xFFFFFFFF past 4 GiB",
    edits: [
      ["v.setUint32(42, offsetOver ? MAX32 : r.offset, true);", "v.setUint32(42, r.offset, true);"],
    ],
    grep: "zip 8:",
    slow: true,
  },
  {
    id: "M34",
    what: "central version needed 2.0 for an entry whose only ZIP64 field is its offset",
    edits: [
      [
        "const version = zip64Length || r.zip64Local ? VERSION_ZIP64",
        "const version = r.zip64Local ? VERSION_ZIP64",
      ],
    ],
    grep: "zip 8:",
    slow: true,
  },
];

const slow = process.argv.includes("--slow");
const only = process.argv.slice(2).filter((a) => /^M\d+$/.test(a));
const selected = MUTANTS.filter((m) => (only.length ? only.includes(m.id) : slow || !m.slow));

const source = readFileSync(SOURCE, "utf-8");
const work = mkdtempSync(join(tmpdir(), "yeet-zip-mutants-"));

function runTests(modulePath, grep, specs) {
  const r = spawnSync(
    join(E2E, "node_modules", ".bin", "playwright"),
    ["test", "--project=node", "--workers=2", "--reporter=json", "--grep", grep, ...specs],
    {
      cwd: E2E,
      env: { ...process.env, YEET_ZIP_MODULE: modulePath, FORCE_COLOR: "0" },
      encoding: "utf-8",
      maxBuffer: 256 * 1024 * 1024,
    },
  );
  const failed = [];
  let total = 0;
  try {
    const report = JSON.parse(r.stdout);
    const walk = (suite, path) => {
      for (const s of suite.suites ?? []) walk(s, [...path, s.title]);
      for (const spec of suite.specs ?? []) {
        total++;
        if (!spec.ok) failed.push([...path.slice(1), spec.title].join(" › "));
      }
    };
    for (const s of report.suites) walk(s, [s.title]);
  } catch {
    failed.push(`(no JSON report; exit ${r.status}) ${r.stderr.slice(-500)}`);
  }
  return { status: r.status, failed, total };
}

let survivors = 0;
try {
  // Baseline: the unmutated module passes every selected test.
  const greps = [...new Set(selected.map((m) => m.grep))].join("|");
  const baseline = runTests(SOURCE, greps, slow ? [...FAST, ...BIG] : FAST);
  console.log(
    `baseline (unmutated zip.ts): ${baseline.total} tests, ${baseline.failed.length} failed`,
  );
  if (baseline.status !== 0) {
    console.log(baseline.failed.join("\n"));
    process.exit(1);
  }
  for (const m of selected) {
    let mutant = source;
    for (const [find, replace] of m.edits) {
      const count = mutant.split(find).length - 1;
      if (count !== 1)
        throw new Error(`${m.id}: expected one match, found ${count}: ${JSON.stringify(find)}`);
      mutant = mutant.replace(find, () => replace);
    }
    const path = join(work, `${m.id}.ts`);
    writeFileSync(path, mutant);
    const r = runTests(path, m.grep, m.slow ? BIG.concat(FAST) : FAST);
    const caught = r.status !== 0 && r.failed.length > 0;
    if (!caught) survivors++;
    console.log(
      `${caught ? "CAUGHT  " : "SURVIVED"} ${m.id.padEnd(4)} ${m.what}\n` +
        (caught
          ? r.failed.map((t) => `           by ${t}`).join("\n")
          : `           (${r.total} tests ran: ${m.grep})`),
    );
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
console.log(
  survivors ? `\n${survivors} mutant(s) survived` : `\nall ${selected.length} mutants caught`,
);
process.exitCode = survivors ? 1 : 0;
