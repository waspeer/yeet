// Sentry only when SENTRY_DSN is set. Wrapping the handler with withSentry()
// costs CPU on every request (scopes, async context, instrumentation), even
// without a DSN, and a free-plan Worker has 10 ms. So without a DSN requests go
// to the plain handler, and @sentry/cloudflare is not even evaluated: it is
// loaded with a dynamic import (bundled, but evaluated lazily) the first time a
// request with a DSN arrives, and the instrumented handler is reused after that.
//
// Kept free of Workers-specific types and imports so the e2e suite can test the
// dispatch in Node (e2e/tests/node/sentry.spec.ts).

export interface WorkerHandler<Env, Req, Controller, Ctx, Res> {
  fetch(request: Req, env: Env, ctx: Ctx): Res | Promise<Res>;
  scheduled(controller: Controller, env: Env, ctx: Ctx): void | Promise<void>;
}

/**
 * A handler that uses `createHandler()` as is when `env.SENTRY_DSN` is empty,
 * and otherwise a separate instance passed through `instrument()` once.
 * (`withSentry()` instruments the object it is given in place, so the plain
 * handler must be a different object.)
 */
export function withOptionalSentry<Env extends { SENTRY_DSN?: string }, Req, Controller, Ctx, Res>(
  createHandler: () => WorkerHandler<Env, Req, Controller, Ctx, Res>,
  instrument: (
    handler: WorkerHandler<Env, Req, Controller, Ctx, Res>,
  ) => Promise<WorkerHandler<Env, Req, Controller, Ctx, Res>>,
): WorkerHandler<Env, Req, Controller, Ctx, Res> {
  const plain = createHandler();
  let instrumented: Promise<WorkerHandler<Env, Req, Controller, Ctx, Res>> | undefined;
  const withSentry = () => {
    instrumented ??= instrument(createHandler()).catch((err: unknown) => {
      instrumented = undefined; // try again on the next request
      throw err;
    });
    return instrumented;
  };

  return {
    fetch(request, env, ctx) {
      if (!env.SENTRY_DSN) return plain.fetch(request, env, ctx);
      return withSentry().then((handler) => handler.fetch(request, env, ctx));
    },
    scheduled(controller, env, ctx) {
      if (!env.SENTRY_DSN) return plain.scheduled(controller, env, ctx);
      return withSentry().then((handler) => handler.scheduled(controller, env, ctx));
    },
  };
}
