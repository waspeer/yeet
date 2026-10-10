// Temp directories and locks for the zip tests. They work inside `npm run
// verify` (under the run's temp root) and without it (scripts/mutate.mjs runs
// the zip specs directly with Playwright, without a server).

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

export const run = promisify(execFile);

const root = () => process.env.YEET_E2E_TMP ?? tmpdir();

/** A fresh temp directory; remove it with `rm` when done. */
export function scratchDir(prefix = "zip-"): Promise<string> {
  return mkdtemp(join(root(), `yeet-${prefix}`));
}

/** Run `fn` with a fresh temp directory, removed afterwards. */
export async function withScratch<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await scratchDir();
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Run `fn` while holding a lock shared by all Playwright workers (mkdir is
 * atomic). The >4 GiB tests hold "zip-big" so only one of them holds several
 * GB of memory in check.py at a time.
 */
export async function zipLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const dir = join(root(), "yeet-zip-locks");
  await mkdir(dir, { recursive: true });
  const lock = join(dir, `${name}-${process.env.YEET_E2E_TMP ? "run" : process.ppid}`);
  for (;;) {
    try {
      await mkdir(lock);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  try {
    return await fn();
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}
