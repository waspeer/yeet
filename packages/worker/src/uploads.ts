// Upload storage on top of the R2 bucket binding. Layout, shared with every
// earlier version of yeet:
//
//   <prefix>/<id>/<filename>     the file itself
//   <prefix>/<id>/.meta.json     metadata sidecar (UploadMeta)
//   <prefix>/<id>/.parts/<n>     size of part n, only while an upload of
//                                unknown size is pending
//   <prefix>/<id>/.downloads/<at>_<random>
//                                one empty object per download (after 0.2),
//                                <at> the ISO 8601 time; see recordDownload()

export interface DownloadRecord {
  at: string; // ISO 8601
}

export interface UploadMeta {
  filename: string;
  /** While pending: the size the client declared, if any. Once finished: R2's object.size. */
  file_size?: number;
  uploaded_at: string;
  expires_at: string;
  password_hash?: string;
  /**
   * Downloads recorded by yeet 0.2 and earlier, which rewrote the sidecar per
   * download (and kept the last 50). Newer downloads are `.downloads/` objects.
   */
  downloads?: DownloadRecord[];
  /** Set while the file is still being uploaded; holds the R2 multipart upload ID. */
  pending_upload_id?: string;
}

/**
 * Upload IDs are base64url. Anything else — in particular dot-segments
 * smuggled in via %2F — must never be turned into an object key, where it
 * could address objects outside the uploads prefix.
 */
export function isValidId(id: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(id);
}

/** Filenames become one key segment, so they may not contain a slash. */
export function isValidFilename(name: string): boolean {
  return (
    name.length > 0 &&
    name.length <= 255 &&
    !name.includes("/") &&
    name !== "." &&
    name !== ".." &&
    name !== ".meta.json"
  );
}

export function isExpired(meta: { expires_at: string }): boolean {
  return new Date(meta.expires_at) <= new Date();
}

export function generateId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").slice(0, 6);
}

/** What listing and cleanup need, stored as R2 custom metadata (2 KB max). */
export interface UploadSummary {
  filename: string;
  file_size: number;
  uploaded_at: string;
  expires_at: string;
  has_password: boolean;
  pending_upload_id?: string;
  download_count: number;
  /** The last five download times. */
  recent_downloads: string[];
}

export function summarize(meta: UploadMeta): UploadSummary {
  const downloads = meta.downloads ?? [];
  return {
    filename: meta.filename,
    file_size: meta.file_size ?? 0,
    uploaded_at: meta.uploaded_at,
    expires_at: meta.expires_at,
    has_password: !!meta.password_hash,
    ...(meta.pending_upload_id ? { pending_upload_id: meta.pending_upload_id } : {}),
    download_count: downloads.length,
    recent_downloads: downloads.slice(-5).map((download) => download.at),
  };
}

/** Prefix (below an upload's directory) of its download records. */
const DOWNLOADS = ".downloads/";

/**
 * A summary with the download records counted in: the sidecar's own downloads
 * (yeet 0.2 and earlier) came before them.
 */
function withDownloads(summary: UploadSummary, downloads: string[]): UploadSummary {
  if (downloads.length === 0) return summary;
  return {
    ...summary,
    download_count: summary.download_count + downloads.length,
    recent_downloads: [...summary.recent_downloads, ...downloads.slice(-5)].sort().slice(-5),
  };
}

function toCustomMetadata(meta: UploadMeta): Record<string, string> {
  return { summary: JSON.stringify(summarize(meta)) };
}

function fromCustomMetadata(custom: Record<string, string> | undefined): UploadSummary | null {
  if (!custom?.summary) return null;
  try {
    return JSON.parse(custom.summary) as UploadSummary;
  } catch {
    return null;
  }
}

export class Uploads {
  private readonly prefix: string;

  constructor(
    private readonly bucket: R2Bucket,
    prefix: string,
  ) {
    this.prefix = prefix.replace(/^\/+|\/+$/g, "");
  }

  private dir(id: string): string {
    if (!isValidId(id)) throw new Error(`Unsafe upload ID: ${JSON.stringify(id)}`);
    return `${this.prefix}/${id}/`;
  }

  fileKey(id: string, filename: string): string {
    return this.dir(id) + filename;
  }

  /** Read the metadata sidecar, or null if the upload does not exist. */
  async readMeta(id: string): Promise<UploadMeta | null> {
    const object = await this.bucket.get(this.dir(id) + ".meta.json");
    if (!object) return null;
    return object.json<UploadMeta>();
  }

  /**
   * Write the metadata sidecar. A summary also goes into the object's custom
   * metadata, so listing every upload takes one R2 call per 1000 objects
   * instead of one read per upload — the free plan allows only 50 per request.
   */
  async writeMeta(id: string, meta: UploadMeta): Promise<void> {
    await this.bucket.put(this.dir(id) + ".meta.json", JSON.stringify(meta, null, 2), {
      httpMetadata: { contentType: "application/json" },
      customMetadata: toCustomMetadata(meta),
    });
  }

