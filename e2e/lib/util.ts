import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { CRON_TEST_TIMEOUT_MS } from "./bucket.js";
import { server } from "./env.js";

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * wrangler dev's output so far: request lines like
 * `[wrangler:info] PUT /api/uploads/<id>/parts/2 200 OK (85ms)` and console
 * output of the Worker. Shared by all tests, so filter by upload ID.
 */
export function serverLog(): Promise<string> {
  return readFile(server.wranglerLog, "utf-8");
}

/** A fresh directory inside the run's temp root (removed when the run ends). */
export function makeTempDir(prefix = "tmp-"): Promise<string> {
  return mkdtemp(join(server.tmpRoot, prefix));
}

/**
 * Run `fn` while holding a run-wide lock called `name`, shared by all
 * Playwright workers (a directory in the run's temp root; mkdir is atomic).
 * Use it for tests that would disturb each other through shared server state,
 * such as the cron, which cleans up every expired upload at once. Waits for
 * the lock as long as a cron test may take (CRON_TEST_TIMEOUT_MS), which
 * grows if CLEANUP_LIST_LIMIT is lowered.
 */
export async function exclusive<T>(
  name: string,
  fn: () => Promise<T>,
  { timeoutMs = CRON_TEST_TIMEOUT_MS } = {},
): Promise<T> {
  await mkdir(join(server.tmpRoot, "locks"), { recursive: true });
  const lock = join(server.tmpRoot, "locks", name);
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      await mkdir(lock);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      if (Date.now() > deadline) throw new Error(`Timed out waiting for lock "${name}"`);
      await sleep(100);
    }
  }
  try {
    return await fn();
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}

type Truthy<T> = Exclude<T, null | undefined | false | 0 | "">;

/**
 * Poll `check` until it returns a truthy value (which is returned) or the
 * timeout passes. A thrown error counts as "not yet" and is reported on timeout.
 */
export async function eventually<T>(
  check: () => Promise<T> | T,
  { timeoutMs = 10_000, intervalMs = 200, message = "condition" } = {},
): Promise<Truthy<T>> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (true) {
    try {
      const value = await check();
      if (value) return value as Truthy<T>;
    } catch (err) {
      lastError = err;
    }
    if (Date.now() >= deadline) break;
    await sleep(intervalMs);
  }
  const detail = lastError instanceof Error ? ` Last error: ${lastError.message}` : "";
  throw new Error(`Timed out after ${timeoutMs} ms waiting for ${message}.${detail}`);
}
