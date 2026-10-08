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
custom-metadata summary, cleanup, and `GET /api/uploads` and
`DELETE /api/uploads/:id` (beyond the auth changes above).

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
  - of a burst, at most 5 attempts per minute get as far as hashing; the rest
    get 429 without any hashing, a correct password among them included (no
    oracle: the same 429 as a wrong one);
  - successes cost no budget once they have finished. While a correct
    password is being hashed it holds a slot, and after its refund one more
    wrong password may be checked within the minute: still at most 5 wrong
    ones;
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
  value. Requests without any credentials, or with an invalid session cookie,
  are not guesses at the token (a session signature cannot be guessed) and
  are not counted.
- **Both credentials:** if an `Authorization` header is present, it alone
  decides. A wrong one gets 401 even with a valid session cookie.
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

### Missing or short token

- **Protected uploads:** the download page (`GET /:id/:filename`) and
  `POST /:id/download` also answer 500 with the message, because the download
  pass cannot be checked safely.
- **`/_dl/:id`:** refuses protected files (500) with a weak token. With a
  missing or short token anyone could sign download links.
- **Unprotected files:** keep working, including their download links.

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

### Download count: one object per download

`recordDownload` used to read `.meta.json`, append the download and write it
back in `waitUntil`. Downloads close together read the same sidecar and
overwrote each other's record (on real Cloudflare 6 downloads were counted as
5; under `wrangler dev`, 10 at once as 2). It also kept only the last 50
records, so the count never went past 50. Evaluated:

- **Conditional writes** (`put` with `onlyIf: { etagMatches }`, re-read and
  retry on a conflict). Exact only while the retries last: with n concurrent
  downloads the last one needs up to n rounds of get + put, so a burst either
  exceeds the 50-subrequest budget or, with a retry cap, loses counts again.
- **A Durable Object per upload** that serializes the read-modify-write. Exact,
  but a second DO class (and migration), one DO request per download against
  the daily quota the rate limiter also uses, and the DO would still have to
  write the sidecar, so listing stays as it is.
- **One empty object per download** (chosen). `<prefix>/<id>/.downloads/<at>_<random>`,
  with `<at>` the ISO 8601 time and 8 random hex digits. Every download writes
  its own key, so nothing can be lost; it is one `put` (one subrequest, the
  same as the old sidecar write, minus the read) and no extra CPU.

How the rest follows:

- **Listing:** `listAll()` already lists every object under the prefix (one
  call per 1000 objects, with custom metadata). It counts each upload's
  `.downloads/` objects in that same pass and adds them to the summary:
  `download_count` = the sidecar's count + the records, `recent_downloads` =
  the last five of both (keys list in time order). No extra subrequests per
  upload. The cost: each download is one more object in the listing, so 1000
  downloads cost one more list call. Records therefore must not pile up; see
  "Keeping the records bounded" below.
- **Delete and cleanup:** both already delete every object under
  `<prefix>/<id>/`, records included. Records without an upload (a download
  that raced a delete or expiry) are listed as `stray`: `listAll()` reads no
  sidecar for them, `GET /api/uploads` omits them and the cleanup deletes them.
- **Compatibility:** sidecars keep `downloads` from earlier versions, which is
  no longer written. Their count still shows (summary or sidecar), and new
  records add to it; the cap of 50 no longer applies to new downloads. A file
  named `.downloads` is a different key (`<id>/.downloads`, no slash) and is
  not mistaken for a record.

#### Keeping the records bounded

Unprotected downloads need no credentials, so a script can download one link
tens of thousands of times. Unbounded, ~49,000 records push `GET /api/uploads`
and the cron past the 50-subrequest budget (and their CPU), and the cleanup
stops for every upload. Three measures, together:

1. **The cron folds the records into the sidecar** (`foldDownloads()`). For
   each upload with records it reads the sidecar, adds them to the sidecar's
   own `download_count` and `recent_downloads` (new fields, which replace a
   legacy `downloads` array: its count and last five times are carried over
   and the array dropped), writes the sidecar with its summary custom metadata
   (`summarize()` reads the new fields, so the summary stays consistent), and
   then deletes the records it counted. The sidecar write is conditional on
   the etag read (`onlyIf: { etagMatches }`), so a sidecar deleted or changed
   meanwhile is never written back. A download recorded during the fold has a
   key the fold did not list; it stays for the next one. Cost per upload: a
   get, a put and a delete per 1000 records. The cron spends at most 45
   subrequests in all (list calls, aborts and deletes of stale uploads
   first), folding the uploads with the most records first; the rest wait a
   day. So the bucket holds about one day of records.
   - If deleting the records fails after the sidecar was written, they are
     counted again at the next fold (logged). The alternative order, deleting
     first, would lose them instead.
2. **At most 1,000 records per upload between two folds** (`RECORD_CAP`).
   `recordDownload()` first lists the upload's records (one call, at most
   1,000 keys) and writes nothing if there are 1,000. Normal use is counted
   exactly; past 1,000 downloads of one upload in a day, the count stops
   growing until the next fold (an undercount, never an overcount). That is a
   second subrequest per download (in `waitUntil`, after the response) and a
   class A operation, like the `put`.
3. **The listing counts at most 2,000 records per upload**
   (`LISTED_RECORDS_LIMIT`, two days' worth). Past it, `listAll()` jumps over
   the rest of that upload's records with `startAfter`, so it never pages
   through more than that per upload, whatever is in the bucket (e.g. records
   written before this version). The count shown is then too low until the
   folds catch up: each cron run folds (or, for an expired upload, deletes)
   the records it counted, and the rest the next day; stray records left of
   a deleted upload go the same way. `DELETE /api/uploads/:id` still deletes
   them all (with the records bounded, a few list and delete calls).

Not chosen: rate-limiting the recording per IP and upload. It would need a
Durable Object call per download, against the daily quota the login and
password limits rely on; the cap bounds the objects without it.

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
