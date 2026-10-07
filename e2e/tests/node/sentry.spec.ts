import { createServer } from "node:http";
import { withOptionalSentry, type WorkerHandler } from "../../../packages/worker/src/sentry.js";
import { eventually, expect, putObject, server, startServer, test } from "../../lib/index.js";

// What these tests establish:
// - Without SENTRY_DSN, the Worker never touches Sentry: the dispatch in
//   packages/worker/src/sentry.ts sends requests to the plain handler and
//   never calls the function that imports @sentry/cloudflare and wraps the
//   handler. Checked directly on that module (a request-level signal would
//   need a debug header in production, which we do not want).
// - With SENTRY_DSN, errors still reach Sentry: a real `wrangler dev` with
//   a DSN pointing at a fake ingest server receives the exception.

type Env = { SENTRY_DSN?: string };
type Handler = WorkerHandler<Env, string, unknown, unknown, string>;

function fakeHandlers() {
  const calls: string[] = [];
  let created = 0;
  const createHandler = (): Handler => {
    const n = ++created;
    return {
      fetch: (request: string) => {
        calls.push(`fetch#${n} ${request}`);
        return `response#${n}`;
      },
      scheduled: () => {
        calls.push(`scheduled#${n}`);
      },
    };
  };
  let instrumentCalls = 0;
  const instrument = async (handler: Handler): Promise<Handler> => {
    instrumentCalls++;
    return {
      fetch: (request, env, ctx) => {
        calls.push("sentry");
        return handler.fetch(request, env, ctx);
      },
      scheduled: (controller, env, ctx) => {
        calls.push("sentry");
        return handler.scheduled(controller, env, ctx);
      },
    };
  };
  return { calls, createHandler, instrument, instrumentCalls: () => instrumentCalls };
}

test.describe("Sentry", () => {
  test("without SENTRY_DSN the instrumentation is never loaded or used", async () => {
    const fake = fakeHandlers();
    const handler = withOptionalSentry<Env, string, unknown, unknown, string>(
      fake.createHandler,
      fake.instrument,
    );
    for (const env of [{}, { SENTRY_DSN: "" }, { SENTRY_DSN: undefined }]) {
      expect(handler.fetch("GET /", env, {})).toBe("response#1");
      await handler.scheduled(null, env, {});
    }
    expect(fake.instrumentCalls()).toBe(0);
    expect(fake.calls).toEqual([
      "fetch#1 GET /",
      "scheduled#1",
      "fetch#1 GET /",
      "scheduled#1",
      "fetch#1 GET /",
      "scheduled#1",
    ]);
  });

  test("with SENTRY_DSN a separate handler is instrumented once and used", async () => {
    const fake = fakeHandlers();
    const handler = withOptionalSentry<Env, string, unknown, unknown, string>(
      fake.createHandler,
      fake.instrument,
    );
    const env = { SENTRY_DSN: "https://key@example.invalid/1" };
    expect(await handler.fetch("GET /a", env, {})).toBe("response#2");
    expect(await handler.fetch("GET /b", env, {})).toBe("response#2");
    await handler.scheduled(null, env, {});
    // A request without a DSN still goes to the untouched plain handler.
    expect(handler.fetch("GET /c", {}, {})).toBe("response#1");
    expect(fake.instrumentCalls()).toBe(1);
    expect(fake.calls).toEqual([
      "sentry",
      "fetch#2 GET /a",
      "sentry",
      "fetch#2 GET /b",
      "sentry",
      "scheduled#2",
      "fetch#1 GET /c",
    ]);
  });

  test("with SENTRY_DSN set on a real Worker, an error reaches Sentry", async () => {
    test.setTimeout(120_000);
    const envelopes: string[] = [];
    const ingest = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        envelopes.push(`${req.method} ${req.url}\n${body}`);
        res.writeHead(200, { "Content-Type": "application/json" }).end("{}");
      });
    });
    await new Promise<void>((resolve) => ingest.listen(0, "127.0.0.1", resolve));
    const address = ingest.address();
    const port = typeof address === "object" && address ? address.port : 0;

    const srv = await startServer({
      token: server.token,
      vars: { SENTRY_DSN: `http://publickey@127.0.0.1:${port}/1` },
    });
    try {
      // An unreadable sidecar makes the download page throw.
      await putObject("uploads/BROKEN/.meta.json", "{not json", { baseURL: srv.baseURL });
      const res = await fetch(`${srv.baseURL}/BROKEN/file.txt`);
      expect(res.status).toBe(500);

      const envelope = await eventually(
        () => envelopes.find((e) => e.includes("/api/1/envelope/") && e.includes('"exception"')),
        { timeoutMs: 20_000, message: "an exception envelope at the fake Sentry ingest" },
      );
      expect(envelope).toContain("SyntaxError");
    } finally {
      await srv.stop();
      ingest.close();
    }
  });
});
