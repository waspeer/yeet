# Browser upload: design decision (phase 0b)

Status: decided from a throwaway prototype plus an independent verification
(verdict: pass with gaps). The prototype is not in this branch. It lives on the
local branch `worktree-agent-a63e58464fe9dcdcd` (`prototypes/0b-browser-zip/`,
including `RESULTS.md` with every measurement), and is kept there for the
iPhone test.

## Question

Can the upload page zip ≥ 1 GiB of user-selected files with compression,
**while** uploading them as 50 MiB multipart parts, with bounded memory, in
every engine (Safari in particular)?

## Answer

Yes, under two conditions:

1. **Read files with `File.slice(offset, offset + 4 MiB).arrayBuffer()`, never
   `File.stream()`.** In the Safari engine, `File.stream()` has no backpressure.
   On a 1 GiB file the Networking process reaches about 1.2 GiB (lifetime peak
   1,229 MiB), against 206 MiB with slices. Slices cost about 3% throughput.
2. **Run the whole pipeline in a dedicated Web Worker** (read → CRC-32 →
   `CompressionStream('deflate-raw')` → zip framing → 50 MiB parts → `fetch`).
   With `File.stream()` on the main thread, Chromium and Safari freeze the page
   for about 1.8–2.7 s at a time. In a worker the worst main-thread stall was
   2–16 ms in every engine.

Request-body streaming (`fetch` with a `ReadableStream` body) is not an option:
Safari throws `NotSupportedError: ReadableStream uploading is not supported`.
Each part is therefore built in memory and sent as a **Blob**. Blob bodies use
about half the page memory of `Uint8Array` bodies in WebKit.

## Measured (Apple M5 Pro, macOS 26.6.2, local `wrangler dev`, 1 GiB input)

| Engine                            | Random 1 GiB | Real stems (169 MB) | Page memory, lifetime peak                   |
| --------------------------------- | ------------ | ------------------- | -------------------------------------------- |
| Safari engine (WKWebView, 26.6.2) | 75–78 MB/s   | 43 MB/s             | 278 MiB (Blob bodies), 448 (`Uint8Array`)    |
| Chromium 153                      | 82–84 MB/s   | 34 MB/s             | ≈ 711–798 MiB total footprint, all processes |
| Firefox 155                       | ≈ 87–90 MB/s | 60 MB/s             | not usable (Playwright instrumentation)      |

- **Bottleneck:** deflate is the limit. Uploading added only 5–12% on localhost.
- **Compression:** real stems compress to 0.60–0.61 of their size.
- **Correctness:** every verified zip was byte-identical per entry. The author
  checked 184 runs and the verifier 16 more, with its own checker.
- **Parts in flight:** 1, 2 and 3 took the same time locally, and each extra
  slot costs about 50 MiB. The best value over a real internet connection is
  untested.

### Measurement traps (for anyone re-measuring)

- **Playwright WebKit is not Safari.** It keeps every in-memory upload body in
  its Networking process: about 1 GiB after 21 parts, still held after
  navigating away. Measure Safari with a WKWebView harness.
- **Playwright's network instrumentation copies upload bodies.** With it on,
  Chromium drops to 30 MB/s and peaks at 1.7 GiB. Turn it off. It cannot be
  turned off in Firefox, so Firefox memory numbers are unusable.
- **Main-thread lag needs a visible window.** Occluded windows and a sleeping
  display throttle timers to about 1 s. Use `caffeinate -d` and keep the
  window on top.
- **Use the kernel's peak, not sampled peaks.** 200 ms sampling understates
  peaks by 10–100 MiB. `vmmap --summary` ("Physical footprint (peak)") gives
  the lifetime peak, but calling it during a run disturbs the run.

## Design for the upload page

- **One Web Worker per upload.** It runs the reader, CRC, deflate, zip framing,
  part assembly and the uploads, and posts progress to the page.
- **4 MiB slice reads.** Send parts as Blobs, built from the compressed
  chunks. Avoiding the extra 50 MiB copy is untested.
