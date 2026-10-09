# HTTP API contract (phase 1)

This is the contract between the Worker (`packages/worker`), the CLI
(`packages/cli`) and the browser upload page. Changes to it are deliberate and
recorded here first. Behaviour not mentioned stays as in
`packages/worker/src/index.ts` at the start of phase 1.

## Hard constraints

- **CPU:** every request, and every cron run, stays within **10 ms CPU** on
  Workers Free with `SENTRY_DSN` unset. This is measured on a real deploy,
  not with `wrangler dev`, which does not enforce limits. **CPU is the
  binding limit** (measured in phase 1H, see "Measurements" below): a
  request's CPU grows with the objects it processes, roughly 20 to 40 ms
  per 1,000 uploads listed (phase 1J: about 1.7 ms per page plus 20 µs
  per object listed), and Cloudflare answers `503` (`exceededCpu`)
  once a Worker keeps exceeding it. So every request and cron run does a
  **bounded amount of work per invocation**, whatever the bucket holds:
  `GET /api/uploads` returns one page (see "Listing a page"), the cron
  handles one slice of the bucket per run (see "Cleanup (cron)"). Those
  bounds are asserted on the objects listed and the R2 calls made, as a
  stand-in for CPU (`e2e/tests/node/r2-work-bounds.spec.ts`).
