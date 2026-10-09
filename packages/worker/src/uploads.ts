// Upload storage on top of the R2 bucket binding. Layout, shared with every
// earlier version of yeet:
//
//   <prefix>/<id>/<filename>     the file itself
//   <prefix>/<id>/.meta.json     metadata sidecar (UploadMeta), which also
//                                holds the download count
//   <prefix>/<id>/.parts/<n>     size of part n, only while an upload of
//                                unknown size is pending
//   <prefix>/<id>/.downloads/…   legacy: one empty object per download,
//                                written by the pre-release versions 1D/1E
//                                only. Never written or counted any more; the
//                                listing skips them and the cron deletes them.
//   <prefix>/.cleanup-cursor     where the next cron run resumes (cleanup.ts)

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
   * Downloads recorded by yeet 0.2 and earlier (the last 50). Read for the
   * count; replaced by download_count and recent_downloads the first time a
   * download is recorded.
   */
  downloads?: DownloadRecord[];
  /** Downloads recorded so far (see recordDownload()). */
  download_count?: number;
  /** The last five download times, oldest first. */
  recent_downloads?: string[];
  /** Set while the file is still being uploaded; holds the R2 multipart upload ID. */
  pending_upload_id?: string;
}

/**
 * The part of the R2 binding this module uses. R2Bucket satisfies it; the
 * unit tests pass a fake that counts calls.
 */
export interface Bucket {
  get(key: string): Promise<{ etag: string; json<T>(): Promise<T> } | null>;
  head(key: string): Promise<object | null>;
  put(
    key: string,
    value: string,
    options?: {
      httpMetadata?: { contentType?: string };
      customMetadata?: Record<string, string>;
      onlyIf?: { etagMatches?: string };
    },
  ): Promise<object | null>;
  list(options: {
    prefix?: string;
    cursor?: string;
    startAfter?: string;
    include?: ("httpMetadata" | "customMetadata")[];
    /** At most this many objects (R2: 1 to 1,000, and it may return fewer). */
    limit?: number;
  }): Promise<{
    objects: { key: string; customMetadata?: Record<string, string> }[];
    truncated: boolean;
    cursor?: string;
  }>;
  delete(keys: string | string[]): Promise<void>;
  resumeMultipartUpload(key: string, uploadId: string): { abort(): Promise<void> };
}

/**
 * Attempts at writing one download into the sidecar (see recordDownload()):
 * a get and a conditional put each, so at most 6 R2 calls per download.
 */
export const RECORD_ATTEMPTS = 3;

/**
 * listAll()'s default limit of R2 calls, sidecar reads of old uploads
 * included, for callers that set none. GET /api/uploads (listPage()) and the
 * cron set much tighter bounds of their own: what limits them is CPU, not
 * R2 calls (see "Listing a page" in docs/design/api.md).
 */
export const LIST_BUDGET = 40;

/**
 * Objects one page of GET /api/uploads lists: the `limit` of its list call
 * (with custom metadata). About 75 finished uploads (2 objects each). Real
 * R2 returns up to about 415 objects per such call (measured in phase 1H),
 * so this is the bound, not R2. Measured in phase 1J on Workers Free at
 * 300 (149 uploads): p50 7 ms, p90 10 ms CPU during a walk (n = 63), p50
 * 12, p90 17 for the same page repeated (n = 100); a fit of about 1.7 ms
 * plus 20 µs per object listed. Lowered to 150 for headroom: an estimate
 * of about 1.7 + 150 × 0.02 ≈ 4.7 ms, not measured yet (see "To measure
 * next" in docs/design/api.md). Tests derive what they expect from it.
 */
export const PAGE_LIMIT = 150;

/**
 * Sidecars without a summary (yeet < 0.2) one page reads, one get each
 * (about 0.3 to 0.5 ms CPU each, phase 1J). A page of nothing but such
 * sidecars shows this many uploads.
 */
export const PAGE_READS = 5;

