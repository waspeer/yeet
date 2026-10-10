# yeet end-to-end tests

One command checks the whole product locally: the built CLI, the Worker under
`wrangler dev` with a local R2 bucket, and the download and upload pages in Chromium, WebKit
and Firefox.

```sh
cd e2e
npm install            # first time only
npm run verify
```

Nothing touches Cloudflare, your real `~/.config/yeet` or `packages/worker/.dev.vars`.

## What `npm run verify` does

1. Installs dependencies of `e2e/`, `packages/cli` and `packages/worker` when
   `node_modules` is missing or older than `package-lock.json`, and the
   Playwright browsers when they are missing.
2. Builds the CLI (`packages/cli/dist/index.js`).
3. Starts `wrangler dev` (which also runs the Worker's `node build.mjs`) on a free
   port of 127.0.0.1, with:
   - `--persist-to` a fresh temp directory, so every run starts with an empty bucket;
   - `--var UPLOAD_TOKEN:<random>` and `--var SENTRY_DSN:` (empty). `--var` takes
     precedence over a developer's `.dev.vars`, which is neither needed nor
     modified; the harness checks `GET /api/me` with its token before testing;
   - `--test-scheduled`, so tests can trigger the cron;
   - a free `--inspector-port`, so runs in different checkouts (worktrees) do not
     collide on 9229.
4. Runs `playwright test`, passing through any arguments after `--`.
5. Tears down — also on test failure, Ctrl-C or SIGTERM: kills wrangler's whole
   process group (wrangler, workerd, esbuild) and deletes the temp directory.

### Exit codes and strict mode

| exit | meaning                                                                                                            |
| ---- | ------------------------------------------------------------------------------------------------------------------ |
| 0    | every selected test ran and passed (`status: "passed"`)                                                            |
| 1    | a test failed or was flaky, no test matched, the harness failed, or — in strict mode — a selected test was skipped |
| 2    | another `verify` run is already active in this checkout; nothing was started                                       |
| 130  | interrupted (Ctrl-C, SIGTERM)                                                                                      |

Strict mode is the default: a skipped test (`test.skip`, `test.fixme`, a
conditional skip) or an expected failure (`test.fail()`, reported as `XFAIL`)
means something was not verified, so the run exits 1 with
`status: "incomplete"`. (A `test.fail()` test that unexpectedly passes is a
normal failure.) **Verifiers must use the default (strict) mode and treat
any non-zero exit as "not verified".** While iterating locally you can pass
`--allow-skips` (`npm run verify -- --allow-skips`) to exit 0 on `incomplete`.
Filtering with `--grep`/`--project` is not skipping: excluded tests are simply
not part of the run.

### One run per checkout

A run holds `e2e/.verify.lock` while it works, because runs in the same
checkout share `results/` and the CLI build. The lock records the run's PID and
process start time, a nonce, the process group IDs of its wrangler and
Playwright children, and its temp directory. A second run in the same checkout
refuses to start (exit 2) and names the PID of the active one.

If the holder is gone — no process with that PID, or one with a different start
time (a reused PID) — it died without tearing down (e.g. `kill -9`). The next
run then stops the recorded process groups that still run programs from this
checkout (SIGTERM, SIGKILL after 5 s), deletes the dead run's temp directory,
and takes the lock, so orphans cannot later overwrite `results/summary.json`. Runs in different
checkouts or git worktrees are independent and can go in parallel: each gets its
own free ports and temp directory.

### Filtering

Arguments after `--` go to Playwright:

```sh
npm run verify -- --project=webkit          # browser tests in WebKit only
npm run verify -- --project=node            # CLI, HTTP and cron tests only
npm run verify -- --grep "password"         # by title, across all projects
npm run verify -- --grep-invert @slow       # skip the 120 MB upload (= npm run verify:fast)
npm run verify -- tests/node/http.spec.ts   # one file
```

Projects:

| project    | tests             | runs                                                              |
| ---------- | ----------------- | ----------------------------------------------------------------- |
| `node`     | `tests/node/*`    | CLI, HTTP and cron tests; no browser, once per run                |
| `chromium` | `tests/browser/*` | download + upload pages in Playwright's Chromium (Desktop Chrome) |
| `webkit`   | `tests/browser/*` | download + upload pages in Playwright's WebKit (Desktop Safari)   |
| `firefox`  | `tests/browser/*` | download + upload pages in Playwright's Firefox (Desktop Firefox) |

With `YEET_E2E_MEASURE=1` there are three more projects, `measure-chromium`,
`measure-webkit` and `measure-firefox` (`tests/measure/*`, opt-in measurements that are never
part of a normal run): `YEET_E2E_MEASURE=1 npm run verify -- --project=measure-chromium
--workers=1` prints the browser's RSS while the upload page zips a 1 GiB folder.

Environment knobs: `YEET_E2E_WORKERS=<n>` (parallel Playwright workers,
default 2 so a run does not max out a laptop; raise it on a bigger machine),
`YEET_E2E_KEEP=1` (keep the temp directory with the R2 state and print its path).

Agents (and humans) iterate with `npm run verify:fast` and subsets
(`--grep`, `--project`, one file), and run the full strict `npm run verify`
once at the end. Never run several harness instances at the same time.

## Output

Playwright's `list` reporter shows progress; at the end a summary prints one line
per test, grouped per project:

```
chromium: 4/4 passed
  PASS    1.4s  tests/browser/download.spec.ts › download page › Download saves the exact file under its name
...
Overall: PASSED — 46 passed, 0 failed, 0 flaky, 0 skipped, 0 expected failure of 46 in 15.0s
```

Machine-readable results of the latest run go to `results/summary.json`
(gitignored; overwritten by every run, and never touched by a run refused with
exit 2):

```jsonc
{
  "status": "passed", // passed | failed | incomplete | interrupted | error
  "totals": { "total": 46, "passed": 46, "failed": 0, "skipped": 0, "flaky": 0, "expectedFailure": 0 },
  "projects": { "node": { ... }, "chromium": { ... }, "webkit": { ... }, "firefox": { ... } },
  "tests": [{ "project", "file", "title", "tags", "outcome", "durationMs", "attempts", "error?" }],
  "args": ["--project=webkit"],          // what was passed after -- (minus --allow-skips)
  "strict": true,                        // false with --allow-skips
  "harness": { "timingsMs": { "prepare", "build CLI", "start wrangler dev", "tests" }, "totalMs" }
}
```

- `passed` means every selected test ran and passed on its first attempt.
- `incomplete`: nothing failed, but at least one selected test was skipped or is
  an expected failure (`test.fail()`). Exit 1 in strict mode (the default), 0
  with `--allow-skips`. Never a pass.
- `failed`: a test failed or was flaky, or no test matched the filters
  (Playwright reports "No tests found" as a failure).
- Retries are off. If you pass `--retries`, a test that passes only on a retry is
  reported as `flaky` and fails the run (`failOnFlakyTests`).
- `error`: the harness itself failed (e.g. wrangler did not start); see `error`.
- Tests excluded by `--grep`/`--project` are absent from the summary, not skipped.

Other files in `results/`: `wrangler.log` (the server's output for the last run,
one line per request) and `test-output/` (screenshot and trace of each failed
test; open a trace with `npx playwright show-trace <path>`).

## Writing a test

Put tests that need no browser in `tests/node/`, browser (page) tests in
`tests/browser/` (they run once per engine). Import everything from `lib/`:

```ts
import { cliUpload, expect, randomFile, sha256, test, KiB } from "../../lib/index.js";

test("a file survives the round trip", async ({ page, tmp }) => {
  const file = await randomFile(tmp, 256 * KiB, "notes.bin");
  const { url } = await cliUpload(file.path, ["--expires", "1d"]);

  await page.goto(url);
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Download" }).click(),
  ]);
  expect(await sha256(await download.path())).toBe(file.sha256);
});
```

Rules of thumb:

- Every test creates its own uploads; never rely on what another test made. The
  bucket is shared by all tests of a run (and empty at its start).
- Use the `tmp` fixture for files; it is removed after the test, and the run's
  temp root after the run. Delete large files as soon as you have their hash.
- The Worker's cleanup only runs when a test triggers it (`cronUntil()` or
  `triggerCron()`), and it deletes every expired upload it reaches. Wrap any
  test that triggers the cron, or needs an expired upload to stay in the
  bucket for a while, in `exclusive("cron", async () => …)` (see
  `tests/node/cron.spec.ts`), and give uploads in other tests expiries of
  minutes or more. The cleanup also deletes legacy `.downloads/` records and
  adds the summary custom metadata to sidecars without one, so a test that
  seeds or inspects either holds the same lock. A cron run handles one
  bounded slice of the bucket (about 50 uploads, at most 3 summaries, and
  of an upload with more keys than that, the ones it saw), and the test
  bucket is shared by every test of the run, so one run rarely gets
  through it: wait for an effect with `cronUntil(check)`, which triggers
  runs until `check` holds, rather than one `triggerCron()` and
  `eventually()`. Sidecars the cron cannot read, or whose summary is too
  large, never get one, so leave none behind; `docs/design/api.md` has the
  details. A `DELETE /api/uploads/:id` deletes at most 100 objects and
  answers `202` while more is left: delete a test upload with more (part
  or legacy records) with `deleteUploadFully()`.
