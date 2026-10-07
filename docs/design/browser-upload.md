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
   mode (deterministic offsets).
6. **Zip details.** Use `File.lastModified` for entry times. Apply the filename
   policy from [zip.md](zip.md) (NFC, duplicates, Windows sanitising). Keep
   folder paths from `webkitRelativePath`.

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
- **Production consequences:**
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

## Untested

- **iOS Safari** (much stricter memory limits). This is a human test, see
  below.
- **Real internet uplinks** (parts in flight, backpressure, slow-link progress).
- **Hidden or background tabs** on desktop.

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
