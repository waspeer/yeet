# yeet end-to-end tests

One command checks the whole product locally: the built CLI, the Worker under
`wrangler dev` with a local R2 bucket, and the download page in Chromium, WebKit
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
   - a free `--inspector-port`, so parallel runs do not collide on 9229.
4. Runs `playwright test`, passing through any arguments after `--`.
5. Tears down — also on test failure, Ctrl-C or SIGTERM: kills wrangler's whole
   process group (wrangler, workerd, esbuild) and deletes the temp directory.

Exit code: 0 if everything selected passed (or was skipped), 1 on any failure or
harness error, 130 when interrupted.

### Filtering

Arguments after `--` go to Playwright:

```sh
npm run verify -- --project=webkit          # download page tests in WebKit only
npm run verify -- --project=node            # CLI, HTTP and cron tests only
npm run verify -- --grep "password"         # by title, across all projects
npm run verify -- --grep-invert @slow       # skip the 120 MB upload (= npm run verify:fast)
npm run verify -- tests/node/http.spec.ts   # one file
```

Projects:

| project    | tests             | runs                                                    |
| ---------- | ----------------- | ------------------------------------------------------- |
| `node`     | `tests/node/*`    | CLI, HTTP and cron tests; no browser, once per run      |
| `chromium` | `tests/browser/*` | download page in Playwright's Chromium (Desktop Chrome) |
| `webkit`   | `tests/browser/*` | download page in Playwright's WebKit (Desktop Safari)   |
| `firefox`  | `tests/browser/*` | download page in Playwright's Firefox (Desktop Firefox) |

Environment knobs: `YEET_E2E_WORKERS=<n>` (parallel workers, default 4),
`YEET_E2E_KEEP=1` (keep the temp directory with the R2 state and print its path).

## Output

Playwright's `list` reporter shows progress; at the end a summary prints one line
per test, grouped per project:

```
chromium: 4/4 passed
  PASS    1.4s  tests/browser/download.spec.ts › download page › Download saves the exact file under its name
...
Overall: PASSED — 23 passed, 0 failed, 0 flaky, 0 skipped of 23 in 15.0s
```

Machine-readable results go to `results/summary.json` (gitignored):

```jsonc
{
  "status": "passed", // passed | failed | incomplete | interrupted | error
  "totals": { "total": 23, "passed": 23, "failed": 0, "skipped": 0, "flaky": 0 },
  "projects": { "node": { ... }, "chromium": { ... }, "webkit": { ... }, "firefox": { ... } },
  "tests": [{ "project", "file", "title", "tags", "outcome", "durationMs", "attempts", "error?" }],
  "args": ["--project=webkit"],          // what was passed after --
  "harness": { "timingsMs": { "prepare", "build CLI", "start wrangler dev", "tests" }, "totalMs" }
}
```

- `passed` means every selected test ran and passed on its first attempt.
- `incomplete`: nothing failed, but something was skipped (or no test matched).
  The exit code is 0; read the status, do not treat it as a pass.
- Retries are off. If you pass `--retries`, a test that passes only on a retry is
  reported as `flaky` and fails the run (`failOnFlakyTests`).
- `error`: the harness itself failed (e.g. wrangler did not start); see `error`.
- Tests excluded by `--grep`/`--project` are absent from the summary, not skipped.

Other files in `results/`: `wrangler.log` (the server's output for the last run,
one line per request) and `test-output/` (screenshot and trace of each failed
test; open a trace with `npx playwright show-trace <path>`).

## Writing a test

Put tests that need no browser in `tests/node/`, download page tests in
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
- The Worker's cleanup only runs when a test calls `triggerCron()`, and it deletes
  every expired upload. Wrap any test that triggers the cron, or needs an expired
  upload to stay in the bucket for a while, in `exclusive("cron", async () => …)`
  (see `tests/node/cron.spec.ts`), and give uploads in other tests expiries of
  minutes or more.
- Opening the page of an expired upload deletes it, so do not visit an upload
  whose removal by the cron you want to observe.
- Tag slow tests with `{ tag: "@slow" }` so `verify:fast` can skip them.

## Helper API (`lib/`)

All exported from `lib/index.ts`.

### Server — `env.ts`