- Likewise `GET /api/uploads` answers one page (about 50 uploads under
  `wrangler dev`, which returns at most 100 objects per list call);
  `listUploads()` follows the cursors and returns all of them.
- CPU is what limits a request and a cron run on the Free plan (measured,
  see "Measurements (phase 1H)" and "(phase 1J)" in `docs/design/api.md`),
  and `wrangler dev`
  enforces no limit. As a stand-in, the work of one `GET /api/uploads` page
  and one cron run (objects listed, list calls, reads, R2 calls) is asserted
  on the Worker's modules with in-memory buckets
  (`tests/node/r2-work-bounds.spec.ts`, with the 415 objects per list call
  real R2 returned: `REAL_R2_CAPS` in `lib/strict-r2.ts`). `lib/fake-r2.ts`
  counts R2 calls, returns at most 100 objects per list call with metadata
  and throws past 50 calls (`tests/node/r2-budget.spec.ts`).
  `lib/strict-r2.ts` is a second, stricter one, written independently by a
  verifier: random short and empty pages from a seeded generator, opaque
  cursors, a configurable number of objects per list call, a count of the
  objects lists return, hooks to change the bucket during a run
  (`tests/node/r2-adversarial.spec.ts`, `r2-adversarial-1g.spec.ts`,
  `r2-orphans.spec.ts`, `r2-work-bounds.spec.ts`, `r2-capacity.spec.ts`,
  whose figures are quoted in `docs/design/api.md`).
