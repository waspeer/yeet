// Extra `wrangler dev` instances for tests that need a server configured
// differently from the shared one: another UPLOAD_TOKEN (token rotation), a
// token that is too short, or SENTRY_DSN set.
//
// Each instance runs in its own process group, recorded as a file in
// <tmpRoot>/extra-servers/, so scripts/verify.mjs stops it on teardown (and
// the next run stops it if this run was killed) even if the test that
// started it crashed before calling stop().

import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { server } from "./env.js";
import { sleep } from "./util.js";

const READY_TIMEOUT_MS = 90_000;
const KILL_GRACE_MS = 5_000;

export interface ExtraServer {
  baseURL: string;
  token: string;
  persistDir: string;
  logPath: string;
  /** Stop wrangler and workerd; safe to call twice. */
  stop(): Promise<void>;
}

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const address = srv.address();
      const port = typeof address === "object" && address ? address.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

function registryDir(): string {
  return join(server.tmpRoot, "extra-servers");
}

function exited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function waitForExit(child: ChildProcess, ms: number): Promise<boolean> {
  if (exited(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

function killGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // already gone
  }
}

/**
 * Start `wrangler dev` for packages/worker with the given token and vars.
 * `persistDir` defaults to a fresh directory; pass the one of a stopped
 * instance to keep its bucket (and rate-limit state).
 */
export async function startServer(opts: {
  token: string;
  persistDir?: string;
  vars?: Record<string, string>;
  /** Another Worker's wrangler config (`-c`), e.g. e2e/zip/runtime/wrangler.jsonc. Default: packages/worker's. */
  config?: string;
  /** Path polled until it answers 2xx. Default: /health. */
  readyPath?: string;
}): Promise<ExtraServer> {
  const persistDir = opts.persistDir ?? (await mkdtemp(join(server.tmpRoot, "extra-r2-")));
  const [port, inspectorPort] = [await freePort(), await freePort()];
  const logPath = join(server.tmpRoot, `extra-wrangler-${port}.log`);
  const vars = { SENTRY_DSN: "", ...opts.vars, UPLOAD_TOKEN: opts.token };

  const args = [
    "dev",
    "--ip",
    "127.0.0.1",
    "--port",
    String(port),
    "--inspector-port",
    String(inspectorPort),
    "--persist-to",
    persistDir,
    "--show-interactive-dev-session=false",
    "--log-level",
    "info",
    ...Object.entries(vars).flatMap(([name, value]) => ["--var", `${name}:${value}`]),
    ...(opts.config ? ["-c", opts.config] : []),
  ];
  const { FORCE_COLOR: _, ...env } = process.env;
  const child = spawn(join(server.workerDir, "node_modules", ".bin", "wrangler"), args, {
    cwd: server.workerDir,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...env, WRANGLER_SEND_METRICS: "false", NO_COLOR: "1" },
  });
  const pid = child.pid;
  if (!pid) throw new Error("Could not start wrangler dev");
  await mkdir(registryDir(), { recursive: true });
  const registration = join(registryDir(), String(pid));
  await writeFile(registration, `${pid}\n`);

  const log = createWriteStream(logPath);
  child.stdout?.pipe(log);
  child.stderr?.pipe(log);

  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    if (!exited(child)) {
      killGroup(pid, "SIGTERM");
      if (!(await waitForExit(child, KILL_GRACE_MS))) killGroup(pid, "SIGKILL");
      await waitForExit(child, 1000);
    }
    // workerd may outlive wrangler for a moment; make sure the group is gone.
    killGroup(pid, "SIGKILL");
    await rm(registration, { force: true });
  };

  const baseURL = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (true) {
    if (exited(child)) {
      await stop();
      throw new Error(`wrangler dev exited early. Log:\n${await readFile(logPath, "utf-8")}`);
    }
    try {
      const res = await fetch(`${baseURL}${opts.readyPath ?? "/health"}`, {
        signal: AbortSignal.timeout(2000),
      });
      if (res.ok) break;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) {
      await stop();
      throw new Error(`wrangler dev on ${baseURL} was not ready in time`);
    }
    await sleep(250);
  }

  return { baseURL, token: opts.token, persistDir, logPath, stop };
}
