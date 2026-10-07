import * as Sentry from "@sentry/cloudflare";
import { Hono } from "hono";
import {
  hashPassword,
  isAuthorized,
  isSupportedHash,
  signDownload,
  verifyDownload,
  verifyPassword,
} from "./crypto.js";
import { downloadPage, errorPage, landingPage, notFoundPage } from "./template.js";
import { generateId, isExpired, isValidFilename, isValidId, Uploads } from "./uploads.js";

export interface Env {
  BUCKET: R2Bucket;
  /** Secret the CLI sends as a bearer token to upload, list and delete. */
  UPLOAD_TOKEN: string;
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

/** Uploads still pending after this long are considered abandoned. */
const ABANDONED_AFTER_MS = 24 * 60 * 60 * 1000;

const app = new Hono<{ Bindings: Env; Variables: { uploads: Uploads } }>();

app.use("*", async (c, next) => {
  c.set("uploads", new Uploads(c.env.BUCKET, c.env.UPLOADS_PREFIX || "uploads"));
  await next();
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
// API for the CLI — everything below requires the upload token
// ---------------------------------------------------------------------------

const api = new Hono<{ Bindings: Env; Variables: { uploads: Uploads } }>();

api.use("*", async (c, next) => {
  if (!c.env.UPLOAD_TOKEN) {
    return c.json({ error: "UPLOAD_TOKEN is not set on the server" }, 500);
  }
  if (!(await isAuthorized(c.req.header("Authorization"), c.env.UPLOAD_TOKEN))) {
    return c.json({ error: "Invalid upload token" }, 401);
  }
  await next();
});

// GET /api/me — lets `yeet login` check the URL and token
api.get("/me", (c) => c.json({ ok: true }));

// GET /api/uploads — every finished upload, newest first
api.get("/uploads", async (c) => {
  const origin = new URL(c.req.url).origin;
  const result = (await c.get("uploads").listAll())
    // Finished uploads only; their summaries carry no pending_upload_id.
    .flatMap(({ id, meta }) =>
      meta && !meta.pending_upload_id
        ? [{ id, ...meta, url: shareUrl(origin, id, meta.filename) }]
        : [],
    )
    .sort((a, b) => b.uploaded_at.localeCompare(a.uploaded_at));

  return c.json({ uploads: result });
});

// POST /api/uploads — start an upload: { filename, size, expires_in, password? }
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
  if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0) {
    return c.json({ error: "Invalid size" }, 400);
  }
  if (typeof expiresIn !== "number" || !Number.isFinite(expiresIn) || expiresIn <= 0) {
    return c.json({ error: "Invalid expires_in (seconds)" }, 400);
  }
  if (password !== undefined && (typeof password !== "string" || password.length === 0)) {
    return c.json({ error: "Invalid password" }, 400);
  }

  const uploads = c.get("uploads");
  let id = generateId();
  while (await uploads.exists(id)) id = generateId();

  const multipart = await c.env.BUCKET.createMultipartUpload(uploads.fileKey(id, filename));
  const now = new Date();
  await uploads.writeMeta(id, {
    filename,
    file_size: size,
    uploaded_at: now.toISOString(),
    expires_at: new Date(now.getTime() + expiresIn * 1000).toISOString(),
    ...(password ? { password_hash: await hashPassword(password) } : {}),
    pending_upload_id: multipart.uploadId,
  });

  return c.json({ id, part_size: PART_SIZE }, 201);
});

// PUT /api/uploads/:id/parts/:number — one part of the file as the raw body
api.put("/uploads/:id/parts/:number", async (c) => {
  const { id } = c.req.param();
  const partNumber = Number(c.req.param("number"));
  if (!isValidId(id) || !Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10_000) {
    return c.json({ error: "Invalid upload or part number" }, 400);
  }

  const uploads = c.get("uploads");
  const meta = await uploads.readMeta(id);
  if (!meta?.pending_upload_id) return c.json({ error: "No upload in progress" }, 404);
  if (!c.req.raw.body) return c.json({ error: "Missing body" }, 400);

  const multipart = c.env.BUCKET.resumeMultipartUpload(
    uploads.fileKey(id, meta.filename),
    meta.pending_upload_id,
  );
  const part = await multipart.uploadPart(partNumber, c.req.raw.body);
  return c.json({ part_number: part.partNumber, etag: part.etag });
});