- **2 parts in flight by default.** Fall back to 1 when memory is low or
  uploads fail.
- **A single file is uploaded as-is, without a zip.** Each part is
  `file.slice(start, end)` sent directly. That costs no memory and no CPU.
- **Store or deflate per entry,** using the extension list from
  [zip.md](zip.md). Optionally, probe-deflate the first 4 MiB of each file.
- **ZIP64 and the zip format** follow [zip.md](zip.md), using the same module
  as the CLI.

### Required for production (gaps found by the verifier)

1. **Abort and cleanup.** On failure or `pagehide`: abort in-flight requests
   (`AbortController`), stop the reader, and call `DELETE /api/uploads/:id`
   (best effort). The cron removes uploads still pending after 24 h.
2. **Retry each part.** Keep each part's Blob until it is acknowledged, and
   retry it with backoff.
3. **Accurate progress.** `fetch` reports no upload progress, so on a slow
   uplink a 50 MiB part can take about a minute. Use XHR
   `upload.onprogress` (not yet measured with Blob bodies), or show
   input-read progress.
4. **Keep the device awake.** Use `navigator.wakeLock` where available.
   Behaviour in a hidden tab or a backgrounded iOS page is untested.
5. **iOS suspension.** A deflate stream cannot be resumed part-way. Decide
   between restarting (simplest), checkpointing at file boundaries, or store
   mode (deterministic offsets). Decided in round 2C+2: a stored zip
   continues, a compressed one restarts (see "Round 2C+2").
6. **Zip details.** Use `File.lastModified` for entry times. Apply the filename
   policy from [zip.md](zip.md) (NFC, duplicates, Windows sanitising). Keep
   folder paths from `webkitRelativePath`. Done in round 2C+2.

### Seen on a real iPhone (Safari 26.6.1, prototype)

- **358 MB in 9 WAVs:** completed in 147 s.
  - Page memory peaked at 296 MB, with no memory-pressure events and at most
    6 ms of main-thread lag.
  - The zip verified byte-correct.
  - The network, not the phone, was the bottleneck: 98 s of waiting for an
    upload slot.
  - Page memory stayed at about 230 MB after the upload. Terminate the worker
    after each upload.
- **1 GB WAV:** 7 parts (about 350 MB) succeeded, then part 8 failed with
  status 0. About 24 s later, reading the picked file failed with
  `NotFoundError: The object can not be found here`. The most likely cause is
  that the screen locked or Safari went to the background: iOS drops the
  upload, then revokes access to the picked `File`.
- **Production consequences** (all done in round 2C, see "Round 2C"
  below):
  - Keep the screen awake with a Wake Lock.
  - Treat `NotFoundError` while reading as "file access lost", not as a
    retryable error, and say so plainly, e.g. "Safari stopped when the screen
    locked. Choose the file again to continue".
  - For a single file, resume from the first unacknowledged part after the
    user re-selects the same file (check its name, size and `lastModified`).
    The multipart upload stays open for 24 h, so this is possible.
  - A deflated zip cannot resume part-way and must restart.

### Server API changes this needs

- **Size at `complete`.** `size` becomes optional at create. The stored size
  comes from R2's `object.size` after `complete`, and a client-sent size is
  only an optional cross-check. Validate before completing, not after.
- **Enforce equal part sizes.** R2 requires every part except the last to be
  the same size. Check this per part, so a client bug gives a clear error.
- **Size limit.** With size optional at create there is no up-front check, so
  any size limit must be enforced per part or at `complete`.
- **Authentication.** The browser must not hold the `UPLOAD_TOKEN`. The page
  logs in once and gets a session cookie (HttpOnly, SameSite=Strict, plus an
  Origin check). Upload requests from the Web Worker carry that cookie on the
  same origin.

## Phase 1B: single-file upload page (measured)

