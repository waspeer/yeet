// Upload storage on top of the R2 bucket binding. Layout, shared with every
// earlier version of yeet:
//
//   <prefix>/<id>/<filename>     the file itself
//   <prefix>/<id>/.meta.json     metadata sidecar (UploadMeta)
//   <prefix>/<id>/.parts/<n>     size of part n, only while an upload of
//                                unknown size is pending
//   <prefix>/<id>/.downloads/<at>_<random>
//                                one empty object per download (after 0.2),
//                                <at> the ISO 8601 time; see recordDownload().
//                                The daily cron folds them into the sidecar.

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
  /**
   * Downloads folded in from `.downloads/` records by the daily cron (see
   * foldDownloads()); `downloads` is folded in too and dropped then.
   */
  download_count?: number;
  /** The last five download times, folded in with download_count. */
  recent_downloads?: string[];
  /** Set while the file is still being uploaded; holds the R2 multipart upload ID. */
  pending_upload_id?: string;
}

/**
 * Download records written per upload between two folds. Past it a download
 * is not recorded (the count stops growing until the next fold), so scripted
 * downloads of one link cannot fill the bucket and the listing.
 */
export const RECORD_CAP = 1000;

/**
 * Records of one upload counted by a listing. Past it the listing skips the
 * rest of that upload's records, so it never pages through more than this per
 * upload; normally there are at most RECORD_CAP (one day's worth).
 */
export const LISTED_RECORDS_LIMIT = 2 * RECORD_CAP;

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
    download_count: meta.download_count ?? downloads.length,
    recent_downloads: meta.recent_downloads ?? downloads.slice(-5).map((download) => download.at),
  };
}

/** Prefix (below an upload's directory) of its download records. */
const DOWNLOADS = ".downloads/";

/**
 * A summary with the download records counted in: the sidecar's own downloads
 * (yeet 0.2 and earlier) came before them.
 */
function withDownloads<T extends { download_count: number; recent_downloads: string[] }>(
  summary: T,
  downloads: string[],
): T {
  if (downloads.length === 0) return summary;
  return {
    ...summary,
    download_count: summary.download_count + downloads.length,
    recent_downloads: [...summary.recent_downloads, ...downloads.slice(-5)].sort().slice(-5),
  };
}

/** One upload as listAll() finds it. */
export interface ListedUpload {
  id: string;
  /** Every key found, except records skipped past LISTED_RECORDS_LIMIT. */
  keys: string[];
  /** The summary with the counted records added, or null if unreadable. */
  meta: UploadSummary | null;
  /** Download records without an upload (no sidecar, nothing else). */
  stray: boolean;
  /** The keys and times of the records counted, for foldDownloads(). */
  records: { keys: string[]; times: string[] };
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
   * that reads the summaries; the daily cron folds them into the sidecar;
   * delete() and the cleanup remove them with the upload.
   *
   * At most RECORD_CAP records are written between two folds: one list call
   * (of at most that many keys) checks first. Returns whether it recorded.
   */
  async recordDownload(id: string): Promise<boolean> {
    const prefix = this.dir(id) + DOWNLOADS;
    const existing = await this.bucket.list({ prefix, limit: RECORD_CAP });
    if (existing.truncated || existing.objects.length >= RECORD_CAP) return false;
    const random = [...crypto.getRandomValues(new Uint8Array(4))]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    await this.bucket.put(`${prefix}${new Date().toISOString()}_${random}`, "");
    return true;
  }