`server.baseURL` (e.g. `http://127.0.0.1:53123`), `server.token`,
`server.tmpRoot`, `server.persistDir`, `server.workerDir`, `server.cliPath`,
`server.wranglerLog`, `server.bucketName` (`yeet`), `server.uploadsPrefix`
(`uploads`). Reading any of them outside `npm run verify` throws an explanatory error.

### CLI — `cli.ts`

- `cli(args, { stdin?, env?, configHome?, auth?, timeoutMs?, cwd? })` →
  `{ code, signal, stdout, stderr, configHome, configPath, durationMs }`.
  Runs `node packages/cli/dist/index.js …args`. `HOME` and `XDG_CONFIG_HOME`
  point to a fresh temp directory (or `configHome`, to keep state between calls),
  inherited `YEET_*` variables are removed, stdin is `stdin` or empty (so
  `login` reads the token from it). `auth: true` sets `YEET_URL`/`YEET_TOKEN` for
  the test server. `env: { X: undefined }` removes a variable.
- `cliUpload(file, args?, opts?)` → `{ url, id, result }`; runs `yeet upload`
  with `auth: true` and throws unless it exits 0 with exactly one line on stdout.
- `newConfigHome()` → a fresh empty config home.

### HTTP — `api.ts`

- `api(path, init?)` → `Response`: fetch with `Authorization: Bearer <token>`;
  `path` is from the origin (`api("/api/uploads")`). `init.token`: `null` sends
  no token, a string sends that one.
- `apiJson(path, init?)`: parsed JSON, throws on non-2xx; sets the JSON content
  type for string bodies.
- `listUploads()`, `deleteUpload(id)`, `idFromUrl(shareUrl)`.
- `uploadViaApi({ filename, data, expiresInSeconds?, password? })` → `{ id, url }`:
  uploads like the CLI does but with expiry in seconds (the CLI's minimum is 1 minute).
- `submitDownloadForm(shareUrl, password?)` → the raw 303/401/404 response.
- `signedDownloadUrl(shareUrl, password?)` → the `/_dl/<id>?expires=&sig=` link.
- `downloadBytes(shareUrl, password?)` → `Buffer`; `downloadSha256(shareUrl,
password?)` → `{ sha256, size }`, streaming, for large files.

### Bucket and cron — `bucket.ts`

These talk to wrangler's Local Explorer API
(`<baseURL>/cdn-cgi/local/explorer/api/r2/...`), bypassing the Worker.

- `listObjects(prefix?)`, `uploadObjects(id)` → `{ key, size, etag, http_metadata, custom_metadata }[]`.
- `putObject(key, body, { contentType?, customMetadata? })`, `getObject(key)`.
- `seedLegacyUpload({ filename, data, id?, meta?, contentType? })` →
  `{ id, url, meta }`: an upload as yeet < 0.2 / rclone left it — the file plus
  `.meta.json`, neither with R2 custom metadata. `meta` overrides fields of the
  sidecar (e.g. `expires_at` in the past, `password_hash`).
- `randomId()` → a 6-character upload ID.
- `triggerCron(cron = "0 3 * * *")`: calls `/__scheduled`. The cleanup runs in
  `waitUntil()`, so poll for its effect with `eventually()`.

### Fixtures — `fixtures.ts`

- `randomFile(dir, size, name?)` → `{ path, name, size, sha256 }`, streamed, so
  `randomFile(tmp, 120 * MiB)` is fine. `KiB` and `MiB` are exported.
- `silentWavFile(dir, seconds, { name?, sampleRate?, channels? })`: 16-bit PCM WAV,
  digital silence with a 50 ms 440 Hz beep every second.
- `fileWith(dir, name, content)`: a file with given text or bytes.
- `FILENAMES.spaces`, `FILENAMES.unicode` (accents, CJK, emoji, en dash),
  `FILENAMES.punctuation` (`'()#&%!`).
- `sha256(pathOrBytes)` → hex digest.

### Utilities — `util.ts`

`eventually(check, { timeoutMs?, intervalMs?, message? })` polls until `check`
returns a truthy value; `exclusive(name, fn, { timeoutMs? })` runs `fn` under a
lock shared by all workers of the run; `sleep(ms)`; `makeTempDir(prefix?)`; `serverLog()`
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
  Cron Trigger schedule (`0 3 * * *`) is not exercised.
- Recent npm (12 here) blocks dependency install scripts by default (esbuild, workerd); the harness works without
  them because their platform binaries come from optional dependencies.
