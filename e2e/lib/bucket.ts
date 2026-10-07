// Direct access to the local R2 bucket behind the Worker, via the Local
// Explorer API that `wrangler dev` serves at /cdn-cgi/local/explorer/api.
// This bypasses the Worker entirely, so tests can seed objects the Worker
// never wrote (legacy uploads) and check what really is in storage.

import { server } from "./env.js";

export interface BucketObject {
  key: string;
  size: number;
  etag: string;
  http_metadata: Record<string, string>;
  custom_metadata: Record<string, string>;
}

function explorerUrl(path: string): string {
  return `${server.baseURL}/cdn-cgi/local/explorer/api/r2/buckets/${server.bucketName}${path}`;
}

async function explorerJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(explorerUrl(path), init);
  const body = (await res.json().catch(() => null)) as {
    success?: boolean;
    result?: T;
    result_info?: { cursor?: string; is_truncated?: string | boolean };
    errors?: unknown;
  } | null;
  if (!res.ok || !body?.success) {
    throw new Error(
      `Local explorer ${init?.method ?? "GET"} ${path} → ${res.status}: ${JSON.stringify(body?.errors ?? body)}`,
    );
  }
  return body as T;
}

/** Keys must be sent as one path segment: slashes encoded as %2F. */
function objectPath(key: string): string {
  return `/objects/${encodeURIComponent(key)}`;
}

/** Every object whose key starts with `prefix`. */
export async function listObjects(prefix = `${server.uploadsPrefix}/`): Promise<BucketObject[]> {
  const objects: BucketObject[] = [];
  let cursor: string | undefined;
  do {
    const query = new URLSearchParams({ prefix, per_page: "1000" });
    if (cursor) query.set("cursor", cursor);
    const page = await explorerJson<{
      result: BucketObject[];
      result_info?: { cursor?: string; is_truncated?: string | boolean };
    }>(`/objects?${query}`);
    objects.push(...page.result);
    const truncated = String(page.result_info?.is_truncated) === "true";
    cursor = truncated ? page.result_info?.cursor : undefined;
  } while (cursor);
  return objects;
}

/** The objects of one upload (`uploads/<id>/…`). */
export function uploadObjects(id: string): Promise<BucketObject[]> {
  return listObjects(`${server.uploadsPrefix}/${id}/`);
}

/** Write an object with optional content type and custom metadata. */
export async function putObject(
  key: string,
  body: string | Uint8Array,
  opts: { contentType?: string; customMetadata?: Record<string, string> } = {},
): Promise<void> {
  const headers: Record<string, string> = {
    "Content-Type": opts.contentType ?? "application/octet-stream",
  };
  if (opts.customMetadata) headers["cf-r2-custom-metadata"] = JSON.stringify(opts.customMetadata);
  await explorerJson(objectPath(key), {
    method: "PUT",
    body: body as string | Uint8Array<ArrayBuffer>,
    headers,
  });
}

/** Read an object's bytes, or null when it does not exist. */
export async function getObject(key: string): Promise<Buffer | null> {
  const res = await fetch(explorerUrl(objectPath(key)));
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Local explorer GET ${key} → ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

export interface LegacyMeta {
  filename: string;
  file_size?: number;
  uploaded_at: string;
  expires_at: string;
  password_hash?: string;
  downloads?: { at: string }[];
}

/** A random 6-character upload ID in the Worker's alphabet. */
export function randomId(): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  let id = "";
  for (let i = 0; i < 6; i++) id += alphabet[Math.floor(Math.random() * alphabet.length)];
  return id;
}

/**
 * Seed an upload the way yeet < 0.2 left it in the bucket (copied by rclone):
 * the file and a `.meta.json` sidecar, both without R2 custom metadata, so the
 * Worker has to read the sidecar itself. Returns the share link.
 */
export async function seedLegacyUpload(opts: {
  filename: string;
  data: Uint8Array;
  id?: string;
  /** Default: uploaded a day ago, expires in 30 days. */
  meta?: Partial<LegacyMeta>;
  /** rclone sets one from the extension; default application/octet-stream. */
  contentType?: string;
}): Promise<{ id: string; url: string; meta: LegacyMeta }> {
  const id = opts.id ?? randomId();
  const now = Date.now();
  const meta: LegacyMeta = {
    filename: opts.filename,
    file_size: opts.data.length,
    uploaded_at: new Date(now - 24 * 3600_000).toISOString(),
    expires_at: new Date(now + 30 * 24 * 3600_000).toISOString(),
    ...opts.meta,
  };
  const dir = `${server.uploadsPrefix}/${id}/`;
  await putObject(dir + opts.filename, opts.data, { contentType: opts.contentType });
  // rclone stores JSON as application/json with no custom metadata.
  await putObject(dir + ".meta.json", JSON.stringify(meta, null, 2), {
    contentType: "application/json",
  });
  const url = `${server.baseURL}/${id}/${encodeURIComponent(opts.filename)}`;
  return { id, url, meta };
}

/**
 * Run the Worker's scheduled handler (the daily cleanup) through wrangler's
 * --test-scheduled endpoint. The cleanup runs in waitUntil(), so callers should
 * poll for its effect with eventually() rather than assume it has finished.
 */
export async function triggerCron(cron = "0 3 * * *"): Promise<void> {
  const res = await fetch(`${server.baseURL}/__scheduled?cron=${encodeURIComponent(cron)}`);
  const text = await res.text();
  if (!res.ok) throw new Error(`/__scheduled returned ${res.status}: ${text}`);
}