- Opening the page of an expired upload deletes it, so do not visit an upload
  whose removal by the cron you want to observe.
- Tag slow tests with `{ tag: "@slow" }` so `verify:fast` can skip them.
- The Worker rate-limits failures (wrong login tokens, download passwords,
  bearer tokens) per client IP, taken from `CF-Connecting-IP`, which
  `wrangler dev` passes through. A test that makes failed attempts sends its
  own `clientIp()`; browser tests get a unique one automatically. Requests
  without the header all count as 127.0.0.1. IPv6 addresses count per /64.
- A test that needs a differently configured server (another token, a short
  token, `SENTRY_DSN`) starts its own with `startServer()` and stops it in a
  `finally`.

## Helper API (`lib/`)

All exported from `lib/index.ts`.

### Server — `env.ts`

`server.baseURL` (e.g. `http://127.0.0.1:53123`), `server.token`,
`server.tmpRoot`, `server.persistDir`, `server.workerDir`, `server.cliPath`,
`server.wranglerLog`, `server.bucketName` (`yeet`), `server.uploadsPrefix`
(`uploads`). Reading any of them outside `npm run verify` throws an explanatory error.

### CLI — `cli.ts`

- `cli(args, { stdin?, env?, configHome?, auth?, timeoutMs?, cwd?, stubs? })` →
  `{ code, signal, stdout, stderr, configHome, configPath, durationMs }`.
  Runs `node packages/cli/dist/index.js …args`. `HOME` and `XDG_CONFIG_HOME`
  point to a fresh temp directory (or `configHome`, to keep state between calls),
  inherited `YEET_*` variables are removed, stdin is `stdin` or empty (so
  `login` reads the token from it). `auth: true` sets `YEET_URL`/`YEET_TOKEN` for
  the test server. `env: { X: undefined }` removes a variable. `FORCE_COLOR` is
  dropped and `NO_COLOR=1` set, so output is plain.
