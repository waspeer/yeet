// Verifier of round 2D: the welcome page on / (the implementer's tests are
// in welcome.spec.ts). What those left open: a real session (not a forged
// cookie) changes nothing; the address comes from the request URL only,
// never from forwarding headers a proxy or client may set; and an origin
// with HTML-special characters (the URL parser lets `"`, `'` and `&` into a
// host) is escaped, so a crafted Host cannot add attributes to the field.

import { request as httpRequest } from "node:http";
import { register } from "node:module";
import { expect, loginCookie, server, test } from "../../lib/index.js";
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

const ctx = { waitUntil() {}, passThroughOnException() {} } as never;
function env(): never {
  const refuse = () => {
    throw new Error("the rate limiter was used");
  };
  return {
    BUCKET: new StrictBucket({ maxCalls: 0 }),
    RATE_LIMITER: { idFromName: refuse, get: refuse },
  } as never;
}

/** The address field's value attribute, as sent (still escaped). */
function addressAttr(html: string): string | undefined {
  return /<input type="text" id="address" value="([^"]*)" readonly/.exec(html)?.[1];
}

/** GET / with a raw Host header (fetch() does not let a Host through). */
function getWithHost(host: string): Promise<{ status: number; body: string }> {
  const url = new URL(server.baseURL);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: url.hostname, port: url.port, path: "/", method: "GET", headers: { Host: host } },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

test.describe("verifier 2D: the welcome page", () => {
  test("a real session gets the very same page: no redirect, no upload list", async () => {
    const plain = await (await fetch(`${server.baseURL}/`)).text();
    const cookie = await loginCookie();
    const res = await fetch(`${server.baseURL}/`, {
      headers: { Cookie: cookie },
      redirect: "manual",
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(await res.text()).toBe(plain);
  });

  test("forwarding headers do not change the address (Worker handler)", async () => {
    const origin = "https://yeet.example.com";
    const res = await worker.fetch(
      new Request(`${origin}/`, {
        headers: {
          "X-Forwarded-Host": "evil.example",
          "X-Forwarded-Proto": "http",
          Forwarded: "host=evil.example;proto=http",
          "X-Original-Host": "evil.example",
          Origin: "https://evil.example",
          Referer: "https://evil.example/",
        },
      }),
      env(),
      ctx,
    );
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(addressAttr(body)).toBe(origin);
    expect(body).toContain(`<code>npx @waspeer/yeet login ${origin}</code>`);
    expect(body).not.toContain("evil.example");
  });

  test("forwarding headers do not change the address (wrangler dev)", async () => {
    const res = await fetch(`${server.baseURL}/`, {
      headers: { "X-Forwarded-Host": "evil.example", Forwarded: "host=evil.example" },
    });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(addressAttr(body)).toBe(new URL(server.baseURL).origin);
    expect(body).not.toContain("evil.example");
  });

  test("an origin with HTML-special characters is escaped, in the field and the command", async () => {
    // The URL parser keeps these in a host; an unescaped `"` would end the
    // value and turn the rest into attributes of the field.
    const host = `a"autofocus"onfocus="alert(1)'&b.example`;
    const origin = new URL(`https://${host}/`).origin;
    expect(origin).toBe(`https://${host}`);
    const res = await worker.fetch(new Request(`${origin}/`), env(), ctx);
    expect(res.status).toBe(200);
    const body = await res.text();
    const escaped = `https://a&quot;autofocus&quot;onfocus=&quot;alert(1)'&amp;b.example`;
    expect(addressAttr(body)).toBe(escaped);
    expect(body).toContain(`<code>npx @waspeer/yeet login ${escaped}</code>`);
    expect(body).not.toContain('"onfocus=');
    // The copy script reads the field's value; the origin is never in it.
    const script = body.slice(body.indexOf('<script type="module">'));
    expect(script).not.toContain("b.example");
    expect(script).not.toContain("autofocus");
  });

  test("through wrangler dev the address follows the Host header; a crafted one adds no attribute", async () => {
    // The page differs per Host, so a cache must key on it; every HTTP
    // cache does (the URL includes the host), and Cloudflare does not
    // cache a Worker's response unless the Worker puts it in the cache.
    const other = await getWithHost("other.example");
    expect(other.status).toBe(200);
    expect(addressAttr(other.body)).toBe("http://other.example");
    const res = await getWithHost(`x"autofocus"onfocus="alert(1).example`);
    // workerd refuses it (500 in wrangler 4); if it ever lets it through,
    // it must arrive escaped.
    if (res.status === 200) {
      expect(res.body).not.toContain('"onfocus=');
      expect(res.body).not.toMatch(/id="address" value="[^"]*"[a-z]/);
    } else {
      expect(res.status).toBeGreaterThanOrEqual(400);
    }
  });
});
