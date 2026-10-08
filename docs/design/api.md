# HTTP API contract (phase 1)

This is the contract between the Worker (`packages/worker`), the CLI
(`packages/cli`) and the browser upload page. Changes to it are deliberate and
recorded here first. Behaviour not mentioned stays as in
`packages/worker/src/index.ts` at the start of phase 1.

## Hard constraints

- **CPU:** every request stays within **10 ms CPU** on Workers Free with
  `SENTRY_DSN` unset. This is measured on a real deploy, not with
  `wrangler dev`, which does not enforce limits.
- **Subrequests:** at most 50 per request, R2 calls included.
- **Request bodies:** at most 100 MB.
- **The `UPLOAD_TOKEN` never reaches the browser.** It must not appear in HTML,
  in JS, in browser storage, in cookies (only values derived from it via HMAC
  may), or in any request the page makes. The page authenticates with a
  session cookie.

## Keys derived from `UPLOAD_TOKEN`

All signing keys are HMAC-SHA256 keys derived from the token with a fixed label:
`key(label) = SHA-256("yeet-" + label + ":" + UPLOAD_TOKEN)`.

| Label      | Signs                                        |
| ---------- | -------------------------------------------- |
| `download` | Signed `/_dl/:id` links (existing behaviour) |
| `session`  | Browser session cookies                      |
| `dlpass`   | Download-pass cookies (after a password)     |

Changing `UPLOAD_TOKEN` invalidates all sessions, download passes and open
download links at once.

## Token requirements

- `UPLOAD_TOKEN` must be **at least 16 characters**.
- If it is missing or shorter, every route needing it (`/api/*`, `/login`,
  `/upload`, password downloads) refuses with a clear message:
  - **API:** `500 {"error": "UPLOAD_TOKEN must be set and at least 16 characters long"}`.
  - **Pages:** an HTML error page with the same message.
- Public download pages for unprotected files keep working.

## Authentication

There are two ways in. `/api/*` accepts either:

1. **Bearer token (CLI):** `Authorization: Bearer <UPLOAD_TOKEN>`. It must match
   exactly, compared in constant time. No cookie or Origin checks apply.
2. **Session cookie (browser):** `yeet_session`.
   - **Unsafe methods** (`POST`, `PUT`, `PATCH`, `DELETE`) also require an
     `Origin` header equal to the request's origin. Without one, or if it
     differs, the server answers `403 {"error": "Cross-origin request refused"}`.
   - **`Sec-Fetch-Site`:** if present, it must be `same-origin`, otherwise the
     same 403.

If neither is valid: `401 {"error": "Invalid upload token"}`. This message
stays the same as today; the CLI and the tests depend on it.

### Session cookie

- **Name:** `yeet_session`.
- **Value:** `v1.<expiresUnixSeconds>.<base64url(HMAC(key("session"), "session:v1:" + expires))>`.
- **Attributes:**
  - `HttpOnly; SameSite=Strict; Path=/; Max-Age=7776000` (90 days).
  - Plus `Secure` when the request URL is `https:`. It is omitted on
    `http://localhost` so local development and tests work in WebKit.
- **Valid when:** the signature verifies (constant time) and the expiry is in
  the future.
- **Revoking:** the cookie is self-contained; the server keeps no list of
  sessions. A copied cookie (from another device, a backup or malware) works
  for up to 90 days from its login, and logging out only clears it in the
  browser that logs out. Only changing `UPLOAD_TOKEN` revokes sessions, and
  then all of them (with every download pass and open download link).

### Routes

- `GET /upload`
  - **Without a valid session:** a login form.
  - **With a valid session:** the upload UI.
  - **Always:** `Cache-Control: no-store`.
- `POST /login` (form field `token`, from `/upload`). Same Origin rule as
  unsafe API calls.
  - **Correct token:** set the session cookie, then `303` to `/upload`.
  - **Wrong token:** `401` with the login form and the error "That token is not
    correct."
  - **Rate-limited:** `429` with a `Retry-After` header and the login form plus
    "Too many attempts. Try again in N seconds."
- `POST /logout`: clears the cookie (`Max-Age=0`), then `303` to `/upload`.
  Same Origin rule.

## Rate limiting

| What                                             | Limit                                                   | Key            |
| ------------------------------------------------ | ------------------------------------------------------- | -------------- |
| Failed `POST /login`                             | 5 per minute                                            | client IP      |
| Wrong download passwords on `POST /:id/download` | 5 per minute per upload                                 | client IP + id |
| Failed Bearer auth on `/api/*`                   | 20 per minute (protects the token from online guessing) | client IP      |

- **When exceeded:** `429` with `Retry-After`. Pages show a readable message;
  the API returns `{"error": "Too many attempts, retry in N s"}`.
