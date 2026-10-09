// An in-memory stand-in for the R2 bucket binding that counts every call, for
// unit tests of packages/worker/src/uploads.ts and cleanup.ts. It follows the
// R2 rules those modules rely on:
//
// - list() returns keys in byte order, at most 1,000 per call, and at most
//   100 when `include` asks for metadata (miniflare's cap; Cloudflare says
//   such lists may return fewer than asked, so `pageSize` can lower it), and
//   never more than the call's `limit`;
//   `cursor` and `startAfter` work as in R2 (the later of the two wins);
// - put() with `onlyIf: { etagMatches }` writes only if the object exists
//   with that etag (atomically) and returns null otherwise;
// - each get, head, put, list, delete and multipart abort or complete is one
//   subrequest.
//   Past `maxCalls` (default 50, the Free plan's limit per invocation) a call
//   throws, as the Workers runtime does.

import type { Bucket } from "../../packages/worker/src/uploads.js";

interface Stored {
  body: string;
  etag: string;
  customMetadata: Record<string, string>;
}

export interface FakeBucketOptions {
  /** Calls allowed before one throws (default 50). */
  maxCalls?: number;
  /** Objects per list page with metadata (default 100, at most 100). */
  pageSize?: number;
  /** Delay of every call in ms (default 0), to let concurrent callers interleave. */
  latencyMs?: () => number;
}

export class FakeBucket implements Bucket {
  readonly objects = new Map<string, Stored>();
  readonly calls: Record<string, number> = {};
  maxCalls: number;
  private etags = 0;

  constructor(private readonly opts: FakeBucketOptions = {}) {
    this.maxCalls = opts.maxCalls ?? 50;
  }

  get total(): number {
    return Object.values(this.calls).reduce((sum, n) => sum + n, 0);
  }

  /** Forget the calls counted so far (e.g. after seeding), and allow `maxCalls` again. */
  resetCalls(): void {
    for (const name of Object.keys(this.calls)) delete this.calls[name];
  }

  /** Store an object without counting a call. */
  seed(key: string, body = "", customMetadata: Record<string, string> = {}): void {
    this.objects.set(key, { body, etag: `e${++this.etags}`, customMetadata });
  }

  keys(prefix = ""): string[] {
    return [...this.objects.keys()].filter((key) => key.startsWith(prefix)).sort(byteOrder);
  }

  private async call(name: string): Promise<void> {
    if (this.total >= this.maxCalls) {
      throw new Error(`Too many subrequests (${name} after ${this.total} calls)`);
    }
    this.calls[name] = (this.calls[name] ?? 0) + 1;
    const delay = this.opts.latencyMs?.() ?? 0;
    await new Promise((resolve) => setTimeout(resolve, delay));
  }

  async get(key: string) {
    await this.call("get");
    const object = this.objects.get(key);
    if (!object) return null;
    return {
      etag: object.etag,
      json: async <T>() => JSON.parse(object.body) as T,
    };
  }

  async head(key: string) {
    await this.call("head");
    return this.objects.has(key) ? { key } : null;
  }

  async put(
    key: string,
    value: string,
    options: { customMetadata?: Record<string, string>; onlyIf?: { etagMatches?: string } } = {},
  ) {
    await this.call("put");
    const etagMatches = options.onlyIf?.etagMatches;
    if (etagMatches !== undefined && this.objects.get(key)?.etag !== etagMatches) return null;
    this.seed(key, value, options.customMetadata ?? {});
    return { key };
  }

  async list(options: {
    prefix?: string;
    cursor?: string;
    startAfter?: string;
    include?: ("httpMetadata" | "customMetadata")[];
    limit?: number;
  }) {
    await this.call("list");
    const limit = Math.min(
      options.include?.length ? Math.min(100, this.opts.pageSize ?? 100) : 1000,
      options.limit ?? 1000,
    );
    let after = options.startAfter;
    if (options.cursor !== undefined) {
      const fromCursor = Buffer.from(options.cursor, "base64url").toString("utf-8");
      if (after === undefined || fromCursor > after) after = fromCursor;
    }
    const keys = this.keys(options.prefix).filter((key) => after === undefined || key > after);
    const page = keys.slice(0, limit);
    const truncated = keys.length > limit;
    return {
      objects: page.map((key) => ({
        key,
        customMetadata: options.include?.includes("customMetadata")
          ? { ...this.objects.get(key)!.customMetadata }
          : undefined,
      })),
      truncated,
      ...(truncated ? { cursor: Buffer.from(page.at(-1)!, "utf-8").toString("base64url") } : {}),
    };
  }

  async delete(keys: string | string[]) {
    await this.call("delete");
    const list = typeof keys === "string" ? [keys] : keys;
    if (list.length > 1000) throw new Error("R2 deletes at most 1000 keys per call");
    for (const key of list) this.objects.delete(key);
  }

  resumeMultipartUpload(_key: string, _uploadId: string) {
    return { abort: () => this.call("abort"), complete: () => this.call("complete") };
  }
}

/** R2 orders keys by their UTF-8 bytes. */
function byteOrder(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, "utf-8"), Buffer.from(b, "utf-8"));
}
