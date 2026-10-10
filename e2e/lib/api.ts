// HTTP helpers against the Worker: the token-protected API and the public
// download flow (download page → POST → 303 → signed /_dl link).

import { createHash, createHmac, randomInt } from "node:crypto";
import { server } from "./env.js";

/**
 * Start an upload (POST /api/uploads) without sending parts or completing it,
 * leaving it pending with a real R2 multipart upload. Returns its ID.
 */
export async function startUpload(opts: {
  filename: string;
  size: number;
  expiresInSeconds?: number;
}): Promise<string> {
  const { id } = await apiJson<{ id: string }>("/api/uploads", {
    method: "POST",
    body: JSON.stringify({
      filename: opts.filename,
      size: opts.size,
      expires_in: opts.expiresInSeconds ?? 3600,
    }),
  });
  return id;
}

/**
 * A `/_dl/<id>` link signed with the test token for any expiry, including one
 * past the file's own expiry (the server clamps the links it hands out to it).
 * Mirrors signDownload() in packages/worker/src/crypto.ts; keep them in sync.
 */
export function forgeDownloadUrl(id: string, expires: number): string {
  const key = createHash("sha256").update(`yeet-download:${server.token}`).digest();
  const signature = createHmac("sha256", key).update(`${id}:${expires}`).digest("base64url");
  return `${server.baseURL}/_dl/${id}?expires=${expires}&sig=${signature}`;
}

/**
 * A random address in 10.0.0.0/8 to send as `CF-Connecting-IP`. The Worker
 * rate-limits failures per client IP; `wrangler dev` passes this header
 * through (Cloudflare's edge overwrites it in production), so a test that
 * counts failures, or makes many, uses its own address and does not trip or
 * inherit another test's limit. Requests without it count as 127.0.0.1.
 */
export function clientIp(): string {
  return `10.${randomInt(256)}.${randomInt(256)}.${randomInt(1, 255)}`;
}

/**
 * fetch() against the server with the upload token. `path` is relative to the
 * origin, e.g. `api("/api/uploads")`. Pass `token: null` to send none, or
 * another string to send a wrong one; `ip` sets CF-Connecting-IP (see
 * clientIp()); `baseURL` targets another server (e2e/lib/servers.ts).
 */
export function api(
  path: string,
  init: RequestInit & { token?: string | null; ip?: string; baseURL?: string } = {},
): Promise<Response> {
  const { token = server.token, ip, baseURL = server.baseURL, ...rest } = init;
  const headers = new Headers(rest.headers);
  if (token !== null) headers.set("Authorization", `Bearer ${token}`);
  if (ip) headers.set("CF-Connecting-IP", ip);
  return fetch(new URL(path, baseURL), { ...rest, headers });
}

/**
 * POST /login like a same-origin browser form would (Origin and
 * Sec-Fetch-Site set). Returns the raw response (303 + Set-Cookie on success).
 */
export function postLogin(
  token: string,
  opts: { ip?: string; baseURL?: string; headers?: Record<string, string> } = {},
): Promise<Response> {
  const baseURL = opts.baseURL ?? server.baseURL;
  return fetch(new URL("/login", baseURL), {
    method: "POST",
    body: new URLSearchParams({ token }),
    redirect: "manual",
    headers: {
      Origin: baseURL,
      "Sec-Fetch-Site": "same-origin",
      ...(opts.ip ? { "CF-Connecting-IP": opts.ip } : {}),
      ...opts.headers,
    },
  });
}

/** `name=value` of a Set-Cookie header, for sending it back in a Cookie header. */
export function cookiePair(setCookie: string | null): string {
  const pair = setCookie?.split(";")[0];
  if (!pair) throw new Error(`No Set-Cookie: ${setCookie}`);
  return pair;
}

/** Log in and return the `yeet_session=...` cookie pair. */
export async function loginCookie(
  opts: { token?: string; ip?: string; baseURL?: string } = {},
): Promise<string> {
  const res = await postLogin(opts.token ?? server.token, opts);
  if (res.status !== 303) throw new Error(`POST /login → ${res.status}: ${await res.text()}`);
  return cookiePair(res.headers.get("set-cookie"));
}

/**
 * fetch() as the logged-in browser page would: the session cookie, plus
 * Origin and Sec-Fetch-Site of the server's own origin. Override or remove
 * (`undefined`) headers with `headers`.
 */
export function sessionFetch(
  path: string,
  cookie: string,
  init: Omit<RequestInit, "headers"> & {
    headers?: Record<string, string | undefined>;
    baseURL?: string;
  } = {},
): Promise<Response> {
  const { headers: overrides = {}, baseURL = server.baseURL, ...rest } = init;
  const headers = new Headers();
  const all: Record<string, string | undefined> = {
    Cookie: cookie,
    Origin: baseURL,
    "Sec-Fetch-Site": "same-origin",
    ...overrides,
  };
  for (const [name, value] of Object.entries(all))
    if (value !== undefined) headers.set(name, value);
  return fetch(new URL(path, baseURL), { redirect: "manual", ...rest, headers });
}

/** Like api(), but parses JSON and throws on a non-2xx status. */
export async function apiJson<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (typeof init.body === "string") headers.set("Content-Type", "application/json");
  const res = await api(path, { ...init, headers });
  const text = await res.text();
  if (!res.ok) throw new Error(`${init.method ?? "GET"} ${path} → ${res.status}: ${text}`);
  return JSON.parse(text) as T;
}