// POST /api/uploads/:id/complete — { parts: [{ part_number, etag }] }
api.post("/uploads/:id/complete", async (c) => {
  const { id } = c.req.param();
  if (!isValidId(id)) return c.json({ error: "Invalid upload" }, 400);

  const body = await c.req
    .json<{ parts?: { part_number: number; etag: string }[] }>()
    .catch(() => null);
  if (!Array.isArray(body?.parts)) return c.json({ error: "Missing parts" }, 400);

  const uploads = c.get("uploads");
  const meta = await uploads.readMeta(id);
  if (!meta?.pending_upload_id) return c.json({ error: "No upload in progress" }, 404);

  const multipart = c.env.BUCKET.resumeMultipartUpload(
    uploads.fileKey(id, meta.filename),
    meta.pending_upload_id,
  );
  const object = await multipart.complete(
    body.parts.map((part) => ({ partNumber: part.part_number, etag: part.etag })),
  );

  if (object.size !== meta.file_size) {
    await uploads.delete(id, { ...meta, pending_upload_id: undefined });
    return c.json(
      { error: `Size mismatch: expected ${meta.file_size} bytes, stored ${object.size}` },
      422,
    );
  }

  const { pending_upload_id: _, ...finished } = meta;
  await uploads.writeMeta(id, finished);
  return c.json({ id, url: shareUrl(new URL(c.req.url).origin, id, meta.filename) });
});

// DELETE /api/uploads/:id — remove an upload, finished or not
api.delete("/uploads/:id", async (c) => {
  const { id } = c.req.param();
  if (!isValidId(id)) return c.json({ error: "Invalid upload" }, 400);
  const uploads = c.get("uploads");
  const removed = await uploads.delete(id, await uploads.readMeta(id).catch(() => null));
  if (removed === 0) return c.json({ error: "Not found" }, 404);
  return c.json({ deleted: id });
});

// Registered before the public pages, whose /:id/:filename? would match /api/*.
app.route("/api", api);

// ---------------------------------------------------------------------------
// Public pages
// ---------------------------------------------------------------------------

app.get("/health", (c) => c.json({ status: "ok" }));

app.get("/", (c) => c.html(landingPage()));

