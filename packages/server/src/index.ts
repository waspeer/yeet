// Entry point — server implementation lives here
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import argon2 from "argon2";
import cron from "node-cron";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { storage } from "./storage-instance.js";
import { downloadPage, notFoundPage, landingPage } from "./template.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const clientJs = readFileSync(join(__dirname, "client.js"));

const app = new Hono();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isExpired(expiresAt: string): boolean {
  return new Date(expiresAt) <= new Date();
}

async function deleteExpiredAndRespond404(id: string): Promise<Response> {
  // Opportunistic cleanup: delete directory for expired/missing file
  storage.deleteUpload(id).catch(() => {});
  return new Response(notFoundPage(), {
    status: 404,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

// GET /client.js — client-side shader bundle
app.get("/client.js", (c) => {
  c.header("Content-Type", "application/javascript");
  c.header("Cache-Control", "public, max-age=31536000, immutable");
  return c.body(clientJs);
});

// GET /health — health check for Coolify
app.get("/health", (c) => c.json({ status: "ok" }));

// GET / — landing page
app.get("/", (c) => c.html(landingPage()));

// GET /:id and GET /:id/:filename — serve download page
app.get("/:id/:filename?", async (c) => {
  const { id } = c.req.param();

  let meta;
  try {
    meta = await storage.readMeta(id);
  } catch {
    return c.html(notFoundPage(), 404);
  }

  if (isExpired(meta.expires_at)) {
    return new Response(await deleteExpiredAndRespond404(id).then((r) => r.text()), {
      status: 404,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
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

// POST /:id/download — verify password and stream file
app.post("/:id/download", async (c) => {
  const { id } = c.req.param();

  let meta;
  try {
    meta = await storage.readMeta(id);
  } catch {
    return c.html(notFoundPage(), 404);
  }

  if (isExpired(meta.expires_at)) {
    return new Response(await deleteExpiredAndRespond404(id).then((r) => r.text()), {
      status: 404,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  if (meta.password_hash) {
    const body = await c.req.parseBody();
    const password = typeof body["password"] === "string" ? body["password"] : "";
    const valid = await argon2.verify(meta.password_hash, password);
    if (!valid) {
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

  // Record the download (fire-and-forget — never block the actual file transfer)
  storage.recordDownload(id, meta).catch((err) => {
    console.error(`[download] Failed to record download for ${id}:`, err);
  });

  const upstream = await storage.streamFile(id, meta.filename);

  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      "Content-Type": upstream.headers.get("Content-Type") ?? "application/octet-stream",
      "Content-Disposition": `attachment; filename="${encodeURIComponent(meta.filename)}"`,
      ...(upstream.headers.get("Content-Length")
        ? { "Content-Length": upstream.headers.get("Content-Length")! }
        : {}),
    },
  });
});

// ---------------------------------------------------------------------------
// Cleanup cron — runs daily at 03:00
// ---------------------------------------------------------------------------

async function runCleanup(): Promise<void> {
  let ids: string[];
  try {
    ids = await storage.listUploadIds();
  } catch (err) {
    console.error("[cleanup] Failed to list upload IDs:", err);
    return;
  }

  let deleted = 0;
  await Promise.all(
    ids.map(async (id) => {
      try {
        const meta = await storage.readMeta(id);
        if (isExpired(meta.expires_at)) {
          await storage.deleteUpload(id);
          deleted++;
        }
      } catch {
        // Skip directories where .meta.json is missing or unreadable
      }
    }),
  );

  if (deleted > 0) console.log(`[cleanup] Deleted ${deleted} expired upload(s)`);
}

cron.schedule("0 3 * * *", () => {
  runCleanup().catch((err) => console.error("[cleanup] Error:", err));
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

const port = Number(process.env.PORT ?? 3000);
serve({ fetch: app.fetch, port }, () => {
  console.log(`yeet server listening on :${port}`);
});
