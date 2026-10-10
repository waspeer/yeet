# Streaming ZIP writer — design decision (phase 0c)

Status: **implemented** (round 2B). Proposed in phase 0c with a prototype (removed; see
[Reproduce](#reproduce)).
Scope: the module that zips multiple files or a folder _while streaming_ into an upload,
copied verbatim into `packages/cli` (Node) and `packages/worker` (Worker + browser upload page).

## Implementation (round 2B)

**Where things live**

| What                              | Where                                                                                              |
| --------------------------------- | -------------------------------------------------------------------------------------------------- |
| The module (two identical copies) | `packages/cli/src/zip.ts`, `packages/worker/src/zip.ts`                                            |
| Copy check                        | `scripts/check-zip-copies.mjs` (`npm run check:zip-copies`; first step of `npm run verify`)        |
| CLI: what to zip / the upload     | `packages/cli/src/selection.ts`, `packages/cli/src/upload-zip.ts` (see [Callers](#callers))        |
| Must-test suite                   | `e2e/tests/node/zip-{format,big,runtime,tooling}.spec.ts`, `e2e/tests/browser/zip-runtime.spec.ts` |
| CLI zip upload tests              | `e2e/tests/node/cli-zip.spec.ts`                                                                   |
| Oracle and helpers                | `e2e/zip/check.py` (verbatim), `parse.ts`, `validate.ts`, `module.ts`, `fixtures.ts`               |
| Opt-in tools                      | `e2e/zip/mutate.mjs`, `readers.ts`, `archive-utility.ts`, `bench/`                                 |

**Changes from the prototype** (none contradicts this document; the first two are what it
already asked for):

- No `zip64` and `experimental` options (test-only, see [Interface](#interface)).
- The central ZIP64 extra holds each size only if that size overflows. The prototype wrote
  both sizes when either did (still spec-valid, and what Python does). Re-checked: the
  "deflated 4.5 GiB → 28 MB" archive (only the uncompressed size overflows) passed every
  reader and `check.py` (`readers.ts --big`, below).
- `storedZipSize()` added (see [Interface](#interface)).
- An entry without `stream()` fails before its header is written; non-`Uint8Array` chunks
  fail in deflate mode too.
- Written to pass the e2e `tsconfig`'s `noUncheckedIndexedAccess` (non-null assertions only,
  no runtime change).

**What was run, on this Mac (Apple M5 Pro, macOS 26.6.2, Node 24.16.0), 2026-10-10**

| Run                                                                        | Result                                                                                       |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `zip-format.spec.ts` (items 1–7, 10–12, CRC, `storedZipSize`)              | 48/48 pass, ~9 s                                                                             |
| `zip-big.spec.ts` (`@slow`, items 4, 5, 8, 9, 10 past 4 GiB, sparse files) | 10/10 pass, 1.3 min                                                                          |
| `zip-runtime.spec.ts` (workerd) and the browser one (3 engines)            | pass                                                                                         |
| `zip/mutate.mjs` (34 mutants of `zip.ts`)                                  | 34/34 caught (29 by the fast tests, 5 only by `zip-big.spec.ts`)                             |
| `zip/readers.ts` (fixtures, empty, 65,534/65,535/70,000 entries)           | ALL PASS (empty archive: the documented `unzip`/`ditto`/`7za x` failures)                    |
| `zip/readers.ts --big` (six >4 GiB archives × 9 readers, real data)        | ALL PASS except `ditto` on the odd-size layout (expected, see below); 11.7 min               |
| `zip/archive-utility.ts --big` (Archive Utility.app)                       | 10/10 PASS, including the four >4 GiB archives and the odd sizes (item 8)                    |
| `zip/bench/bench-crc.ts`                                                   | slice-by-8 2,080 MB/s, byte table 580, `zlib.crc32` 28,935 (consistent with the table below) |

Not run in this round: `bench-compress.ts` (needs the stems folder) and `node-compat.ts`
(needs the older Node binaries); the browser/workerd benchmarks were not ported.

## Decision summary

- One dependency-free TypeScript file (`zip.ts`, ~540 lines in the prototype, most of it
  header serialization and a CRC table) using only Web Streams, `TextEncoder`,
  `DataView` and, as a default you can override, `CompressionStream`. It runs unchanged in
  Node, workerd, Chromium, WebKit and Firefox (all tested, see the matrix).
- `createZip(entries, options) → ReadableStream<Uint8Array>`. Entries are pulled lazily
  from an (async) iterable; each entry opens its source only when it is reached.
- Every file entry uses a **data descriptor** (bit 3). **ZIP64 only where needed**:
  - a per-entry ZIP64 local header when the declared size is unknown or within 16 MiB of 4 GiB;
  - a central-directory ZIP64 extra holding **only the fields that overflow**;
  - a ZIP64 end record only past 65,534 entries or 4 GiB of offsets.
- Deflate (raw) by default, store for already-compressed extensions or with `--store`.
  The compressor and CRC-32 can be injected:
  - **CLI:** inject `zlib.createDeflateRaw({ level: 1 })` (measured 2.8× faster than
    `CompressionStream` on the real stems, 1.9 pp worse ratio) and `zlib.crc32` when present.
  - **Browser / Worker:** use the defaults.
- The CLI's `engines.node >=20` **can stay** if the CLI injects zlib, as recommended. Relying
  on the default `CompressionStream("deflate-raw")` would require `>=20.12` (measured).
- Timestamps: DOS date/time in the producer's local zone plus the Info-ZIP UTC
  extended-timestamp extra (0x5455). UTF-8 flag (bit 11) always set.
- Extra fields: the ZIP64 extra (0x0001), when present, is always the **first** extra field,
  before UT (0x5455). Windows 7 Explorer reportedly requires that.
- Filenames: the core NFC-normalizes paths and rejects collisions after NFC and case
  folding. Windows-illegal names are fixed by an opt-in `sanitizeForWindows` helper, which
  the CLI and browser apply (see [Filename policy](#filename-policy)).
- On macOS, **Archive Utility is the reference reader**. `ditto` is not a usable proxy past
  4 GiB: it mis-extracts valid archives (see the reader matrix).

Revision 2 (after independent verification): extra-field order, filename policy,
must-test list, known limitations and the `ditto` >4 GiB finding were added. All suites
were re-run after the extra-field change; nothing regressed:

| Suite                                 | Result                                                                                           |
| ------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Node                                  | ALL PASS: 95 passing checks, 9 expected failures (the non-policy variants and the empty archive) |
| workerd                               | ALL PASS (`ditto` expected to fail on UTC mtimes)                                                |
| Chromium / WebKit / Firefox           | ALL PASS                                                                                         |
| >4 GiB suite (6 archives × 9 readers) | all pass except `ditto` on the odd-size layout (expected)                                        |
| Archive Utility                       | 10/10, including >4 GiB and odd sizes                                                            |

## Interface

```ts
export interface ZipEntry {
  /** Relative "/"-separated path; trailing "/" = directory entry. */
  path: string;
  /** ms since epoch; default: now. */
  lastModified?: number;
  /** Uncompressed size if known (fs.stat / File.size). Enables non-ZIP64 headers; must match or the zip errors. */
  size?: number;
  /** Per-entry override; default options.compress, then the extension heuristic. */
  compress?: boolean;
  /** Called once, when the entry is reached. Omitted for directories. */
  stream?: () => ReadableStream<Uint8Array>;
}

export interface ByteTransform {
  writable: WritableStream<Uint8Array>;
  readable: ReadableStream<Uint8Array>;
}

export interface ZipOptions {
  /** false = store everything (--store). Default true (deflate except COMPRESSED_EXTENSIONS). */
  compress?: boolean;
  /** Raw-deflate factory. Default: () => new CompressionStream("deflate-raw"). */
  deflateRaw?: () => ByteTransform;
  /** CRC-32 update, zlib.crc32 signature (data, previous) => crc. Default: pure-JS slice-by-8. */
  crc32?: (data: Uint8Array, previous: number) => number;
  /** Minutes east of UTC for DOS timestamps. Default: producer's local offset (0 in workerd). */
  timeZoneOffset?: number;
}

export function createZip(
  entries: AsyncIterable<ZipEntry> | Iterable<ZipEntry>,
  options?: ZipOptions,
): ReadableStream<Uint8Array>;

export function isCompressedPath(path: string): boolean;
export const COMPRESSED_EXTENSIONS: ReadonlySet<string>;
export function crc32Js(data: Uint8Array, previous?: number): number;
/** Opt-in: make a "/"-separated path extractable by Windows Explorer (not applied by createZip). */
export function sanitizeForWindows(path: string): string;
/** Added in round 2B: the exact archive size when every file entry is stored and sized, else undefined. */
export function storedZipSize(
  entries: Iterable<ZipEntry>,
  options?: ZipOptions,
): number | undefined;
```

The prototype also had `zip64?: "auto" | "always"` and an `experimental` object. Both
existed only to test reader compatibility and are **not** in the production module (`"always"`
and the `"mirror"` variant break `ditto`, see below).

`storedZipSize()` is the one addition to the interface proposed here. A stored entry's
compressed size is its size, so when every file is stored and declares its size, every header,
descriptor and offset is known before the first byte is written. The CLI uses it to send the
size at create, which lifts the server's 150-part limit for uploads of unknown size
([api.md](api.md)) for `--store` and for selections of only already-compressed files.

### Why this shape

- **`stream()` as a factory, not a stream.** The source opens lazily, so a 10,000-file folder
  does not hold 10,000 open file handles. `File` already has this shape:
  `{ path: f.webkitRelativePath || f.name, lastModified: f.lastModified, size: f.size, stream: () => f.stream() }`.
- **Entries as an `AsyncIterable`.** The CLI can walk a directory lazily (skipping `.DS_Store`
  is the caller's policy, not the core's). Arrays work too.
- **Returns a `ReadableStream`.** It plugs into anything: `Readable.fromWeb` for the CLI, a
  re-chunker that cuts fixed 50 MiB R2 parts, `fetch` bodies, `Response` in a Worker. The
  total length is known only when the stream ends, and the upload API takes the size at
  `complete`. Pull-based: nothing is produced ahead of the consumer except the chunk in
  flight. State per entry is one central-directory record (~100 bytes plus the name).
- **`size` is optional but should always be passed** by yeet's callers. It is the only way to
  avoid ZIP64 local headers without seeking back. It also detects files that change while
  being zipped (a size mismatch errors the stream, tested).
- **Injection instead of runtime detection.** The core never imports `node:*` and never
  sniffs the runtime, so the copied file is identical in both packages. Each caller picks
  its fastest primitives.
- **Errors and cancellation.** These are all tested:
  - invalid paths (absolute, `..`) throw, and so do paths that collide after NFC
    normalization or case folding;
  - a source error errors the zip stream;
  - cancelling the zip stream cancels the current entry's source, in both store and
    deflate mode.

### Progress

The core has no progress callback. Callers measure input consumption by wrapping each
entry's source:

```ts
const counted = (s: ReadableStream<Uint8Array>) =>
  s.pipeThrough(
    new TransformStream({
      transform(c, ctl) {
        onBytes(c.length);
        ctl.enqueue(c);
      },
    }),
  );
entries.map((e) => ({ ...e, stream: () => counted(e.stream!()) }));
```

The zip pulls with backpressure, so bytes pulled from a source track bytes consumed within a
few chunks. That is the pipe-chain buffering, which is 64 KiB chunks in the tests. The
progress total is the sum of `size`. To track upload progress (compressed bytes), count the
zip output, which the uploader sees anyway. "File k of n" also falls out of the wrapper: a
source is pulled only after the previous entry finished.

## Format decisions

| Topic                      | Decision                                                                                                                                                                                                                     | Evidence / reason                                                                                                                                                                                                                                                                                                                |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Data descriptors           | Bit 3 on every file entry; descriptor **with** signature `PK\7\8`; local CRC = 0                                                                                                                                             | Sizes and CRC are unknown when the header is written. All tested readers accept it, including the streaming readers (`bsdtar` from stdin).                                                                                                                                                                                       |
| Descriptor width           | 24 bytes (8-byte sizes) **iff** the local header has a ZIP64 extra; otherwise 16 bytes                                                                                                                                       | This is APPNOTE's rule and the one readers implement. Java's JDK-8265186 and Go's history are bugs from violating it.                                                                                                                                                                                                            |
| ZIP64 local header         | When `size` is unknown or `>= 4 GiB − 16 MiB`. Then: version needed 4.5, 32-bit sizes `0xFFFFFFFF`, ZIP64 extra with zeros.                                                                                                  | The 16 MiB margin covers deflate expansion of incompressible data (measured: +0.03 %). `0xFFFFFFFF` + extra is the spec-consistent form, the same one Python's streaming writer uses. A variant with zero 32-bit sizes also passed every reader, but it puts ZIP64 fields behind non-`0xFFFFFFFF` values, which APPNOTE forbids. |
| ZIP64 central extra        | Only the overflowing fields, each on its own, in spec order (size, compressed size, offset). The prototype wrote both sizes when either overflowed; the production module writes each size only when it overflows (round 2B) | Measured: `ditto` **rejects** a stored entry whose central header carries ZIP64 sizes below 4 GiB (`zip64: "always"` and `"mirror"` variants; deflated entries were fine). Writing only what overflows also matches APPNOTE 4.5.3 and Go issue 33116 (unneeded fields broke 7-Zip, Keka, The Unarchiver, …).                     |
| ZIP64 end record + locator | Only when entries `>= 65535` or central-directory offset/size `>= 0xFFFFFFFF`                                                                                                                                                | 70,000-entry archive passes in all readers, including Archive Utility.                                                                                                                                                                                                                                                           |
| Version made by / needed   | made by Unix (3), version 2.0, or 4.5 for ZIP64 entries; external attrs `0100644` / `040755`                                                                                                                                 | Gives sane permissions with `unzip`/`ditto`/`bsdtar`. An entry whose only ZIP64 field is its offset gets 4.5 in the central header but 2.0 in its local header (see known limitations).                                                                                                                                          |
| Extra-field order          | ZIP64 (0x0001) first, then UT (0x5455), in local and central headers                                                                                                                                                         | zip_kit's implementation notes (github.com/julik/zip_kit, IMPLEMENTATION_DETAILS.md) report that Windows 7 Explorer only finds ZIP64 as the first extra. Not verified on Windows. No regression in any local reader after the change (re-run below).                                                                             |
| Filenames                  | Always UTF-8 with bit 11; NFC-normalized; "/" is the only separator                                                                                                                                                          | Ü, 日本語, emoji, em dash round-trip in every tested reader. ASCII is valid UTF-8, so there is no reason to branch. See [Filename policy](#filename-policy).                                                                                                                                                                     |
| Timestamps                 | DOS date/time in the producer's local zone (`timeZoneOffset` overrides), plus UT extra (0x5455) with UTC mtime, clamped to 0..2³¹−1                                                                                          | Measured: `unzip`, `bsdtar`, `7za` and **Archive Utility** use the UT extra. **`ditto` uses the DOS fields only**: a zip made in workerd (UTC) extracted 2 h early with `ditto` on a CEST machine, and correct with `?tz=120`. The CLI and browser produce local time, so they are correct everywhere.                           |
| Directories                | Path ending in `/`: stored, no descriptor                                                                                                                                                                                    | Supported (an empty dir round-trips). Whether the CLI emits empty dirs is a product call.                                                                                                                                                                                                                                        |
| Store list                 | `isCompressedPath`: mp3 m4a aac ogg oga opus flac wma, mp4 m4v mov mkv webm avi wmv, jpg jpeg png gif webp heic heif avif jxl, zip gz tgz bz2 xz zst 7z rar br lz4, docx xlsx pptx odt ods odp epub jar apk ipa dmg pdf      | Deflating these costs CPU for about 0 % gain (the random-data rows below show the throughput cost). `pdf` is borderline (some PDFs are uncompressed); keep it or drop it.                                                                                                                                                        |
| Empty archive              | Byte-identical to Python's empty `ZipFile`                                                                                                                                                                                   | `unzip` warns "zipfile is empty" (exit 1) and `ditto` rejects it. **The CLI must refuse an empty selection** rather than upload such a zip.                                                                                                                                                                                      |

## Filename policy

The core enforces only rules that hold for every recipient platform. Platform-specific
renaming is an explicit, opt-in step. All of the rules below are implemented in the
prototype, tested there, and now tested in `e2e/tests/node/zip-format.spec.ts` (item 11 below)
and, for the CLI's side (pre-flight collisions, renames), `e2e/tests/node/cli-zip.spec.ts`.

**In the core (`createZip`), always:**

1. **NFC-normalize every path.** macOS file APIs and some browsers hand out NFD names
   (`e` + U+0301). Windows and Linux tools then show or compare them differently.
   Tested: an NFD input is stored as NFC.
2. **Reject collisions after NFC and case folding** (`path.toLowerCase()`), rather than
   de-duplicate them. Two such entries overwrite each other when extracted on macOS
   (case-insensitive APFS by default) and on Windows, so the zip would silently lose a file.
   - Why throw and not rename: renaming inside the core would change user-visible paths
     without the caller knowing.
   - The CLI already has the full file list before zipping (it stats every file for sizes),
     so it can pre-flight the same check and either error early or rename (e.g. `name (2).ext`).
   - Tested: `café` composed vs decomposed, and `Readme.TXT` vs `readme.txt`.
3. **"/" is the only separator; a backslash is a literal character.** It is legal in
   macOS and Linux names, and silently splitting on it would invent directories. Tested:
   `back\slash.txt` round-trips as one name.
4. **Reject absolute paths and `..` segments.** Drop `.` and empty segments.

**`sanitizeForWindows(path)` (exported helper, applied by the CLI and the browser before
`createZip`):**

- Replaces `< > : " \ | ? *` and control characters with `_`. Finder shows a POSIX `:` as
  `/`, so `:` really occurs in Mac names.
- Strips trailing dots and spaces from each segment; a segment that becomes empty becomes `_`.
- Prefixes reserved device names with `_`: CON, PRN, AUX, NUL, COM0–9, LPT0–9, also with
  an extension (e.g. `CON.txt`).
- Leaves paths of 260+ characters alone. Renaming cannot fix them reliably, so the caller
  should warn.
- Renames can create new collisions; `createZip` catches those.

**Why the core stays neutral:**

- yeet does not know the recipient's OS. Sanitizing always is cheap and only changes names
  that would fail on Windows anyway, so callers should apply it by default.
- Keeping it out of the core keeps the core spec-pure and testable. A future caller that
  wants exact names (e.g. a Linux-to-Linux transfer flag) can skip the helper.
- The helper is in the same file, so both packages get an identical copy.

## Compression and CRC strategy per runtime

| Runtime                  | Deflate                                                                                                               | CRC-32                                                 |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| CLI (Node)               | inject `Duplex.toWeb(zlib.createDeflateRaw({ level: 1 }))`                                                            | inject `zlib.crc32` if present, else default `crc32Js` |
| Browser upload page      | default `CompressionStream("deflate-raw")` (no level control)                                                         | default `crc32Js`                                      |
| Worker (if it ever zips) | default `CompressionStream`, but only `compress: false` is realistic under CPU limits (~80–130 MB/s measured locally) | default `crc32Js`                                      |

### Why zlib level 1 in the CLI

On the real stems (8 WAV, 169.4 MB), `CompressionStream` behaves like zlib level 6: same
ratio, same speed. Level 1 is 2.8× faster for 1.9 percentage points of output (+3.2 MB). The
zip is piped into the upload, so compression only becomes the bottleneck when the uplink is
faster than the compressor:

- level 6 / `CompressionStream` (35 MB/s ≈ 280 Mbit/s): limits any uplink above that;
- level 1 (99 MB/s ≈ 790 Mbit/s): limits only near-gigabit uplinks.

On a slow 100 Mbit/s uplink the extra 3.2 MB costs about 0.26 s, which is negligible. Level 1
also removes the Node `>=20.12` requirement. If more ratio is wanted later, level 3 is a
middle point (61.3 %, 69–71 MB/s).

Node's `zlib` ran at 80–143 MB/s on the synthetic inputs regardless of level. The synthetic
WAV (half digital silence, half tone/noise) is **not** representative: every level gives
47.5 %. Real stems are what separate the levels.

## Node version implications (measured)

| Node    | `CompressionStream("deflate-raw")` | `zlib.crc32` | default zip    | zip with zlib injected |
| ------- | ---------------------------------- | ------------ | -------------- | ---------------------- |
| 18.20.8 | no (`format is invalid`)           | no           | errors cleanly | PASS                   |
| 20.11.1 | no                                 | no           | errors cleanly | PASS                   |
| 20.12.0 | yes                                | no           | PASS           | PASS                   |
| 20.20.2 | yes                                | yes          | PASS           | PASS                   |
| 22.0.0  | yes                                | no           | PASS           | PASS                   |
| 24.16.0 | yes                                | yes          | PASS           | PASS                   |
| 26.9.0  | yes                                | yes          | PASS           | PASS                   |

Readers used for this table: `unzip -t`, Python `zipfile`, `ditto`, `7za t`.

- **`deflate-raw`:** 20.12.0 is the first 20.x line with it. Before that, the default errors
  the stream at the first deflated entry, leaving a partial output (the CLI must abort the
  multipart upload on any stream error).
- **`zlib.crc32`:** missing in 22.0.0 and present in 20.20.2. Node's changelog places it at
  22.2.0 / 20.15.0, but those exact versions were not tested. Hence: feature-detect it.
- **Conclusion:** with zlib injected, `engines.node >=20` stays valid. Node 20 reached
  end-of-life in April 2026, so moving to `>=22` is reasonable for other reasons, but zip does
  not force it.
- **`Duplex.toWeb`** exists in every tested version. It is still marked experimental in the
  Node docs (see risks).

## Runtime matrix (fixtures zipped by the same `zip.ts`, then validated on macOS)

Fixture set (`fixtures.ts`, 9 entries, ~12.8 MB uncompressed):

- text;
- an empty file;
- 3 MiB of noise;
- an 8 MiB synthetic WAV;
- a 1 MiB `.JPG` (stored by extension);
- a non-ASCII path;
- a forced-store file;
- a deep path;
- an empty dir.

Each fixture set was written in three variants: all sizes known, all unknown (ZIP64 local
headers), and mixed. Validation checks every entry's SHA-256 against an independent manifest
computed in Node, plus mtimes where the extractor sets them. A wrong mtime counts as a
failure. Every archive also goes through the structural checker.

| Runtime                            | Version                                                                              | Result                                                                                         |
| ---------------------------------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| Node                               | 24.16.0 (also 20.12.0, 20.20.2, 22.0.0, 26.9.0 with a reduced reader set)            | PASS: all readers, all default variants, 70k entries, error/cancel paths                       |
| workerd via `wrangler dev` (local) | wrangler 4.148.0, workerd 2026-10-06, compat date 2026-10-01, **no** `nodejs_compat` | PASS, except `ditto` (expected failure: wrong mtime, see below) unless `timeZoneOffset` is set |
| Chromium (Playwright)              | 153.0.8010.12                                                                        | PASS: all readers, including zips built from real `File` objects                               |
| WebKit (Playwright)                | 26.6                                                                                 | PASS (its deflate output differs in bytes, 8,232,128 vs 8,244,712, and is still valid)         |
| Firefox (Playwright)               | 155.0                                                                                | PASS                                                                                           |

`CompressionStream` in all three engines and workerd supports `deflate-raw`, `deflate` and
`gzip` (tested).

## Reader compatibility matrix

Tested on macOS 26.6.2 (25G83). Readers:

- Info-ZIP UnZip 6.00 (Apple build, ZIP64_SUPPORT);
- Python 3.14.7 `zipfile`;
- `ditto -x -k`;
- **Archive Utility.app** itself, driven with `open -g -a "Archive Utility"`, output compared;
- `bsdtar` 3.5.3 / libarchive 3.7.4, reading the file and as a pure streaming reader from stdin;
- p7zip `7za` 16.02 (from the `7zip-bin` npm package).

| Archive                                                                          | unzip -t / -x         | Python | ditto                                                    | Archive Utility | bsdtar (file / stdin) | 7za t / x                            |
| -------------------------------------------------------------------------------- | --------------------- | ------ | -------------------------------------------------------- | --------------- | --------------------- | ------------------------------------ |
| fixtures, sizes known (no ZIP64)                                                 | ✅                    | ✅     | ✅                                                       | ✅              | ✅                    | ✅                                   |
| fixtures, sizes unknown (ZIP64 local + 24-byte descriptors)                      | ✅                    | ✅     | ✅                                                       | ✅              | ✅                    | ✅                                   |
| fixtures, store everything                                                       | ✅                    | ✅     | ✅                                                       | ✅              | ✅                    | ✅                                   |
| fixtures, DOS time in UTC (as from workerd)                                      | ✅ mtime ok           | ✅     | ✅ content, **mtime −2 h**                               | ✅ mtime ok     | ✅ mtime ok           | ✅ mtime ok                          |
| `zip64: "always"` / central "mirror" (NOT the policy)                            | ✅                    | ✅     | ❌ "Couldn't read pkzip signature" at first stored entry | ✅              | ✅                    | ✅                                   |
| 70,000 entries (ZIP64 end record by count)                                       | ✅                    | ✅     | ✅                                                       | ✅ (7.5 s)      | ✅                    | ✅ t; x not run (p7zip took >10 min) |
| stored 4.5 GiB entry (size known) + entry at offset > 4 GiB                      | ✅                    | ✅     | ✅                                                       | ✅              | ✅                    | ✅                                   |
| stored 4.5 GiB entry, size unknown                                               | ✅                    | ✅     | ✅                                                       | ✅              | ✅                    | ✅                                   |
| deflated 4.5 GiB → 28.1 MB (only uncompressed size > 4 GiB)                      | ✅                    | ✅     | ✅                                                       | not run         | ✅                    | ✅                                   |
| deflated incompressible 4.5 GiB (compressed size > 4 GiB), size unknown          | ✅                    | ✅     | ✅                                                       | ✅              | ✅                    | ✅                                   |
| 4 × 1.2 GiB stored, no ZIP64 local headers, 5th entry and central dir past 4 GiB | ✅                    | ✅     | ✅                                                       | not run         | ✅                    | ✅                                   |
| stored odd sizes past 4 GiB: 262,140 B + 5 × (1000 MiB − 1), sizes known         | ✅                    | ✅     | ❌ **exit 0 with wrong files** (see below)               | ✅ (4.6 s)      | ✅                    | ✅                                   |
| empty archive (0 entries)                                                        | ⚠️ "zipfile is empty" | ✅     | ❌ (same for Python's own empty zip)                     | not run         | ✅                    | ✅ t                                 |

**`ditto` must not be used as a stand-in for Archive Utility, especially past 4 GiB.
Archive Utility (the real app) is the macOS reference.** The evidence:

- **Odd-size stored entries past 4 GiB.** `ditto` fails on archives larger than 4 GiB
  that contain stored data-descriptor entries whose size is not a multiple of 1 MiB.
  - The independent verifier found it with 262,140 B and 1000 MiB − 1 entries. It saw
    "Couldn't read pkzip signature" and, once, exit 0 with a corrupted 4.7 GB file.
  - The verifier reports that Python's own streaming writer triggers the same failure.
  - My re-run reproduced the silent variant: `ditto` exited 0, but files were missing and
    others had wrong sizes (e.g. `small-odd.bin` 1,048,838,202 B instead of 262,140 B).
  - All other readers, the structural checker and **Archive Utility** extracted the same
    archive correctly.
  - My original >4 GiB entries were all 1 MiB multiples, which hid this.
- **ZIP64 central sizes below 4 GiB.** Archive Utility accepted the `zip64: "always"` file
  that `ditto` rejected.
- **Timestamps.** Archive Utility honors the UT timestamp; `ditto` does not.

The chosen policy passes Archive Utility and every other reader in every row above.

**Structural check.** Every archive written with the chosen policy also passes the
verifier's strict parser `check.py` (now `e2e/zip/check.py`, verbatim), run as the "structural"
reader in all suites. That includes:

- the fixtures from Node, workerd and the three browsers;
- the 65,534/65,535/70,000-entry archives;
- all six >4 GiB archives.

It rejects the non-policy variants: `zip64: "always"` and central "mirror" (unneeded ZIP64
fields), and zero 32-bit sizes behind a local ZIP64 extra.

All >4 GiB archives were written to the OS temp dir and deleted afterwards. These are the
sizes on disk:

| Archive                            | Bytes on disk |
| ---------------------------------- | ------------- |
| stored 4.5 GiB entry, size known   | 4,831,838,678 |
| stored 4.5 GiB entry, size unknown | 4,831,838,706 |
| deflated incompressible 4.5 GiB    | 4,833,313,321 |
| 4 × 1.2 GiB stored                 | 5,153,961,560 |
| stored odd sizes                   | 5,243,143,199 |

### Not tested: human-in-the-loop checks before release

Each of these needs a person on a real device. Use the archives the suites generate:
fixtures with sizes known and unknown, a >4 GiB archive with odd-size stored entries, and
awkward names (NFD, `:`, `?`, `CON.txt`, trailing dot/space, Ü/日本語/emoji, a 260+
character path).

- **Windows 11 Explorer** ("Extract all" and opening the zip as a folder):
  1. a normal archive with sizes known;
  2. sizes unknown, i.e. ZIP64 local headers on small entries;
  3. a >4 GiB archive (stored and deflated);
  4. awkward names, with and without `sanitizeForWindows`.

  From research: Explorer is reported to reject central ZIP64 extras with fields that do
  not overflow (avoided by the policy), and Windows 7 is reported to need ZIP64 as the
  first extra (now done). Neither is verified.

- **iOS / iPadOS Files app** (tap to expand), small and >4 GiB.
- **Android Files** (Google Files) plus one third-party unzip app (e.g. ZArchiver or RAR).
  Android apps built on Java `ZipInputStream` / Commons Compress may reject stored entries
  with data descriptors (see known limitations).
- **Older macOS Archive Utility**: only macOS 26.6.2 was tested.
- Modern 7-Zip (only p7zip 16.02 from 2016 was tested), WinRAR, The Unarchiver, Keka,
  BetterZip.
- Linux distribution `unzip` builds.
- Real Safari (Playwright WebKit is not Safari) and mobile browsers.
- **Production** Cloudflare Workers (only local `wrangler dev`); CPU limits there.
- Browser zipping of large real files read from disk via `File.stream()`. Tested: in-memory
  `File`s, plus stems served over localhost for the deflate benchmark only.
- Archive Utility on the two ">4 GiB" rows marked "not run". The Archive Utility GUI with
  error dialogs was only observed indirectly: on failure the script would see no output and
  kill the app, and no failures occurred.
- Node 20.15 / 22.2 exactly (the `zlib.crc32` boundaries), Node < 18.

## Measured numbers

Environment for all numbers:

- **Hardware:** Apple M5 Pro (18 cores), 48 GiB RAM, macOS 26.6.2.
- **Runtimes:** Node 24.16.0 (zlib 1.3.1-e00f703) unless stated. Playwright 1.63.0 browsers.
- **Units:** MB = 10^6 bytes of _input_.

### CRC-32 (Node, `scripts/bench-crc.ts`: 64 MiB random in 64 KiB chunks, median of 7)

| Implementation                      | Node 24.16.0 | Node 26.9.0 |
| ----------------------------------- | ------------ | ----------- |
| byte table (256 entries)            | 540 MB/s     | 530 MB/s    |
| slice-by-8 (`crc32Js`, 8 KiB table) | 2,065 MB/s   | 2,037 MB/s  |
| `zlib.crc32` (native)               | 29,581 MB/s  | 38,188 MB/s |

`crc32Js` in browsers (`browser-test.ts --bench`, 64 MiB, best of 3):

| Engine   | random     | synthetic WAV |
| -------- | ---------- | ------------- |
| Chromium | 2,186 MB/s | 2,137 MB/s    |
| WebKit   | 2,237 MB/s | 2,165 MB/s    |
| Firefox  | 1,721 MB/s | 1,864 MB/s    |

In workerd (local, 32 MiB, one run; timers there are coarse, so treat as indicative):

| Input         | `crc32Js`        |
| ------------- | ---------------- |
| random        | 1,678–1,766 MB/s |
| synthetic WAV | 1,864 MB/s       |

Slice-by-8 is worth its 8 KiB table: it is 3.8× faster than the byte table and fast enough
that CRC never dominates next to deflate. The native `zlib.crc32` is about 14× faster again,
which only matters for `--store`.

### Deflate (Node, `scripts/bench-compress.ts`, median of 3, inputs held in memory, 64 KiB chunks)

Columns:

- **ratio:** compressed size as a share of the input.
- **deflate MB/s:** the transform alone.
- **createZip MB/s:** the whole module, including CRC (`zlib.crc32`) and framing.

| Input                                | Compressor        | ratio   | deflate MB/s | createZip MB/s |
| ------------------------------------ | ----------------- | ------- | ------------ | -------------- |
| random 64 MiB                        | CompressionStream | 100.0 % | 82           | 82             |
|                                      | zlib level 1      | 100.0 % | 77           | 78             |
|                                      | zlib level 3      | 100.0 % | 79           | 77             |
|                                      | zlib level 6      | 100.0 % | 79           | 74             |
| synthetic WAV 64 MiB (≈50 % silence) | CompressionStream | 47.5 %  | 132          | 131            |
|                                      | zlib level 1      | 47.6 %  | 140          | 137            |
|                                      | zlib level 3      | 47.6 %  | 136          | 136            |
|                                      | zlib level 6      | 47.5 %  | 132          | 132            |
| **real stems** (8 WAV, 169.4 MB)     | CompressionStream | 60.5 %  | 36           | 34             |
|                                      | **zlib level 1**  | 62.4 %  | **102**      | **99**         |
|                                      | zlib level 3      | 61.3 %  | 69           | 71             |
|                                      | zlib level 6      | 60.5 %  | 34           | 35             |

Store mode, through the whole module (`createZip` MB/s):

| Input                | `crc32Js` | `zlib.crc32` |
| -------------------- | --------- | ------------ |
| random 64 MiB        | 2,131     | 23,461       |
| synthetic WAV 64 MiB | 2,125     | 22,960       |
| real stems           | 1,964     | 21,266       |

`zlib.deflateRawSync` without any streams gave the same speeds, so the `Duplex.toWeb`
adapter overhead is negligible:

| Input         | level 1  | level 6  |
| ------------- | -------- | -------- |
| random        | 80 MB/s  | 85 MB/s  |
| synthetic WAV | 143 MB/s | 141 MB/s |

End to end like the CLI: stems read from disk (warm cache) → `createZip` → drained, median of 3.

| Configuration                              | ratio  | throughput | time   |
| ------------------------------------------ | ------ | ---------- | ------ |
| defaults (CompressionStream + `crc32Js`)   | 60.5 % | 35 MB/s    | 4.80 s |
| **zlib level 1 + `zlib.crc32` (proposal)** | 62.4 % | 99 MB/s    | 1.71 s |
| store + `zlib.crc32` (`--store`)           | 100 %  | 3,684 MB/s | 0.05 s |

### Deflate in browsers and workerd (`CompressionStream("deflate-raw")`)

The browser rows are the best of 3. The workerd rows are a single run with coarse timers, so
treat them as indicative.

| Engine                  | random 64 MiB | synthetic WAV 64 MiB | real stems 169.4 MB |
| ----------------------- | ------------- | -------------------- | ------------------- |
| Chromium 153            | 93 MB/s       | 151 MB/s, 47.5 %     | 37 MB/s, 60.5 %     |
| WebKit 26.6             | 83 MB/s       | 109 MB/s, 47.3 %     | 49 MB/s, 60.1 %     |
| Firefox 155             | 98 MB/s       | 171 MB/s, 47.5 %     | 77 MB/s, 60.2 %     |
| workerd (local, 32 MiB) | 80–83 MB/s    | 133–138 MB/s, 47.5 % | not run             |

For the browser upload page this means about 37–77 MB/s of zipping on this machine. That is
above typical uplinks, so the defaults are fine there.

### Other timings (single runs)

- **Small fixture zips** (~8 MB output): written in 180–290 ms in every runtime.
- **70,000-entry zip:** written in 390–520 ms.
- **4.5 GiB stored zip** with `zlib.crc32`, written to the OS temp dir: 0.6 s.

## Callers

**CLI (implemented, round 2B).** `yeet upload <file>` uploads one file as it is.
`yeet upload <file1> <file2> …` and `yeet upload <folder>` upload one zip:

- `packages/cli/src/selection.ts` (`planUpload()`) walks the selection with `stat`/`readdir`
  only: `<folder>.zip` with the folder as the single top-level entry, or
  `yeet-<YYYYMMDD-HHMMSS>.zip` (local time) for several paths, files at the top level. It
  skips `.DS_Store`, symbolic links to folders (no cycles) and anything that is neither file
  nor folder (with a note), keeps empty folders as directory entries, applies NFC and
  `sanitizeForWindows()` (with a note listing renames), warns about paths of 260+ characters,
  and refuses names that collide after that (ignoring case; a file and a folder of the same
  name included) with both sources named, and a selection without any file.
- `packages/cli/src/upload-zip.ts` (`uploadZip()`) zips with `zlib.createDeflateRaw({ level: 1 })`
  via `Duplex.toWeb` and `zlib.crc32` when present (`compress: false` with `--store`), opens
  each file only when the zip reaches it, cuts the output into parts of exactly `part_size`
  (the last shorter), three in flight, the zip paused while they are (at most four 50 MiB
  buffers). Size: at create when `storedZipSize()` knows it, else at `complete`. Of unknown
  size the server completes at most 150 parts ([api.md](api.md)): the CLI stops before part
  151, or before the first when the stored files alone exceed that. On any error (a source
  error, a size that changed while read, a part failed after its retries, Ctrl-C) no new part
  starts, the parts in flight finish (aborted after 30 s), the upload is deleted and
  `complete` is never sent; exit 1, or 130 for Ctrl-C (a second Ctrl-C quits at once).
- Progress: the CLI's usual line (stderr, TTY only), with the input bytes whose output has
  been uploaded as the count and "file k of n" after it.

**Browser:** entries from `FileList` / drag-and-drop with `webkitRelativePath`, then defaults
(round 2C, not part of this round).

**Copies:** `zip.ts` lives byte-identical in `packages/cli/src/zip.ts` and
`packages/worker/src/zip.ts`. `scripts/check-zip-copies.mjs` (`npm run check:zip-copies` at the
root) fails when they differ; `e2e`'s `npm run verify` runs it before anything else, and
`zip-tooling.spec.ts` tests it.

## Must-test list for the production implementation

The test-first session should treat each item as a required test. Items marked (proto)
were ported from the 0c prototype. Where each item is tested now, and what ran, is in the
table after the list.

1. **Structural validator as a test oracle.** Port or reuse `check.py` (now `e2e/zip/check.py`)
   (the independent verifier's parser, kept verbatim as the reference) (proto). It checks
   both views of the archive (central directory and sequential local headers):
   - flags and UTF-8 bit;
   - version needed / made by;
   - 32-bit vs ZIP64 sizes, and ZIP64 extra contents (only overflowing fields);
   - presence of the ZIP64 end record and locator;
   - UT extra and DOS date/time against the expected zone;
   - descriptor signature and width;
   - contiguous offsets, CRC and SHA-256;
   - the ZIP64 policy itself (local ZIP64 iff size unknown or ≥ 4 GiB − 16 MiB).
2. **Descriptor width asserted structurally:** 24 bytes iff the local ZIP64 extra is
   present, 16 otherwise. Never inferred from a reader accepting the file, and never via
   `ditto` (proto via check.py).
3. **mtime skew is a failure, not a note** (proto). Assert DOS date/time and the UT value
   directly, then after extraction. Cover:
   - UTC and non-UTC producer zones (`timeZoneOffset`, and the process TZ via `TZ=...`);
   - **both sides of a DST transition** (e.g. Europe/Amsterdam, last Sunday of March and of
     October), since the default offset is taken per entry mtime;
   - odd seconds (DOS has 2 s resolution: round down);
   - pre-1980 clamping, and post-2038 UT clamping (2³¹−1).
4. **ZIP64 end-record boundary:** 65,534 entries → no ZIP64 end record; 65,535 → present
   (asserted structurally, proto). Also a central-directory offset just below and above
   4 GiB.
5. **The 16 MiB ZIP64 margin:** a declared size of exactly `0xFFFFFFFF − 16 MiB − 1`
   (no ZIP64) vs `0xFFFFFFFF − 16 MiB` (ZIP64). Use a synthetic stream that does not touch
   disk.
6. **The "exceeds 4 GiB without ZIP64 local header" guard.** It is unreachable with
   honest size hints and a real deflater, because deflate expands by far less than 16 MiB.
   Test it with a small declared size (e.g. 1 byte, matching the input) and an injected
   `deflateRaw` that emits more than 4 GiB. The stream must error instead of writing a
   32-bit descriptor.
7. **Size-hint mismatch** (shorter and longer than declared) errors the stream (proto).
8. **Stored odd-size entries past 4 GiB** (e.g. 262,140 B and 1000 MiB − 1, total > 4 GiB)
   in Archive Utility and the structural checker (proto).
9. **Deflated entries whose compressed size exceeds 4 GiB** (incompressible input, size
   unknown) (proto).
10. **Extra-field order:** ZIP64 is the first extra in local and central headers when
    present (assert bytes).
11. **Filename policy** (proto):
    - NFC normalization;
    - case-insensitive and NFC collisions throw;
    - backslash stays literal;
    - `sanitizeForWindows` table: `:`, `?`, `CON.txt`, `nul`, trailing dot/space, `...`, Unicode untouched.
12. **Error and cancel paths** (proto):
    - source error propagates;
    - cancelling the zip cancels the active source (store and deflate);
    - invalid paths throw.
13. **Cross-runtime:** the same module in Node, workerd (no `nodejs_compat`) and
    Chromium/WebKit/Firefox, validated with the structural checker (proto).
14. **Copy check:** the CLI and Worker copies of `zip.ts` are byte-identical.
15. **Tooling guard:** the 7za binary from `7zip-bin` is executable; fail with a `chmod`
    hint if not (proto: `assertSevenZip`).

**Where each item is tested (round 2B).** `node e2e/zip/mutate.mjs [--slow]` checks that each
listed mutant of `zip.ts` makes the test fail.

| Item | Test (`e2e/tests/…`)                                                                                                     | Mutants caught                                                             |
| ---- | ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| 1    | `zip-format` "check.py passes: …" (6 variants), "every local reader accepts …", "check.py is not vacuous"                | M22 UTF-8 flag, M23/M24 CRC, M25 deflate CRC, M26 zero sizes, M27 dir attr |
| 2    | `zip-format` "zip 2: descriptor width"                                                                                   | M1 always 24 bytes, M22, M26                                               |
| 3    | `zip-format` "zip 3: …" (zones, DST under `TZ=Europe/Amsterdam`, odd seconds, clamps, extraction)                        | M18 offset of now, M19 rounding, M20 no 1980 clamp, M21 no 2038 clamp      |
| 4    | `zip-format` "65534 / 65535 entries"; `zip-big` "central directory at 0xfffffffe / 0xffffffff"                           | M4, M30 (count), M5 (offset, slow)                                         |
| 5    | `zip-format` "zip 5" (header only); `zip-big` "zip 5" (written in full)                                                  | M2 `>` vs `>=`, M3 1 MiB margin, M31 (slow)                                |
| 6    | `zip-format` "zip 6: …guard" (and "not over-eager")                                                                      | M6 no guard                                                                |
| 7    | `zip-format` "zip 7" (8 cases)                                                                                           | M7 no size check                                                           |
| 8    | `zip-big` "zip 8: stored odd-size entries past 4 GiB"; Archive Utility via `zip/archive-utility.ts --big` (opt-in)       | M33 offset not saturated, M34 version needed (slow)                        |
| 9    | `zip-big` "deflated, compressed size over 4 GiB"; `readers.ts --big` with real incompressible data                       | M32 (slow)                                                                 |
| 10   | `zip-format` "zip 10" (local, central via a fake 4 GiB deflater); `zip-big` extra lists                                  | M8 local order, M9 central order, M10 both sizes                           |
| 11   | `zip-format` "zip 11" (NFC, collisions, backslash, sanitize table); CLI side in `cli-zip`                                | M11 NFC, M12 case, M13 backslash, M15 CON.txt, M16 trailing dots           |
| 12   | `zip-format` "zip 12" (source error, iterable error, cancel ×3, invalid input, empty archive)                            | M14 `..`, M17 no cancel                                                    |
| 13   | `zip-format` (Node), `node/zip-runtime` (workerd, no `nodejs_compat`), `browser/zip-runtime` (Chromium, WebKit, Firefox) | —                                                                          |
| 14   | `zip-tooling` "are byte-identical", "fails when they differ"                                                             | —                                                                          |
| 15   | `zip-tooling` "7za without the exec bit"; `readers.ts` prints the hint for real (seen on this machine)                   | —                                                                          |

Also: "compression choice" (M28 inverted heuristic, M29 `--store` ignored) and "crc32Js".

## Known limitations

- **Strict streaming readers reject stored entries with data descriptors.** A reader that
  does not use the central directory cannot find the end of a stored entry whose sizes are
  only in the trailing descriptor. That covers Java `ZipInputStream` and Apache Commons
  Compress `ZipArchiveInputStream` without `allowStoredEntriesWithDataDescriptor`, which
  are common in Android apps.
  - Deflated entries are fine, because the deflate stream terminates itself.
  - Stored + descriptor is inherent to streaming without seeking. The only alternative is
    knowing the CRC before writing the header, which needs a second read of the file.
  - Not tested here. Listed for the Android check above.
- **UT mtime is a signed 32-bit value** (Info-ZIP reads it as signed), so it is clamped
  at 2038-01-19. Later mtimes keep a correct DOS date (up to 2107) but a saturated UT.
- **Version needed differs between local (2.0) and central (4.5)** for an entry whose only
  ZIP64 field is its offset (it starts past 4 GiB but has a known small size). The local
  header was written before the offset mattered for the central record. Python's writer
  does the same. All tested readers, including Archive Utility, accept it. `check.py`
  reports it as a note.
- **`7zip-bin`'s `7za` lacks the exec bit** when npm install scripts are blocked (as on this
  machine). The validator now checks for it and prints a `chmod +x` hint.
- **Empty archives** are rejected or warned about by `unzip` and `ditto`; callers must
  refuse an empty selection. The CLI does.
- **A compressed CLI zip is at most 150 parts (7.86 GB of zip).** Its size is only known at
  its end, and the server completes an upload of unknown size from at most 150 parts
  ([api.md](api.md)). The CLI stops before part 151 and says to use `--store` (size known up
  front, no limit) or smaller groups; it stops before the first part when the stored files
  alone are larger. A very large compressible folder therefore fails after uploading 7.86 GB.
- **`ditto` reads DOS times with the UTC offset in effect when it runs** (measured
  2026-10-10, in CEST, TZ=Europe/Amsterdam): entries from winter time came out 1 h early,
  whatever the zip says. So no zip extracts with correct mtimes in `ditto` on both sides of a
  DST transition. Archive Utility, `unzip`, `bsdtar` and `7za` use the UT extra and are right.
  The tests that extract with `ditto` use an mtime of a minute ago for that reason.
- **A file and a folder whose names differ only in case** (`a` and `A/…`) collide on
  extraction, but `createZip` compares whole paths only and lets them through. The CLI's
  pre-flight check catches it; another caller would have to.

## Risks and open questions

1. **Windows Explorer is untested.** That is the biggest compatibility unknown. Mitigation:
   the ZIP64-only-when-needed policy and spec-exact extras. Test on a real Windows machine
   before release, especially with a >4 GiB zip and with non-ASCII names.
2. **`Duplex.toWeb` is experimental in Node docs.** If it changes, wrap `zlib` in a small
   hand-written `TransformStream` instead. The interface is unaffected.
3. **Files that change while zipping.**
   - Size known and changed: the zip errors, and the upload must be aborted.
   - Same size, different content: the CRC still matches what was read, so the archive is
     consistent.
4. **Partial output on error.** The stream errors mid-archive. The uploader must abort the
   R2 multipart upload and never `complete` a truncated zip.
5. **Worker-side zipping** would produce UTC DOS times (fixable with `timeZoneOffset`) and
   be CPU-bound. Keep zipping on the client.
6. **Empty selection** must be rejected by callers (readers reject empty zips).
7. **ditto/Archive Utility quirks are version-specific.** These results are from macOS 26.6.2
   only; older macOS was not tested.
8. **Archive Utility unwraps a single top-level folder.** That is cosmetic, but it is why
   folder zips should keep the folder as the single root.
9. **Store-list edge cases.** Already-compressed data with an unlisted extension just costs
   CPU (see the random-data rows). Uncompressed data with a listed extension (rare PDFs, WAV
   inside `.mov`) just costs size.

## Reproduce

The prototype (`prototypes/0c-zip/`) was removed in round 2B; it is in git history
(e.g. commit `24de5c8`). Its tests and tools now live in `e2e/`. From `e2e/`, after
`npm install` (the suite) or `npm run verify` once (it installs the packages too):

| Command                                     | What it runs                                                                                  | Time        |
| ------------------------------------------- | --------------------------------------------------------------------------------------------- | ----------- |
| `npm run verify` (or `verify:fast`)         | the must-test suite with everything else; `verify:fast` skips the `@slow` >4 GiB tests        | minutes     |
| `node zip/mutate.mjs [--slow] [M7 …]`       | the zip tests against deliberate bugs in `zip.ts`; each mutant must be caught                 | 1 min / +5  |
| `node zip/readers.ts [--big] [filter]`      | every reader on real files; `--big`: the six >4 GiB archives (~5 GB temp each, one at a time) | 2 / ~15 min |
| `node zip/archive-utility.ts [--big]`       | real Archive Utility (macOS, opens the app in the background)                                 | 1 / ~5 min  |
| `node zip/bench/bench-crc.ts`               | CRC-32 benchmark                                                                              | seconds     |
| `node zip/bench/bench-compress.ts [runs]`   | deflate benchmark (the stems section needs the stems folder named in the script)              |             |
| `node zip/bench/node-compat.ts <node bins>` | older Node versions                                                                           |             |

Node 24 runs the `.ts` files directly. The 7za readers need the exec bit (`zip/validate.ts`
prints the `chmod +x` command when it is missing). Not ported: the prototype's browser and
workerd benchmark pages (`browser-test.ts --bench/--stems`, the Worker's `/bench`); their
numbers above stay as measured in 0c.