/**
 * Extra list calls one page may make, only to jump over the rest of a
 * `.downloads/` or `.parts/` run its list call ended in (see listAll()). So
 * a page makes at most 2 list calls and examines at most 2 × PAGE_LIMIT
 * objects; without such runs (anything yeet 0.2 and later writes for a
 * finished upload), 1 call and PAGE_LIMIT objects.
 */
export const PAGE_JUMPS = 1;

/**
 * Part records `POST /api/uploads/:id/complete` of an upload of unknown size
 * reads at most (one per part sent, records of parts not in the request
 * included). Above it the request is refused (400) before anything changes,
 * telling the client to start again with the size: CPU, not R2 calls, is
 * the binding limit, and the complete of 4,000 records took 82 to 138 ms
 * CPU on Workers Free (phase 1J, n = 3). 300 parts are up to about 15.7 GB
 * at the 50 MiB part size. The CLI and the upload page always send the
 * size, so they never take this path.
 */
export const MAX_UNSIZED_PARTS = 300;

/**
 * R2 calls `POST /api/uploads/:id/complete` of an upload of unknown size may
 * spend on its part records (readPartSizes() and their deletion): the 50
 * subrequests the Free plan was assumed to allow, minus its 4 other ones
 * (the Bearer rate-limit call, the sidecar read, the multipart complete and
 * the sidecar write). A second guard behind MAX_UNSIZED_PARTS: it only
 * refuses first if R2 returns fewer than 7 records per list call.
 */
export const PART_RECORDS_BUDGET = 50 - 4;

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

export function isExpired(meta: { expires_at: string }, now = Date.now()): boolean {
  return new Date(meta.expires_at).getTime() <= now;
}

export function generateId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").slice(0, 6);
}

/**
 * The most bytes (keys plus values, UTF-8) of summary custom metadata yeet
 * writes. R2 refuses custom metadata above its own limit (miniflare enforces
 * 8,192 bytes); 2,048 keeps well clear of it. A summary that does not fit is
 * not written (see toCustomMetadata()).
 */
export const MAX_SUMMARY_BYTES = 2048;

/** What listing and cleanup need, stored as R2 custom metadata (see MAX_SUMMARY_BYTES). */
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

const isString = (value: unknown): value is string => typeof value === "string";
const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const optional = <T>(value: unknown, check: (value: unknown) => value is T): boolean =>
  value === undefined || check(value);

/**
 * The body of a sidecar as an UploadMeta, or null if it does not have that
 * shape: the fields summarize() and the cron read must have their types. A
 * sidecar that fails this (e.g. a hand-edited `"downloads": 5`) is treated
 * like one that is not valid JSON: not listed, not counted, not cleaned up,
 * and never allowed to stop a listing or a cron run.
 */
export function parseUploadMeta(value: unknown): UploadMeta | null {
  if (!isObject(value)) return null;
  const { downloads, recent_downloads } = value;
  const ok =
    isString(value.filename) &&
    isString(value.uploaded_at) &&
    isString(value.expires_at) &&
    optional(value.file_size, isCount) &&
    optional(value.password_hash, isString) &&
    optional(value.pending_upload_id, isString) &&
    optional(value.download_count, isCount) &&
    (recent_downloads === undefined ||
      (Array.isArray(recent_downloads) && recent_downloads.every(isString))) &&
    (downloads === undefined ||
      (Array.isArray(downloads) && downloads.every((d) => isObject(d) && isString(d.at))));
  return ok ? (value as unknown as UploadMeta) : null;
}

/** A summary read back from custom metadata, or null if it does not have the shape written. */
export function parseSummary(value: unknown): UploadSummary | null {
  if (!isObject(value)) return null;
  const ok =
    isString(value.filename) &&
    isCount(value.file_size) &&
    isString(value.uploaded_at) &&
    isString(value.expires_at) &&
    typeof value.has_password === "boolean" &&
    optional(value.pending_upload_id, isString) &&
    isCount(value.download_count) &&
    Array.isArray(value.recent_downloads) &&
    value.recent_downloads.every(isString);
  return ok ? (value as unknown as UploadSummary) : null;
}

/** Only for a sidecar parseUploadMeta() accepts; anything else may throw. */
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