The page (`packages/worker/src/upload-page.ts`, `src/upload/`) uploads one
file without zipping: a fresh Web Worker per upload, parts sent with XHR as
`file.slice()` Blobs, 2 in flight (1 after the first retry), 4 attempts per
request with exponential backoff or `Retry-After`. Playwright 1.63 builds,
local `wrangler dev`, 120 MiB (3 parts):

- **XHR `upload.onprogress` with Blob bodies works in all three engines.**
  6–10 of 10–13 progress updates per upload fell between part boundaries.
- **Origin from the worker.** Its POST/PUT/DELETE requests carry
  `Origin: <page origin>` and `Sec-Fetch-Site: same-origin` in all three
  engines: Playwright reports them, and the Worker's session check, which
  refuses requests without them, accepts every upload.
- **Main thread, max lag of a 10 ms timer during the upload:** WebKit 3–4 ms,
  Firefox 20–39 ms, Chromium 74–82 ms. Headless Chromium also lags 52 ms when
  idle (26 ticks in 1.5 s instead of ~150), so its figure is timer throttling,
  not upload work.
- **Memory (RSS of all browser processes, 360 MiB upload):** Chromium 478 →
  peak 494 → 507 MiB 30 s after; WebKit 575 → 585 → 586; Firefox 1125 → 1174
  → 1133. File-backed Blobs do not grow memory, and the worker is terminated
  after success, failure or cancel. RSS only; the iPhone is untested.
- **Empty files** upload as one empty part and download as 0 bytes (local R2
  only; real R2 is untested).
- **Playwright WebKit cancels the `keepalive` DELETE sent on `pagehide`
  whenever a `page.route()` is active;** without interception it arrives.

## Round 2C: the finished page (single file)

What the page now does, besides phase 1B (details in [api.md](api.md),
"Upload page module"):

- **Look:** the yeet window of the download and login pages (`layout()`
  in `template.ts`): striped title bar, close box, Geneva 12 px, black
  borders and hard shadows, the black primary button. The select and the
  progress bar are drawn in the same black and white.
- **Options:** expiry (1, 7, 30 by default, 90 days, 1 year) and an
  optional download password, chosen before the file; the done state
  repeats both next to **Copy link**.
- **Phone width:** touch-size targets and 16 px fields below 480 px or on
  a touch screen; checked at 375 × 667 in all three engines (no sideways
  scrolling, every target at least 44 px and on screen).
- **Lost file access:** a failed read (`NotFoundError`) is "file access
  lost", not a network error: the upload is kept, and choosing the same
  file again continues from the first unacknowledged part. Tested by
  renaming the file away on disk mid-upload: reading the `File` then fails
  in every Playwright engine, in WebKit with the iPhone's own
  `NotFoundError: The object can not be found here.` (Chromium:
  `NotFoundError`, Firefox: `AbortError`).
- **Found while testing:** once its file is gone, WebKit's
  `File.lastModified` no longer returns the date the file had (it reads
  the missing file again), so the page records name, size and
  `lastModified` when the file is chosen.
- **No cleanup `DELETE` after `complete`** (a verifier found that a
  cancel or `pagehide` during `complete` could destroy a finished
  upload), and the server's `complete` no longer undoes a concurrent
  `DELETE`.
- **Zipping** (several files, folders): round 2C+2, below.

## Round 2C+2: several files or a folder, zipped while uploading

