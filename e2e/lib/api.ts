// HTTP helpers against the Worker: the token-protected API and the public
// download flow (download page → POST → 303 → signed /_dl link).

import { createHash } from "node:crypto";
import { server } from "./env.js";

/**
 * fetch() against the server with the upload token. `path` is relative to the
 * origin, e.g. `api("/api/uploads")`. Pass `token: null` to send none, or
 * another string to send a wrong one.
 */
export function api(
  path: string,
  init: RequestInit & { token?: string | null } = {},
): Promise<Response> {
  const { token = server.token, ...rest } = init;
  const headers = new Headers(rest.headers);
  if (token !== null) headers.set("Authorization", `Bearer ${token}`);
  return fetch(new URL(path, server.baseURL), { ...rest, headers });
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

/** Every finished upload, as `GET /api/uploads` returns it. */
export async function listUploads(): Promise<ListedUpload[]> {
  return (await apiJson<{ uploads: ListedUpload[] }>("/api/uploads")).uploads;
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
export function submitDownloadForm(shareUrl: string, password?: string): Promise<Response> {
  const form = new URLSearchParams();
  if (password !== undefined) form.set("password", password);
  return fetch(new URL("download", shareUrl), { method: "POST", body: form, redirect: "manual" });
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
