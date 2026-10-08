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

function explorerUrl(path: string, baseURL = server.baseURL): string {
  return `${baseURL}/cdn-cgi/local/explorer/api/r2/buckets/${server.bucketName}${path}`;
}

async function explorerJson<T>(path: string, init?: RequestInit, baseURL?: string): Promise<T> {
  const res = await fetch(explorerUrl(path, baseURL), init);
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
  opts: {
    contentType?: string;
    customMetadata?: Record<string, string>;
    /** Another server's bucket (e2e/lib/servers.ts). */
    baseURL?: string;
  } = {},
): Promise<void> {
  const headers: Record<string, string> = {
    "Content-Type": opts.contentType ?? "application/octet-stream",
  };
  if (opts.customMetadata) headers["cf-r2-custom-metadata"] = JSON.stringify(opts.customMetadata);
  await explorerJson(
    objectPath(key),
    { method: "PUT", body: body as string | Uint8Array<ArrayBuffer>, headers },
    opts.baseURL,
  );
}

/**
 * An object's metadata, custom metadata included (listObjects() leaves it
 * out), or null when it does not exist.
 */
export async function headObject(
  key: string,
  opts: { baseURL?: string } = {},
): Promise<BucketObject | null> {
  const res = await fetch(explorerUrl(objectPath(key), opts.baseURL), {
    headers: { "cf-metadata-only": "true" },
  });
  if (res.status === 404) return null;
  const body = (await res.json()) as { success?: boolean; result?: BucketObject };
  if (!res.ok || !body.success || !body.result) {
    throw new Error(`Local explorer HEAD ${key} -> ${res.status}: ${JSON.stringify(body)}`);
  }
  return { ...body.result, custom_metadata: body.result.custom_metadata ?? {} };
}

/** Read an object's bytes, or null when it does not exist. */
export async function getObject(
  key: string,
  opts: { baseURL?: string } = {},
): Promise<Buffer | null> {
  const res = await fetch(explorerUrl(objectPath(key), opts.baseURL));
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

export interface UploadMeta extends LegacyMeta {
  /** Set while the file is still being uploaded: the R2 multipart upload ID. */
  pending_upload_id?: string;
  /** Downloads counted so far (replaces `downloads` once set). */
  download_count?: number;
  /** The last five download times, oldest first. */
  recent_downloads?: string[];
}

/**
 * The summary the Worker keeps in the sidecar's R2 custom metadata (key
 * `summary`). Mirrors summarize() in packages/worker/src/uploads.ts; keep the
 * two in sync.
 */
export function summarize(meta: UploadMeta): Record<string, unknown> {
  const downloads = meta.downloads ?? [];
  return {
    filename: meta.filename,
    file_size: meta.file_size ?? 0,
    uploaded_at: meta.uploaded_at,
    expires_at: meta.expires_at,
    has_password: !!meta.password_hash,
    ...(meta.pending_upload_id ? { pending_upload_id: meta.pending_upload_id } : {}),
    download_count: meta.download_count ?? downloads.length,
    recent_downloads: meta.recent_downloads ?? downloads.slice(-5).map((download) => download.at),
  };
}

/** Read an upload's `.meta.json` sidecar straight from the bucket. */
export async function readUploadMeta(id: string): Promise<UploadMeta | null> {
  const raw = await getObject(`${server.uploadsPrefix}/${id}/.meta.json`);
  return raw && (JSON.parse(raw.toString("utf-8")) as UploadMeta);
}

/**
 * Overwrite an upload's `.meta.json`. By default it also gets the `summary`
 * custom metadata, as the Worker's writeMeta() does; `withSummary: false`
 * writes it the way yeet < 0.2 / rclone did, without custom metadata.
 */
export async function writeUploadMeta(
  id: string,
  meta: UploadMeta,
  { withSummary = true } = {},
): Promise<void> {
  await putObject(`${server.uploadsPrefix}/${id}/.meta.json`, JSON.stringify(meta, null, 2), {
    contentType: "application/json",
    ...(withSummary ? { customMetadata: { summary: JSON.stringify(summarize(meta)) } } : {}),
  });
}
