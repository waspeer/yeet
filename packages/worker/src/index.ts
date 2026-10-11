import type * as SentryModule from "@sentry/cloudflare";
import { Hono, type Context } from "hono";
import { getCookie } from "hono/cookie";
import {
  createDownloadPass,
  createSession,
  hashPassword,
  isAuthorized,
  isCorrectToken,
  isSupportedHash,
  isUsableToken,
  nowSeconds,
  SESSION_MAX_AGE,
  signDownload,
  TOKEN_TOO_SHORT,
  verifyDownload,
  verifyDownloadPass,
  verifyPassword,
  verifySession,
} from "./crypto.js";
import {
  rateLimit,
  RateLimiter,
  refundAttempt,
  reserveAttempt,
  RULES,
  type RateLimitResult,
} from "./rate-limit.js";
import {
  encodeListCursor,
  isBearerAttempt,
  parseExpiry,
  parseListCursor,
  partCount,
  rateLimitClient,
  readTextUpTo,
} from "./parse.js";
import { formatRange, parseRange } from "./range.js";
import { withOptionalSentry } from "./sentry.js";
import {
  downloadPage,
  errorPage,
  landingPage,
  loginPage,
  notFoundPage,
  tooManyAttempts,
} from "./template.js";
import { uploadPage } from "./upload-page.js";
import { runCleanup } from "./cleanup.js";
import {
  DELETED_UPLOAD_ID,
  generateId,
  isExpired,
  isValidFilename,
  isUploading,
  isValidId,
  MAX_UNSIZED_PARTS,
  PART_RECORDS_BUDGET,
  Uploads,
} from "./uploads.js";

export { RateLimiter };

export interface Env {
  BUCKET: R2Bucket;
  /** Counters for failed login, password and bearer-token attempts. */
  RATE_LIMITER: DurableObjectNamespace<RateLimiter>;
  /** Secret the CLI sends as a bearer token, and that the browser logs in with. */
  UPLOAD_TOKEN?: string;
  UPLOADS_PREFIX?: string;
  DOWNLOAD_URL_TTL?: string;
  SENTRY_DSN?: string;
}

/**
 * Size of each part of a multipart upload. R2 wants equal-sized parts (except
 * the last) of at least 5 MiB, and a Worker on the free plan accepts request
 * bodies up to 100 MB, so the CLI sends files in 50 MiB pieces.
 */
const PART_SIZE = 50 * 1024 * 1024;

/** The longest lifetime of an upload, in seconds: 365 days. */
const MAX_EXPIRES_IN = 365 * 24 * 60 * 60;

/** How long a download pass (after a correct password) lasts at most. */
const DOWNLOAD_PASS_MAX_AGE = 24 * 60 * 60;

const SESSION_COOKIE = "yeet_session";

/** Upload IDs that would collide with a page route. */
const RESERVED_IDS = new Set(["upload", "health", "logout"]);

type AppEnv = { Bindings: Env; Variables: { uploads: Uploads } };
type Ctx = Context<AppEnv>;

/** Set once Sentry has been loaded, which only happens when SENTRY_DSN is set. */
let sentry: typeof SentryModule | undefined;

/** Sentry, if this request's environment enables it. */
function sentryFor(env: Env): typeof SentryModule | undefined {
  return env.SENTRY_DSN ? sentry : undefined;
}

const app = new Hono<AppEnv>();

app.use("*", async (c, next) => {
  c.set("uploads", new Uploads(c.env.BUCKET, c.env.UPLOADS_PREFIX || "uploads"));
  await next();
  // No other site may frame a page of ours (clickjacking of the login,
  // upload and download forms): CSP for current browsers, X-Frame-Options
  // for older ones. Harmless on everything else, so set on every response.
  c.res.headers.set("Content-Security-Policy", "frame-ancestors 'none'");
  c.res.headers.set("X-Frame-Options", "DENY");
});

function shareUrl(origin: string, id: string, filename: string): string {
  return `${origin}/${id}/${encodeURIComponent(filename)}`;
}

/** RFC 8187 encoding for Content-Disposition, which forbids the bare sub-delimiters. */
function encodeRfc8187(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (ch) => "%" + ch.charCodeAt(0).toString(16).toUpperCase(),
  );
}

// ---------------------------------------------------------------------------
// Browser requests: cookies, origin checks, rate limits
// ---------------------------------------------------------------------------

/**
 * The client as the rate limits know it: the address Cloudflare saw, an IPv6
 * one by its /64 (see rateLimitClient()).
 */
function clientIp(c: Ctx): string {
  return rateLimitClient(c.req.header("CF-Connecting-IP") ?? "unknown");
}