/**
 * The sidecar with one more download at `at`: download_count and
 * recent_downloads, which take over from a legacy `downloads` array.
 */
export function withDownload(meta: UploadMeta, at: string): UploadMeta {
  const { downloads: _, ...rest } = meta;
  const { download_count, recent_downloads } = summarize(meta);
  return {
    ...rest,
    download_count: download_count + 1,
    recent_downloads: [...recent_downloads, at].sort().slice(-5),
  };
}

/** Subdirectories of an upload that can hold many objects; listings jump over them. */
const BULK_DIRS = [".downloads/", ".parts/"];

/** One upload as listAll() finds it. */
export interface ListedUpload {
  id: string;
  /** The keys listed; every key of the upload when `complete`. */
  keys: string[];
  /** False if the listing jumped over some of its keys (see listAll()). */
  complete: boolean;
  /** The summary, or null without a (readable) sidecar. */
  meta: UploadSummary | null;
  /** It has legacy `.downloads/` records (yeet 1D/1E), which the cron deletes. */
  legacyRecords: boolean;
  /**
   * Legacy download records without an upload: every key was listed, and
   * there is no sidecar or anything else.
   */
  stray: boolean;
  /** Its sidecar has no summary custom metadata (yeet < 0.2): read separately. */
  unsummarized: boolean;
}

export interface Listing {
  /** In key order (by ID), so a later listing can resume after the last one. */
  uploads: ListedUpload[];
  /** True if the budget ran out before the end of the bucket: uploads after the last are missing. */
  truncated: boolean;
  /** The R2 calls made. */
  subrequests: number;
  /** When truncated: the key to pass as `after` to continue where this listing stopped. */
  resumeAfter?: string;
}

const utf8Length = (text: string) => new TextEncoder().encode(text).length;

/**
 * The summary custom metadata of a sidecar, or none if the sidecar is not
 * shaped like one (parseUploadMeta()) or its summary would take more than
 * MAX_SUMMARY_BYTES (a filename or download times far longer than yeet
 * writes). Without it the sidecar is written all the same, and listings
 * read its body instead, as for a sidecar of yeet < 0.2.
 */
function toCustomMetadata(meta: UploadMeta): Record<string, string> {
  const valid = parseUploadMeta(meta);
  if (!valid) return {};
  const summary = JSON.stringify(summarize(valid));
  return utf8Length("summary") + utf8Length(summary) <= MAX_SUMMARY_BYTES ? { summary } : {};
}

/** Whether a sidecar's summary fits in its custom metadata (see toCustomMetadata()). */
export function canStoreSummary(meta: UploadMeta): boolean {
  return "summary" in toCustomMetadata(meta);
}

/**
 * The summary in a sidecar's custom metadata, or null without a usable one
 * (missing, not JSON, or not shaped like a summary, `"null"` included). The
 * listing and the migration script (backfill.ts) both decide with this.
 */