- **What counts:** only failures. Successful requests never count.
- **Mechanism:** free-plan only. The implementer evaluates the Workers Rate
  Limiting binding, the Cache API and Durable Objects on the free plan, and
  records the choice and its trade-offs (per-colo vs global, accuracy, CPU
  and subrequest cost) in this file.

## Download passwords

- **Storage:** the stored hash format stays `pbkdf2-sha256$<iterations>$<salt>$<hash>`.
  The iteration count lives in the hash, so changing it never breaks
  existing links.
- **Iterations: 20,000** (lowered from 50,000 in phase 1, after measuring).
  - **Measured** on Workers Free (test account, `wrangler tail`):
    - with 50,000 iterations, a password check costs 13 ms CPU median and
      20 ms at p90, against 2 ms without a password;
    - Sentry loading lazily and the download pass did not change that path.
  - **Expected:** at roughly 0.2–0.4 ms per 1,000 iterations, 20,000 brings
    p90 to about 10 ms. To be confirmed by the next measurement.
  - **Trade-off:** a stolen bucket's hashes are 2.5× cheaper to brute-force.
    Online guessing stays capped at 5 wrong passwords per minute per IP per
    upload, parallel requests included: each attempt is counted before its
    password is hashed (see "Check before reveal" below).
  - **Old links:** hashes with any other iteration count still verify.
- **Download pass:** after a correct password, the response also sets
  `yeet_dl_<id>`:
  - **Value:** `<expires>.<base64url(HMAC(key("dlpass"), id + ":" + expires))>`.
  - **Attributes:** `HttpOnly; SameSite=Lax; Path=/<id>`, plus `Secure` on
    https. `Max-Age` is the shorter of 24 h and the time until the file
    expires.
  - **Effect:** while it is valid, `GET /:id/:filename` shows the Download
    button without a password field, and `POST /:id/download` skips the
    password check.
- **Iterations:** lowering them is a last resort. First measure CPU again with
  Sentry loading only when `SENTRY_DSN` is set, and with the download pass in
  place. If lowering is still needed, record the new count and the measured
  reason here, together with the rate limit.

## Upload API changes

- **`POST /api/uploads`** `{ filename, size?, expires_in, password? }` →
  `201 { id, part_size }`.
  - `size` is optional. If given, it must be a safe non-negative integer.
  - `expires_in` must be whole seconds from 1 to 31,536,000 (365 days).
    Anything else (0, negative, a fraction, a string, more than a year such
    as `1e308`) is `400 {"error": "Invalid expires_in: whole seconds from 1 to 31536000 (365 days)"}`,
    checked before anything is created in the bucket. Before, a huge value
    passed the check and failed with a 500 after `createMultipartUpload`,
    leaving a multipart upload no sidecar pointed to, which the cleanup never
    saw. The CLI refuses `--expires` (and `YEET_DEFAULT_EXPIRES`) above
    `365d` itself; the upload page always asks for 30 days.
  - `part_size` stays 52,428,800 (50 MiB).
- **`PUT /api/uploads/:id/parts/:n`**
  - **Required:** a `Content-Length` header (`411` without it).
  - **Too large:** `Content-Length` above `part_size` gives
    `413 {"error": "Part larger than part_size"}`.
  - **Order:** R2 requires every part except the last to be exactly
    `part_size`. The server checks this as early as it can. A client that sends
    a short part and then a higher-numbered part gets a clear `400` at the
    latest at `complete`, never R2's opaque error.
- **`POST /api/uploads/:id/complete`** `{ parts, size? }`.
  - **Validated before completing:** the parts array (shape, numbers 1..n,
    no duplicates, etags are strings).
  - **Stored size:** `file_size` comes from R2's `object.size` after the
    upload completes.
  - **Mismatch:** if the client sent `size` (at create or at complete) and it
    differs from `object.size`, the upload is deleted and the server answers
    `422` with both numbers.
- **Pending uploads:** they are never listed, and their pages return 404. This
  is unchanged.

## Sentry

Sentry is only initialised, and its wrapper only used, when `SENTRY_DSN` is
set. Without it, requests do not pay any Sentry CPU cost.

## Unchanged

