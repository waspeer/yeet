# Streaming ZIP writer — design decision (phase 0c)

Status: proposed, backed by the prototype in `prototypes/0c-zip/`.
Scope: the module that zips multiple files or a folder _while streaming_ into an upload,
copied verbatim into `packages/cli` (Node) and `packages/worker` (Worker + browser upload page).

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
```

The prototype also has `zip64?: "auto" | "always"` and an `experimental` object. Both exist
only to test reader compatibility and should **not** be part of the real API (`"always"` and
the `"mirror"` variant break `ditto`, see below).

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
  - invalid paths (absolute, `..`, drive letters) and duplicate paths throw;
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

| Topic                      | Decision                                                                                                                                                                                                                | Evidence / reason                                                                                                                                                                                                                                                                                                                |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Data descriptors           | Bit 3 on every file entry; descriptor **with** signature `PK\7\8`; local CRC = 0                                                                                                                                        | Sizes and CRC are unknown when the header is written. All tested readers accept it, including the streaming readers (`bsdtar` from stdin).                                                                                                                                                                                       |
| Descriptor width           | 24 bytes (8-byte sizes) **iff** the local header has a ZIP64 extra; otherwise 16 bytes                                                                                                                                  | This is APPNOTE's rule and the one readers implement. Java's JDK-8265186 and Go's history are bugs from violating it.                                                                                                                                                                                                            |
| ZIP64 local header         | When `size` is unknown or `>= 4 GiB − 16 MiB`. Then: version needed 4.5, 32-bit sizes `0xFFFFFFFF`, ZIP64 extra with zeros.                                                                                             | The 16 MiB margin covers deflate expansion of incompressible data (measured: +0.03 %). `0xFFFFFFFF` + extra is the spec-consistent form, the same one Python's streaming writer uses. A variant with zero 32-bit sizes also passed every reader, but it puts ZIP64 fields behind non-`0xFFFFFFFF` values, which APPNOTE forbids. |
| ZIP64 central extra        | Only the overflowing fields, in spec order (size, compressed size, offset)                                                                                                                                              | Measured: `ditto` **rejects** a stored entry whose central header carries ZIP64 sizes below 4 GiB (`zip64: "always"` and `"mirror"` variants; deflated entries were fine). Writing only what overflows also matches APPNOTE 4.5.3 and Go issue 33116 (unneeded fields broke 7-Zip, Keka, The Unarchiver, …).                     |
| ZIP64 end record + locator | Only when entries `>= 65535` or central-directory offset/size `>= 0xFFFFFFFF`                                                                                                                                           | 70,000-entry archive passes in all readers, including Archive Utility.                                                                                                                                                                                                                                                           |
| Version made by / needed   | made by Unix (3), version 2.0, or 4.5 for ZIP64 entries; external attrs `0100644` / `040755`                                                                                                                            | Gives sane permissions with `unzip`/`ditto`/`bsdtar`.                                                                                                                                                                                                                                                                            |
| Filenames                  | Always UTF-8 with bit 11                                                                                                                                                                                                | Ü, 日本語, emoji, em dash round-trip in every tested reader. ASCII is valid UTF-8, so there is no reason to branch.                                                                                                                                                                                                              |
| Timestamps                 | DOS date/time in the producer's local zone (`timeZoneOffset` overrides), plus UT extra (0x5455) with UTC mtime                                                                                                          | Measured: `unzip`, `bsdtar`, `7za` and **Archive Utility** use the UT extra. **`ditto` uses the DOS fields only**: a zip made in workerd (UTC) extracted 2 h early with `ditto` on a CEST machine, and correct with `?tz=120`. The CLI and browser produce local time, so they are correct everywhere.                           |
| Directories                | Path ending in `/`: stored, no descriptor                                                                                                                                                                               | Supported (an empty dir round-trips). Whether the CLI emits empty dirs is a product call.                                                                                                                                                                                                                                        |
| Store list                 | `isCompressedPath`: mp3 m4a aac ogg oga opus flac wma, mp4 m4v mov mkv webm avi wmv, jpg jpeg png gif webp heic heif avif jxl, zip gz tgz bz2 xz zst 7z rar br lz4, docx xlsx pptx odt ods odp epub jar apk ipa dmg pdf | Deflating these costs CPU for about 0 % gain (the random-data rows below show the throughput cost). `pdf` is borderline (some PDFs are uncompressed); keep it or drop it.                                                                                                                                                        |
| Empty archive              | Byte-identical to Python's empty `ZipFile`                                                                                                                                                                              | `unzip` warns "zipfile is empty" (exit 1) and `ditto` rejects it. **The CLI must refuse an empty selection** rather than upload such a zip.                                                                                                                                                                                      |

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
computed in Node, plus mtimes where the extractor sets them.

| Runtime                            | Version                                                                              | Result                                                                                 |
| ---------------------------------- | ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| Node                               | 24.16.0 (also 20.12.0, 20.20.2, 22.0.0, 26.9.0 with a reduced reader set)            | PASS: all readers, all default variants, 70k entries, error/cancel paths               |
| workerd via `wrangler dev` (local) | wrangler 4.148.0, workerd 2026-10-06, compat date 2026-10-01, **no** `nodejs_compat` | PASS: all readers. `ditto` shows the UTC mtime shift unless `timeZoneOffset` is set.   |
| Chromium (Playwright)              | 153.0.8010.12                                                                        | PASS: all readers, including zips built from real `File` objects                       |
| WebKit (Playwright)                | 26.6                                                                                 | PASS (its deflate output differs in bytes, 8,232,128 vs 8,244,712, and is still valid) |
| Firefox (Playwright)               | 155.0                                                                                | PASS                                                                                   |

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
| empty archive (0 entries)                                                        | ⚠️ "zipfile is empty" | ✅     | ❌ (same for Python's own empty zip)                     | not run         | ✅                    | ✅ t                                 |

`ditto` is **not** a perfect proxy for Archive Utility: Archive Utility accepted the
`zip64: "always"` file that `ditto` rejected, and Archive Utility honors the UT timestamp
while `ditto` does not. The chosen policy passes both.

All >4 GiB archives were written to the OS temp dir and deleted afterwards. These are the
sizes on disk:

| Archive                            | Bytes on disk |
| ---------------------------------- | ------------- |
| stored 4.5 GiB entry, size known   | 4,831,838,678 |
| stored 4.5 GiB entry, size unknown | 4,831,838,706 |
| deflated incompressible 4.5 GiB    | 4,833,313,321 |
| 4 × 1.2 GiB stored                 | 5,153,961,560 |

### Not tested (do not assume)

- **Windows Explorer** (any version), including its UTF-8 flag and ZIP64 handling. From
  research: Explorer is reported to reject central ZIP64 extras with fields that do not
  overflow, which the chosen policy avoids. Not verified.
- Modern 7-Zip (only p7zip 16.02 from 2016), WinRAR, The Unarchiver, Keka, BetterZip.
- Linux distribution `unzip` builds, Android, iOS/iPadOS Files app.
- Real Safari (Playwright WebKit is not Safari), mobile browsers.
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

## Planned callers (sketch)

CLI:

```ts
const zip = createZip(walk(root /* skips .DS_Store, yields {path, size, lastModified, stream} */), {
  compress: !flags.store,
  deflateRaw: () => Duplex.toWeb(zlib.createDeflateRaw({ level: 1 })) as ByteTransform,
  crc32: (zlib as { crc32?: typeof crc32Js }).crc32, // undefined → crc32Js
});
// zip → re-chunk into 50 MiB parts → upload; on any error: abort multipart; size at complete.
```

Zip name: `yeet-<timestamp>.zip` for loose files, or `<folder>.zip` with paths relative to the
folder's parent so the folder name is the single top-level entry.

Browser: entries from `FileList` / drag-and-drop with `webkitRelativePath`, then defaults.

Copying: `zip.ts` lives byte-identical in `packages/cli/src/` and `packages/worker/src/`
(exact location is up to the implementing session), with a root `scripts/check-zip-copies`
that compares hashes in CI or a pre-commit step.

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

From `prototypes/0c-zip/`, after `npm install`:

| Command                                            | What it runs                                          | Time          |
| -------------------------------------------------- | ----------------------------------------------------- | ------------- |
| `node scripts/node-test.ts`                        | Node matrix                                           | a few minutes |
| `node scripts/zip64-test.ts`                       | >4 GiB suite; ~5 GB temp per case, deleted afterwards | ~10 min       |
| `node scripts/worker-test.ts`                      | `wrangler dev` on 127.0.0.1:8799                      |               |
| `node scripts/browser-test.ts [--bench] [--stems]` | browser matrix and benchmarks                         |               |
| `node scripts/archive-utility-test.ts [--big]`     | real Archive Utility                                  |               |
| `node scripts/bench-crc.ts`                        | CRC-32 benchmark                                      |               |
| `node scripts/bench-compress.ts [runs] [--e2e]`    | deflate benchmark                                     |               |
| `node scripts/node-compat.ts <node binaries…>`     | older Node versions                                   |               |

Node 24 runs the `.ts` files directly.