What the page does now (details in [api.md](api.md), "Upload page
module", and [zip.md](zip.md), "Callers"):

- **Choosing:** **Choose files** takes several files, **Choose folder**
  a folder (`webkitdirectory`; hidden on a touch screen, where the drop
  hint is hidden too), and a drop takes either: folders are read with
  `webkitGetAsEntry()` and `readEntries()` until it returns none. One
  file (not in a folder) is uploaded as before, without a zip.
- **What is zipped:** `src/upload/selection.ts` (`planSelection()`),
  the CLI's rules: `<folder>.zip` with the folder as the single top
  entry, or `yeet-<timestamp>.zip`; `.DS_Store` skipped; empty folders
  kept (a drop reports them, the folder picker does not); NFC and
  `sanitizeForWindows()` with a note; refused with a clear message:
  nothing but `.DS_Store` and empty folders, or two names that would be
  one in the zip, a file and a folder of the same name included. An e2e
  test plans the same folder with this and the CLI and compares.
- **Zipping** (item 6 above, done): in the upload's Web Worker with
  `zip.ts`'s browser defaults, store or deflate per entry by extension
  (empty files stored), 4 MiB `slice().arrayBuffer()` reads, entry
  times from `File.lastModified` in the browser's zone, the output cut
  into 50 MiB parts sent as Blobs, two in flight, the same retries,
  backoff and progress ("File k of n" as the zip reaches each file). The
  worker is terminated after every upload.
- **Size and the 150-part limit:** every file stored → the exact size
  (`storedZipSize()`) at create, no limit. Otherwise the size goes with
  `complete`, which the server allows for 150 parts (7.86 GB), so the
  page deflates only if an upper bound of the zip fits (each deflated
  file at its size + 4 × zlib's stored-block overhead + 1 KiB, in the
  stored layout, + 64 KiB: at most 0.13 % over the input). A larger
  selection is stored completely, so its size is known again and there
  is no limit; it can therefore never fail halfway on the limit. If some
  of its files would have compressed, the page first shows a warning
  (more than about 7.8 GB, so uploaded uncompressed; for a smaller
  download zip it first, on a Mac right-click → Compress) with **Upload
  anyway** and **Choose again**. Not when nothing would compress anyway.
- **iOS suspension** (item 5 above, decided): a single file continues
  (round 2C). A **stored zip** is deterministic, so choosing the same
  files again (paths, sizes, dates as first chosen, the same empty
  folders) continues it: the zip is made again from the start (the files
  are read once more up to there, locally) and the parts the server
  already has are not sent again; unless the time zone changed meanwhile
  (round 2D: the DOS dates would differ), then it starts over. A
  **compressed zip** cannot continue
  part-way: the page says choosing the files again starts the upload
  over, and deletes the old upload when the new one starts. Nothing
  deletes an upload once `complete` is sent.
- **Lost-file detection for zips:** a zip part is in memory, so a lost
  file shows first as a failed part (iOS: status 0); after each failed
  attempt the worker reads one byte of the file it read last, and a
  failed read while zipping stops the zip. Both end as "file", kept.
- **`complete` again** (2C+ verifier, item b): sent again at the
  earliest 5 s after an attempt whose answer was lost, because the first
  may still run on the server; the server also copes with a second one
  meanwhile ([api.md](api.md), "Errors R2 raises at `complete`"). What
  real R2 does with a second complete is not measured.

### Measured (Apple M5 Pro, macOS 26.6.2, local `wrangler dev`, Playwright 1.63)

**Browser memory, 1 GiB folder** (`tests/measure/zip-memory.spec.ts`,
opt-in, one run per engine and kind): RSS summed over every process
below the Playwright worker plus every process run from the browser's
install directory (WebKit's WebContent and Networking processes are
XPC services, not children), sampled every 100 ms with `ps`, from just
before the folder is chosen until 10 s after the link shows. 8 × 128
MiB: "compressed" is 4 noise WAVs and 4 mostly silent WAVs (zip 563 MB),
"stored" is 8 noise MP3s (zip 1,073,743,094 bytes).

| Engine       | Kind       | Time  | Before   | Peak     | Growth    | 10 s after | Largest processes at the peak (MiB)   |
| ------------ | ---------- | ----- | -------- | -------- | --------- | ---------- | ------------------------------------- |
| Chromium 153 | compressed | 8.7 s | 489 MiB  | 818 MiB  | +329 MiB  | 677 MiB    | 392, 195, 184 (chrome-headless-shell) |
| Chromium 153 | stored     | 7.1 s | 498 MiB  | 882 MiB  | +384 MiB  | 539 MiB    | 348, 299, 185                         |
| WebKit 26.6  | compressed | 9.1 s | 591 MiB  | 2023 MiB | +1432 MiB | 1982 MiB   | WebContent 939, Networking 736        |
| WebKit 26.6  | stored     | 6.7 s | 659 MiB  | 2671 MiB | +2012 MiB | 2568 MiB   | Networking 1352, WebContent 932       |
| Firefox 155  | compressed | 6.9 s | 1135 MiB | 2397 MiB | +1263 MiB | 1573 MiB   | plugin-container 1151, firefox 903    |
| Firefox 155  | stored     | 6.4 s | 1577 MiB | 2815 MiB | +1238 MiB | 1266 MiB   | plugin-container 1262, firefox 1211   |

- **Chromium** stays bounded (+329 to +384 MiB for 0.56 and 1.07 GB of
  zip), and comes back down after the upload.
- **WebKit's Networking process grows with the zip** (736 MiB for 0.56
  GB, 1352 MiB for 1.07 GB) and keeps it afterwards: the trap measured
  in phase 0b (Playwright's WebKit keeps every in-memory upload body; not
  Safari). Its WebContent process (the page and the worker) reached about
  935 MiB in both runs, so it does not grow with the zip, but it is far
  above the 278 MiB the 0b prototype measured in a WKWebView. Whether
  that is Playwright's build, a garbage collector in no hurry, or the
  page, is not known; **a real Safari / iPhone measurement is needed**.
