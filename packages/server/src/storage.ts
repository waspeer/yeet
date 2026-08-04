import { AwsClient } from "aws4fetch";

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
  /** S3 API endpoint, e.g. "https://<account>.r2.cloudflarestorage.com" */
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Bucket name, addressed path-style against the endpoint */
  bucket: string;
  /** Key prefix for uploads, e.g. "uploads" (no leading/trailing slash) */
  uploadsPrefix: string;
  /** Lifetime of presigned download URLs, in seconds. Defaults to 3600. */
  presignExpirySeconds?: number;
}

const DEFAULT_PRESIGN_EXPIRY_SECONDS = 3600;

/**
 * Percent-encode a single path segment. Object keys hold raw filenames
 * (rclone uploads them as-is), so they may contain spaces, unicode and
 * reserved characters. We encode with encodeURIComponent and additionally
 * escape the RFC 3986 sub-delimiters that encodeURIComponent leaves alone,
 * so the URL we send is byte-identical to the canonical URI aws4fetch signs.
 */
function encodeSegment(segment: string): string {
  return encodeURIComponent(segment).replace(
    /[!'()*]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
  );
}

/** Percent-encode an object key, keeping "/" as a separator. */
function encodeKey(key: string): string {
  return key.split("/").map(encodeSegment).join("/");
}

/**
 * Guard against dot-segments in a caller-supplied upload ID. Percent-encoding
 * does not neutralise these: `new URL()` resolves ".." before the request is
 * signed, so an unchecked ID escapes the uploads prefix — and with enough
 * segments, the bucket itself. Callers validate too; this is the backstop that
 * keeps the invariant local to the code that builds the keys.
 */
function assertSafeId(id: string): void {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) {
    throw new Error(`Unsafe upload ID: ${JSON.stringify(id)}`);
  }
}