- **R2 calls:** the limit is **1,000 R2 binding calls per invocation**
  (measured; it was assumed to be 50 subrequests before). It no longer
  shapes the design; the R2 call budgets that remain (45 for a cron run,
  46 for the part records of a `complete`) are a second guard behind the
  bounds on objects listed (and, for a `complete` of unknown size, on part
  records: `MAX_UNSIZED_PARTS`).
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
  - **Measured at 20,000** (phase 1H, Workers Free, `wrangler tail`, 60
    correct and 40 wrong passwords on `POST /:id/download`): a correct
    password costs **8 ms CPU median, 13 ms at p90** (max 17), a wrong one
    7 ms median, 9 ms at p90 (max 22); none was refused for CPU.
    **Decision: keep 20,000 iterations.** The p90 is above 10 ms, but
    Workers Free tolerated it without an error; lowering the count further
    would make a stolen bucket's hashes cheaper to brute-force again.
  - **Measured again** (phase 1J, same code, in a session that ran a few
    ms slower throughout): a correct password p50 13, p90 20 ms (max 22,
    n = 60), a wrong one p50 12, p90 23 (max 26, n = 40); none refused.
    **Decision (round 1K): still 20,000 iterations.**
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
each request and run does a bounded amount of work: `GET /api/uploads`
answers one page per request with a `cursor` for the next (see "Listing a
page" below), and the cleanup runs hourly over one slice of the bucket at
a time (see "Cleanup (cron)").

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
  - An empty `Authorization` header never reaches the Worker: `wrangler
dev` removes it (an empty header of another name arrives), and so does
    Cloudflare's edge (measured in phase 1H with a probe Worker that
    reports the headers it gets). Such a request is therefore treated like
    one without the header (session cookie, not counted). The Worker's own
    rule (an empty header present decides and counts) stays, in case a
    future edge passes it on; it is unit-tested in
    `e2e/tests/node/parsing.spec.ts`.
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
  - **Limit: at most 150 part records** (`MAX_UNSIZED_PARTS`; 300 in
    round 1K, 150 since round 1L). CPU binds, not R2 calls: the `complete`
    of an upload of unknown size with 4,000 part records took 82, 125 and
    138 ms CPU on Workers Free (phase 1J, n = 3), and with 300 records p50
    14, p90 17 ms (phase 1K, n = 8, all `200`), over 10 ms. So `complete`
    answers `400` with this error before anything changes (no multipart
    complete, no write; the upload stays pending, its records stay):

    ```json
    {
      "error": "Too many parts to complete an upload of unknown size (at most 150); start the upload again and send its size (\"size\" in POST /api/uploads)"
    }
    ```

    when
    - the request lists more than 150 parts (checked before any listing), or
    - the bucket holds more than 150 part records for the upload (records
      of parts not in the request count too). The list calls carry a
      `limit`, so at most 151 records are listed to find out (real R2
      respects such a `limit`: 301 asked, 301 returned, phase 1K).

    150 parts are up to about 7.9 GB at the 50 MiB part size. With the size
    known at create there is no such limit (R2's own 10,000 parts). The
    CLI and the upload page always send the size, 0 included, so they never
    take this path (asserted: `e2e/tests/node/unsized-complete.spec.ts` for
    the CLI, `tests/browser/upload.spec.ts` for the page); only a hand-made
    client could. The refusal of 301 records cost p50 9, p90 11 ms (phase
    1K, n = 8): it lists 301 records with metadata. _Estimate, not
    measured:_ these imply about 20 µs per record listed (the refusal) to
    33 µs per record listed and deleted (the complete, over a sized
    `complete`'s p50 4 ms in the same session), so for 150 records about
    7–9 ms p50 for a `complete` and about 6 ms for the refusal (151
    listed); the p90 may stay near 10.

  - **Second guard, the R2 call budget:** `complete` makes 4 subrequests
    besides the records (the Bearer rate-limit call, the sidecar read, the
    multipart complete, the sidecar write), reads the records with one list
    call per page (`readPartSizes()`, with metadata) and deletes them
    afterwards, one call per 1,000. It stops listing as soon as these
    cannot fit in 46 R2 calls (`PART_RECORDS_BUDGET`, from the 50
    subrequests once assumed; the real limit is 1,000 R2 calls, phase 1H)
    and answers the same 400. With 150 records that only happens if R2
    returns fewer than 4 records per list call (`r2-budget.spec.ts`).
    Before round 1K this budget was the limit: 4,100 parts at 100 records
    per call; at real R2's 415 per call at most about 13,280 by the call
    budget (32 list calls and 14 deletes), so in effect R2's own 10,000
    part numbers (this said "about 18,000" until round 1L, which was
    wrong). Before the budget check
    (round 1H), 4,101 to 4,700 parts failed _after_ the multipart complete.
  - **Not covered:** a size given at `complete` that does not match the
    stored object makes the request delete the upload too (a listing and
    deletes of all its keys, up to 150 records now); the cron deletes
    whatever a failed request leaves after 24 hours.
  - **Size known: at most as many parts as the size has** (round 1L). A
    `complete` listing more parts than `max(1, ceil(size / part_size))` is
    a `400` ("Invalid parts: an upload of 104857601 bytes has 3 parts
    (part_size 52428800 bytes), not 4") after the sidecar read, before R2
    is asked; those parts were refused on `PUT` anyway. Any `parts` array
    longer than R2's 10,000 is a `400` ("Invalid parts: at most 10000")
    before its entries are parsed or sorted. So the array a request sorts
    is bounded by 10,000 entries and by the request body; that work (one
    pass and one sort) is not measured.
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
  cron past the 50 subrequests then assumed (and every object listed costs
  CPU, the real limit). The cap of 1,000 records per upload was also not
  atomic, and overlapping folds could count records twice. A Durable Object
  per upload would count exactly, but costs a DO request per download from
  the daily quota the rate limits rely on.

### Measurements (phase 1H)

Measured on a real Workers Free deploy (a test account, Sentry off), with
`wrangler tail` for CPU time and a probe Worker on the same bucket for R2
itself. They replace the assumptions the earlier rounds were built on
(at most 50 subrequests per request, 100 objects per list call).

- **`GET /api/uploads`, one request listing everything** (the design before
  round 1I, a budget of 40 R2 calls; n = 10 requests per bucket):
  - 2,150 uploads with a summary and 60 without (995 listed, truncated):
    43–71 ms CPU, median 48.
  - 2,211 uploads, all with a summary (all listed): 67–103 ms CPU, median 82.
  - 9,211 uploads (8,199 listed, truncated): 225–320 ms CPU for the first
    7; the next 3 were refused by Cloudflare with `503` and outcome
    `exceededCpu`. After the cron deleted 915 of them (8,296 left, n = 3):
    234–318 ms.

  So CPU grows with the uploads listed, roughly 27–47 µs per upload (20 to
  40 ms per 1,000), far above 10 ms; Workers Free tolerates some excess
  before it refuses requests. Recomputed from the tail data by the
  verifier of round 1I, allowing for a fixed cost per request: about
  27–71 µs per upload plus 1–6 ms per request. This is an inference
  from requests that listed 1,000 to 8,000 uploads, not a measurement
  of a page.

- **The cron** (`runCleanup()` called through the probe Worker, the design
  before round 1I: up to 25 list calls and 45 R2 calls; n = 5 runs): 45 and
  65 ms CPU for runs that gave 20 and 18 sidecars their summary, 141–179
  ms for runs that deleted 4 to 507 uploads. The 1I verifier inferred
  from these about 14.8–17.3 µs per object listed, and at least about
  0.7–1.3 ms per summary written (a get and a conditional put), not
  measured separately.
- **R2:** a `list()` with `include: ["customMetadata"]` returned about 415
  objects per call, without it about 848, never 1,000 even with
  `limit: 1000`. The limit on R2 binding calls is **1,000 per invocation**,
  not 50. `put()` with `onlyIf: { etagMatches }` returns null both for a
  stale etag and for a key that does not exist. Custom metadata is limited
  to 8,192 bytes.
- **Password checks** at 20,000 PBKDF2 iterations: see "Download
  passwords" above (median 8 ms, p90 13 ms, n = 60).
- **Other routes** during the e2e flows on the deploy (515 requests, none
  refused): medians of 0–4 ms, p90 at most 14 ms (`POST /:id/download`
  with a password).
- **An empty `Authorization` header** is removed by Cloudflare's edge
  before the Worker sees it (see "What counts as a failure").

The bounds of round 1I were chosen from these numbers; phase 1J measured
them (below), and round 1K lowered them.

### Measurements (phase 1J)

Measured on a real Workers Free deploy of `255420b` (a test account,
Sentry off): CPU time per invocation from `wrangler tail`, the cron's
`runCleanup()` called through a probe Worker on the same bucket, the real
hourly trigger observed once. These are the bounds of round 1I
(`PAGE_LIMIT` 300, `PAGE_READS` 10, `CLEANUP_LIST_LIMIT` 200,
`CLEANUP_SUMMARIES` 10). **Session noise:** this session ran a few ms
slower than phase 1H with unchanged code (a password check: p50 13, p90
20 ms here, against 8 and 13 in 1H), so small differences between the two
phases mean little.

- **`GET /api/uploads`, one page** (buckets of 2,000 and about 8,000
  uploads with a summary; the bucket size made no difference):
  - a full page (300 objects, 149 uploads) **during a walk**, pages spaced
    out: p50 7, p90 10 ms (n = 63); the **same page repeated**: p50 12,
    p90 17 (n = 100);
  - the last page of a bucket, with 0, 25 and 80 uploads (about 0, 50 and
    160 objects listed): p50 2, 3 and 5 ms, max 4, 4 and 7 (n = 10 each);
  - a page with 10 sidecar reads: p50 16, p90 21 (n = 22); with 5: p50 11,
    p90 17 (n = 22): about 0.3–0.5 ms per read;
  - a page with a jump over legacy records (600 objects): p50 18, p90 22
    (n = 12).

  A fit over these: **about 1.7 ms per request plus about 20 µs per object
  listed**.

- **`yeet list`** (the built CLI, from a laptop): 2,000 uploads, all
  shown, in 4.7 s; 8,042 uploads, all shown, in 30.7 s; no `503`, `429` or
  `exceededCpu`.
- **The cron** (`runCleanup()` through the probe Worker): a plain run of
  200 objects p50 6 ms (n = 8); one that deleted 4 to 13 uploads p50 7
  (n = 11); one that wrote 10 summaries p50 19, p90 22 (n = 8); one with a
  `deleteUnder()` round (600 objects) p50 12, p90 14 (n = 8). A fit:
  **about 2.9 ms per run plus about 15 µs per object listed, plus about
  1.26 ms per summary written**. The real hourly scheduled event fired
  (the 19:00 UTC run: 17 ms CPU, 10 summaries, outcome ok).
- **R2 with `limit` set** (200 and 300, with metadata): 0 short and 0
  empty pages among 332 truncated list calls.
- **`POST /api/uploads/:id/complete`** of an upload of unknown size with
  4,000 part records: 82, 125 and 138 ms CPU (n = 3), 147–156 s wall time;
  it completed each time.
- No `exceededCpu` anywhere; 4 transient R2 errors (a `500`, internal
  error 10001).

**The inferences of phases 1H and 1I, against these:**

| inferred                                                     | measured (1J)                          | verdict                  |
| ------------------------------------------------------------ | -------------------------------------- | ------------------------ |
| a page of 149 uploads: 6–13 ms                               | p50 7–12, p90 10–17                    | confirmed, p90 above it  |
| fixed cost of a request: 1–6 ms                              | about 1.7 ms                           | confirmed                |
| 27–71 µs per upload listed                                   | about 40 µs (20 µs per object)         | confirmed                |
| cron: 14.8–17.3 µs per object listed                         | about 15 µs                            | confirmed                |
| cron: at least 0.7–1.3 ms per summary                        | about 1.26 ms                          | confirmed, at the top    |
| cron: 10 summaries among 200 objects: 10–16 ms               | p50 19, p90 22                         | refuted: higher          |
| cron: 600 objects: 8.9–10.4 ms                               | p50 12, p90 14 (a `deleteUnder()` run) | refuted: higher          |
| `complete` with thousands of part records: likely over 10 ms | 82–138 ms at 4,000                     | confirmed                |
| real R2 may return short or empty pages with `limit`         | none in 332 calls                      | not seen (still handled) |

**Decided (round 1K):** `PAGE_LIMIT` 300 → 150, `PAGE_READS` 10 → 5,
`CLEANUP_LIST_LIMIT` 200 → 100, `CLEANUP_SUMMARIES` 10 → 3, at most 300
part records for a `complete` of unknown size (`MAX_UNSIZED_PARTS`), and
PBKDF2 stays at 20,000 iterations. _Estimates from the fits above, not
measured:_ a full page about 1.7 + 150 × 0.02 ≈ 4.7 ms; a cron run at
worst (100 objects and 3 summaries) about 2.9 + 100 × 0.015 + 3 × 1.26 ≈
8.2 ms; a run with a `deleteUnder()` round (3 × 100 objects) about 2.9 +
300 × 0.015 ≈ 7.4 ms. See "To measure next".

### Listing a page (GET /api/uploads)

`GET /api/uploads` answers **one page per request**:

```jsonc
// GET /api/uploads, or GET /api/uploads?cursor=<cursor>
{
  "uploads": [
    /* finished uploads of this page, newest first */
  ],
  "cursor": "dXBsb2Fkcy9hQjN4X1Ew", // where the next page starts; null on the last page
  "truncated": true, // only when cursor is not null: more pages exist
}
```

- **Request:** without `cursor`, the first page; with the `cursor` of the
  previous page, the next. Every page is newest first within itself; a
  client that wants the whole list fetches every page and sorts.
- **`cursor`:** opaque to clients. It is the base64url spelling (no
  padding) of the key the next page starts after (listPage()'s `next`,
  `encodeListCursor()` in `parse.ts`). Strictly parsed
  (`parseListCursor()`): only base64url characters, the one canonical
  spelling (no padding, no stray bits), valid UTF-8, at most 1,024 bytes
  (an R2 key's maximum), and starting with `<UPLOADS_PREFIX>/`. Anything
  else, an empty `?cursor=` and two `cursor` parameters included, is
  `400 {"error": "Invalid cursor"}` (after authentication). The listing
  only ever lists under `<prefix>/` whatever the key, so the check is
  strictness, not the boundary. A cursor stays valid as long as the
  prefix does; uploads made or deleted between pages may be missed or
  not, but none is listed twice (pages go forward in key order).
- **Compatibility:** `truncated: true` keeps its meaning, "more exists".
  A client that ignores `cursor` (yeet 0.2's CLI) gets the first page and
  prints its note that only part of the uploads is shown. A new CLI
  against a server without pages (`truncated` without `cursor`) prints
  that page with the same note. (That is a 0.2 CLI built from `fe688c9`
  or later; earlier pre-release builds, such as `feb7b2f`, also
  versioned 0.2.0 and never published on npm, show the first page
  without the note.)

**Work per request** (`listPage()` in `uploads.ts`, on top of `listAll()`;
asserted in `e2e/tests/node/r2-work-bounds.spec.ts` on a bucket returning
415 objects per list call, as real R2 did):

- **One list call** with custom metadata and `limit: 150` (`PAGE_LIMIT`):
  at most 150 objects, about 75 finished uploads. Real R2 returns more
  than 150 per call, so the `limit` is the bound. 300 until round 1K;
  measured at 300 in phase 1J (p50 7–12, p90 10–17 ms, see "Measurements
  (phase 1J)") and halved for headroom. _Estimate, not measured:_ about
  1.7 + 150 × 0.02 ≈ 4.7 ms a page (the last page of a bucket listing
  about 160 objects measured p50 5, max 7 ms).
- **At most one more list call** (`PAGE_JUMPS`), only when the first ends
  inside a `.downloads/` or `.parts/` run: it continues after the run
  (`startAfter: <prefix>/<id>/<run>/~`), so an upload with thousands of
  legacy records is still listed. Its `limit: 50` (`JUMP_LIMIT`, round
  1L; until then the page's 150) only has to reach the upload's sidecar
  and file after the run; a short jump is handled like any short page.
  At most 200 objects then. Phase 1K measured a jump page of 300 objects
  at p50 8, p90 13, max 18 ms (n = 51); _estimate, not measured:_ about
  p50 6, p90 10 at 200, from the slope between that and a full page.
- **At most 5 reads** of sidecars without a summary (`PAGE_READS`, 10
  until round 1K; a jump takes the place of one): **at most 6 R2 calls**
  per page, plus the Bearer rate-limit call.

A page holds the uploads `listAll()` listed completely, in key order, and
**never a partly listed one**: the last upload of a page that ends inside
it is left for the next page, which starts right before it. An upload
followed by keys that belong to no upload is complete (a fix of round
1I: before, it was always treated as possibly partly listed). If a page
lists nothing but the start of one upload:

- **with more than 2 of its keys listed outside its `.downloads/` and
  `.parts/` runs** (more than a yeet upload has there; more than a page
  lists, not a yeet upload): it is returned unread, and the next page
  starts after it, so pages never stall;
- **with more than 2 keys listed, nearly all in a `.downloads/` run, and
  its sidecar not reached** (the page ended in the run and R2 answered the
  jump over it with a short or empty page; the sidecar sorts after
  `.downloads/`): its sidecar is read (1 call, within `PAGE_READS`) and
  the upload is returned with it, and the next page starts after it. If
  the read fails, nothing is returned and the cursor stays where it was.
  **If it fails every time** (a sidecar R2 cannot serve), the listing
  stalls there: every page from that cursor returns nothing and the same
  cursor, nothing after it is listed (nothing is skipped either), and
  `yeet list` stops at its page cap (see below) with its note that only
  part is shown (`e2e/tests/node/verify-1j.spec.ts`, "probe read always
  fails"). Not seen on real R2; the fix is by hand, as for a sidecar that
  never gets a summary (below): repair or delete that upload. Before
  round 1J such an upload was returned without a summary, so left out,
  and the next page started after it: skipped for that walk.
- **with at most 2** (R2 returned a short page, as it may; even empty ones):
  nothing is returned and the cursor stays where it was, so the next
  request tries again rather than skipping an upload. If R2 kept doing
  that, `yeet list` would stop at its page cap (see below). Real R2
  returned full pages in phase 1H, and with `limit` set in phase 1J (0
  short or empty among 332 truncated list calls).

Pending uploads, and sidecars that are unreadable or not shaped like one
(see "Sidecars that never get a summary" below), are left out of the
page, never an error.

**Pages per bucket** (`e2e/tests/node/r2-capacity.spec.ts`,
`r2-work-bounds.spec.ts`; 415 objects per list call):

| bucket                                | uploads per page | pages |
| ------------------------------------- | ---------------- | ----- |
| 5,000 uploads with a summary          | 74               | 68    |
| 1,000 uploads, half without a summary | about 10         | 100   |
| 1,000 uploads, none with a summary    | 5                | 200   |
| 5,000 uploads, none with a summary    | 5                | 1,000 |

74 because 150 objects are 75 uploads and the last one of a page that
goes on is left for the next. `wrangler dev` returns at most 100 objects
per list call, so it shows 49 per page. (At the bounds of round 1I: 149
and 10 per page, 34 and 500 pages.)

**More than 5,000 sidecars without a summary** take more than 1,000
pages at 5 a page: `yeet list` stops at its cap of 1,000 pages
(`MAX_LIST_PAGES`) and prints only part, with its note, until enough of
them have their summary. With summaries, 1,000 pages hold about 74,000
uploads. The cron gives 3 an hour (72 a day); the one-time script
`packages/worker/scripts/backfill-summaries.mjs` (see "Migrating a bucket
of yeet < 0.2" below) gives all of them theirs in one go.

**`yeet list`** fetches every page, one request after the other, and
prints all uploads newest first. A page that fails with a network error,
5xx (503 is what Cloudflare answers over the CPU limit) or 429 is retried
with backoff (1, 2 and 4 s), or after the server's `Retry-After` if it
sent one; one longer than 10 s is not waited for (since round 1J: a
`429` after too many wrong tokens asks for up to a minute, which the
backoff used to retry anyway). `Retry-After` counts only as digits
(seconds) or an HTTP date in one of its three spellings (asctime read as
GMT); anything else (`-5`, `+5`, `1.5`, `1e3`) is ignored and the backoff
applies (round 1K: `Date.parse()` read `-5` as a date in 2001, so the CLI
retried at once). If it still fails, or answers with something that is
not a page (a `200` that is not JSON, say), `yeet list` prints what it
has with a note and exits 1; if the first page fails, that is the error.
For any status whose `Retry-After` was too long to wait for, the note
says when to try again (round 1K; before, only a `429` did), as "in N
seconds", minutes or hours, or "later" above a day rather than the raw
number. (Before round 1J a later page that was not JSON was an error
that printed nothing.) It fetches at most 1,000 pages, so a server that
keeps answering with a cursor cannot keep it busy forever. Tested against
a stand-in server in `e2e/tests/node/cli.spec.ts` and `verify-1j.spec.ts`,
and end to end in `list-pages.spec.ts`.

**Sidecars that never get a summary cost a read for good**, in every page
that lists them and (2 calls reserved, 1 spent) in every cron run that
lists them: neither the cron nor the script writes one for

- a sidecar that is not valid JSON, or valid JSON not shaped like a
  sidecar (`parseUploadMeta()`: e.g. `{}`, `"downloads": 5`, a
  `download_count` that is a string). Such an upload is treated as
  unreadable everywhere: left out of `GET /api/uploads`, its downloads
  not counted, never deleted by the cron. It never stops a listing or a
  cron run. (The download page reads the sidecar on its own: it fails on
  invalid JSON, and works as long as the fields it uses are usable.)
- a sidecar whose summary would take more than 2,048 bytes of custom
  metadata (`MAX_SUMMARY_BYTES`; only with a filename or download times
  far longer than yeet writes). It is listed, counted and cleaned up
  normally, just read each time. R2 refuses custom metadata over its own
  limit (8,192 bytes, measured on R2 and in `wrangler dev`), which used
  to make the cron throw on such a sidecar; `writeMeta()` now leaves the
  summary out.

The fix is by hand: repair the sidecar's JSON (it is the upload's
`<prefix>/<id>/.meta.json`, see `UploadMeta` in `uploads.ts`), after which
the next cron run or the script adds the summary, or delete the upload
(`yeet delete <id>`, `DELETE /api/uploads/:id`, or its objects in the
dashboard). The script's `unreadable` and `tooLarge` counts, with
`--verbose`, name them.

`listAll()` itself still takes an R2 call budget (default 40,
`LIST_BUDGET`) for callers that set none; `e2e/tests/node/r2-budget.spec.ts`,
`r2-adversarial.spec.ts`, `r2-adversarial-1g.spec.ts` and
`r2-orphans.spec.ts` test it on in-memory buckets of 100 objects per call
(`e2e/lib/fake-r2.ts`, and the stricter `e2e/lib/strict-r2.ts`: short and
empty pages, junk keys, IDs that are prefixes of each other).

### Cleanup (cron)

The cleanup (`packages/worker/src/cleanup.ts`) runs **every hour**
(`0 * * * *` in `wrangler.jsonc`), and each run does a small, bounded
amount of work, whatever the bucket holds:

1. **Reads its cursor**, `<prefix>/.cleanup-cursor` (1 call): the key to
   start after, or none for the beginning of the bucket.
2. **Lists one slice from there:** one list call with custom metadata and
   `limit: 100` (`CLEANUP_LIST_LIMIT`, about 50 uploads), and at most one
   more to jump over a `.downloads/` or `.parts/` run it ends in
   (`CLEANUP_JUMPS`). It leaves sidecars without a summary unread and
   reserves 2 calls for each.
3. **Gives sidecars without a summary theirs first**, at most **3 per
   run** (`CLEANUP_SUMMARIES`, 10 until round 1K): a get and a conditional put
   (`onlyIf: { etagMatches }`) each. The get also tells the run whether
   the upload is stale. Stale ones get their summary too, so that a later
   run deletes them from the listing alone. Uploads from the first one
   left without a summary wait for the next run. A sidecar that can never
   get one (see "Sidecars that never get a summary") takes one of the 3
   attempts in every run that reaches it.
4. **Handles the uploads in key order:**
   - **Expired, and pending for over 24 hours:** their keys go into batch
     deletes, the sidecars in a batch of their own after all other keys; a
     pending one first gets its multipart upload aborted (1 call; again in
     each run while its deletion takes several).
   - **An upload whose keys the listing did not all see, and the legacy
     records of a current upload:** listed and deleted under
     `<prefix>/<id>/` (or only `.downloads/` for a current upload) with
     `deleteUnder()`, **one such upload per run and one round**: a list of
     at most 100 keys without metadata and a delete, plus 1 for the
     sidecar, deleted on its own once everything else is gone. An upload
     with more keys takes several runs; the run stops at it, and the next
     starts there.
5. **Saves the cursor** (1 call, only if it changed): after the last upload
   it finished. If it reached the end of the bucket, the next run starts at
   the beginning.

**Work per run** (asserted in `e2e/tests/node/r2-work-bounds.spec.ts`, 415
objects per list call): at most **3 list calls of at most 100 objects**
(the slice, a jump, one `deleteUnder()` round), so at most 300 objects
examined (usually one call of 100); at most 3 summaries written; and at
most **45 R2 calls** (`CLEANUP_BUDGET`), a second guard from the time 50
subrequests were assumed: a run's own work needs at most 17 (cursor read
and write, 2 lists, 6 for summaries, 3 for `deleteUnder()`, 4 batch
deletes), so the rest only limits multipart aborts. 100 rather than a
page's 150 because a run may list three times. Measured at the bounds of
round 1I (200 objects, 10 summaries; see "Measurements (phase 1J)"): p50
6–7 ms for a plain run or one with deletes, 12 (p90 14) with a
`deleteUnder()` round, 19 (p90 22) with 10 summaries, so the limit and the
summaries were lowered in round 1K. _Estimates, not measured:_ at most
about 2.9 + 100 × 0.015 + 3 × 1.26 ≈ 8.2 ms for a run with 3 summaries,
and about 2.9 + 300 × 0.015 ≈ 7.4 ms for one with a `deleteUnder()` round.

**The sidecar goes last** because it is what makes the listing see an
upload: when a run (or a `DELETE /api/uploads/:id`) stops half-way, what is
left still has its sidecar, and the next run finds it stale and goes on.
Keys left without a sidecar would never be cleaned up.

**Never cleaned up by the cron:** uploads whose sidecar it cannot read
(not valid JSON or not shaped like one, see above; such a sidecar never
stops a run), and an upload directory with more keys that yeet does not
write sorting before its `.meta.json` than a run lists (outside
`.downloads/` and `.parts/`; 100 at 100 objects per list call): no run
reaches its sidecar, so none sees it as stale; each returns it unread and
goes on after it instead of stalling (`e2e/tests/node/r2-adversarial-1g.spec.ts`,
with 30,000 such keys). yeet itself never writes such keys.

**A jump answered with a short or empty page** (see "Listing a page"):
the run reads the sidecar of the upload whose `.downloads/` run it ended
in (1 call of its budget), and so knows whether it is stale. Before round
1J it handled the upload as current and deleted only its records, which
was harmless: a later run lists it whole once few enough records are
left (`e2e/tests/node/verify-1i.spec.ts`, with every jump empty: 12 runs
before the fix, 11 after, to clean up 3 uploads of 600 records or parts).

**Runs per bucket** (`e2e/tests/node/r2-capacity.spec.ts` and
`r2-work-bounds.spec.ts`; 415 objects per list call, every tenth upload
expired; a run is an hour):

| bucket                             | first run                       | runs to finish |
| ---------------------------------- | ------------------------------- | -------------- |
| 1,000 uploads with a summary       | 4 deleted, 5 calls              | 21             |
| 5,000 uploads with a summary       | 4 deleted, 5 calls              | 103            |
| 1,000 uploads, none with a summary | 3 summaries, 0 deleted          | 334            |
| 5,000 uploads, none with a summary | 3 summaries, 0 deleted, 9 calls | 1,667          |
| the same, none expired             | 3 summaries                     | 1,667          |

So a bucket of N uploads with summaries is gone through in ceil(N / 49)
hours (49 = the 50 uploads of 100 objects, minus the last, left for the
next run; 5,000 uploads in about 4.3 days); one without summaries in
ceil(N / 3) hours (72 a day). Deleting a run of legacy records or part
records takes one run per about 100 keys (a stale upload with 30,000 such
keys: 344 runs). At the bounds of round 1I: ceil(N / 99) and N / 10 hours,
169 runs. Expired files are refused at request time regardless (the page,
the form and `/_dl` check `expires_at`), so a later deletion costs only
storage; `yeet list` shows them as expired until then.

Without summaries the deletions wait: a run gives 3 sidecars their
summary and stops after the last of them. So do sidecars that can never
get one: each takes an attempt in every run that reaches it, so a bucket
with 300 of them in a row needs 100 runs to get past them, on every pass
(`r2-adversarial-1g.spec.ts`: 3,000 unreadable sidecars, 1,050 runs).
Hence the one-time script below for a bucket of yeet < 0.2 uploads, and
the advice to repair or delete unreadable sidecars.

**Local tests** (`wrangler dev`, the shared e2e bucket): one cron run no
longer gets through the test bucket, so the e2e tests trigger runs until
their upload has been reached (`cronUntil()` in `e2e/lib/bucket.ts`).

### To measure next (on a real deploy)

Phase 1J measured what the earlier list asked for (see "Measurements
(phase 1J)"). What remains is a **short control measurement of the bounds
of round 1K**, on the same kind of deploy, against the estimates above:

- `GET /api/uploads`: a full page (150 objects, 74 uploads; estimated
  about 4.7 ms), one with 5 sidecar reads, and one with a jump (300
  objects), during a walk and repeated; and `yeet list` through a bucket
  of several thousand uploads.
- The cron: a plain run of 100 objects, one with deletes, one with 3
  summaries (estimated about 8.2 ms at worst), and one with a
  `deleteUnder()` round (estimated about 7.4 ms).
- `POST /api/uploads/:id/complete` of an upload of unknown size with 300
  part records (estimated about 6–10 ms) and with 301 (refused).
- If a page or a run is still over 10 ms, lower `PAGE_LIMIT`,
  `CLEANUP_LIST_LIMIT`, `PAGE_READS` or `CLEANUP_SUMMARIES` (or
  `MAX_UNSIZED_PARTS`). That is a change of the constant and of the
  numbers in this file: the tests compute what they expect from the
  constants, and `verify-1i.spec.ts` and `r2-capacity.spec.ts` check that
  this file states their values and the numbers derived from them.

### Migrating a bucket of yeet < 0.2 (one-time)

`packages/worker/scripts/backfill-summaries.mjs` gives every sidecar
without a summary its summary in one go, from your machine, instead of
the cron's 3 per hourly run. It lives in `packages/worker` because it needs
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
- **Safe:** a dry run unless `--apply`. The dry run reads every sidecar
  without a summary (gets only, no writes) and classifies it exactly as
  `--apply` would, so its `writable`, `unreadable` and `tooLarge` counts
  and its closing "Run again with --apply to write N summaries" are what
  `--apply` will find (before round 1I it counted every missing summary as
  writable and reported `unreadable` and `tooLarge` as 0). Idempotent: a second run finds
  nothing to do. Each write is conditional on the etag it read, so a
  download counted (or an upload deleted) in between is never overwritten;
  it is reported as `changed`, and the Worker wrote that sidecar's summary
  itself. Sidecars that are not valid JSON or not shaped like a sidecar
  (`{}`, `[]`, `"downloads": 5`, …) are left alone (`unreadable`), and so
  are ones whose summary would exceed 2,048 bytes (`tooLarge`); see
  "Sidecars that never get a summary" above.
- **Cost:** one list call per page of objects, plus a get per sidecar
  without a summary (dry run too) and a put per sidecar written. These are
  API calls from your machine, not Worker
  subrequests.
- **Output:** one JSON line, e.g.
  `{"apply":true,"sidecars":120,"missing":118,"writable":117,"written":117,"changed":0,"unreadable":1,"tooLarge":0}`;
  `--verbose` names each key on stderr. On stderr it also says how many
  summaries `--apply` would write (dry run) and how many sidecars can never
  get one.
- **Tested** on the in-memory bucket and, end to end, on a `wrangler dev`
  bucket (`e2e/tests/node/backfill.spec.ts`), and run on a real R2 bucket
  in the phase 1H measurement. Start with a dry run.

### Legacy download records (1D/1E)

The pre-release versions 1D and 1E wrote one empty object per download,
`<prefix>/<id>/.downloads/<at>_<random>`. They are no longer written or
counted: the listing jumps over them, the cron deletes them (as above,
about 100 per hourly run), and `DELETE /api/uploads/:id` removes them with their
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