export function summaryFromCustomMetadata(
  custom: Record<string, string> | undefined,
): UploadSummary | null {
  if (!custom?.summary) return null;
  try {
    return parseSummary(JSON.parse(custom.summary));
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class Uploads {
  private readonly prefix: string;

  constructor(
    private readonly bucket: Bucket,
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

  /** Where the cron keeps its position (an ID is never `.cleanup-cursor`). */
  get cursorKey(): string {
    return `${this.prefix}/.cleanup-cursor`;
  }

  /**
   * A key that sorts right after every key of upload `id` and before the
   * next upload's: `<id>0`, since '/' < '0' and no ID character lies
   * between the two.
   */
  keyAfter(id: string): string {
    return `${this.dir(id).slice(0, -1)}0`;
  }

  /**
   * Read the metadata sidecar, or null if the upload does not exist. Throws
   * if it is not valid JSON; its shape is not checked (the pages need only a
   * few of its fields). Listing, counting and cleanup use readSidecar().
   */
  async readMeta(id: string): Promise<UploadMeta | null> {
    const object = await this.bucket.get(this.dir(id) + ".meta.json");
    if (!object) return null;
    return object.json<UploadMeta>();
  }

  /**
   * Read the metadata sidecar (1 R2 call) for code that must not stop on a
   * bad one: `meta` is null if it is missing, not valid JSON, or not shaped
   * like a sidecar (parseUploadMeta()); `etag` is set whenever it exists.
   */
  async readSidecar(id: string): Promise<{ etag: string | null; meta: UploadMeta | null }> {
    const object = await this.bucket.get(this.dir(id) + ".meta.json");
    if (!object) return { etag: null, meta: null };
    const body = await object.json<unknown>().catch(() => null);
    return { etag: object.etag, meta: parseUploadMeta(body) };
  }

  /**
   * Write the metadata sidecar. A summary also goes into the object's custom
   * metadata, so a listing reads every upload's summary from its list pages
   * instead of one read per upload, which would cost a round trip and CPU
   * each.
   */
  async writeMeta(
    id: string,
    meta: UploadMeta,
    onlyIf?: { etagMatches: string },
  ): Promise<boolean> {
    const written = await this.bucket.put(
      this.dir(id) + ".meta.json",
      JSON.stringify(meta, null, 2),
      {
        httpMetadata: { contentType: "application/json" },
        customMetadata: toCustomMetadata(meta),
        ...(onlyIf ? { onlyIf } : {}),
      },
    );
    return written !== null;
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

  /**
   * The recorded part sizes of an upload, and the keys of their records, or
   * null if there are more than `maxRecords` of them, or if listing them
   * (one call per page, with metadata) and deleting them afterwards
   * (deleteKeys(): one call per 1,000) would take more than `budget` R2
   * calls. It stops listing as soon as either is certain: it lists at most
   * `maxRecords + 1` records (each call's `limit`) and makes at most
   * `budget` calls itself.
   */
  async readPartSizes(
    id: string,
    budget = Infinity,
    maxRecords = Infinity,
  ): Promise<{ sizes: Map<number, number>; keys: string[] } | null> {
    const prefix = `${this.dir(id)}.parts/`;
    const sizes = new Map<number, number>();
    const keys: string[] = [];
    let cursor: string | undefined;
    let calls = 0;
    const deletes = () => Math.ceil(keys.length / 1000);
    do {
      // This call, and at least the deletes of the records found so far.
      if (calls + 1 + deletes() > budget) return null;
      calls++;
      // Enough to tell that there are more than maxRecords, and no more.
      const left = maxRecords + 1 - keys.length;
      const page = await this.bucket.list({
        prefix,
        cursor,
        include: ["customMetadata"],
        ...(left < 1000 ? { limit: left } : {}),
      });
      for (const object of page.objects) {
        keys.push(object.key);
        const partNumber = Number(object.key.slice(prefix.length));
        const size = Number(object.customMetadata?.size);
        if (Number.isInteger(partNumber) && Number.isSafeInteger(size)) sizes.set(partNumber, size);
      }
      if (keys.length > maxRecords) return null;
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    return calls + deletes() > budget ? null : { sizes, keys };
  }

  async exists(id: string): Promise<boolean> {
    return (await this.bucket.head(this.dir(id) + ".meta.json")) !== null;
  }

  /**
   * Count a download made at `at` in the sidecar: a read-modify-write that
   * only writes if the sidecar is unchanged since it was read (R2's
   * `onlyIf: { etagMatches }`, checked atomically with the write). On a
   * conflict (another download, or a delete, got there first) it reads again
   * after a short random wait, up to RECORD_ATTEMPTS times.
   *
   * So downloads one after another are counted exactly, and a count is never
   * written twice or over a newer one (no overcount, a deleted upload is
   * never written back). Under heavy concurrency on one file a download may
   * still find the sidecar changed on every attempt and is then not counted:
   * an undercount. At most 2 × RECORD_ATTEMPTS R2 calls; called in
   * waitUntil(), after the response. Returns whether it counted.
   */
  async recordDownload(id: string, at: string): Promise<boolean> {
    for (let attempt = 1; ; attempt++) {
      const started = Date.now();
      const { etag, meta } = await this.readSidecar(id);
      // Gone, pending, or a sidecar that cannot be counted in (see readSidecar()).
      if (!etag || !meta || meta.pending_upload_id) return false;
      if (await this.writeMeta(id, withDownload(meta, at), { etagMatches: etag })) {
        return true;
      }
      if (attempt >= RECORD_ATTEMPTS) return false;
      // Spread the retries of colliding downloads over a few round trips of
      // the read and write just made, more widely on each attempt.
      const roundTrip = Math.max(10, Date.now() - started);
      await sleep(Math.random() * roundTrip * 8 * attempt);
    }
  }

  /**
   * Finished and pending uploads with their summaries, in key order, in at
   * most `budget` R2 calls (default LIST_BUDGET) whatever the bucket holds.
   *
   * One list call returns at most `limit` objects with their custom
   * metadata, and R2 may return fewer (miniflare at most 100; real R2 about
   * 415, measured in phase 1H, whatever the limit above that). A finished
   * upload is 2 objects (file and sidecar) whose summary comes from the
   * sidecar's custom metadata. A sidecar of yeet < 0.2 has no summary and
   * costs one read, counted in the budget. With `deferReads: n` such
   * sidecars are left unread (`meta` null, `unsummarized`) for the caller,
   * which reserves n calls of the budget for each; `maxListCalls` caps the
   * list calls on top of the budget.
   *
   * `.downloads/` (legacy) and `.parts/` keys can be many per upload. When a
   * page ends inside such a run, the next call starts after it
   * (`startAfter`), so it costs at most one call per upload; the upload is
   * then marked incomplete (its keys are not all listed). `jumpCalls`
   * allows that many such calls beyond `maxListCalls` (still within the
   * budget), so that a listing of one call still gets past such a run.
   *
   * Stops when the budget is spent, and then returns the uploads listed so
   * far (never a partly listed last one) with `truncated: true` and the
   * key to continue after (`resumeAfter`), which `after` takes: right before
   * the first upload it leaves out, so a resumed listing skips none. If it
   * listed nothing but the start of one upload whose sidecar it never
   * reached because R2 returned a short or empty page after a `.downloads/`
   * run, it reads that sidecar (1 call, within the budget) and returns the
   * upload with it, rather than skip it or stall on it.
   */
  async listAll(
    opts: {
      budget?: number;
      after?: string;
      deferReads?: number;
      maxListCalls?: number;
      jumpCalls?: number;
      limit?: number;
    } = {},
  ): Promise<Listing> {
    const budget = opts.budget ?? LIST_BUDGET;
    const maxListCalls = opts.maxListCalls ?? budget;
    const jumpCalls = opts.jumpCalls ?? 0;
    const limit = opts.limit !== undefined ? { limit: opts.limit } : {};
    // What a sidecar without a summary costs: a read, here or by the caller.
    const readCost = opts.deferReads ?? 1;
    const base = `${this.prefix}/`;
    interface Group extends Omit<ListedUpload, "stray" | "unsummarized"> {
      sidecar: boolean;
      others: number;
      /** Keys listed outside its `.downloads/` and `.parts/` runs. */
      outside: number;
      /** Its sidecar was read because the listing never reached it (see below). */
      probed: boolean;
      /** A key right before this upload's first, or undefined for the start of the bucket. */
      before: string | undefined;
    }
    const groups: Group[] = [];
    let calls = 0;
    let truncated = false;
    const start = opts.after !== undefined && opts.after.startsWith(base) ? opts.after : undefined;
    let next: { cursor?: string; startAfter?: string } =
      start !== undefined ? { startAfter: start } : {};
    let lastKey = start; // the last key listed
    const readsNeeded = (list: Group[]) =>
      readCost * list.filter((g) => g.sidecar && !g.meta).length;
    let jumps = 0; // calls made under jumpCalls
    let jumping = false; // the next call jumps over the rest of a run
    let endedInGroup = false; // the last key listed belongs to the last group

    for (;;) {
      // Room for this call, and for the reads of the uploads listed so far.
      const jump = jumping && jumps < jumpCalls;
      if ((!jump && calls - jumps + 1 > maxListCalls) || calls + 1 + readsNeeded(groups) > budget) {
        truncated = true;
        break;
      }
      if (jump) jumps++;
      const page = await this.bucket.list({
        prefix: base,
        ...next,
        include: ["customMetadata"],
        ...limit,
      });
      calls++;
      for (const object of page.objects) {
        const previousKey = lastKey;
        lastKey = object.key;
        const [id, ...rest] = object.key.slice(base.length).split("/");
        endedInGroup = false;
        if (!id || !isValidId(id) || rest.length === 0) continue;
        endedInGroup = true;
        let group = groups.at(-1);
        if (group?.id !== id) {
          group = {
            id,
            keys: [],
            complete: true,
            meta: null,
            legacyRecords: false,
            sidecar: false,
            others: 0,
            outside: 0,
            probed: false,
            // After the previous upload rather than its last key listed,
            // which may lie inside a run the listing jumped over.
            before: group ? this.keyAfter(group.id) : previousKey,
          };
          groups.push(group);
        }
        const name = rest.join("/");
        group.keys.push(object.key);
        if (name.startsWith(".downloads/")) {
          group.legacyRecords = true;
          continue;
        }
        group.others++;
        if (!name.startsWith(".parts/")) group.outside++;
        if (name === ".meta.json") {
          group.sidecar = true;
          group.meta = summaryFromCustomMetadata(object.customMetadata);
        }
      }
      if (!page.truncated) break;
      // A page that ends inside an upload's `.downloads/` or `.parts/` run:
      // continue after the run. Its keys (times, hex, digits) sort before '~'.
      const last = page.objects.at(-1)?.key ?? "";
      const [lastId, ...lastRest] = last.slice(base.length).split("/");
      const bulk = BULK_DIRS.find((dir) => lastRest.join("/").startsWith(dir));
      jumping = !!bulk && !!lastId && isValidId(lastId);
      if (jumping) {
        groups.at(-1)!.complete = false;
        next = { startAfter: `${base}${lastId}/${bulk}~` };
      } else {
        next = { cursor: page.cursor };
      }
    }

    // Keys of one upload are contiguous, so every upload but the last is
    // listed completely; the last only if the listing reached the end, or
    // listed a key after it (one that belongs to no upload).
    const lastPartial = truncated && endedInGroup;
    if (lastPartial && groups.length > 0) groups.at(-1)!.complete = false;
    const candidates = lastPartial ? groups.slice(0, -1) : groups;
    // The reads of old sidecars, as far as the budget goes.
    let reads = 0;
    const kept: Group[] = [];
    for (const group of candidates) {
      const read = group.sidecar && !group.meta ? readCost : 0;
      if (calls + reads + read > budget) {
        truncated = true;
        break;
      }
      reads += read;
      kept.push(group);
    }

    // Resume right before the first upload left out, or after the last key
    // listed if none was (the budget went on keys that are no upload).
    let resumeAfter: string | undefined;
    let unread: Group | undefined;
    if (truncated) {
      const firstLeft = groups[kept.length];
      resumeAfter = firstLeft ? firstLeft.before : lastKey;
      // (Only if more than 2 of its keys were listed: a yeet upload has at
      // most 2 outside its `.downloads/` and `.parts/` runs, the sidecar
      // and the file. With 2 or fewer, R2 merely returned short pages, as
      // it may (even empty ones); then nothing is returned and the next
      // listing starts where this one did.)
      if (firstLeft && resumeAfter === start && firstLeft.keys.length > 2) {
        if (!firstLeft.sidecar && firstLeft.outside <= 2) {
          // Its keys are mostly a `.downloads/` or `.parts/` run, and the
          // listing ended before its sidecar: R2 returned a short or empty
          // page on the jump over the run. It may be an upload like any
          // other, so it must not be skipped: read its sidecar (one call)
          // and return it with what that says, or, without room for the
          // read or if the read fails, return nothing and let the next
          // listing start where this one did.
          if (calls + 1 <= budget) {
            calls++;
            const read = await this.readSidecar(firstLeft.id).catch(() => undefined);
            if (read) {
              // No sidecar (null etag): no upload to list, only its keys.
              firstLeft.sidecar = read.etag !== null;
              firstLeft.meta = read.meta ? summarize(read.meta) : null;
              firstLeft.probed = true;
              unread = firstLeft;
              kept.push(firstLeft);
              resumeAfter = this.keyAfter(firstLeft.id);
            }
          }
        } else {
          // Nothing before it was listed: the budget does not stretch to this
          // one upload (more keys than it lists, not a yeet upload). Return it
          // unread, and incomplete if partly listed, so that the next listing
          // gets past it rather than stalling.
          unread = firstLeft;
          kept.push(firstLeft);
          resumeAfter = this.keyAfter(firstLeft.id);
        }
      }
    }

    const uploads = await Promise.all(
      kept.map(async (group): Promise<ListedUpload> => {
        const { sidecar, others, outside: _o, probed, before: _, ...listed } = group;
        let meta = listed.meta;
        if (sidecar && !meta && group !== unread && opts.deferReads === undefined) {
          calls++;
          // A sidecar that is unreadable or not shaped like one is listed
          // without a summary (left out of GET /api/uploads, left alone by
          // the cron), never an error that stops the listing.
          const full = await this.readSidecar(listed.id).catch(() => null);
          meta = full?.meta ? summarize(full.meta) : null;
        }
        return {
          ...listed,
          meta,
          // Only if every key was listed: a sidecar may follow the records.
          stray: listed.complete && !sidecar && others === 0,
          // (A sidecar probed above was read already.)
          unsummarized: sidecar && !listed.meta && !probed,
        };
      }),
    );
    return { uploads, truncated, subrequests: calls, ...(truncated ? { resumeAfter } : {}) };
  }

  /**
   * One page of GET /api/uploads: the finished uploads among the next
   * objects after the key `after` (from the start of the bucket without
   * one), newest first, and the key the next page starts after, or null at
   * the end of the bucket.
   *
   * Bounded per request whatever the bucket holds (CPU, not R2 calls, is
   * what limits a request on the Free plan): one list call of at most
   * PAGE_LIMIT objects, at most PAGE_JUMPS more to jump over the rest of a
   * `.downloads/` or `.parts/` run, and reads of sidecars without a summary,
   * 1 + PAGE_READS R2 calls in all. listAll() keeps its guarantees per
   * page: no partly listed upload (but the one a stalled listing must get
   * past), the next page starts right before the first upload this one
   * left out, and an unreadable or malformed sidecar is left out, never an
   * error.
   */
  async listPage(
    after?: string,
  ): Promise<{ uploads: (UploadSummary & { id: string })[]; next: string | null }> {
    const listing = await this.listAll({
      // A jump takes the place of a read: at most 1 + PAGE_READS R2 calls.
      budget: 1 + PAGE_READS,
      maxListCalls: 1,
      jumpCalls: PAGE_JUMPS,
      limit: PAGE_LIMIT,
      ...(after !== undefined ? { after } : {}),
    });
    const uploads = listing.uploads
      // Finished uploads only; their summaries carry no pending_upload_id.
      .flatMap(({ id, meta }) => (meta && !meta.pending_upload_id ? [{ id, ...meta }] : []))
      .sort((a, b) => b.uploaded_at.localeCompare(a.uploaded_at));
    // An empty page that R2 says is not the last (it may return fewer
    // objects than asked, none included) gives no key to resume after:
    // the next page starts where this one did.
    const next = listing.truncated ? (listing.resumeAfter ?? after ?? this.listPrefix) : null;
    return { uploads, next };
  }

  /** The prefix every key of the uploads starts with, `<prefix>/`. */
  get listPrefix(): string {
    return `${this.prefix}/`;
  }

  /**
   * Give a sidecar written without one (yeet < 0.2, rclone) its summary
   * custom metadata, so listings read it from their pages instead of one
   * read each. Conditional on the sidecar being unchanged since read, so it
   * never overwrites a download counted meanwhile (which writes the summary
   * itself). Returns the sidecar read (null if gone, unreadable or not
   * shaped like a sidecar, see readSidecar()), whether it wrote, and the R2
   * calls made: 2, or 1 without a summary to write. A sidecar whose summary
   * does not fit (MAX_SUMMARY_BYTES) is returned but not written: it stays
   * without one, and costs a read in every listing.
   */
  async addSummary(
    id: string,
  ): Promise<{ meta: UploadMeta | null; written: boolean; calls: number }> {
    const { etag, meta } = await this.readSidecar(id);
    if (!etag || !meta) return { meta: null, written: false, calls: 1 };
    if (!canStoreSummary(meta)) return { meta, written: false, calls: 1 };
    const written = await this.writeMeta(id, meta, { etagMatches: etag });
    return { meta, written, calls: 2 };
  }

  /** Whether `key` is the sidecar of an upload, `<prefix>/<id>/.meta.json`. */
  isSidecarKey(key: string): boolean {
    const [id, name, ...rest] = key.slice(this.prefix.length + 1).split("/");
    return key.startsWith(`${this.prefix}/`) && !!id && name === ".meta.json" && rest.length === 0;
  }

  /**
   * Delete every object under `prefix` (an upload's directory, or a
   * directory in it) in at most `maxCalls` R2 calls and `maxLists` list
   * calls: a list (up to `limit` keys without metadata, default 1,000) and
   * a delete per round, and the upload's sidecar in a call of its own once
   * everything else is gone.
   * Returns the calls made and whether nothing is left.
   *
   * The sidecar goes last because it is what makes the listing (and so the
   * cron) see an upload: if the calls run out half-way, what is left is
   * still an upload that the next run finds and deletes, not keys without a
   * sidecar that nothing would ever clean up.
   */
  async deleteUnder(
    prefix: string,
    maxCalls: number,
    opts: { limit?: number; maxLists?: number } = {},
  ): Promise<{ calls: number; done: boolean }> {
    const maxLists = opts.maxLists ?? Infinity;
    let lists = 0;
    if (!prefix.startsWith(`${this.prefix}/`) || !prefix.endsWith("/")) {
      throw new Error(`Unsafe prefix: ${JSON.stringify(prefix)}`);
    }
    let calls = 0;
    // The sidecars seen, kept until everything else is gone.
    const sidecars = new Set<string>();
    // Set after a page that held nothing but sidecars (see below).
    let startAfter: string | undefined;
    while (calls + 2 <= maxCalls && lists < maxLists) {
      const page = await this.bucket.list({
        prefix,
        ...(startAfter ? { startAfter } : {}),
        ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
      });
      calls++;
      lists++;
      startAfter = undefined;
      const keys = page.objects.map((object) => object.key);
      const others = keys.filter((key) => !this.isSidecarKey(key));
      for (const key of keys) if (this.isSidecarKey(key)) sidecars.add(key);
      if (others.length > 0) {
        await this.bucket.delete(others);
        calls++;
      }
      if (page.truncated) {
        // More to list. Each round lists from the start, minus what is
        // gone, except after a page with nothing to delete (only the
        // sidecar, on a short page): listing from the start would return it
        // again, so the next round starts after it instead.
        if (others.length === 0) startAfter = keys.at(-1);
        continue;
      }
      // Everything else is gone: only the sidecar may be left.
      if (sidecars.size === 0) return { calls, done: true };
      if (calls + 1 > maxCalls) break;
      await this.bucket.delete([...sidecars]);
      calls++;
      return { calls, done: true };
    }
    return { calls, done: false };
  }

  /**
   * Delete objects by key, in batches of the 1000 R2 accepts per call, the
   * sidecars after every other key (see deleteUnder()).
   */
  async deleteKeys(keys: string[]): Promise<void> {
    const others = keys.filter((key) => !this.isSidecarKey(key));
    const sidecars = keys.filter((key) => this.isSidecarKey(key));
    for (const batch of [others, sidecars]) {
      for (let i = 0; i < batch.length; i += 1000) {
        await this.bucket.delete(batch.slice(i, i + 1000));
      }
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
