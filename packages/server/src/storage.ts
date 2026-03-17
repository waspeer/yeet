import { Buffer } from "node:buffer";

export interface DownloadRecord {
  at: string; // ISO 8601
}

export interface UploadMeta {
  filename: string;
  file_size?: number;
  uploaded_at: string;
  expires_at: string;
  password_hash?: string;
  downloads?: DownloadRecord[];
}

export interface StorageClientConfig {
  /** Base URL of the WebDAV endpoint, e.g. "https://u12345.your-storagebox.de" */
  baseUrl: string;
  username: string;
  password: string;
  /** Path prefix for uploads directory, e.g. "/uploads" */
  uploadsPath: string;
}

/**
 * Extract upload IDs from a WebDAV PROPFIND response.
 * Looks for <D:href> elements that are immediate children of uploadsPath.
 */
function parseUploadIds(xml: string, uploadsPath: string): string[] {
  const hrefPattern = /<[^>]*href[^>]*>([^<]+)<\/[^>]*href>/gi;
  const ids: string[] = [];
  const prefix = uploadsPath.replace(/\/$/, "") + "/";

  for (const match of xml.matchAll(hrefPattern)) {
    const href = decodeURIComponent(match[1].trim());
    if (!href.startsWith(prefix)) continue;
    const rest = href.slice(prefix.length).replace(/\/$/, "");
    // A valid upload ID is a single non-empty path segment (no slashes)
    if (rest && !rest.includes("/")) {
      ids.push(rest);
    }
  }

  return ids;
}

/** Thin fetch wrapper for the Hetzner storage box WebDAV endpoint. */
export class StorageClient {
  private readonly authHeader: string;
  private readonly baseUrl: string;
  private readonly uploadsPath: string;

  constructor(config: StorageClientConfig) {
    const credentials = Buffer.from(`${config.username}:${config.password}`).toString("base64");
    this.authHeader = `Basic ${credentials}`;
    this.baseUrl = config.baseUrl.replace(/\/$/, "");
    this.uploadsPath = config.uploadsPath.replace(/\/$/, "");
  }

  private url(path: string): string {
    return `${this.baseUrl}${path}`;
  }

  private webdavError(op: string, status: number): Error {
    return Object.assign(new Error(`WebDAV ${op} failed: ${status}`), { status });
  }

  /** Fetch and parse the .meta.json sidecar for the given upload ID. */
  async readMeta(id: string): Promise<UploadMeta> {
    const res = await fetch(this.url(`${this.uploadsPath}/${id}/.meta.json`), {
      headers: { Authorization: this.authHeader },
    });
    if (!res.ok) throw this.webdavError("GET", res.status);
    return res.json() as Promise<UploadMeta>;
  }

  /**
   * Return the raw fetch Response for the uploaded file so the caller can
   * stream it directly to the HTTP client without buffering.
   */
  async streamFile(id: string, filename: string): Promise<Response> {
    const res = await fetch(this.url(`${this.uploadsPath}/${id}/${encodeURIComponent(filename)}`), {
      headers: { Authorization: this.authHeader },
    });
    if (!res.ok) throw this.webdavError("GET", res.status);
    return res;
  }

  /** List all upload IDs by doing a depth-1 PROPFIND on the uploads directory. */
  async listUploadIds(): Promise<string[]> {
    const res = await fetch(this.url(`${this.uploadsPath}/`), {
      method: "PROPFIND",
      headers: {
        Authorization: this.authHeader,
        Depth: "1",
        "Content-Type": "application/xml",
      },
      body: '<?xml version="1.0"?><D:propfind xmlns:D="DAV:"><D:prop><D:resourcetype/></D:prop></D:propfind>',
    });
    if (!res.ok) throw this.webdavError("PROPFIND", res.status);
    const xml = await res.text();
    return parseUploadIds(xml, this.uploadsPath);
  }

  /** Write the .meta.json sidecar for the given upload ID. */
  async writeMeta(id: string, meta: UploadMeta): Promise<void> {
    const res = await fetch(this.url(`${this.uploadsPath}/${id}/.meta.json`), {
      method: "PUT",
      headers: {
        Authorization: this.authHeader,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(meta, null, 2),
    });
    if (!res.ok) throw this.webdavError("PUT", res.status);
  }

  /** Append a download record to the metadata and persist it. Keeps last 50 entries. */
  async recordDownload(id: string, meta: UploadMeta): Promise<void> {
    const downloads = meta.downloads ?? [];
    downloads.push({ at: new Date().toISOString() });
    if (downloads.length > 50) {
      downloads.splice(0, downloads.length - 50);
    }
    meta.downloads = downloads;
    await this.writeMeta(id, meta);
  }

  /** Delete the entire upload directory (file + sidecar) for the given ID. */
  async deleteUpload(id: string): Promise<void> {
    const res = await fetch(this.url(`${this.uploadsPath}/${id}/`), {
      method: "DELETE",
      headers: {
        Authorization: this.authHeader,
        Depth: "infinity",
      },
    });
    // 404 is acceptable — already gone
    if (!res.ok && res.status !== 404) throw this.webdavError("DELETE", res.status);
  }
}