function isHttps(c: Ctx): boolean {
  return new URL(c.req.url).protocol === "https:";
}

/**
 * A cookie with the attributes every yeet cookie shares. `Secure` only on
 * https, so the cookie also works on http://localhost (WebKit drops Secure
 * cookies there).
 */
function cookie(
  c: Ctx,
  name: string,
  value: string,
  opts: { maxAge: number; path: string; sameSite: "Strict" | "Lax" },
): string {
  const secure = isHttps(c) ? "; Secure" : "";
  return `${name}=${value}; Max-Age=${opts.maxAge}; Path=${opts.path}; HttpOnly; SameSite=${opts.sameSite}${secure}`;
}

/**
 * The checks that make a cookie-authenticated request safe from cross-site
 * request forgery: `Origin` must be our own origin (required for unsafe
 * methods), and `Sec-Fetch-Site`, when the browser sends it, `same-origin`.
 */
function isSameOrigin(c: Ctx, requireOrigin: boolean): boolean {
  const origin = c.req.header("Origin");
  if (origin === undefined ? requireOrigin : origin !== new URL(c.req.url).origin) return false;
  const site = c.req.header("Sec-Fetch-Site");
  return site === undefined || site === "same-origin";
}

function isUnsafeMethod(method: string): boolean {
  return method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
}

function setRetryAfter(c: Ctx, limit: RateLimitResult): void {
  c.header("Retry-After", String(limit.retryAfter));
}

async function hasSession(c: Ctx, token: string): Promise<boolean> {
  return verifySession(token, getCookie(c, SESSION_COOKIE));
}

function downloadPassCookieName(id: string): string {
  return `yeet_dl_${id}`;
}

async function hasDownloadPass(c: Ctx, token: string, id: string): Promise<boolean> {
  return verifyDownloadPass(token, id, getCookie(c, downloadPassCookieName(id)));
}

// ---------------------------------------------------------------------------
// API — everything below requires the upload token or a browser session
// ---------------------------------------------------------------------------

const api = new Hono<AppEnv>();

api.use("*", async (c, next) => {
  const token = c.env.UPLOAD_TOKEN;
  if (!isUsableToken(token)) return c.json({ error: TOKEN_TOO_SHORT }, 500);

  // The CLI: an Authorization header decides on its own, without cookies or
  // origin checks. Every attempt is checked against the failure limit before
  // its result is revealed, and only wrong tokens count.
  const authorization = c.req.header("Authorization");
  if (isBearerAttempt(authorization)) {
    const valid = await isAuthorized(authorization, token);
    const limit = await rateLimit(c.env.RATE_LIMITER, RULES.bearer, clientIp(c), !valid);
    if (!limit.allowed) {
      setRetryAfter(c, limit);
      return c.json({ error: `Too many attempts, retry in ${limit.retryAfter} s` }, 429);
    }
    if (!valid) return c.json({ error: "Invalid upload token" }, 401);
    return next();
  }

  // The browser: a session cookie, plus the same-origin checks against CSRF.
  if (!(await hasSession(c, token))) return c.json({ error: "Invalid upload token" }, 401);
  if (!isSameOrigin(c, isUnsafeMethod(c.req.method))) {
    return c.json({ error: "Cross-origin request refused" }, 403);
  }
  await next();
});

// GET /api/me — lets `yeet login` check the URL and token
api.get("/me", (c) => c.json({ ok: true }));

// GET /api/uploads[?cursor=…] — one page of finished uploads, newest first
// within the page (see listPage(): a bounded amount of work per request).
// `cursor` is where the next page starts: pass it back as `?cursor=`; null
// on the last page, which alone has no `truncated: true`. A client that
// ignores both (yeet 0.2's CLI) gets the first page and its note that only
// part of the uploads is shown.
api.get("/uploads", async (c) => {
  const origin = new URL(c.req.url).origin;
  const uploads = c.get("uploads");
  const cursors = c.req.queries("cursor") ?? [];
  let after: string | undefined;
  if (cursors.length > 0) {
    const parsed = cursors.length === 1 ? parseListCursor(cursors[0]!, uploads.listPrefix) : null;
    if (parsed === null) return c.json({ error: "Invalid cursor" }, 400);
    after = parsed;
  }
  const page = await uploads.listPage(after);
  const result = page.uploads.map((upload) => ({
    ...upload,
    url: shareUrl(origin, upload.id, upload.filename),
  }));
  return c.json({
    uploads: result,
    cursor: page.next === null ? null : encodeListCursor(page.next),
    ...(page.next !== null ? { truncated: true } : {}),
  });
});

