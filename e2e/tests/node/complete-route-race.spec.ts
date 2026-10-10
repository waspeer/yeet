// The complete/DELETE race through the real routes (round 2C verifier).
// complete-race.spec.ts drives Uploads.finishUpload() directly, and its
// wrangler dev test cannot time a DELETE into the window between R2's
// multipart complete and the sidecar write. Here the Worker's own fetch
// handler (packages/worker/src/index.ts) runs in Node on the in-memory
// strict bucket, whose multipart complete runs a DELETE request through
// the same handler at exactly that moment. That checks what the routes
// answer, which the unit tests do not: a complete that lost to a DELETE
// must not hand out a link (404), the deletion must stay whole, and a
// complete sent again after a success answers with the same link.

import { timingSafeEqual } from "node:crypto";
import { register } from "node:module";
import {
  DELETED_UPLOAD_ID,
  summarize,
  type UploadMeta,
} from "../../../packages/worker/src/uploads.js";
import { expect, test } from "../../lib/index.js";
import { StrictBucket } from "../../lib/strict-r2.js";

// rate-limit.ts imports `cloudflare:workers` (for its Durable Object class),
// which Node cannot load: resolve it to a stub, then load the Worker.
register(
  "data:text/javascript," +
    encodeURIComponent(
      `export async function resolve(specifier, context, next) {
        if (specifier === "cloudflare:workers") {
          return { url: "data:text/javascript,export class DurableObject {}", shortCircuit: true };
        }
        return next(specifier, context);
      }`,
    ),
);
// Workers' non-standard crypto.subtle.timingSafeEqual (crypto.ts), from Node's.
const subtle = crypto.subtle as SubtleCrypto & { timingSafeEqual?: unknown };
subtle.timingSafeEqual ??= (a: ArrayBufferView | ArrayBuffer, b: ArrayBufferView | ArrayBuffer) =>
  timingSafeEqual(
    new Uint8Array(
      ArrayBuffer.isView(a) ? a.buffer.slice(a.byteOffset, a.byteOffset + a.byteLength) : a,
    ),
    new Uint8Array(
      ArrayBuffer.isView(b) ? b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) : b,
    ),
  );
type Handler = { fetch: (request: Request, env: never, ctx: never) => Promise<Response> };
// A specifier tsc does not follow: e2e's typecheck has no Workers types
// for index.ts (Playwright still transpiles it at run time).
const WORKER_ENTRY: string = "../../../packages/worker/src/index.js";
const worker = ((await import(WORKER_ENTRY)) as { default: unknown }).default as Handler;

const P = "uploads";
const DAY = 86_400_000;
const TOKEN = "verifier-token-" + "x".repeat(40);
const ORIGIN = "https://yeet.test";

/** A strict bucket with a multipart complete that can run a hook mid-way. */
class RaceBucket extends StrictBucket {
  /** Runs when the route calls R2's complete, before R2 does anything (round 2C+2). */
  beforeComplete?: () => Promise<void>;
  /** Runs after R2's complete made the file, before the route goes on. */
  duringComplete?: () => Promise<void>;
  /**
   * Refuse a second complete of the same multipart upload, as R2 may (what
   * real R2 does is not measured; round 2C+2).
   */
  completeOnce = false;
  readonly completed = new Set<string>();
  completes = 0;
  /** With the object's size, as R2's head() has it. */
  override async head(key: string) {
    const found = await super.head(key);
    return found ? { ...found, size: this.objects.get(key)!.body.length } : null;
  }
  override resumeMultipartUpload(key: string, uploadId: string) {
    const base = super.resumeMultipartUpload(key, uploadId);
    return {
      abort: base.abort,
      complete: async (_parts: unknown) => {
        const before = this.beforeComplete;
        this.beforeComplete = undefined;
        if (before) await before();
        if (this.aborted.includes(uploadId)) throw new Error("multipart upload aborted");
        if (this.completeOnce && this.completed.has(uploadId)) {
          throw new Error("multipart upload already completed");
        }
        this.completed.add(uploadId);
        this.completes++;
        this.seed(key, "abc");
        const hook = this.duringComplete;
        this.duringComplete = undefined;
        if (hook) await hook();
        return { size: 3 };
      },
    };
  }
}

function env(bucket: RaceBucket) {
  return {
    BUCKET: bucket,
    // Every rate limit allows (none is under test here).
    RATE_LIMITER: {
      idFromName: (name: string) => name,
      get: () => ({ hit: async () => ({ allowed: true, retryAfter: 0 }) }),
    },
    UPLOAD_TOKEN: TOKEN,
    UPLOADS_PREFIX: P,
  } as never;
}

const ctx = { waitUntil() {}, passThroughOnException() {} } as never;