- `expectExitCode(result, code)`: asserts the exit code; a failure shows the
  expected and received code plus the command's stdout and stderr.
  `describeRun(result)` gives that dump for your own assertion messages.
- `cliUpload(file, args?, opts?)` → `{ url, id, result }`; runs `yeet upload`
  with `auth: true` and fails unless it exits 0 with exactly one URL on stdout
  ("stdout was not exactly one URL: …").
- `newConfigHome()` → a fresh empty config home.
- `spawnCli(args, options)`: start the CLI yourself (e.g. to send it SIGINT). Every CLI
  child (also from `cli()`) runs in its own process group and is SIGKILLed when its test
  ends (the automatic `reapClis` fixture) or the worker exits, so none outlives a timed-out
  or failed test.
- `stubs: true` (or `--import CLI_PRELOAD` before the CLI path with `spawnCli`) loads
  `lib/cli-preload.mjs` into the CLI, whose stubs `YEET_STUB_*` variables in `env` turn on:
  `YEET_STUB_FREE_BYTES=<n>` makes `fs.statfs` report n free bytes, and
  `YEET_STUB_SLOW_READ_MS=<ms>` delays each read of a file named `slow*` (so zipping can be
  interrupted), and `YEET_STUB_ENOSPC_AFTER=<n>` makes writes to the temporary
  `upload.zip` fail with `ENOSPC` after n bytes. The CLI's own test hooks: `YEET_TEST_MAX_UNSIZED_PARTS` lowers its 150-part
  cap for zips of unknown size, `YEET_TEST_ZIP_SIZE_BOUND` replaces its worst-case zip size.

### Stand-in server — `stand-in.ts`

- `standIn(partSize, onRequest?)`: a local stand-in for the upload API that records every
  request (`requests`, `puts()`, `create()`, `creates()`, `completes()`, `deletes()`,
  `zip()` for the parts in order) and answers like the Worker with any part size, so a few
  KB take hundreds of parts. `onRequest` may act on a request and return a status to send
  instead, or `"hold"` to never answer. Uploads are named `up1`, `up2`, … Pass `env` to
  `cli()`. Used by `tests/node/cli-zip*.spec.ts`.

### Zip — `zip/`

The streaming zip writer's tests (`tests/node/zip-*.spec.ts`, `tests/browser/zip-runtime.spec.ts`)
use `zip/`: `check.py` (the structural oracle, kept verbatim), `parse.ts`, `validate.ts`
(every local reader), `module.ts` (the module under test; `YEET_ZIP_MODULE` points it at
another copy), `fixtures.ts`. Opt-in tools there: `mutate.mjs`, `readers.ts`,
`archive-utility.ts`, `bench/`; see "Reproduce" in `docs/design/zip.md`. The zip specs also run
outside `npm run verify` (`npx playwright test --project=node tests/node/zip-format.spec.ts`).

### HTTP — `api.ts`

- `api(path, init?)` → `Response`: fetch with `Authorization: Bearer <token>`;
  `path` is from the origin (`api("/api/uploads")`). `init.token`: `null` sends
  no token, a string sends that one; `init.ip` sets `CF-Connecting-IP`;
  `init.baseURL` targets another server.
- `clientIp()` → a random 10.x.x.x address for `CF-Connecting-IP`.
- `postLogin(token, { ip?, baseURL?, headers? })` → the raw `POST /login`
  response, sent like a same-origin form (Origin, `Sec-Fetch-Site: same-origin`).
  `loginCookie(opts?)` → the `yeet_session=…` pair; `cookiePair(setCookie)`.
- `sessionFetch(path, cookie, init?)`: fetch as the logged-in page would
  (cookie, Origin, `Sec-Fetch-Site`); `init.headers` overrides or removes
  (`undefined`) headers.
- `apiJson(path, init?)`: parsed JSON, throws on non-2xx; sets the JSON content
  type for string bodies.
- `listUploads({ maxPages? })`: every finished upload, following the pages of
  `GET /api/uploads` (type `UploadsPage` for one page); `deleteUpload(id)`,
  `idFromUrl(shareUrl)`.