function isSize(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

// POST /api/uploads — start an upload: { filename, size?, expires_in, password? }
api.post("/uploads", async (c) => {
  const body = await c.req
    .json<{ filename?: unknown; size?: unknown; expires_in?: unknown; password?: unknown }>()
    .catch(() => null);
  const filename = body?.filename;
  const size = body?.size;
  const expiresIn = body?.expires_in;
  const password = body?.password;

  if (typeof filename !== "string" || !isValidFilename(filename)) {
    return c.json({ error: "Invalid filename" }, 400);
  }
  if (size !== undefined && !isSize(size)) {
    return c.json({ error: "Invalid size" }, 400);
  }
  if (
    typeof expiresIn !== "number" ||
    !Number.isSafeInteger(expiresIn) ||
    expiresIn < 1 ||
    expiresIn > MAX_EXPIRES_IN
  ) {
    return c.json(
      { error: `Invalid expires_in: whole seconds from 1 to ${MAX_EXPIRES_IN} (365 days)` },
      400,
    );
  }
  if (password !== undefined && (typeof password !== "string" || password.length === 0)) {
    return c.json({ error: "Invalid password" }, 400);
  }

  const uploads = c.get("uploads");
  let id = generateId();
  while (RESERVED_IDS.has(id) || (await uploads.exists(id))) id = generateId();

  const multipart = await c.env.BUCKET.createMultipartUpload(uploads.fileKey(id, filename));
  const now = new Date();
  await uploads.writeMeta(id, {
    filename,
    ...(size !== undefined ? { file_size: size } : {}),
    uploaded_at: now.toISOString(),
    expires_at: new Date(now.getTime() + expiresIn * 1000).toISOString(),
    ...(password ? { password_hash: await hashPassword(password) } : {}),
    pending_upload_id: multipart.uploadId,
  });

  return c.json({ id, part_size: PART_SIZE }, 201);
});

/**
 * The exact length part `partNumber` must have in an upload of `size` bytes,
 * or null if the upload has no such part. Every part but the last is
 * PART_SIZE; an empty file is one empty part.
 */
function expectedPartLength(size: number, partNumber: number): number | null {
  const count = partCount(size, PART_SIZE);
  if (partNumber > count) return null;
  return partNumber < count ? PART_SIZE : size - (count - 1) * PART_SIZE;
}

// PUT /api/uploads/:id/parts/:number — one part of the file as the raw body
api.put("/uploads/:id/parts/:number", async (c) => {
  const { id } = c.req.param();
  // Plain decimal digits only: no "1.0", "0x1" or "01" for part 1.
  const rawPart = c.req.param("number");
  const partNumber = /^[1-9]\d{0,4}$/.test(rawPart) ? Number(rawPart) : NaN;
  if (!isValidId(id) || !(partNumber <= 10_000)) {
    return c.json({ error: "Invalid upload or part number" }, 400);
  }

  const contentLength = c.req.header("Content-Length");
  if (contentLength === undefined) return c.json({ error: "Content-Length required" }, 411);
  if (!/^\d+$/.test(contentLength)) return c.json({ error: "Invalid Content-Length" }, 400);
  const length = Number(contentLength);
  if (length > PART_SIZE) return c.json({ error: "Part larger than part_size" }, 413);

  const uploads = c.get("uploads");
  const meta = await uploads.readMeta(id);
  // (An upload whose deletion is under way is none, see Uploads.delete().)
  if (!isUploading(meta)) return c.json({ error: "No upload in progress" }, 404);

  // With the size known, every part's length is known: check it right away.
  // Without it, a short part is only wrong if a later part follows, which
  // `complete` checks from the recorded part sizes.
  if (meta.file_size !== undefined) {
    const expected = expectedPartLength(meta.file_size, partNumber);
    if (expected === null) {
      return c.json(
        { error: `Part ${partNumber} is beyond the declared size of ${meta.file_size} bytes` },
        400,
      );
    }
    if (length !== expected) {
      return c.json(
        {
          error:
            `Part ${partNumber} must be ${expected} bytes, got ${length}: every part except ` +
            `the last must be exactly part_size (${PART_SIZE} bytes)`,
        },
        400,
      );
    }
  }

  const multipart = c.env.BUCKET.resumeMultipartUpload(
    uploads.fileKey(id, meta.filename),
    meta.pending_upload_id,
  );
  const part = await multipart.uploadPart(partNumber, c.req.raw.body ?? new Uint8Array(0));
  if (meta.file_size === undefined) await uploads.writePartSize(id, partNumber, length);
  return c.json({ part_number: part.partNumber, etag: part.etag });
});

/** R2's limit on the parts of a multipart upload; part numbers are 1 to this. */
const MAX_PARTS = 10_000;

/**
 * The most bytes a complete request's body may have: 96 per entry of a
 * `parts` array of MAX_PARTS (`{"part_number":10000,"etag":"…"},` is 32
 * bytes besides the etag, which leaves 64 characters for it, twice the 32
 * of an MD5 in hex) and 1 KiB for the rest. 961,024 bytes; the 10,000
 * entries of phase 2's measurement were 669 KB.
 */
const MAX_COMPLETE_BODY = 1024 + MAX_PARTS * 96;

/**
 * The `parts` array of a complete request, or an error message. Only its
 * length is checked: arrays longer than R2 allows are refused before any
 * entry is looked at.
 */
function partList(value: unknown): unknown[] | string {
  if (!Array.isArray(value) || value.length === 0) return "Missing parts";
  if (value.length > MAX_PARTS) return `Invalid parts: at most ${MAX_PARTS}`;
  return value as unknown[];
}

/** The entries of a `parts` array (see partList()), sorted, or an error message. */
function parseParts(entries: unknown[]): { partNumber: number; etag: string }[] | string {
  const parts: { partNumber: number; etag: string }[] = [];
  for (const part of entries) {
    const { part_number: partNumber, etag } = (part ?? {}) as Record<string, unknown>;
    if (typeof partNumber !== "number" || !Number.isInteger(partNumber) || partNumber < 1) {
      return "Invalid parts: every part needs a part_number of 1 or more";
    }
    if (typeof etag !== "string" || etag.length === 0) {
      return `Invalid parts: part ${partNumber} needs an etag string`;
    }
    parts.push({ partNumber, etag });
  }
  parts.sort((a, b) => a.partNumber - b.partNumber);
  for (let i = 0; i < parts.length; i++) {
    if (parts[i]!.partNumber !== i + 1) {
      return i > 0 && parts[i]!.partNumber === parts[i - 1]!.partNumber
        ? `Invalid parts: part ${parts[i]!.partNumber} is listed twice`
        : `Invalid parts: part ${i + 1} is missing (parts must be numbered 1 to ${parts.length})`;
    }
  }
  return parts;
}

// POST /api/uploads/:id/complete — { parts: [{ part_number, etag }], size? }
api.post("/uploads/:id/complete", async (c) => {
  const { id } = c.req.param();
  if (!isValidId(id)) return c.json({ error: "Invalid upload" }, 400);

  // The body is bounded before it is parsed: by its Content-Length when it
  // has one, and while it is read in any case.
  const tooLarge = () =>
    c.json({ error: `Request body too large: at most ${MAX_COMPLETE_BODY} bytes` }, 413);
  const declared = c.req.header("Content-Length");
  if (declared !== undefined && Number(declared) > MAX_COMPLETE_BODY) return tooLarge();
  const text = await readTextUpTo(c.req.raw.body, MAX_COMPLETE_BODY);
  if (text === null) return tooLarge();
  let body: { parts?: unknown; size?: unknown } | null;
  try {
    body = JSON.parse(text) as { parts?: unknown; size?: unknown } | null;
  } catch {
    body = null;
  }
  const entries = partList(body?.parts);
  if (typeof entries === "string") return c.json({ error: entries }, 400);
  if (body?.size !== undefined && !isSize(body.size)) {
    return c.json({ error: "Invalid size" }, 400);
  }

  const uploads = c.get("uploads");
  const read = await uploads.readMetaVersion(id);
  const meta = read?.meta;
  // Already finished: a client sending complete again because the answer
  // to its first one was lost (the upload page retries) gets that answer.
  // The entries are not used, so not looked at either.
  if (read && !meta?.pending_upload_id && typeof meta?.filename === "string") {
    return c.json({ id, url: shareUrl(new URL(c.req.url).origin, id, meta.filename) });
  }
  // (An upload whose deletion is under way is none, see Uploads.delete().)
  if (!read || !isUploading(meta)) return c.json({ error: "No upload in progress" }, 404);

  // Size known at create: every part was checked on PUT, so the upload has
  // exactly this many, and a list of any other length can never complete
  // (a shorter one would make a shorter file). Checked before the entries
  // are looked at: validating and sorting 10,000 of them cost p90 18 ms
  // CPU on Workers Free (phase 2).
  if (meta.file_size !== undefined) {
    const count = partCount(meta.file_size, PART_SIZE);
    if (entries.length !== count) {
      return c.json(
        {
          error:
            `Invalid parts: an upload of ${meta.file_size} bytes has ${count} ` +
            `part${count === 1 ? "" : "s"} (part_size ${PART_SIZE} bytes), not ${entries.length}`,
        },
        400,
      );
    }
  }

  // Size unknown at create: refused before anything is changed if there are
  // more parts or part records than one request reads (MAX_UNSIZED_PARTS),
  // or if the records cannot be listed and deleted within
  // PART_RECORDS_BUDGET R2 calls. The count is checked before the entries
  // are looked at (round 2F), like the sized count above: a longer list can
  // never complete, whatever its entries.
  const tooMany = () =>
    c.json(
      {
        error:
          `Too many parts to complete an upload of unknown size (at most ${MAX_UNSIZED_PARTS}); ` +
          `start the upload again and send its size ("size" in POST /api/uploads)`,
      },
      400,
    );
  if (meta.file_size === undefined && entries.length > MAX_UNSIZED_PARTS) return tooMany();

  const parts = parseParts(entries);
  if (typeof parts === "string") return c.json({ error: parts }, 400);

  // Size unknown at create: check the layout R2 requires from the recorded
  // part sizes, so the client gets a clear error instead of R2's.
  let partRecords: string[] = [];
  if (meta.file_size === undefined) {
    const records = await uploads.readPartSizes(id, PART_RECORDS_BUDGET, MAX_UNSIZED_PARTS);
    if (!records) return tooMany();
    const { sizes, keys } = records;
    partRecords = keys;
    const missing = parts.find(({ partNumber }) => !sizes.has(partNumber));
    if (missing) return c.json({ error: `Part ${missing.partNumber} was not uploaded` }, 400);
    for (const { partNumber } of parts) {
      const size = sizes.get(partNumber)!;
      if (partNumber < parts.length && size !== PART_SIZE) {
        return c.json(
          {
            error:
              `Part ${partNumber} is ${size} bytes but is followed by more parts: every part ` +
              `except the last must be exactly part_size (${PART_SIZE} bytes)`,
          },
          400,
        );
      }
    }
  }

  const multipart = c.env.BUCKET.resumeMultipartUpload(
    uploads.fileKey(id, meta.filename),
    meta.pending_upload_id,
  );
  let object: R2Object;
  try {
    object = await multipart.complete(parts);
  } catch (err) {
    // R2 refused (round 2C+2). Not always the client's fault: another
    // request may have completed this multipart upload meanwhile (a
    // complete sent again while the first still runs; then the file
    // exists and this request finishes like that one, the conditional
    // sidecar write keeping it to one), or a DELETE may have aborted it.
    // Only on this path: 1 head, and without a file 1 sidecar read.
    const made = await c.env.BUCKET.head(uploads.fileKey(id, meta.filename));
    if (made) {
      object = made;
    } else {
      // No file but a finished sidecar is no second complete (that one's
      // file exists): a DELETE has deleted the file and not yet the
      // sidecar (round 2D). A link to it would be dead, so it is deleted.
      const now = await uploads.readSidecar(id);
      if (
        !now.meta ||
        now.meta.pending_upload_id === DELETED_UPLOAD_ID ||
        !now.meta.pending_upload_id
      ) {
        return c.json({ error: "No upload in progress: it was deleted" }, 404);
      }
      const detail = err instanceof Error ? ` (${err.message})` : "";
      return c.json(
        {
          error: `Could not complete the upload; check that every part was uploaded and its etag is right${detail}`,
        },
        400,
      );
    }
  }

  const expected = [meta.file_size, body?.size as number | undefined].find(
    (size) => size !== undefined && size !== object.size,
  );
  if (expected !== undefined) {
    await uploads.delete(id, { ...meta, pending_upload_id: undefined });
    return c.json(
      {
        error: `Size mismatch: expected ${expected} bytes, stored ${object.size}`,
        expected_size: expected,
        stored_size: object.size,
      },
      422,
    );
  }

  // Conditional on the sidecar read above: a DELETE since then wins
  // (see Uploads.finishUpload()).
  if ((await uploads.finishUpload(id, meta, read.etag, object.size)) === "deleted") {
    return c.json({ error: "No upload in progress: it was deleted" }, 404);
  }
  if (partRecords.length > 0) await uploads.deleteKeys(partRecords);
  return c.json({ id, url: shareUrl(new URL(c.req.url).origin, id, meta.filename) });
});

// DELETE /api/uploads/:id — remove an upload, finished or not
api.delete("/uploads/:id", async (c) => {
  const { id } = c.req.param();
  if (!isValidId(id)) return c.json({ error: "Invalid upload" }, 400);
  const uploads = c.get("uploads");
  // At most DELETE_LIMIT objects per request. With more left, `202` and
  // `done: false`: the upload is gone for users already (Uploads.delete()),
  // and another DELETE (the CLI makes them) or the cron deletes the rest.
  const result = await uploads.delete(id, await uploads.readMeta(id).catch(() => null));
  if (!result.found) return c.json({ error: "Not found" }, 404);
  if (!result.done) return c.json({ deleted: id, done: false }, 202);
  return c.json({ deleted: id });
});

// Registered before the public pages, whose /:id/:filename? would match /api/*.
app.route("/api", api);

// ---------------------------------------------------------------------------
// Browser login — registered before /:id/:filename?, which would match /upload
// ---------------------------------------------------------------------------

// GET /upload — the login form, or the upload page once logged in
app.get("/upload", async (c) => {
  c.header("Cache-Control", "no-store");
  const token = c.env.UPLOAD_TOKEN;
  if (!isUsableToken(token)) return c.html(errorPage(TOKEN_TOO_SHORT), 500);
  return c.html((await hasSession(c, token)) ? uploadPage() : loginPage());
});

// POST /login — form field `token`; sets the session cookie
app.post("/login", async (c) => {
  c.header("Cache-Control", "no-store");
  const token = c.env.UPLOAD_TOKEN;
  if (!isUsableToken(token)) return c.html(errorPage(TOKEN_TOO_SHORT), 500);
  if (!isSameOrigin(c, true)) return c.html(errorPage("Cross-origin request refused"), 403);

  const form = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
  // Pasting on a phone can add spaces or a newline; the stored token is never altered.
  const candidate = typeof form["token"] === "string" ? form["token"].trim() : "";
  const valid = candidate.length > 0 && (await isCorrectToken(candidate, token));

  const limit = await rateLimit(c.env.RATE_LIMITER, RULES.login, clientIp(c), !valid);
  if (!limit.allowed) {
    setRetryAfter(c, limit);
    return c.html(loginPage({ error: tooManyAttempts(limit.retryAfter) }), 429);
  }
  if (!valid) return c.html(loginPage({ error: "That token is not correct." }), 401);

  c.header(
    "Set-Cookie",
    cookie(c, SESSION_COOKIE, await createSession(token), {
      maxAge: SESSION_MAX_AGE,
      path: "/",
      sameSite: "Strict",
    }),
  );
  return c.redirect("/upload", 303);
});

// POST /logout — clears the session cookie
app.post("/logout", (c) => {
  c.header("Cache-Control", "no-store");
  if (!isSameOrigin(c, true)) return c.html(errorPage("Cross-origin request refused"), 403);
  c.header(
    "Set-Cookie",
    cookie(c, SESSION_COOKIE, "", { maxAge: 0, path: "/", sameSite: "Strict" }),
  );
  return c.redirect("/upload", 303);
});

// ---------------------------------------------------------------------------
// Public pages
// ---------------------------------------------------------------------------

app.get("/health", (c) => c.json({ status: "ok" }));

// GET / — the welcome page: what yeet is, this yeet's address, a way to
// /upload. The cheapest route: no R2 call, no session or token check, and
// the same page for everyone at this address (so a browser may keep it a while).
app.get("/", (c) => {
  c.header("Cache-Control", "public, max-age=300");
  return c.html(landingPage(new URL(c.req.url).origin));
});

// GET /_dl/:id — the file itself, behind a short-lived signed link that the
// password check hands out. Registered before /:id/:filename? so it wins.
app.get("/_dl/:id", async (c) => {
  const { id } = c.req.param();
  // Spelled exactly as signed (plain digits), or the link is invalid.
  const expires = parseExpiry(c.req.query("expires")) ?? NaN;
  const signature = c.req.query("sig") ?? "";
  const token = c.env.UPLOAD_TOKEN ?? "";
  if (!isValidId(id) || !(await verifyDownload(token, id, expires, signature))) {
    return c.html(errorPage("This download link is invalid or has expired."), 403);
  }

  const uploads = c.get("uploads");
  const meta = await uploads.readMeta(id);
  if (!meta || meta.pending_upload_id || isExpired(meta)) return c.html(notFoundPage(), 404);
  // With a missing or short token, anyone could sign links: never for protected files.
  if (meta.password_hash && !isUsableToken(token)) {
    return c.html(errorPage(TOKEN_TOO_SHORT), 500);
  }

  const key = uploads.fileKey(id, meta.filename);
  const range = parseRange(c.req.header("Range"));
  const unsatisfiable = async (size?: number): Promise<Response> => {
    size ??= (await c.env.BUCKET.head(key))?.size;
    return new Response(null, {
      status: 416,
      headers: size === undefined ? {} : { "Content-Range": `bytes */${size}` },
    });
  };
  if (range && "suffix" in range && range.suffix === 0) return unsatisfiable();

  let object: R2ObjectBody | R2Object | null;
  try {
    // R2 gets the parsed range as a normalized header, so it applies HTTP's
    // rules (e.g. clamping a last position past the end) to exactly that.
    object = await c.env.BUCKET.get(
      key,
      range ? { range: new Headers({ Range: formatRange(range) }) } : {},
    );
  } catch {
    return unsatisfiable();
  }
  if (!object || !("body" in object)) return c.html(notFoundPage(), 404);

  // A range starting past the end is unsatisfiable; R2 would serve the whole file.
  if (range && "start" in range && range.start >= object.size) {
    await object.body.cancel();
    return unsatisfiable(object.size);
  }

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("ETag", object.httpEtag);
  headers.set("Accept-Ranges", "bytes");
  headers.set(
    "Content-Disposition",
    `attachment; filename*=UTF-8''${encodeRfc8187(meta.filename)}`,
  );
  headers.set("Cache-Control", "private, no-store");
  if (!headers.has("Content-Type")) headers.set("Content-Type", "application/octet-stream");

  // An empty file has no bytes to address; it is served whole.
  if (range && object.size > 0) {
    const last = object.size - 1;
    const [first, end] =
      "suffix" in range
        ? [Math.max(0, object.size - range.suffix), last]
        : [range.start, Math.min(range.end ?? last, last)];
    headers.set("Content-Range", `bytes ${first}-${end}/${object.size}`);
    headers.set("Content-Length", String(end - first + 1));
    return new Response(object.body, { status: 206, headers });
  }

  headers.set("Content-Length", String(object.size));
  return new Response(object.body, { headers });
});

// GET /:id and GET /:id/:filename — download page
app.get("/:id/:filename?", async (c) => {
  const { id } = c.req.param();
  if (!isValidId(id)) return c.html(notFoundPage(), 404);

  const uploads = c.get("uploads");
  const meta = await uploads.readMeta(id);
  if (!meta || meta.pending_upload_id) {
    const S = sentryFor(c.env);
    S?.logger.warn(S.logger.fmt`Download page visited for unknown file: ${id}`);
    return c.html(notFoundPage(), 404);
  }

  if (isExpired(meta)) {
    const S = sentryFor(c.env);
    S?.logger.info(S.logger.fmt`Download page visited for expired file: ${id} (${meta.filename})`);
    c.executionCtx.waitUntil(uploads.delete(id, meta).catch(() => {}));
    return c.html(notFoundPage(), 404);
  }

  // A valid download pass (from an earlier correct password) hides the password field.
  let hasPassword = !!meta.password_hash;
  if (hasPassword) {
    const token = c.env.UPLOAD_TOKEN;
    if (!isUsableToken(token)) return c.html(errorPage(TOKEN_TOO_SHORT), 500);
    if (await hasDownloadPass(c, token, id)) hasPassword = false;
  }

  return c.html(
    downloadPage({
      id,
      filename: meta.filename,
      fileSize: meta.file_size ?? 0,
      expiresAt: meta.expires_at,
      hasPassword,
    }),
  );
});

// POST /:id/download — check the password, then redirect to a signed link
app.post("/:id/download", async (c) => {
  const { id } = c.req.param();
  if (!isValidId(id)) return c.html(notFoundPage(), 404);

  const uploads = c.get("uploads");
  const meta = await uploads.readMeta(id);
  if (!meta || meta.pending_upload_id) {
    const S = sentryFor(c.env);
    S?.logger.warn(S.logger.fmt`Download attempted for unknown file: ${id}`);
    return c.html(notFoundPage(), 404);
  }

  if (isExpired(meta)) {
    const S = sentryFor(c.env);
    S?.logger.warn(S.logger.fmt`Download attempted for expired file: ${id} (${meta.filename})`);
    c.executionCtx.waitUntil(uploads.delete(id, meta).catch(() => {}));
    return c.html(notFoundPage(), 404);
  }

  const fileExpires = Math.floor(new Date(meta.expires_at).getTime() / 1000);

  if (meta.password_hash) {
    if (!isSupportedHash(meta.password_hash)) {
      return c.html(
        errorPage(
          "This link was made with an older version of yeet and can no longer be opened. Ask the sender to share the file again.",
        ),
        410,
      );
    }
    const token = c.env.UPLOAD_TOKEN;
    if (!isUsableToken(token)) return c.html(errorPage(TOKEN_TOO_SHORT), 500);

    // A valid download pass skips the (CPU-heavy) password check.
    if (!(await hasDownloadPass(c, token, id))) {
      const page = (status: 401 | 429, errorMessage: string) =>
        c.html(
          downloadPage({
            id,
            filename: meta.filename,
            fileSize: meta.file_size ?? 0,
            expiresAt: meta.expires_at,
            hasPassword: true,
            errorMessage,
          }),
          status,
        );

      // The attempt is counted as a failure before hashing, in the same step
      // as the check, so a parallel burst gets no more than the limit through
      // and a client over the limit costs no PBKDF2. A correct password
      // refunds it below.
      const rateKey = `${clientIp(c)}:${id}`;
      const reservation = await reserveAttempt(c.env.RATE_LIMITER, RULES.downloadPassword, rateKey);
      if (!reservation.allowed) {
        setRetryAfter(c, reservation);
        return page(429, tooManyAttempts(reservation.retryAfter));
      }

      const body = await c.req.parseBody();
      const password = typeof body["password"] === "string" ? body["password"] : "";
      if (!(await verifyPassword(password, meta.password_hash))) {
        const S = sentryFor(c.env);
        S?.logger.warn(S.logger.fmt`Incorrect password attempt for file: ${id} (${meta.filename})`);
        return page(401, "Incorrect password. Please try again.");
      }
      await refundAttempt(c.env.RATE_LIMITER, RULES.downloadPassword, rateKey, reservation);

      const maxAge = Math.min(DOWNLOAD_PASS_MAX_AGE, fileExpires - nowSeconds());
      if (maxAge > 0) {
        const pass = await createDownloadPass(token, id, nowSeconds() + maxAge);
        c.header(
          "Set-Cookie",
          cookie(c, downloadPassCookieName(id), pass, { maxAge, path: `/${id}`, sameSite: "Lax" }),
        );
      }
    }
  }

  // Count the download without holding up the redirect.
  const at = new Date().toISOString();
  c.executionCtx.waitUntil(
    uploads
      .recordDownload(id, at)
      .then((counted) => {
        if (!counted)
          console.log(`[download] Download of ${id} not counted (sidecar kept changing)`);
      })
      .catch((err) => {
        console.error(`[download] Failed to record download for ${id}:`, err);
      }),
  );

  // The signed link is a bearer token: until it expires it works without the
  // password. Its lifetime is therefore clamped to the file's own expiry.
  const ttl = Number(c.env.DOWNLOAD_URL_TTL) || 3600;
  const expires = Math.min(nowSeconds() + ttl, fileExpires);
  const sig = await signDownload(c.env.UPLOAD_TOKEN ?? "", id, expires);
  return c.redirect(`/_dl/${id}?expires=${expires}&sig=${sig}`, 303);
});

app.onError((err, c) => {
  sentryFor(c.env)?.captureException(err);
  console.error(err);
  if (c.req.path.startsWith("/api/")) return c.json({ error: "Internal server error" }, 500);
  return c.html(errorPage(), 500);
});

// ---------------------------------------------------------------------------
// Hourly cleanup of expired and abandoned uploads (a bounded slice per run)
// ---------------------------------------------------------------------------

async function cleanup(env: Env): Promise<void> {
  const report = await runCleanup(env.BUCKET, env.UPLOADS_PREFIX || "uploads");
  if (report.deleted > 0) {
    console.log(`[cleanup] Deleted ${report.deleted} expired or abandoned upload(s)`);
  }
  if (report.recordsCleared > 0) {
    console.log(
      `[cleanup] Deleted the legacy download records of ${report.recordsCleared} upload(s)`,
    );
  }
  if (report.summarized > 0) {
    console.log(`[cleanup] Added the summary to ${report.summarized} older sidecar(s)`);
  }
  if (report.cursor)
    console.log(`[cleanup] Not done; the next run continues after ${report.cursor}`);
}

export default withOptionalSentry<Env, Request, ScheduledController, ExecutionContext, Response>(
  () => ({
    fetch: (request, env, ctx) => app.fetch(request, env, ctx),
    scheduled(_controller, env, ctx) {
      ctx.waitUntil(cleanup(env));
    },
  }),
  async (handler) => {
    const Sentry = await import("@sentry/cloudflare");
    sentry = Sentry;
    return Sentry.withSentry(
      (env: Env) => ({
        dsn: env.SENTRY_DSN,
        integrations: [Sentry.consoleLoggingIntegration({ levels: ["warn", "error"] })],
      }),
      handler as ExportedHandler<Env>,
    ) as typeof handler;
  },
);