- **Firefox:** not usable for memory (Playwright's instrumentation, as in
  0b); +1.24 to +1.26 GB for both sizes, released afterwards.
- **Not measured:** the kernel's lifetime peak (`vmmap`), real Safari,
  an iPhone, real uplinks. Throughput here is local (8 parts to
  `wrangler dev`); the silent WAVs compress quickly, so these times are
  not a deflate benchmark.

**Tests** (`npm run verify`, all three engines; see the report of round
2C+2 for the run): `tests/browser/upload-zip.spec.ts` (pickers and
drops, the folder's and the timestamp zip, `.DS_Store`, an empty folder,
FILENAMES names, nested folders, the stored path with the size at create,
the compressed path with the size at complete across two parts and below
its bound, the forced store and its warning with the limit lowered by the
page's test hook, no warning when nothing would compress, an empty
selection, collisions, Cancel with part records, no `DELETE` after
`complete`, lost files for both kinds, the 5 s wait before `complete`
again, the worker terminated), each zip checked with `check.py`, Python
and `unzip -t` and per-entry SHA-256; `tests/node/upload-selection.spec.ts`
(`planSelection()`); screenshots in `e2e/screenshots/2c2/<engine>/`.

## Untested

- **iOS Safari** (much stricter memory limits). This is a human test, see
  below.
- **Real internet uplinks** (parts in flight, backpressure, slow-link progress).
- **Hidden or background tabs** on desktop.
- **A real folder drop** (round 2C+2): the tests drop stand-ins for the
  browser's `FileSystemEntry` objects around real files; a folder
  dragged from Finder (or the Files app) into a real browser is a human
  test. So is the folder picker on a phone (hidden there), picking
  several files in the iPhone's picker, and the forced store with a real
  8 GB selection (tested with the limit lowered to 1 part).

## iPhone test (human, about 20 min)

Run from the 0b prototype branch:

1. On the Mac, keep `caffeinate -d` running, then run `node run.mjs --serve` in
   `prototypes/0b-browser-zip/`. Connect Safari Web Inspector to the iPhone.
2. Upload the stems with the recommended config (slice, worker, Blob, 2 in
   flight). Note the time and the Timelines → Memory peak.
3. Upload a ~1 GB WAV with the same config. Note whether it finishes or the tab
   is killed, how long the Files picker takes, and free space before and after.
4. Upload the same file with the stream reader once. Expect it to be killed.
5. Upload the same file with 1 part in flight.
6. Mid-upload, lock the screen for 30 s, then switch apps for 30 s. Note
   whether the upload stalls, fails (and at which part) or resumes.
7. Check each zip on the Mac with `unzip -t` and a per-entry SHA-256. Note the
   phone model and iOS version.
