// The Worker's own fetch handler (packages/worker/src/index.ts), loaded in
// Node, for tests that drive the real routes on an in-memory bucket
// (strict-r2.ts) and count its R2 calls.

import { timingSafeEqual } from "node:crypto";
import { register } from "node:module";
import type { Bucket } from "../../packages/worker/src/uploads.js";

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
const WORKER_ENTRY: string = "../../packages/worker/src/index.js";
const worker = ((await import(WORKER_ENTRY)) as { default: unknown }).default as Handler;

export const WORKER_TOKEN = "worker-node-token-" + "x".repeat(40);
export const WORKER_ORIGIN = "https://yeet.test";

/** The Worker's environment over `bucket`; every rate limit allows. */
export function workerEnv(bucket: Bucket, prefix = "uploads") {
  return {
    BUCKET: bucket,
    RATE_LIMITER: {
      idFromName: (name: string) => name,
      get: () => ({ hit: async () => ({ allowed: true, retryAfter: 0 }) }),
    },
    UPLOAD_TOKEN: WORKER_TOKEN,
    UPLOADS_PREFIX: prefix,
  } as never;
}

const ctx = { waitUntil() {}, passThroughOnException() {} } as never;

/** `request` through the Worker, on `bucket`. */
export function workerFetch(bucket: Bucket, request: Request, prefix?: string): Promise<Response> {
  return worker.fetch(request, workerEnv(bucket, prefix), ctx);
}