// GET /_dl/:id — the file itself, behind a short-lived signed link that the
// password check hands out. Registered before /:id/:filename? so it wins.
app.get("/_dl/:id", async (c) => {
  const { id } = c.req.param();
  const expires = Number(c.req.query("expires"));
  const signature = c.req.query("sig") ?? "";
  if (!isValidId(id) || !(await verifyDownload(c.env.UPLOAD_TOKEN, id, expires, signature))) {
    return c.html(errorPage("This download link is invalid or has expired."), 403);
  }

  const uploads = c.get("uploads");
  const meta = await uploads.readMeta(id);
  if (!meta || meta.pending_upload_id || isExpired(meta)) return c.html(notFoundPage(), 404);

  let object: R2ObjectBody | R2Object | null;
  try {
    object = await c.env.BUCKET.get(uploads.fileKey(id, meta.filename), {
      range: c.req.raw.headers,
    });
  } catch {
    return new Response(null, { status: 416 });
  }
  if (!object || !("body" in object)) return c.html(notFoundPage(), 404);

  // A range starting past the end is unsatisfiable; R2 would serve the whole file.
  const rangeStart = c.req.header("Range")?.match(/^bytes=(\d+)-/)?.[1];
  if (rangeStart !== undefined && Number(rangeStart) >= object.size) {
    await object.body.cancel();
    return new Response(null, {
      status: 416,
      headers: { "Content-Range": `bytes */${object.size}` },
    });
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

  const range = object.range;
  if (c.req.header("Range") && range) {
    const offset =
      "suffix" in range && range.suffix !== undefined
        ? object.size - range.suffix
        : ((range as { offset?: number }).offset ?? 0);
    const length =
      "suffix" in range && range.suffix !== undefined
        ? range.suffix
        : ((range as { length?: number }).length ?? object.size - offset);
    headers.set("Content-Range", `bytes ${offset}-${offset + length - 1}/${object.size}`);
    headers.set("Content-Length", String(length));
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
    Sentry.logger.warn(Sentry.logger.fmt`Download page visited for unknown file: ${id}`);
    return c.html(notFoundPage(), 404);
  }

  if (isExpired(meta)) {
    Sentry.logger.info(
      Sentry.logger.fmt`Download page visited for expired file: ${id} (${meta.filename})`,
    );
    c.executionCtx.waitUntil(uploads.delete(id, meta).catch(() => {}));
    return c.html(notFoundPage(), 404);
  }

  return c.html(
    downloadPage({
      filename: meta.filename,
      fileSize: meta.file_size ?? 0,
      expiresAt: meta.expires_at,
      hasPassword: !!meta.password_hash,
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
    Sentry.logger.warn(Sentry.logger.fmt`Download attempted for unknown file: ${id}`);
    return c.html(notFoundPage(), 404);
  }

  if (isExpired(meta)) {
    Sentry.logger.warn(
      Sentry.logger.fmt`Download attempted for expired file: ${id} (${meta.filename})`,
    );
    c.executionCtx.waitUntil(uploads.delete(id, meta).catch(() => {}));
    return c.html(notFoundPage(), 404);
  }

  if (meta.password_hash) {
    if (!isSupportedHash(meta.password_hash)) {
      return c.html(
        errorPage(
          "This link was made with an older version of yeet and can no longer be opened. Ask the sender to share the file again.",
        ),
        410,
      );
    }
    const body = await c.req.parseBody();
    const password = typeof body["password"] === "string" ? body["password"] : "";
    if (!(await verifyPassword(password, meta.password_hash))) {
      Sentry.logger.warn(
        Sentry.logger.fmt`Incorrect password attempt for file: ${id} (${meta.filename})`,
      );
      return c.html(
        downloadPage({
          filename: meta.filename,
          fileSize: meta.file_size ?? 0,
          expiresAt: meta.expires_at,
          hasPassword: true,
          passwordError: true,
        }),
        401,
      );
    }
  }

  // Record the download without holding up the redirect.
  c.executionCtx.waitUntil(
    uploads.recordDownload(id, meta).catch((err) => {
      console.error(`[download] Failed to record download for ${id}:`, err);
    }),
  );

  // The signed link is a bearer token: until it expires it works without the
  // password. Its lifetime is therefore clamped to the file's own expiry.
  const ttl = Number(c.env.DOWNLOAD_URL_TTL) || 3600;
  const fileExpires = Math.floor(new Date(meta.expires_at).getTime() / 1000);
  const expires = Math.min(Math.floor(Date.now() / 1000) + ttl, fileExpires);
  const sig = await signDownload(c.env.UPLOAD_TOKEN, id, expires);
  return c.redirect(`/_dl/${id}?expires=${expires}&sig=${sig}`, 303);
});

app.onError((err, c) => {
  Sentry.captureException(err);
  console.error(err);
  if (c.req.path.startsWith("/api/")) return c.json({ error: "Internal server error" }, 500);
  return c.html(errorPage(), 500);
});

// ---------------------------------------------------------------------------
// Daily cleanup of expired and abandoned uploads
// ---------------------------------------------------------------------------

async function runCleanup(env: Env): Promise<void> {
  const uploads = new Uploads(env.BUCKET, env.UPLOADS_PREFIX || "uploads");
  const stale = (await uploads.listAll()).filter(({ meta }) => {
    if (!meta) return false; // unreadable sidecar: leave it for a human
    const abandoned =
      !!meta.pending_upload_id &&
      Date.now() - new Date(meta.uploaded_at).getTime() > ABANDONED_AFTER_MS;
    return isExpired(meta) || abandoned;
  });

  for (const { id, meta } of stale) {
    if (meta?.pending_upload_id)
      await uploads.abortPending(id, meta.filename, meta.pending_upload_id);
  }
  await uploads.deleteKeys(stale.flatMap(({ keys }) => keys));

  if (stale.length > 0)
    console.log(`[cleanup] Deleted ${stale.length} expired or abandoned upload(s)`);
}

export default Sentry.withSentry(
  (env: Env) => ({
    dsn: env.SENTRY_DSN,
    integrations: [Sentry.consoleLoggingIntegration({ levels: ["warn", "error"] })],
  }),
  {
    fetch: app.fetch,
    async scheduled(_controller, env, ctx) {
      ctx.waitUntil(runCleanup(env));
    },
  } satisfies ExportedHandler<Env>,
);