export interface ListedUpload {
  id: string;
  filename: string;
  file_size: number;
  uploaded_at: string;
  expires_at: string;
  has_password: boolean;
  download_count: number;
  recent_downloads: string[];
  url: string;
}

/** One page of `GET /api/uploads`, as the server returns it. */
export interface UploadsPage {
  uploads: ListedUpload[];
  cursor: string | null;
  truncated?: true;
}

/**
 * Every finished upload, as `GET /api/uploads` returns them: all pages,
 * following `cursor` (at most `maxPages`, then it throws).
 */
export async function listUploads({ maxPages = 1000 } = {}): Promise<ListedUpload[]> {
  const all: ListedUpload[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < maxPages; page++) {
    const query: string = cursor === null ? "" : `?cursor=${encodeURIComponent(cursor)}`;
    const body: UploadsPage = await apiJson<UploadsPage>(`/api/uploads${query}`);
    all.push(...body.uploads);
    if (body.cursor === null) return all;
    cursor = body.cursor;
  }
  throw new Error(`GET /api/uploads: still more after ${maxPages} pages`);
}

/**
 * Upload bytes through the API directly, the way the CLI does, but with the
 * expiry in seconds (the CLI's minimum is one minute). Returns the share link.
 */
export async function uploadViaApi(opts: {
  filename: string;
  data: Uint8Array;
  expiresInSeconds?: number;
  password?: string;
}): Promise<{ id: string; url: string }> {
  const { filename, data, expiresInSeconds = 3600, password } = opts;
  const { id, part_size: partSize } = await apiJson<{ id: string; part_size: number }>(
    "/api/uploads",
    {
      method: "POST",
      body: JSON.stringify({
        filename,
        size: data.length,
        expires_in: expiresInSeconds,
        ...(password ? { password } : {}),
      }),
    },
  );
  const parts: { part_number: number; etag: string }[] = [];
  const partCount = Math.max(1, Math.ceil(data.length / partSize));
  for (let n = 1; n <= partCount; n++) {
    const body = data.subarray((n - 1) * partSize, n * partSize);
    parts.push(
      await apiJson(`/api/uploads/${id}/parts/${n}`, {
        method: "PUT",
        body: body as Uint8Array<ArrayBuffer>,
        headers: { "Content-Type": "application/octet-stream" },
      }),
    );
  }
  return apiJson<{ id: string; url: string }>(`/api/uploads/${id}/complete`, {
    method: "POST",
    body: JSON.stringify({ parts }),
  });
}

export async function deleteUpload(id: string): Promise<Response> {
  return api(`/api/uploads/${encodeURIComponent(id)}`, { method: "DELETE" });
}

/**
 * DELETE until done: a request deletes at most DELETE_LIMIT objects and
 * answers 202 while more is left (round 1L). Returns the last response.
 */
export async function deleteUploadFully(id: string, maxRequests = 200): Promise<Response> {
  for (let i = 1; ; i++) {
    const res = await deleteUpload(id);
    if (res.status !== 202 || i >= maxRequests) return res;
    await res.body?.cancel();
  }
}

/** The upload ID in a share link (`<origin>/<id>/<filename>`). */
export function idFromUrl(shareUrl: string): string {
  const id = new URL(shareUrl).pathname.split("/")[1];
  if (!id) throw new Error(`Not a share link: ${shareUrl}`);
  return id;
}

/**
 * Submit the download form like a browser would and return the raw response
 * (303 with Location on success, 401 HTML on a wrong password, 404 if gone).
 */
export function submitDownloadForm(
  shareUrl: string,
  password?: string,
  opts: { ip?: string; cookie?: string } = {},
): Promise<Response> {
  const form = new URLSearchParams();
  if (password !== undefined) form.set("password", password);
  const headers: Record<string, string> = {};
  if (opts.ip) headers["CF-Connecting-IP"] = opts.ip;
  if (opts.cookie) headers["Cookie"] = opts.cookie;
  return fetch(new URL("download", shareUrl), {
    method: "POST",
    body: form,
    redirect: "manual",
    headers,
  });
}

/** The signed `/_dl/<id>?expires=&sig=` link the download form redirects to. */
export async function signedDownloadUrl(shareUrl: string, password?: string): Promise<string> {
  const res = await submitDownloadForm(shareUrl, password);
  const location = res.headers.get("Location");
  if (res.status !== 303 || !location) {
    throw new Error(`Expected a 303 from the download form, got ${res.status}`);
  }
  return new URL(location, shareUrl).toString();
}

/** Download a share link's file through the public flow and return its bytes. */
export async function downloadBytes(shareUrl: string, password?: string): Promise<Buffer> {
  const res = await fetch(await signedDownloadUrl(shareUrl, password));
  if (res.status !== 200) throw new Error(`Download returned ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/** Like downloadBytes(), but streams the body into a hash: for large files. */
export async function downloadSha256(
  shareUrl: string,
  password?: string,
): Promise<{ sha256: string; size: number }> {
  const res = await fetch(await signedDownloadUrl(shareUrl, password));
  if (res.status !== 200 || !res.body) throw new Error(`Download returned ${res.status}`);
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of res.body) {
    hash.update(chunk);
    size += chunk.length;
  }
  return { sha256: hash.digest("hex"), size };
}