/** Decode the five XML predefined entities used in S3 list responses. */
function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function firstTagValue(xml: string, tag: string): string | undefined {
  const match = xml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`));
  return match ? decodeXmlEntities(match[1]) : undefined;
}

/** Extract the <Prefix> of every <CommonPrefixes> entry in a ListObjectsV2 response. */
function parseCommonPrefixes(xml: string): string[] {
  const prefixes: string[] = [];
  for (const block of xml.matchAll(/<CommonPrefixes>([\s\S]*?)<\/CommonPrefixes>/g)) {
    const prefix = firstTagValue(block[1], "Prefix");
    if (prefix) prefixes.push(prefix);
  }
  return prefixes;
}

/** Extract the <Key> of every <Contents> entry in a ListObjectsV2 response. */
function parseContentKeys(xml: string): string[] {
  const keys: string[] = [];
  for (const block of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
    const key = firstTagValue(block[1], "Key");
    if (key) keys.push(key);
  }
  return keys;
}

/** Thin signed-fetch wrapper for a Cloudflare R2 (S3-compatible) bucket. */
export class StorageClient {
  private readonly client: AwsClient;
  private readonly endpoint: string;
  private readonly bucket: string;
  private readonly uploadsPrefix: string;
  private readonly presignExpirySeconds: number;

  constructor(config: StorageClientConfig) {
    this.client = new AwsClient({
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      service: "s3",
      region: "auto",
    });
    this.endpoint = config.endpoint.replace(/\/$/, "");
    this.bucket = config.bucket;
    this.uploadsPrefix = config.uploadsPrefix.replace(/^\/|\/$/g, "");
    this.presignExpirySeconds = config.presignExpirySeconds ?? DEFAULT_PRESIGN_EXPIRY_SECONDS;
  }

  /** Absolute URL for an object key (path-style addressing). */
  private objectUrl(key: string): string {
    return `${this.endpoint}/${encodeSegment(this.bucket)}/${encodeKey(key)}`;
  }

  private metaKey(id: string): string {
    assertSafeId(id);
    return `${this.uploadsPrefix}/${id}/.meta.json`;
  }

  private s3Error(op: string, status: number): Error {
    return Object.assign(new Error(`S3 ${op} failed: ${status}`), { status });
  }

  /**
   * Run one ListObjectsV2 page. Returns the raw XML body.
   */
  private async listPage(params: Record<string, string>): Promise<string> {
    const url = new URL(`${this.endpoint}/${encodeSegment(this.bucket)}`);
    url.searchParams.set("list-type", "2");
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
    const res = await this.client.fetch(url.toString());
    if (!res.ok) throw this.s3Error("LIST", res.status);
    return res.text();
  }

  /** Fetch and parse the .meta.json sidecar for the given upload ID. */
  async readMeta(id: string): Promise<UploadMeta> {
    const res = await this.client.fetch(this.objectUrl(this.metaKey(id)));
    if (!res.ok) throw this.s3Error("GET", res.status);
    return res.json() as Promise<UploadMeta>;
  }

  /** Write the .meta.json sidecar for the given upload ID. */
  async writeMeta(id: string, meta: UploadMeta): Promise<void> {
    const res = await this.client.fetch(this.objectUrl(this.metaKey(id)), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(meta, null, 2),
    });
    if (!res.ok) throw this.s3Error("PUT", res.status);
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

  /**
   * Build a presigned GET URL so the browser downloads straight from R2
   * instead of proxying bytes through this server.
   *
   * The Content-Disposition override is part of the signed query string, so
   * R2 forces a download with the original filename. The header value is
   * written without whitespace on purpose: URLSearchParams serialises spaces
   * as "+", which would not survive the signature round-trip.
   *
   * The URL is a bearer token: anyone holding it can download until it
   * expires, past any password gate. Its lifetime is therefore clamped to
   * the file's own expiry.
   */
  async presignDownloadUrl(
    id: string,
    filename: string,
    fileExpiresAt?: string,
  ): Promise<string> {
    let expirySeconds = this.presignExpirySeconds;
    if (fileExpiresAt) {
      const secondsUntilFileExpiry = Math.ceil(
        (new Date(fileExpiresAt).getTime() - Date.now()) / 1000,
      );
      expirySeconds = Math.max(1, Math.min(expirySeconds, secondsUntilFileExpiry));
    }

    assertSafeId(id);
    const url = new URL(this.objectUrl(`${this.uploadsPrefix}/${id}/${filename}`));
    url.searchParams.set("X-Amz-Expires", String(expirySeconds));
    // encodeSegment rather than encodeURIComponent: RFC 8187 ext-values
    // forbid the sub-delimiters ('()!*) that encodeURIComponent leaves bare.
    url.searchParams.set(
      "response-content-disposition",
      `attachment;filename*=UTF-8''${encodeSegment(filename)}`,
    );

    const signed = await this.client.sign(url.toString(), {
      method: "GET",
      aws: { signQuery: true },
    });
    return signed.url;
  }

  /** List all upload IDs by listing the common prefixes under the uploads prefix. */
  async listUploadIds(): Promise<string[]> {
    const prefix = `${this.uploadsPrefix}/`;
    const ids: string[] = [];
    let continuationToken: string | undefined;

    do {
      const xml = await this.listPage({
        prefix,
        delimiter: "/",
        ...(continuationToken ? { "continuation-token": continuationToken } : {}),
      });

      for (const commonPrefix of parseCommonPrefixes(xml)) {
        if (!commonPrefix.startsWith(prefix)) continue;
        const id = commonPrefix.slice(prefix.length).replace(/\/$/, "");
        // A valid upload ID is a single non-empty path segment
        if (id && !id.includes("/")) ids.push(id);
      }

      continuationToken =
        firstTagValue(xml, "IsTruncated") === "true"
          ? firstTagValue(xml, "NextContinuationToken")
          : undefined;
    } while (continuationToken);

    return ids;
  }

  /** List every object key stored under an upload ID. */
  private async listUploadKeys(id: string): Promise<string[]> {
    assertSafeId(id);
    const prefix = `${this.uploadsPrefix}/${id}/`;
    const keys: string[] = [];
    let continuationToken: string | undefined;

    do {
      const xml = await this.listPage({
        prefix,
        ...(continuationToken ? { "continuation-token": continuationToken } : {}),
      });
      keys.push(...parseContentKeys(xml));
      continuationToken =
        firstTagValue(xml, "IsTruncated") === "true"
          ? firstTagValue(xml, "NextContinuationToken")
          : undefined;
    } while (continuationToken);

    return keys;
  }

  /**
   * Delete every object (file + sidecar) belonging to the given upload ID.
   * Returns the number of objects removed — 0 means nothing was found, which
   * callers should not report as a successful deletion.
   */
  async deleteUpload(id: string): Promise<number> {
    const keys = await this.listUploadKeys(id);

    // At most two objects per upload, so per-key DELETEs are plenty.
    await Promise.all(
      keys.map(async (key) => {
        const res = await this.client.fetch(this.objectUrl(key), { method: "DELETE" });
        // 404 is acceptable — already gone
        if (!res.ok && res.status !== 404) throw this.s3Error("DELETE", res.status);
      }),
    );

    return keys.length;
  }
}