async function call(bucket: RaceBucket, method: string, path: string, body?: unknown) {
  const res = await worker.fetch(
    new Request(ORIGIN + path, {
      method,
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    env(bucket),
    ctx,
  );
  return {
    status: res.status,
    json: (await res.json().catch(() => null)) as Record<string, unknown>,
  };
}

function seedPending(b: StrictBucket, id: string, records = 0): void {
  const meta: UploadMeta = {
    filename: "f.bin",
    file_size: 3,
    uploaded_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 30 * DAY).toISOString(),
    pending_upload_id: `mp-${id}`,
  };
  b.seed(`${P}/${id}/.meta.json`, JSON.stringify(meta), {
    summary: JSON.stringify(summarize(meta)),
  });
  // Objects that make the upload larger than one DELETE's DELETE_LIMIT.
  for (let n = 1; n <= records; n++) b.seed(`${P}/${id}/.parts/${n}`, "", { size: "5" });
}

const completeBody = { parts: [{ part_number: 1, etag: "e1" }], size: 3 };

function sidecar(b: StrictBucket, id: string): UploadMeta | null {
  const object = b.objects.get(`${P}/${id}/.meta.json`);
  return object ? (JSON.parse(object.body) as UploadMeta) : null;
}

test.describe("complete racing a DELETE, through the routes", () => {
  test("a DELETE (at most DELETE_LIMIT objects) inside complete: 404, nothing left", async () => {
    const b = new RaceBucket({ maxCalls: Infinity });
    seedPending(b, "a1");
    let deleted: { status: number } | undefined;
    b.duringComplete = async () => {
      deleted = await call(b, "DELETE", "/api/uploads/a1");
    };
    const res = await call(b, "POST", "/api/uploads/a1/complete", completeBody);
    expect(deleted?.status).toBe(200);
    expect(res).toEqual({
      status: 404,
      json: { error: "No upload in progress: it was deleted" },
    });
    expect(b.sorted(`${P}/a1/`)).toEqual([]);
    expect((await call(b, "GET", "/api/uploads")).json.uploads).toEqual([]);
  });

  test("a DELETE (more than DELETE_LIMIT objects) inside complete: 404, marker kept, file gone", async () => {
    const b = new RaceBucket({ maxCalls: Infinity });
    seedPending(b, "a2", 150);
    let deleted: { status: number } | undefined;
    b.duringComplete = async () => {
      deleted = await call(b, "DELETE", "/api/uploads/a2");
    };
    const res = await call(b, "POST", "/api/uploads/a2/complete", completeBody);
    expect(deleted?.status).toBe(202);
    expect(res.status).toBe(404);
    expect(sidecar(b, "a2")?.pending_upload_id).toBe(DELETED_UPLOAD_ID);
    expect(b.objects.has(`${P}/a2/f.bin`)).toBe(false);
    expect((await call(b, "GET", "/api/uploads")).json.uploads).toEqual([]);
    // A complete sent again is refused too (the deletion is under way).
    expect((await call(b, "POST", "/api/uploads/a2/complete", completeBody)).status).toBe(404);
    for (let i = 0; i < 5 && b.sorted(`${P}/a2/`).length > 0; i++) {
      await call(b, "DELETE", "/api/uploads/a2");
    }
    expect(b.sorted(`${P}/a2/`)).toEqual([]);
  });

  test("a second complete inside the first: both answer the same link, the upload is whole", async () => {
    const b = new RaceBucket({ maxCalls: Infinity });
    seedPending(b, "a3");
    let inner: Awaited<ReturnType<typeof call>> | undefined;
    b.duringComplete = async () => {
      inner = await call(b, "POST", "/api/uploads/a3/complete", completeBody);
    };
    const outer = await call(b, "POST", "/api/uploads/a3/complete", completeBody);
    expect(outer.status).toBe(200);
    expect(inner?.status).toBe(200);
    expect(inner?.json).toEqual(outer.json);
    expect(outer.json.url).toBe(`${ORIGIN}/a3/f.bin`);
    expect(b.sorted(`${P}/a3/`)).toEqual([`${P}/a3/.meta.json`, `${P}/a3/f.bin`]);
    expect(sidecar(b, "a3")?.pending_upload_id).toBeUndefined();
  });

  test("a complete sent again after it succeeded: the same link, R2's complete not called again", async () => {
    const b = new RaceBucket({ maxCalls: Infinity });
    seedPending(b, "a4");
    const first = await call(b, "POST", "/api/uploads/a4/complete", completeBody);
    expect(first.status).toBe(200);
    b.reset();
    const again = await call(b, "POST", "/api/uploads/a4/complete", completeBody);
    expect(again).toEqual(first);
    expect(b.completes).toBe(1);
    // One sidecar read and nothing else.
    expect(b.calls).toEqual({ get: 1 });
  });

  test("a complete without a session or token is refused before anything is read", async () => {
    const b = new RaceBucket({ maxCalls: Infinity });
    seedPending(b, "a5");
    b.reset();
    const res = await worker.fetch(
      new Request(`${ORIGIN}/api/uploads/a5/complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: ORIGIN },
        body: JSON.stringify(completeBody),
      }),
      env(b),
      ctx,
    );
    expect(res.status).toBe(401);
    expect(b.calls).toEqual({});
  });
});

// Round 2C+2 (leftovers of the 2C+ verifier). (a) A DELETE that aborted the
// multipart upload after complete read the sidecar: R2's complete then
// throws, and the route answered 400 "Could not complete the upload; check
// that every part was uploaded…", which is not what happened. (b) A
// complete sent again while the first is still running (the page retries a
// complete whose answer it lost): if R2 refuses the second multipart
// complete, the second request must still end well.
test.describe("complete after R2 refused it (round 2C+2)", () => {
  for (const records of [0, 150]) {
    test(`a DELETE (${records ? "more than" : "at most"} DELETE_LIMIT objects) before R2's complete: 404 "it was deleted", not 400`, async () => {
      const b = new RaceBucket({ maxCalls: Infinity });
      seedPending(b, "c1", records);
      let deleted: { status: number } | undefined;
      b.beforeComplete = async () => {
        deleted = await call(b, "DELETE", "/api/uploads/c1");
      };
      const res = await call(b, "POST", "/api/uploads/c1/complete", completeBody);
      expect(deleted?.status).toBe(records ? 202 : 200);
      expect(b.aborted).toEqual(["mp-c1"]);
      expect(res).toEqual({
        status: 404,
        json: { error: "No upload in progress: it was deleted" },
      });
      expect(b.completes).toBe(0);
      expect(b.objects.has(`${P}/c1/f.bin`)).toBe(false);
      expect((await call(b, "GET", "/api/uploads")).json.uploads).toEqual([]);
    });
  }

  test("a second complete inside the first, R2 refusing the second: both answer the same link", async () => {
    const b = new RaceBucket({ maxCalls: Infinity });
    b.completeOnce = true;
    seedPending(b, "c2");
    let inner: Awaited<ReturnType<typeof call>> | undefined;
    b.duringComplete = async () => {
      inner = await call(b, "POST", "/api/uploads/c2/complete", completeBody);
    };
    const outer = await call(b, "POST", "/api/uploads/c2/complete", completeBody);
    expect(b.completes).toBe(1);
    expect(inner).toEqual({ status: 200, json: { id: "c2", url: `${ORIGIN}/c2/f.bin` } });
    expect(outer).toEqual(inner);
    expect(b.sorted(`${P}/c2/`)).toEqual([`${P}/c2/.meta.json`, `${P}/c2/f.bin`]);
    expect(sidecar(b, "c2")).toMatchObject({ filename: "f.bin", file_size: 3 });
    expect(sidecar(b, "c2")?.pending_upload_id).toBeUndefined();
  });

  test("the same with the size unknown (part records): both 200, the upload whole", async () => {
    const b = new RaceBucket({ maxCalls: Infinity });
    b.completeOnce = true;
    // Size unknown at create, one part record (as the page's zip uploads).
    const meta: UploadMeta = {
      filename: "f.zip",
      uploaded_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 30 * DAY).toISOString(),
      pending_upload_id: "mp-c3",
    };
    b.seed(`${P}/c3/.meta.json`, JSON.stringify(meta), {
      summary: JSON.stringify(summarize(meta)),
    });
    b.seed(`${P}/c3/.parts/1`, "", { size: "3" });
    let inner: Awaited<ReturnType<typeof call>> | undefined;
    b.duringComplete = async () => {
      inner = await call(b, "POST", "/api/uploads/c3/complete", completeBody);
    };
    const outer = await call(b, "POST", "/api/uploads/c3/complete", completeBody);
    expect(inner).toEqual({ status: 200, json: { id: "c3", url: `${ORIGIN}/c3/f.zip` } });
    expect(outer).toEqual(inner);
    expect(b.sorted(`${P}/c3/`)).toEqual([`${P}/c3/.meta.json`, `${P}/c3/f.zip`]);
  });

  test("R2 refusing a complete for another reason is still the 400, after one head and one read more", async () => {
    const b = new RaceBucket({ maxCalls: Infinity });
    b.completeOnce = true;
    seedPending(b, "c4");
    // As if R2 refused this multipart upload's complete without making the
    // file (a wrong etag, say): nothing interferes.
    b.completed.add("mp-c4");
    b.reset();
    const res = await call(b, "POST", "/api/uploads/c4/complete", completeBody);
    expect(res.status).toBe(400);
    expect(String(res.json.error)).toMatch(/^Could not complete the upload; check that every part/);
    expect(b.calls).toEqual({ get: 2, head: 1 });
    expect(sidecar(b, "c4")?.pending_upload_id).toBe("mp-c4");
  });
});