Download links (`/_dl/:id`, Range support), the bucket layout and the
custom-metadata summary, and `DELETE /api/uploads/:id` (beyond the auth
changes above). `GET /api/uploads` and the cleanup keep their behaviour, but
within a fixed number of R2 calls; for a bucket too large for that,
`GET /api/uploads` adds `"truncated": true` (see "Listing within a fixed
number of R2 calls" below).

## Implementation notes

Recorded while implementing phase 1A. They clarify the contract above; where
they add behaviour, the contract did not say otherwise.

### Rate-limit mechanism: a Durable Object per key

Evaluated on the Free plan:

- **Workers Rate Limiting binding** (`ratelimits`). Counters are local to each
  Cloudflare location and "eventually consistent, and intentionally designed to
  not be used as an accurate accounting system"; the period can only be 10 or
  60 s. `limit()` always increments, and there is no way to read a counter
  without incrementing it. So it cannot both count only failures and check
  every attempt (including correct ones) before revealing the result. Without
  that check a client over the limit still learns when a guess is right, and
  the limit protects nothing. The Deploy button documentation also does not
  list it among the resources it provisions.
- **Cache API.** Does nothing on `*.workers.dev`, where Erik's Worker lives
  (it only works on custom domains), is per data centre, and has no atomic
  increment. Ruled out.
- **Durable Objects (SQLite-backed).** Available on Free (100,000 requests,
  100,000 rows written and 5 million rows read per day). One object per key is
  global and strongly consistent, so counts are exact. It supports
  check-then-count, works in `wrangler dev` (the e2e tests exercise it), and
  the Deploy button provisions Durable Objects from `wrangler.jsonc` (binding
  plus a `new_sqlite_classes` migration; nothing to create by hand).

**Chosen: Durable Objects** (`packages/worker/src/rate-limit.ts`, class
`RateLimiter`, binding `RATE_LIMITER`).

- **Keys:** `login:<ip>`, `dlpw:<ip>:<id>`, `bearer:<ip>`, with
  `ip = CF-Connecting-IP` (`unknown` if absent). Each key gets its own object,
  created near the client that first used it.
  - **IPv6 by /64** (`rateLimitClient()` in `parse.ts`): an IPv6 address
    counts by its first 64 bits (`2001:db8:1:2::/64`), since one client
    usually has a whole /64 and could otherwise use a new address, and a new
    budget, for every attempt. IPv4 addresses (also IPv4-mapped ones) count
    as they are; anything unparsable is used as is.
  - **Known limits:** keys are per client address, so a client with many
    addresses (several /64s, a botnet) gets a budget per address, and
    clients behind one address (a carrier-grade NAT, an office) share one: a
    guesser there can make the others wait out a minute. The 16-character
    token minimum is the protection that does not depend on addresses.
- **Window:** a sliding log of the failure times in the last 60 s, at most
  `limit` entries. An attempt is refused when `limit` failures are in the
  window. `Retry-After` is the time until the oldest one leaves it (rounded up,
  at least 1 s). Refused attempts are not counted, so a client that keeps
  trying gets in again once its old failures age out: at most `limit` guesses
  per minute. An alarm deletes the object's data once its window has passed.
- **Check before reveal:** the Worker evaluates the cheap checks (token
  compare) first and then makes one call, `hit(failed)`. It refuses (429) if
  over the limit, whatever the result, and only counts failures.
- **Download passwords: reserve, then refund.** PBKDF2 takes milliseconds, so
  the check cannot wait for the result. At first the Worker checked
  (`hit(false)`), hashed, and only then counted a failure (`hit(true)`): a
  burst of parallel guesses all passed the check before the first failure was
  counted, so every one was hashed and a right one among them got its 303.
  Now one call, `reserve()`, checks and counts the attempt as a failure in a
  single step (the object handles one call at a time and that call never
  awaits). A wrong password needs no second call; a correct one gives its
  entry back with `refund()` before the redirect. So:
  - per client and upload, at most 5 wrong passwords a minute are hashed,
    plus any correct ones: a correct password is hashed in a slot of its own
    and then refunds it, so after it one more attempt may be hashed (5 wrong
    plus the refunded correct one). Every other attempt of a burst gets 429
    without any hashing, a correct password among them included (no oracle:
    the same 429 as a wrong one). `e2e/tests/node/rate-limit.spec.ts`
    checks by timing that refused attempts are not hashed;
  - successes cost no budget once they have finished, but while a correct
    password is being hashed it holds a slot. So correct passwords sent in
    parallel from one address (more than 5 at once) can be throttled too:
    the ones beyond the free slots get 429 until the others have finished;
  - if the refund call fails, the success stays counted as a failure for the
    rest of the minute (logged; fails safe).
- **Cost per request:**
  - **One Durable Object call:** every `/api/*` request with an
    `Authorization` header (the CLI, correct token included, see above) and
    every `POST /login`.
  - **One or two calls:** a `POST /:id/download` for a protected file without
    a valid download pass: one for a wrong password or a refusal, two for a
    correct password (`reserve` + `refund`).
  - **No calls:** session-cookie API requests (the browser upload page), page
    views, unprotected downloads.

  The Worker's own CPU for a call is an RPC round trip with tiny arguments; the
  object's CPU and storage are billed to the Durable Object. Failures write one
  row each; a correct download password writes two (the reservation and its
  refund).

- **Fails open:** if the object cannot be reached (e.g. the daily Durable Object
  quota is used up), the attempt is allowed and an error is logged. The limit
  is defence in depth; the 16-character token minimum is the main protection.
  Exhausting the quota also takes about as many Worker requests as the free
  plan allows per day (100,000).
- **Local testing:** `wrangler dev` passes a client-sent `CF-Connecting-IP`
  through (Cloudflare's edge overwrites it in production), so each e2e test
  uses its own address and limits never leak between tests.

### What counts as a failure

- **Bearer:** only requests that carry an `Authorization` header with a wrong
  value, an empty value included (`isBearerAttempt()`). Requests without any
  credentials, or with an invalid session cookie, are not guesses at the
  token (a session signature cannot be guessed) and are not counted.
- **Both credentials:** if an `Authorization` header is present, even empty,
  it alone decides. A wrong or empty one gets 401 (and counts) even with a
  valid session cookie.
  - `wrangler dev` removes an empty `Authorization` header before the Worker
    sees it (an empty header of another name arrives), so locally such a
    request falls back to the session cookie. Whether Cloudflare's edge
    passes it on is not verified; if it does, the rule above applies. The
    decision is unit-tested in `e2e/tests/node/parsing.spec.ts`.
- **Login:** an empty or wrong token counts.
- **Cross-origin refusals** (403) happen before any check and do not count.

### Browser requests

- **`Sec-Fetch-Site`:** checked on every session-authenticated `/api/*`
  request, safe methods included: when present, it must be `same-origin`.
  `Origin` is only required on unsafe methods; browsers omit it on same-origin
  GETs.
- **`POST /logout`:** does not need the token, only the same-origin checks.
- **`POST /login`:** trims leading and trailing whitespace of the submitted
  token before the constant-time comparison. iOS Safari can add whitespace
  when pasting. The stored secret is never trimmed or altered, and Bearer auth
  stays exact. (Trailing whitespace of an HTTP header value never reaches the
  Worker anyway: HTTP strips it.) The field is
  `type="password" autocapitalize="off" autocorrect="off" spellcheck="false" autocomplete="current-password"`.
- **Responses** of `/upload`, `/login` and `/logout` all carry
  `Cache-Control: no-store`. A wrong token is never echoed back in the page.
- **Cross-origin `/login` or `/logout`:** `403` with an HTML error page
  "Cross-origin request refused".
- **No framing:** every Worker response (so `/upload`, `/login`, the
  download pages and their error pages) carries
  `Content-Security-Policy: frame-ancestors 'none'` and, for browsers without
  CSP Level 2, `X-Frame-Options: DENY`, so another site cannot frame the
  login, upload or download forms (clickjacking). Static assets (`public/`)
  are served before the Worker and do not get them; they are scripts and
  images, not pages.

### Missing or short token

- **Protected uploads:** the download page (`GET /:id/:filename`) and
  `POST /:id/download` also answer 500 with the message, because the download
  pass cannot be checked safely.
- **`/_dl/:id`:** refuses protected files (500) with a weak token. With a
  missing or short token anyone could sign download links.
- **Unprotected files:** keep working, including their download links.

### Strict parsing

Numbers that are signed or used as keys must be spelled one way only:

- **Expiry fields** of the session cookie, the download pass and the
  `expires` of a signed `/_dl` link: a positive decimal integer of at most 12
  digits without leading zeros (`^[1-9]\d{0,11}$`). The signatures cover the
  number, so before, `0<expires>`, `<expires>.0` or a hex spelling (for the
  link) of a genuine value passed as the same one. Anything else is an
  invalid cookie (no session, no pass) or a 403 link.
- **Part numbers** in `PUT /api/uploads/:id/parts/:n`: `^[1-9]\d*$` and at
  most 10,000. `1.0`, `0x1`, `01`, `+1`, `1e0` are
  `400 {"error": "Invalid upload or part number"}` instead of part 1.

### Upload API

- **Size known at create:** every part's length is checked on `PUT`. Parts
  below the last must be exactly `part_size`, the last exactly the
  remainder, and a part number past the end is refused. All of these are
  `400` with a message naming the expected and received length.
- **Size unknown at create:**
  - **On `PUT`:** each accepted part records its length in an empty object
    `<prefix>/<id>/.parts/<n>` (custom metadata `size`).
  - **At `complete`:**
    - **A listed part that was never uploaded:**
      `400 {"error": "Part <n> was not uploaded"}`.
    - **A short part followed by more:**
      `400 {"error": "Part <n> is <s> bytes but is followed by more parts: …"}`.
  - **The records:** deleted once the upload completes, and with the upload
    otherwise (delete, cleanup).
  - **Limit:** `complete` makes 4 subrequests besides the records (the
    Bearer rate-limit call, the sidecar read, the multipart complete, the
    sidecar write), reads the records with one list call per page
    (`readPartSizes()`, with metadata) and deletes them afterwards, one
    call per 1,000. That must fit in the Free plan's 50: at 100 records per
    list call, 4 + ceil(n / 100) + ceil(n / 1,000) ≤ 50, so at most
    **4,100 parts** (exactly 50 subrequests). With more records it stops
    listing as soon as they cannot fit (`PART_RECORDS_BUDGET`, 46 calls)
    and answers `400 {"error": "Too many parts to complete an upload of
    unknown size in one request; start the upload again with its size"}`
    before completing anything; the upload stays pending. Records of parts
    not in the request count too. If R2 returns fewer records per list
    call the limit is lower; more, higher. Counted on the in-memory bucket
    (`e2e/tests/node/r2-budget.spec.ts`); before this check, 4,101 to
    4,700 parts failed *after* the multipart complete (from 4,601 even
    before the sidecar write, leaving a completed file under a pending
    sidecar). The CLI and the upload page always send the size, so they
    never take this path; only a hand-made client could. Not covered: a
    size given at `complete` that does not match the stored object makes
    the request delete the upload too (a listing and deletes of all its
    keys), which by the same count passes 50 above about 3,800 parts
    (computed, not measured); the request then fails half-way, and the cron
    deletes the rest after 24 hours.
  - **Why not check per part:** with the size unknown, a short part is only
    wrong once a higher one exists. That would cost a bucket listing on every
    `PUT`.
- **Errors R2 raises at `complete`** (e.g. a wrong etag): `400` with
  "Could not complete the upload; check that every part was uploaded and its
  etag is right (…)" instead of a 500.
- **`422` body:**
  `{"error": "Size mismatch: expected X bytes, stored Y", "expected_size": X, "stored_size": Y}`.
- **Size `0`:** a zero-length part (`Content-Length: 0`) is accepted, so an
  empty file is one empty part.
- **Reserved IDs:** generated upload IDs never equal `upload`, `health` or
  `logout`, which are page routes.

### Download page

- **Valid download pass:** the page renders as for an unprotected file (no
  password field).
- **Rate-limited:** the page shows the form with "Too many attempts. Try again
  in N seconds." (`429`, `Retry-After`).

### Download count: a conditional update of the sidecar

The count lives in `.meta.json`: `download_count` and `recent_downloads`
(the last five ISO 8601 times, oldest first), mirrored in the summary custom
metadata. A legacy `downloads` array (yeet 0.2 and earlier) is read for both
and replaced by them on the first download counted.

`recordDownload()` runs in `waitUntil`, after the redirect: it reads the
sidecar, adds the download and writes it back with
`onlyIf: { etagMatches: <etag read> }`. R2 checks the condition and writes in
one step, so a write based on a stale read fails (`put` returns null) instead
of overwriting a newer count, and a sidecar deleted meanwhile is never
written back. On a failure it reads again after a random wait (up to
8 × the round trip just measured × the attempt number), at most 3 attempts.

- **Semantics:** downloads one after another are counted exactly. Downloads
  of one file at the same moment may conflict; each retries, and one that
  finds the sidecar changed on all 3 attempts is not counted (logged). So
  under heavy concurrency the count can be too low, never too high. Locally
  (`wrangler dev`), the verification of round 1F measured 18 to 20 of 20
  simultaneous downloads counted; `e2e/tests/node/download-flow.spec.ts`
  requires at least 15 and at most 20. On real R2, with longer round trips,
  more may be missed; not measured yet.
- **Cost:** at most 6 R2 calls per download (3 × get + put), usually 2. A
  whole `POST /:id/download` makes at most 9 subrequests: the sidecar read,
  2 rate-limit calls for a protected file (`reserve` + `refund`) and the 6.
  The waits are wall time, not CPU.
- **A sidecar that is not shaped like one** (see "Sidecars that never get
  a summary" below) is not counted and not written: `recordDownload()`
  returns false instead of throwing in `waitUntil`.
- **Why not one object per download** (the design of 1D/1E): every download
  added an object to the listing, and listing them was bounded only by
  assuming 1,000 objects per list call. With metadata a list call returns at
  most 100 (miniflare caps it; Cloudflare says such lists may return fewer
  than asked), so a few thousand records pushed `GET /api/uploads` and the
  cron past 50 subrequests. The cap of 1,000 records per upload was also not
  atomic, and overlapping folds could count records twice. A Durable Object
  per upload would count exactly, but costs a DO request per download from
  the daily quota the rate limits rely on.

### Listing within a fixed number of R2 calls

`listAll()` lists `<prefix>/` with custom metadata, one page after the
other, and stops at a budget: **40 R2 calls** for `GET /api/uploads` (plus
its one rate-limit call: 41 subrequests); the cron's is below. Sidecars of
yeet < 0.2 carry no summary and cost one read each, counted in the budget.
`.downloads/` and `.parts/` runs are jumped over: a page that ends inside
one is followed by a call with `startAfter: <prefix>/<id>/<run>/~`, so each
costs at most one extra call, however many objects it holds.

When the budget runs out, the listing returns the uploads it has, in ID
order (never a partly listed last one), with `truncated: true`, and
`GET /api/uploads` passes the flag on. `yeet list` then prints a note that
only part of the uploads is shown.

- **Which uploads a truncated listing shows:** the first part of the bucket
  in key order, so the uploads with the lowest IDs (sorted newest first, as
  always). IDs are random, so that is an arbitrary selection, not the
  newest uploads.
- **Resuming** (the cron): the listing returns the key to continue after
  (`resumeAfter`), right before the first upload it left out (one with no
  room left for its sidecar read, or partly listed). If nothing before that
  upload was listed (its keys alone fill the budget, so it is no yeet
  upload), it is returned unread, and incomplete if partly listed, and the
  listing resumes after it, so the next one always gets further.
- **Stray records** (legacy `.downloads/` keys without an upload) are only
  reported when every key of that upload ID was listed: a partly listed
  upload may have its sidecar after the records.

**Capacity** (uploads one `GET /api/uploads` lists), assuming 100 objects
per list call with metadata, as miniflare returns; measured on the
in-memory bucket by `e2e/tests/node/r2-capacity.spec.ts`:

- **Finished uploads with a summary** (2 objects each): 40 calls × 50 =
  2,000, minus the last, partly listed one: **1,999**.
- **Each sidecar without a summary** costs one call, so 50 fewer uploads. A
  bucket of nothing but such sidecars shows **39** (one list call, then 39
  reads). The cron adds the missing summaries, 21 per run (below); the
  one-time script below adds them all at once.
- **Sidecars that never get a summary cost that read for good**, in every
  `GET /api/uploads` and (2 calls reserved, 1 spent) in every cron run
  that lists them: neither the cron nor the script writes one for
  - a sidecar that is not valid JSON, or valid JSON not shaped like a
    sidecar (`parseUploadMeta()`: e.g. `{}`, `"downloads": 5`, a
    `download_count` that is a string). Such an upload is treated as
    unreadable everywhere: left out of `GET /api/uploads`, its downloads
    not counted, never deleted by the cron. It never stops a listing or a
    cron run. (The download page reads the sidecar on its own: it fails
    on invalid JSON, and works as long as the fields it uses are usable.)
  - a sidecar whose summary would take more than 2,048 bytes of custom
    metadata (`MAX_SUMMARY_BYTES`; only with a filename or download times
    far longer than yeet writes). It is listed, counted and cleaned up
    normally, just read each time. R2 refuses custom metadata over its
    own limit (`wrangler dev`: 8,192 bytes), which used to make the cron
    throw on such a sidecar; `writeMeta()` now leaves the summary out.

  The fix is by hand: repair the sidecar's JSON (it is the upload's
  `<prefix>/<id>/.meta.json`, see `UploadMeta` in `uploads.ts`), after
  which the next cron run or the script adds the summary, or delete the
  upload (`yeet delete <id>`, `DELETE /api/uploads/:id`, or its objects in
  the dashboard). The script's `unreadable` and `tooLarge` counts, with
  `--verbose`, name them.
- **Each upload whose `.parts/` or legacy `.downloads/` run ends a page**
  costs one more call. Pending uploads of unknown size and legacy records
  also take room in the pages they share.
- **If real R2 returns more per call** (up to 1,000), capacity grows to
  match; if it returns fewer, it shrinks. To be measured on a real deploy.

`e2e/tests/node/r2-budget.spec.ts` counts the calls on the Worker's own
modules with an in-memory bucket that returns at most 100 objects per call
and, like the Free plan, throws past 50. `r2-adversarial.spec.ts`,
`r2-adversarial-1g.spec.ts` and `r2-orphans.spec.ts` add a stricter bucket (`e2e/lib/strict-r2.ts`: short
and empty pages, junk keys, IDs that are prefixes of each other).

### Cleanup (cron)

The daily run (`packages/worker/src/cleanup.ts`) makes at most **45 R2
calls**:

1. **Reads its cursor**, `<prefix>/.cleanup-cursor` (1 call): the key to
   start after, or none for the beginning of the bucket.
2. **Lists from there**, at most 25 list calls (about 1,249 uploads). It
   leaves sidecars without a summary unread and reserves 2 calls for each
   out of the 43 it may use together with steps 3 and 4, so it lists no
   further than the run can handle: a page of 50 such sidecars stops the
   listing after one call.
3. **Gives sidecars without a summary theirs first**, before any other
   work: a get and a conditional put (`onlyIf: { etagMatches }`), 2 calls
   each, at most **21 per run** ((45 − cursor read − cursor write − one list
   call) / 2). The get also tells the run whether the upload is stale.
   Stale ones get their summary too, so that a later run deletes them from
   the listing alone.
4. **Handles the uploads in key order** while the rest of the budget lasts
   (keeping one call for step 5):
   - **Expired, and pending for over 24 hours:** their keys go into batch
     deletes (1,000 keys per call), the sidecars in batches of their own
     after all other keys; a pending one first gets its multipart upload
     aborted (1 call).
   - **Uploads whose keys the listing jumped over, and legacy records:**
     listed and deleted under `<prefix>/<id>/` (or only `.downloads/` for a
     current upload), 2 calls per 1,000 objects, plus 1 for the sidecar,
     deleted on its own once everything else is gone.
5. **Saves the cursor** (1 call, only if it changed): after the last upload
   it finished. If it reached the end of the bucket, the next run starts at
   the beginning.

**The sidecar goes last** because it is what makes the listing see an
upload: when a run's calls (or a `DELETE /api/uploads/:id`) stop half-way,
what is left still has its sidecar, and the next run finds it stale and
goes on. Keys left without a sidecar would never be cleaned up.

**Never cleaned up by the cron:** uploads whose sidecar it cannot read
(not valid JSON or not shaped like one, see the listing above; such a
sidecar never stops a run), and an upload directory with more keys that
yeet does not write sorting before its `.meta.json` than a run lists
(outside `.downloads/` and `.parts/`, which the listing jumps over; about
2,500 at 100 per list call): no run reaches its sidecar, so none sees it
as stale; each returns it unread and goes on after it instead of
stalling (`e2e/tests/node/r2-adversarial-1g.spec.ts`, with 30,000 such
keys). yeet itself never writes such keys.

So the order is stable across runs and each run continues where the last
one stopped: a bucket of N uploads is gone through in about N / 1,249 days,
longer when a run has more to delete than its budget allows (it then stops
at that upload and goes on from there the next day). Expired files are
refused at request time regardless (the page, the form and `/_dl` check
`expires_at`), so a later deletion costs only storage; `yeet list` shows
them as expired until then.

Measured on the in-memory bucket (`e2e/tests/node/r2-capacity.spec.ts`):
5,000 uploads, every tenth expired, cron runs until nothing expired and no
sidecar without a summary is left.

| bucket                     | first run                     | runs |
| -------------------------- | ----------------------------- | ---- |
| with summaries             | 124 deleted, 29 calls         | 5    |
| sidecars without a summary | 21 summaries, 45 calls        | 350  |
| the same, none expired     | 21 summaries, 45 calls        | 239  |

Without summaries the deletions wait: step 3 takes the whole budget, and a
run stops at the first stale upload it has no calls left to delete. Hence
the one-time script below for a bucket of yeet < 0.2 uploads.

### Migrating a bucket of yeet < 0.2 (one-time)

`packages/worker/scripts/backfill-summaries.mjs` gives every sidecar
without a summary its summary in one go, from your machine rather than
within a Worker's 50 calls. It lives in `packages/worker` because it needs
direct access to the bucket (through wrangler, a dev dependency there) and
the Worker's own `writeMeta()` and `summarize()`, so it writes exactly the
summary the Worker would; the CLI only talks HTTP to the Worker and has no
dependencies. The logic is `packages/worker/src/backfill.ts` (not part of
the deployed Worker); the script bundles it with esbuild and binds the
bucket.

```sh
cd packages/worker
npm install
npx wrangler whoami                                                    # the bucket's account?
node scripts/backfill-summaries.mjs --remote --bucket <bucket_name>          # dry run: counts only
node scripts/backfill-summaries.mjs --remote --bucket <bucket_name> --apply  # writes
```

- **Targets:** `--remote` binds the bucket through wrangler's remote
  bindings (`getPlatformProxy()`, so it needs `wrangler login`); `--local
  [--persist-to <dir>]` uses a `wrangler dev` bucket on disk (stop
  `wrangler dev` first). One of the two is required. `--prefix` defaults to
  `uploads`; pass your `UPLOADS_PREFIX` if you changed it.
- **What it touches:** only `<prefix>/<id>/.meta.json` objects without a
  usable `summary` custom metadata (missing, not JSON, or not shaped like
  a summary such as `"null"`: the listing's own check). Each is read and
  written back with the same JSON content, plus the summary and
  `Content-Type: application/json`. Files, part records, legacy records
  and other keys are only listed.
- **Other custom metadata and HTTP metadata of the sidecar are dropped:**
  the write replaces the object, and `writeMeta()` sets only `summary` and
  the content type, so e.g. the `mtime` rclone stores in custom metadata
  is gone afterwards. yeet does not read it; the cron's summary step does
  the same. The JSON body is unchanged.
- **Safe:** a dry run unless `--apply`. Idempotent: a second run finds
  nothing to do. Each write is conditional on the etag it read, so a
  download counted (or an upload deleted) in between is never overwritten;
  it is reported as `changed`, and the Worker wrote that sidecar's summary
  itself. Sidecars that are not valid JSON or not shaped like a sidecar
  (`{}`, `[]`, `"downloads": 5`, …) are left alone (`unreadable`), and so
  are ones whose summary would exceed 2,048 bytes (`tooLarge`); see
  "Sidecars that never get a summary" above.
- **Cost:** one list call per page of objects, plus a get and a put per
  sidecar written. These are API calls from your machine, not Worker
  subrequests.
- **Output:** one JSON line, e.g.
  `{"apply":true,"sidecars":120,"missing":118,"written":118,"changed":0,"unreadable":0,"tooLarge":0}`;
  `--verbose` names each key on stderr.
- **Tested** on the in-memory bucket and, end to end, on a `wrangler dev`
  bucket (`e2e/tests/node/backfill.spec.ts`). Not yet run against real R2:
  start with a dry run.

### Legacy download records (1D/1E)

The pre-release versions 1D and 1E wrote one empty object per download,
`<prefix>/<id>/.downloads/<at>_<random>`. They are no longer written or
counted: the listing jumps over them, the cron deletes them (as above,
2 calls per 1,000), and `DELETE /api/uploads/:id` removes them with their
upload. They are not added to the count first: that would take a
conditional sidecar update per batch, and a failed delete after it would
count them twice. They only exist in pre-release test buckets, whose counts
drop back to what the sidecar holds. Records without an upload (a download
that raced a delete) are deleted the same way.

### Range requests on `/_dl/:id`

The Worker parses `Range` itself and only passes R2 a range it accepted, as
a normalized header. Following RFC 9110 §14:

- **Served (206):** one range, `bytes=<first>-<last>`, `bytes=<first>-` or
  `bytes=-<suffix>` (unit case-insensitive). A last position past the end is
  clamped, a suffix longer than the file is the whole file. `Content-Range`
  and `Content-Length` describe exactly the bytes sent.
- **Ignored (200 with the whole file, no `Content-Range`):** anything else —
  invalid syntax (`bytes=abc`, `bytes=-`), a last position before the first
  (`bytes=3-1`), several ranges (`bytes=0-1,3-4`, not supported) or another
  unit. Also a suffix range on an empty file, which has no bytes to address.
- **Unsatisfiable (416, `Content-Range: bytes */<size>`):** a first position
  at or past the end (`bytes=5-` on a 5-byte file, any first position on an
  empty file), or `bytes=-0`.
- **Huge numbers:** any number of digits is valid. Positions above
  `Number.MAX_SAFE_INTEGER` (8 PiB, past the end of any object) are clamped
  to it, so the range R2 gets is always plain decimal integers
  (`bytes=0-99999999999999999999999` reaches R2 as `bytes=0-9007199254740991`,
  never `bytes=0-1e+23`, which R2 ignored and answered with the whole file
  under a `Content-Range` for part of it). Parsing and formatting live in
  `packages/worker/src/range.ts`.

### Sentry

- **Loading:** `@sentry/cloudflare` is imported dynamically. The bundle
  contains it, but it is only evaluated, and `withSentry()` only applied (to a
  separate handler object), on the first request whose environment has a
  `SENTRY_DSN`. `withSentry()` instruments the handler object it is given in
  place.
- **Without a DSN:** requests go straight to the plain Hono handler, and the
  `Sentry.logger` calls and `captureException` are skipped.
- **With a DSN:** they run exactly as before.
- **Tests:** `e2e/tests/node/sentry.spec.ts` unit-tests the dispatch and checks
  that an exception reaches a fake ingest server when a DSN is set.

### Upload page module

- **Where:** `GET /upload` with a valid session returns `uploadPage()` from
  `packages/worker/src/upload-page.ts`, a placeholder with a logout form.
- **Replacing it:** keep the function, which takes no arguments and returns the
  full HTML document. It may use `layout()` and `escHtml()` from
  `template.ts`. `index.ts` adds `Cache-Control: no-store`.