  /**
   * Remember the size of an uploaded part while the total size is unknown, so
   * `complete` can check the part layout before R2 does. One empty object per
   * part (`<id>/.parts/<n>`), overwritten if the part is sent again, deleted
   * with the upload.
   */
  async writePartSize(id: string, partNumber: number, size: number): Promise<void> {
    await this.bucket.put(`${this.dir(id)}.parts/${partNumber}`, "", {
      customMetadata: { size: String(size) },
    });
  }

  /** The recorded part sizes of an upload, and the keys of their records. */
  async readPartSizes(id: string): Promise<{ sizes: Map<number, number>; keys: string[] }> {
    const prefix = `${this.dir(id)}.parts/`;
    const sizes = new Map<number, number>();
    const keys: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.bucket.list({ prefix, cursor, include: ["customMetadata"] });
      for (const object of page.objects) {
        keys.push(object.key);
        const partNumber = Number(object.key.slice(prefix.length));
        const size = Number(object.customMetadata?.size);
        if (Number.isInteger(partNumber) && Number.isSafeInteger(size)) sizes.set(partNumber, size);
      }
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    return { sizes, keys };
  }

  async exists(id: string): Promise<boolean> {
    return (await this.bucket.head(this.dir(id) + ".meta.json")) !== null;
  }

  /**
   * Record a download as a new empty object, `.downloads/<ISO time>_<random>`.
   * Never a read-modify-write of the sidecar: concurrent downloads each write
   * their own key, so none is lost. listAll() counts them in the same listing
   * that reads the summaries; delete() and the cleanup remove them with the
   * upload.
   */
  async recordDownload(id: string): Promise<void> {
    const random = [...crypto.getRandomValues(new Uint8Array(4))]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    await this.bucket.put(`${this.dir(id)}${DOWNLOADS}${new Date().toISOString()}_${random}`, "");
  }

  /**
   * Every upload with its object keys and metadata summary, download records
   * included. Sidecars written by yeet < 0.2 carry no summary; those are read
   * individually. `stray` marks download records left without an upload (a
   * download that raced a delete): no sidecar is read for them, and the
   * cleanup removes them.
   */
  async listAll(): Promise<
    { id: string; keys: string[]; meta: UploadSummary | null; stray: boolean }[]
  > {
    const groups = new Map<
      string,
      { keys: string[]; meta: UploadSummary | null; sidecar: boolean; downloads: string[] }
    >();
    let cursor: string | undefined;
    do {
      const page = await this.bucket.list({
        prefix: `${this.prefix}/`,
        cursor,
        include: ["customMetadata"],
      });
      for (const object of page.objects) {
        const [id, ...rest] = object.key.slice(this.prefix.length + 1).split("/");
        if (!id || !isValidId(id) || rest.length === 0) continue;
        let group = groups.get(id);
        if (!group)
          groups.set(id, (group = { keys: [], meta: null, sidecar: false, downloads: [] }));
        group.keys.push(object.key);
        const name = rest.join("/");
        if (name === ".meta.json") {
          group.sidecar = true;
          group.meta = fromCustomMetadata(object.customMetadata);
        } else if (name.startsWith(DOWNLOADS)) {
          // Listed in key order, which for ISO 8601 times is time order.
          group.downloads.push(name.slice(DOWNLOADS.length).split("_")[0]!);
        }
      }
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);

    return Promise.all(
      [...groups].map(async ([id, { keys, meta, sidecar, downloads }]) => {
        const stray = !sidecar && keys.length === downloads.length;
        if (!meta && !stray) {
          const full = await this.readMeta(id).catch(() => null);
          meta = full && summarize(full);
        }
        return { id, keys, meta: meta && withDownloads(meta, downloads), stray };
      }),
    );
  }

  /** Delete objects by key, in batches of the 1000 R2 accepts per call. */
  async deleteKeys(keys: string[]): Promise<void> {
    for (let i = 0; i < keys.length; i += 1000) {
      await this.bucket.delete(keys.slice(i, i + 1000));
    }
  }

  /** Abort an unfinished multipart upload. Ignores ones already gone. */
  async abortPending(id: string, filename: string, uploadId: string): Promise<void> {
    await this.bucket
      .resumeMultipartUpload(this.fileKey(id, filename), uploadId)
      .abort()
      .catch(() => {}); // already completed, aborted or expired
  }

  /**
   * Delete every object of an upload, aborting its multipart upload if it
   * never completed. Returns the number of objects removed.
   */
  async delete(id: string, meta?: UploadMeta | null): Promise<number> {
    if (meta?.pending_upload_id) {
      await this.abortPending(id, meta.filename, meta.pending_upload_id);
    }

    const keys: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.bucket.list({ prefix: this.dir(id), cursor });
      keys.push(...page.objects.map((object) => object.key));
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);

    await this.deleteKeys(keys);
    return keys.length;
  }
}