  /**
   * Every upload with its object keys and metadata summary, download records
   * included. Sidecars written by yeet < 0.2 carry no summary; those are read
   * individually. `stray` marks download records left without an upload (a
   * download that raced a delete): no sidecar is read for them, and the
   * cleanup removes them.
   *
   * Counts at most LISTED_RECORDS_LIMIT records per upload: past that the
   * listing jumps over the rest of that upload's records (`startAfter`), so
   * the number of list calls stays bounded however many there are. Returns
   * the subrequests it made, for the cron's budget.
   */
  async listAll(): Promise<{ uploads: ListedUpload[]; subrequests: number }> {
    const groups = new Map<
      string,
      { keys: string[]; meta: UploadSummary | null; sidecar: boolean; others: number } & {
        records: { keys: string[]; times: string[] };
      }
    >();
    let subrequests = 0;
    let cursor: string | undefined;
    let startAfter: string | undefined;
    do {
      const page = await this.bucket.list({
        prefix: `${this.prefix}/`,
        ...(cursor ? { cursor } : startAfter ? { startAfter } : {}),
        include: ["customMetadata"],
      });
      subrequests++;
      let skipping: string | undefined;
      for (const object of page.objects) {
        const [id, ...rest] = object.key.slice(this.prefix.length + 1).split("/");
        if (!id || !isValidId(id) || rest.length === 0) continue;
        let group = groups.get(id);
        if (!group) {
          group = {
            keys: [],
            meta: null,
            sidecar: false,
            others: 0,
            records: { keys: [], times: [] },
          };
          groups.set(id, group);
        }
        const name = rest.join("/");
        if (name.startsWith(DOWNLOADS)) {
          if (group.records.keys.length >= LISTED_RECORDS_LIMIT) {
            skipping = id;
            continue;
          }
          group.keys.push(object.key);
          group.records.keys.push(object.key);
          // Listed in key order, which for ISO 8601 times is time order.
          group.records.times.push(name.slice(DOWNLOADS.length).split("_")[0]!);
          continue;
        }
        group.keys.push(object.key);
        group.others++;
        if (name === ".meta.json") {
          group.sidecar = true;
          group.meta = fromCustomMetadata(object.customMetadata);
        }
      }
      const last = page.objects.at(-1)?.key;
      const skipPrefix = skipping && `${this.prefix}/${skipping}/${DOWNLOADS}`;
      if (page.truncated && skipPrefix && last?.startsWith(skipPrefix)) {
        // Still inside the records being skipped: continue after all of them.
        // Record keys are ISO times and hex digits, which all sort before "~".
        cursor = undefined;
        startAfter = `${skipPrefix}~`;
      } else {
        cursor = page.truncated ? page.cursor : undefined;
        startAfter = undefined;
      }
    } while (cursor || startAfter);

    const uploads = await Promise.all(
      [...groups].map(async ([id, { keys, meta, sidecar, others, records }]) => {
        const stray = !sidecar && others === 0;
        if (!meta && !stray) {
          subrequests++;
          const full = await this.readMeta(id).catch(() => null);
          meta = full && summarize(full);
        }
        return { id, keys, meta: meta && withDownloads(meta, records.times), stray, records };
      }),
    );
    return { uploads, subrequests };
  }

  /**
   * Fold download records into the sidecar: add them to `download_count` and
   * `recent_downloads` (which replace a legacy `downloads` array), write the
   * sidecar and its summary, then delete the records. The sidecar is only
   * written if it has not changed since it was read (an etag condition), so a
   * concurrent delete or completion is never undone. Returns false if nothing
   * was folded.
   *
   * A download recorded meanwhile is a key not in `records` and stays for the
   * next fold. If deleting the records fails after the sidecar was written,
   * they are counted again next time (logged by the caller).
   */
  async foldDownloads(id: string, records: { keys: string[]; times: string[] }): Promise<boolean> {
    if (records.keys.length === 0) return false;
    const object = await this.bucket.get(this.dir(id) + ".meta.json");
    if (!object) return false;
    const meta = await object.json<UploadMeta>();
    if (meta.pending_upload_id) return false;
    const { downloads: _, ...rest } = meta;
    const counted = withDownloads(summarize(meta), records.times);
    const folded: UploadMeta = {
      ...rest,
      download_count: counted.download_count,
      recent_downloads: counted.recent_downloads,
    };
    const written = await this.bucket.put(
      this.dir(id) + ".meta.json",
      JSON.stringify(folded, null, 2),
      {
        httpMetadata: { contentType: "application/json" },
        customMetadata: toCustomMetadata(folded),
        onlyIf: { etagMatches: object.etag },
      },
    );
    if (!written) return false;
    await this.deleteKeys(records.keys);
    return true;
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