- `uploadViaApi({ filename, data, expiresInSeconds?, password? })` → `{ id, url }`:
  uploads like the CLI does but with expiry in seconds (the CLI's minimum is 1 minute).
- `startUpload({ filename, size, expiresInSeconds? })` → id of an upload left
  pending (POST /api/uploads only, real R2 multipart upload).
- `submitDownloadForm(shareUrl, password?, { ip?, cookie? })` → the raw
  303/401/404/429 response. Without `password` the form has no password field.
- `signedDownloadUrl(shareUrl, password?)` → the `/_dl/<id>?expires=&sig=` link.
- `downloadBytes(shareUrl, password?)` → `Buffer`; `downloadSha256(shareUrl,
password?)` → `{ sha256, size }`, streaming, for large files.
- `forgeDownloadUrl(id, expires)` → a `/_dl` link correctly signed with the test
  token for any expiry, e.g. beyond the file's own (the server clamps the links
  it hands out). Mirrors `signDownload()` in `packages/worker/src/crypto.ts`.

### Bucket and cron — `bucket.ts`

These talk to wrangler's Local Explorer API
(`<baseURL>/cdn-cgi/local/explorer/api/r2/...`), bypassing the Worker.

- `listObjects(prefix?)`, `uploadObjects(id)` → `{ key, size, etag, http_metadata, custom_metadata }[]`
  (the explorer's listing leaves both metadata fields empty; `headObject(key)` returns them).
- `putObject(key, body, { contentType?, customMetadata?, baseURL? })`,
  `getObject(key, { baseURL? })`, `headObject(key, { baseURL? })`
  (`baseURL`: another server's bucket, see `servers.ts`).
- `seedLegacyUpload({ filename, data, id?, meta?, contentType? })` →
  `{ id, url, meta }`: an upload as yeet < 0.2 / rclone left it — the file plus
  `.meta.json`, neither with R2 custom metadata. `meta` overrides fields of the
  sidecar (e.g. `expires_at` in the past, `password_hash`).
- `readUploadMeta(id)` → the parsed `.meta.json` (or null);
  `writeUploadMeta(id, meta, { withSummary = true })` overwrites it, with the
  `summary` custom metadata the Worker's `writeMeta()` sets, or without it
  (`withSummary: false`, like an old sidecar). `summarize(meta)` mirrors
  `summarize()` in `packages/worker/src/uploads.ts`; keep the copies in sync.
- `randomId()` → a 6-character upload ID.
- `triggerCron(cron = "0 * * * *")`: calls `/__scheduled`, which starts one run.
  The cleanup runs in `waitUntil()`, so poll for its effect.
- `cronUntil(check, { message?, maxRuns = CRON_RUNS, perRunMs = 1500 })` → the
  runs it took: triggers a run, polls `check` for up to `perRunMs`, and triggers
  the next until `check` holds (one run handles one slice of the shared bucket).
  `CRON_RUNS` is 80 at a `CLEANUP_LIST_LIMIT` of 100 (40 at round 1I's 200)
  and grows if the limit is lowered; `CRON_TEST_TIMEOUT_MS` is a test timeout
  with room for that many (150 s at 80 runs).

### Fixtures — `fixtures.ts`

- `randomFile(dir, size, name?)` → `{ path, name, size, sha256 }`, streamed, so
  `randomFile(tmp, 120 * MiB)` is fine. `KiB` and `MiB` are exported.
- `silentWavFile(dir, seconds, { name?, sampleRate?, channels? })`: 16-bit PCM WAV,
  digital silence with a 50 ms 440 Hz beep every second.
- `fileWith(dir, name, content)`: a file with given text or bytes.
- `FILENAMES.spaces`, `FILENAMES.unicode` (accents, CJK, emoji, en dash),
  `FILENAMES.punctuation` (`'()#&%!`).
- `sha256(pathOrBytes)` → hex digest.

### Extra servers — `servers.ts`

- `startServer({ token, persistDir?, vars? })` → `{ baseURL, token, persistDir,
logPath, stop() }`: another `wrangler dev` of the Worker, with its own ports,
  `UPLOAD_TOKEN` and vars (`SENTRY_DSN` empty unless given). Pass the
  `persistDir` of a stopped instance to restart on the same bucket, e.g. with
  a rotated token. Takes a few seconds to start.
- Each instance runs in its own process group, registered in
  `<tmpRoot>/extra-servers/`; `verify` stops whatever is still running there on
  teardown, and a later run does so for a killed one, like its own wrangler.
- `putObject(key, body, { baseURL })` seeds another server's bucket.

### Upload page — `browser.ts`

- `logIn(page)`: logs in through the real form on `/upload` (field `token`),
  then waits until the page script is ready ("Choose file" enabled).
- `dropFile(page, path)`: drops a file on the drop zone with a synthetic
  `DragEvent` whose `DataTransfer` holds a real `File` (taken from a helper file
  input, so large files are not copied through the protocol).
- `instrumentUploadPage(page)` (before `goto`), `pageStats(page)`,
  `resetStats(page)`: every value of the progress bar, and the main thread's
  worst lateness on a 10 ms `setInterval`.
- `shareLink(page, timeout?)`: waits for the done state and returns the link.
- `dropFiles(page, paths)`: drops several files at once (round 2C+2).
- `dropTree(page, nodes)`, `treeOf(dir)`: drops files and folders. No test can make a
  browser drop a real folder, so the drop carries stand-ins for the browser's
  `webkitGetAsEntry()` entries (`file()`, `createReader().readEntries()` in batches,
  Chromium's `getMetadata()`) around real `File`s: files on disk (backed by the file, so a
  rename makes their reads fail) or made in the page (`text`, e.g. names that cannot exist
  side by side on a case-insensitive disk). `treeOf(dir)` gives a folder on disk as Finder
  drops it, `.DS_Store` included.
- Folders can also be picked: `page.locator("#folder-input").setInputFiles(dir)` (a
  `webkitdirectory` input) works in all three engines; it reports no empty folders.
- The page's test hook `window.__yeetE2E = { maxUnsizedParts: n }` (set with
  `page.addInitScript()` before `goto`) lowers its limit for zips of unknown size, so
  `tests/browser/upload-zip.spec.ts` reaches the forced store with 51 MiB instead of 8 GB.

The upload runs in a Web Worker. In Playwright 1.63, `page.route()`,
`page.waitForRequest/Response()` and `context.on("request")` all see that
worker's requests in Chromium, WebKit and Firefox; the failure tests inject
errors with `page.route()`. Exception: while any route is active, Playwright's
WebKit cancels a `keepalive` fetch sent from `pagehide`, so the "leaving the
page" test uses no route.

Losing access to the picked file (as iOS does when the screen locks) is
simulated by renaming the file away on disk while a part is held, then
aborting that part (`tests/browser/upload-resume.spec.ts`): Playwright gives
the page a `File` backed by the path in all three engines, so its reads then
fail (WebKit and Chromium `NotFoundError`, Firefox `AbortError`).
`tests/browser/screenshots.spec.ts` saves every page state at desktop and
phone width to `e2e/screenshots/2c/<engine>/` (git-ignored) for review.

### Utilities — `util.ts`

`eventually(check, { timeoutMs?, intervalMs?, message? })` polls until `check`
returns a truthy value; `exclusive(name, fn, { timeoutMs? })` runs `fn` under a
lock shared by all workers of the run (waiting for it up to `CRON_TEST_TIMEOUT_MS`
by default); `sleep(ms)`; `makeTempDir(prefix?)`; `serverLog()`
returns wrangler's output so far (e.g. to count `PUT …/parts/N` requests).

## Known limits

- Playwright's WebKit is not Safari, and certainly not iOS Safari: it is the
  WebKit engine in Playwright's own shell on macOS. Download behaviour, file
  naming and the share sheet on iPhone are not covered.
  Likewise Chromium/Firefox are Playwright's builds, headless.
- WebKit on macOS reports download filenames in Unicode NFD (decomposed); compare
  names after `.normalize("NFC")`.
- Tests run against `wrangler dev`'s local simulation (workerd + local R2), not
  real R2: no free-plan CPU limit, no 100 MB request body limit, no real
  multipart edge cases, and timings are much faster than production.
- The Local Explorer API used by `bucket.ts` is a recent `wrangler dev` feature
  (present in wrangler 4.148). If it disappears, seed objects with
  `npx wrangler r2 object put "yeet/<key>" --file <f> --local --persist-to <server.persistDir>`
  from `packages/worker` instead.
- The cron is triggered through wrangler's `/__scheduled` test route; the real
  Cron Trigger schedule (`0 * * * *`, hourly) is not exercised.
- Recent npm (12 here) blocks dependency install scripts by default (esbuild, workerd); the harness works without
  them because their platform binaries come from optional dependencies.
