// GET / (round 2D): the welcome page. Through wrangler dev: status and
// headers (anti-framing kept, a short public cache, no cookie). In Node, on
// the Worker's own fetch handler (as complete-route-race.spec.ts does): no
// R2 call, no rate limiter, no token needed, and the address shown is the
// request's origin, whatever host the Worker is reached on.

import { register } from "node:module";
import { expect, server, test } from "../../lib/index.js";
import { StrictBucket } from "../../lib/strict-r2.js";

// rate-limit.ts imports `cloudflare:workers`, which Node cannot load.
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
type Handler = { fetch: (request: Request, env: never, ctx: never) => Promise<Response> };
// A specifier tsc does not follow (e2e's typecheck has no Workers types).
const WORKER_ENTRY: string = "../../../packages/worker/src/index.js";
const worker = ((await import(WORKER_ENTRY)) as { default: unknown }).default as Handler;

test.describe("GET / (welcome page)", () => {
  test("200 HTML with the anti-framing headers, a short public cache and no cookie", async () => {
    const res = await fetch(`${server.baseURL}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=UTF-8");
    expect(res.headers.get("content-security-policy")).toBe("frame-ancestors 'none'");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("cache-control")).toBe("public, max-age=300");
    expect(res.headers.get("set-cookie")).toBeNull();
    const body = await res.text();
    expect(body).toContain(`value="${new URL(server.baseURL).origin}"`);
    expect(body).toContain('href="/upload"');
    expect(body).not.toContain(server.token);
  });

  test("the same for a logged-in browser: no session check, no upload list", async () => {
    const plain = await (await fetch(`${server.baseURL}/`)).text();
    const res = await fetch(`${server.baseURL}/`, {
      headers: { Cookie: "yeet_session=v1.9999999999.forged" },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(plain);
  });

  test("no R2 call, no rate limiter, no token needed; the address is the request's origin", async () => {
    const bucket = new StrictBucket({ maxCalls: 0 });
    const refuse = () => {
      throw new Error("the rate limiter was used");
    };
    const env = {
      BUCKET: bucket,
      RATE_LIMITER: { idFromName: refuse, get: refuse },
      // No UPLOAD_TOKEN: the welcome page does not need one.
    } as never;
    const ctx = { waitUntil() {}, passThroughOnException() {} } as never;
    for (const origin of ["https://yeet.erik-music.workers.dev", "https://files.example.com"]) {
      const res = await worker.fetch(new Request(`${origin}/`), env, ctx);
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toContain(`<input type="text" id="address" value="${origin}" readonly`);
      expect(body).not.toContain("npx");
      expect(body).not.toContain("yeet login");
    }
    expect(bucket.calls).toEqual({});
  });
});
