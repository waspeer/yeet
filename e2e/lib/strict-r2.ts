// A second in-memory R2 bucket, written independently of fake-r2.ts by the
// verifier of round 1F, and stricter: UTF-8 byte order everywhere (startAfter
// and cursor comparisons included), opaque cursors, metadata lists capped at
// 100 and optionally random shorter pages (even empty ones with
// `truncated: true`), every call type counted and logged, throws past
// `maxCalls`. Hooks let a test change the bucket during a run. The random
// page lengths come from a seeded generator, so a failure reproduces.
import { randomBytes } from "node:crypto";
import type { Bucket } from "../../packages/worker/src/uploads.js";

/** A deterministic generator of numbers in [0, 1) (mulberry32). */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const cmp = (a: string, b: string) => Buffer.compare(Buffer.from(a, "utf-8"), Buffer.from(b, "utf-8"));

interface Obj {
  body: string;
  etag: string;
  meta: Record<string, string>;
}

export class StrictBucket implements Bucket {
  objects = new Map<string, Obj>();
  calls: Record<string, number> = {};
  log: string[] = [];
  maxCalls = 50;
  private cursors = new Map<string, string>();
  private n = 0;
  /** Random page length 0..cap for metadata lists. */
  randomPages = false;
  /** Called before each list call returns (to mutate the bucket mid-run). */
  onList?: () => void;
  /** Called after get returns and before the conditional put lands. */
  beforePut?: (key: string) => void;
  private readonly random: () => number;
  constructor(opts: { randomPages?: boolean; maxCalls?: number; seed?: number } = {}) {
    this.randomPages = !!opts.randomPages;
    if (opts.maxCalls !== undefined) this.maxCalls = opts.maxCalls;
    this.random = seededRandom(opts.seed ?? 1);
  }
  get total() {
    return Object.values(this.calls).reduce((a, b) => a + b, 0);
  }
  reset() {
    this.calls = {};
    this.log = [];
  }
  private cache: string[] | null = null;
  seed(key: string, body = "", meta: Record<string, string> = {}) {
    if (!this.objects.has(key) && this.cache) {
      // Keep the sorted key cache: insert in place rather than sort again.
      const at = this.firstAfter(key);
      this.cache.splice(at, 0, key);
    }
    this.objects.set(key, { body, etag: `"${++this.n}"`, meta });
  }
  private all(): string[] {
    if (!this.cache) {
      const ks = [...this.objects.keys()].map((k) => [Buffer.from(k, "utf-8"), k] as const);
      ks.sort((a, b) => Buffer.compare(a[0], b[0]));
      this.cache = ks.map((x) => x[1]);
    }
    return this.cache;
  }
  /** Index of first key > after (byte order). */
  private firstAfter(after: string | undefined): number {
    const a = this.all();
    if (after === undefined) return 0;
    let lo = 0, hi = a.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (cmp(a[mid]!, after) > 0) hi = mid; else lo = mid + 1; }
    return lo;
  }
  remove(k: string) {
    if (this.objects.delete(k)) this.cache = this.cache?.filter((key) => key !== k) ?? null;
  }
  sorted(prefix = "") {
    return this.range(prefix, undefined, Infinity).page;
  }
  private range(prefix: string, after: string | undefined, limit: number): { page: string[]; more: boolean } {
    const a = this.all();
    let i = this.firstAfter(after);
    // jump to prefix start
    if (prefix) { let lo = 0, hi = a.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (cmp(a[mid]!, prefix) >= 0) hi = mid; else lo = mid + 1; } i = Math.max(i, lo); }
    const page: string[] = [];
    while (i < a.length && a[i]!.startsWith(prefix) && page.length < limit) page.push(a[i++]!);
    const more = i < a.length && a[i]!.startsWith(prefix);
    return { page, more };
  }
  private async call(name: string, detail = "") {
    if (this.total >= this.maxCalls) throw new Error(`Too many subrequests: ${name} after ${this.total}`);
    this.calls[name] = (this.calls[name] ?? 0) + 1;
    this.log.push(`${name} ${detail}`);
    await Promise.resolve();
  }
  async get(key: string) {
    await this.call("get", key);
    const o = this.objects.get(key);
    if (!o) return null;
    const body = o.body;
    return { etag: o.etag, json: async <T>() => JSON.parse(body) as T };
  }
  async head(key: string) {
    await this.call("head", key);
    return this.objects.has(key) ? {} : null;
  }
  async put(
    key: string,
    value: string,
    options: { customMetadata?: Record<string, string>; onlyIf?: { etagMatches?: string } } = {},
  ) {
    await this.call("put", key);
    this.beforePut?.(key);
    const m = options.onlyIf?.etagMatches;
    if (m !== undefined) {
      const cur = this.objects.get(key);
      if (!cur || cur.etag !== m) return null;
    }
    this.seed(key, value, options.customMetadata ?? {});
    return {};
  }
  async list(options: { prefix?: string; cursor?: string; startAfter?: string; include?: string[] }) {
    await this.call("list", JSON.stringify(options));
    this.onList?.();
    const cap = options.include?.length ? 100 : 1000;
    const limit = this.randomPages ? Math.floor(this.random() * (cap + 1)) : cap;
    let after = options.startAfter;
    if (options.cursor !== undefined) {
      const c = this.cursors.get(options.cursor);
      if (c === undefined) throw new Error("bad cursor");
      if (after === undefined || cmp(c, after) > 0) after = c;
    }
    const { page, more } = this.range(options.prefix ?? "", after, limit);
    const truncated = more;
    let cursor: string | undefined;
    if (truncated) {
      cursor = randomBytes(9).toString("base64url");
      // An empty page continues from where the request started.
      this.cursors.set(cursor, page.at(-1) ?? after ?? "");
    }
    return {
      objects: page.map((key) => ({
        key,
        customMetadata: options.include?.includes("customMetadata") ? { ...this.objects.get(key)!.meta } : undefined,
      })),
      truncated,
      ...(cursor ? { cursor } : {}),
    };
  }
  async delete(keys: string | string[]) {
    const list = typeof keys === "string" ? [keys] : keys;
    await this.call("delete", String(list.length));
    if (list.length > 1000) throw new Error(">1000 keys");
    const gone = new Set(list.filter((k) => this.objects.delete(k)));
    if (gone.size) this.cache = this.cache?.filter((key) => !gone.has(key)) ?? null;
  }
  aborted: string[] = [];
  resumeMultipartUpload(key: string, uploadId: string) {
    return {
      abort: async () => {
        await this.call("abort", key);
        this.aborted.push(uploadId);
      },
    };
  }
}

export { cmp as byteCompare };
