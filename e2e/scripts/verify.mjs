#!/usr/bin/env node
// One-command end-to-end verification for yeet.
//
//   npm run verify [-- [--allow-skips] <playwright test args>]
//
// 1. installs package dependencies that are missing or stale, builds the CLI
// 2. starts `wrangler dev` on free ports with a throwaway R2 directory and a
//    random UPLOAD_TOKEN (passed with --var, so nothing is written into
//    packages/worker)
// 3. runs `playwright test` with any extra arguments passed through
// 4. tears everything down — also on failure, Ctrl-C or SIGTERM — and writes
//    results/summary.json
//
// Strict by default: a run where any selected test was skipped ("incomplete")
// exits 1, like a failure. --allow-skips makes it exit 0 instead.
//
// One run per checkout at a time: a second concurrent run refuses to start
// (exit 2) instead of clobbering results/ and the CLI build of the first.
//
// Set YEET_E2E_KEEP=1 to keep the temp directory (R2 state, fixtures) for debugging.

import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  closeSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const E2E_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const REPO_DIR = dirname(E2E_DIR);
const CLI_DIR = join(REPO_DIR, "packages", "cli");
const WORKER_DIR = join(REPO_DIR, "packages", "worker");
const RESULTS_DIR = join(E2E_DIR, "results");
const SUMMARY_PATH = join(RESULTS_DIR, "summary.json");
const WRANGLER_LOG = join(RESULTS_DIR, "wrangler.log");
const LOCK_PATH = join(E2E_DIR, ".verify.lock");

const SERVER_READY_TIMEOUT_MS = 90_000;
const KILL_GRACE_MS = 5_000;

const allowSkips = process.argv.includes("--allow-skips");
const playwrightArgs = process.argv.slice(2).filter((arg) => arg !== "--allow-skips");
const startedAt = Date.now();
const timings = {};

/** @type {import("node:child_process").ChildProcess | null} */
let wrangler = null;
/** @type {import("node:child_process").ChildProcess | null} */
let playwright = null;
let tmpRoot = null;
let interrupted = false;
let cleanedUp = false;

function log(message) {
  process.stderr.write(`[verify] ${message}\n`);
}

function seconds(ms) {
  return `${(ms / 1000).toFixed(1)}s`;
}

async function step(name, fn) {
  const start = Date.now();
  log(`${name}...`);
  const result = await fn();
  timings[name] = Date.now() - start;
  log(`${name} done in ${seconds(timings[name])}`);
  return result;
}

// ---------------------------------------------------------------------------
// Preparation
// ---------------------------------------------------------------------------

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: ["ignore", "inherit", "inherit"] });
  if (result.status !== 0) {
    throw new Error(`\`${command} ${args.join(" ")}\` failed in ${relative(REPO_DIR, cwd) || "."}`);
  }
}

/** Run `npm ci` when node_modules is missing or older than package-lock.json. */
function ensureDependencies(dir) {
  const lock = join(dir, "package-lock.json");
  const marker = join(dir, "node_modules", ".package-lock.json");
  if (existsSync(marker) && statSync(marker).mtimeMs >= statSync(lock).mtimeMs) return;
  log(`installing dependencies in ${relative(REPO_DIR, dir)}`);
  run("npm", ["ci", "--no-audit", "--no-fund"], dir);
}

async function ensureBrowsers() {
  const { chromium, firefox, webkit } = await import("@playwright/test");
  const missing = [chromium, firefox, webkit].filter((b) => !existsSync(b.executablePath()));
  if (missing.length === 0) return;
  log(`installing Playwright browsers: ${missing.map((b) => b.name()).join(", ")}`);
  run(
    join(E2E_DIR, "node_modules", ".bin", "playwright"),
    ["install", ...missing.map((b) => b.name())],
    E2E_DIR,
  );
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

// ---------------------------------------------------------------------------
// wrangler dev
// ---------------------------------------------------------------------------

async function startWrangler({ port, inspectorPort, persistDir, token }) {
  const logStream = createWriteStream(WRANGLER_LOG);
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
    "--test-scheduled",
    "--show-interactive-dev-session=false",
    "--log-level",
    "info",
    // Passed as vars, so a developer's own .dev.vars is neither needed nor touched.
    // --var wins over values from .dev.vars; SENTRY_DSN is blanked so no page
    // loads the Sentry CDN script during tests.
    "--var",
    `UPLOAD_TOKEN:${token}`,
    "--var",
    "SENTRY_DSN:",
  ];
  wrangler = spawn(join(WORKER_DIR, "node_modules", ".bin", "wrangler"), args, {
    cwd: WORKER_DIR,
    // Own process group, so teardown can kill wrangler, workerd and esbuild at once.
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...withoutForceColor(process.env), WRANGLER_SEND_METRICS: "false", NO_COLOR: "1" },
  });
  wrangler.stdout.pipe(logStream);
  wrangler.stderr.pipe(logStream);

  let exited = null;
  wrangler.on("exit", (code, signal) => {
    exited = { code, signal };
  });
  wrangler.on("error", (err) => {
    logStream.write(`[verify] could not start wrangler: ${err.message}\n`);
    exited = { code: null, signal: null };
  });

  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + SERVER_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (exited) break;
    try {
      const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) break;
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  const failure = exited
    ? `wrangler dev exited early (code ${exited.code}, signal ${exited.signal})`
    : Date.now() >= deadline
      ? `wrangler dev was not ready within ${SERVER_READY_TIMEOUT_MS / 1000}s`
      : null;
  if (failure) throw new Error(`${failure}. Log tail:\n${tail(WRANGLER_LOG)}`);

  // The token must be the one we passed; a stale .dev.vars must not win.
  const me = await fetch(`${base}/api/me`, { headers: { Authorization: `Bearer ${token}` } });
  if (me.status !== 200) {
    throw new Error(`GET /api/me with the harness token returned ${me.status}; is --var ignored?`);
  }
  return base;
}

function withoutForceColor(env) {
  const { FORCE_COLOR: _, ...rest } = env;
  return rest;
}

function tail(file, lines = 40) {
  try {
    return readFileSync(file, "utf-8").trimEnd().split("\n").slice(-lines).join("\n");
  } catch {
    return "(no log)";
  }
}

function waitForExit(child, ms) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

function killGroup(child, signal) {
  try {
    process.kill(-child.pid, signal);
  } catch {
    // already gone
  }
}

// ---------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------

async function cleanup() {
  if (cleanedUp) return;
  cleanedUp = true;
  if (playwright && playwright.exitCode === null) {
    killGroup(playwright, "SIGTERM");
    if (!(await waitForExit(playwright, KILL_GRACE_MS))) killGroup(playwright, "SIGKILL");
  }
  if (wrangler && wrangler.exitCode === null && wrangler.signalCode === null) {
    killGroup(wrangler, "SIGTERM");
    if (!(await waitForExit(wrangler, KILL_GRACE_MS))) {
      killGroup(wrangler, "SIGKILL");
      await waitForExit(wrangler, 1000);
    }
  }
  if (tmpRoot) {
    if (process.env.YEET_E2E_KEEP) log(`kept temp directory ${tmpRoot}`);
    else rmSync(tmpRoot, { recursive: true, force: true });
  }
  releaseLock();
}

let signalCount = 0;
function onSignal(signal) {
  signalCount++;
  interrupted = true;
  if (signalCount === 1 && playwright && playwright.exitCode === null) {
    // Let Playwright stop gracefully and report what ran; teardown follows its exit.
    log(`${signal} received, stopping tests (press Ctrl-C again to force)`);
    killGroup(playwright, "SIGINT");
    return;
  }
  log(`${signal} received, tearing down`);
  cleanup().finally(() => process.exit(130));
}
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, onSignal);

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

function writeHarnessSummary(extra) {
  let summary = {};
  try {
    summary = JSON.parse(readFileSync(SUMMARY_PATH, "utf-8"));
  } catch {
    summary = {
      status: "error",
      totals: { total: 0, passed: 0, failed: 0, skipped: 0, flaky: 0 },
      projects: {},
      tests: [],
    };
  }
  if (interrupted && summary.status !== "error") summary.status = "interrupted";
  summary.args = playwrightArgs;
  summary.strict = !allowSkips;
  summary.harness = {
    ...summary.harness,
    ...extra,
    timingsMs: timings,
    totalMs: Date.now() - startedAt,
  };
  writeFileSync(SUMMARY_PATH, JSON.stringify(summary, null, 2) + "\n");
  return summary;
}

// ---------------------------------------------------------------------------
// One run per checkout
// ---------------------------------------------------------------------------

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

/** Take the checkout's run lock, or return the PID of the run that holds it. */
function acquireLock() {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(LOCK_PATH, "wx");
      writeFileSync(fd, String(process.pid));
      closeSync(fd);
      return null;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      const pid = Number(readFileSync(LOCK_PATH, "utf-8"));
      if (pid && isAlive(pid)) return pid;
      rmSync(LOCK_PATH, { force: true }); // left behind by a run that was killed
    }
  }
  throw new Error(`Could not take ${LOCK_PATH}`);
}

function releaseLock() {
  try {
    if (Number(readFileSync(LOCK_PATH, "utf-8")) === process.pid) rmSync(LOCK_PATH);
  } catch {
    // not ours or already gone
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  mkdirSync(RESULTS_DIR, { recursive: true });
  rmSync(SUMMARY_PATH, { force: true });

  await step("prepare", async () => {
    ensureDependencies(E2E_DIR);
    ensureDependencies(CLI_DIR);
    ensureDependencies(WORKER_DIR);
    await ensureBrowsers();
  });
  await step("build CLI", () => run("npm", ["run", "--silent", "build"], CLI_DIR));

  tmpRoot = mkdtempSync(join(tmpdir(), "yeet-e2e-"));
  const persistDir = join(tmpRoot, "r2-state");
  const token = randomBytes(32).toString("base64url");
  const [port, inspectorPort] = [await freePort(), await freePort()];

  // wrangler runs the Worker's custom build (node build.mjs) itself.
  const baseURL = await step("start wrangler dev", () =>
    startWrangler({ port, inspectorPort, persistDir, token }),
  );
  log(`server ready at ${baseURL} (log: ${relative(E2E_DIR, WRANGLER_LOG)})`);

  const testsStart = Date.now();
  const code = await new Promise((resolve) => {
    playwright = spawn(
      join(E2E_DIR, "node_modules", ".bin", "playwright"),
      ["test", ...playwrightArgs],
      {
        cwd: E2E_DIR,
        // Own group: Ctrl-C reaches only us, and we forward a single SIGINT.
        detached: true,
        stdio: "inherit",
        env: {
          ...process.env,
          YEET_E2E_BASE_URL: baseURL,
          YEET_E2E_TOKEN: token,
          YEET_E2E_TMP: tmpRoot,
          YEET_E2E_PERSIST_DIR: persistDir,
          YEET_E2E_WORKER_DIR: WORKER_DIR,
          YEET_E2E_CLI: join(CLI_DIR, "dist", "index.js"),
          YEET_E2E_WRANGLER_LOG: WRANGLER_LOG,
        },
      },
    );
    playwright.on("exit", (exitCode, signal) => resolve(exitCode ?? (signal ? 1 : 0)));
    playwright.on("error", (err) => {
      log(`could not start Playwright: ${err.message}`);
      resolve(1);
    });
  });
  timings["tests"] = Date.now() - testsStart;
  return code;
}

const holder = acquireLock();
if (holder) {
  log(
    `another verify run (PID ${holder}) is already using this checkout; ` +
      "wait for it to finish (its results go to results/summary.json). Not starting.",
  );
  process.exit(2);
}

let exitCode = 1;
let harnessError = null;
try {
  exitCode = await main();
} catch (err) {
  harnessError = err instanceof Error ? err.message : String(err);
  log(`ERROR: ${harnessError}`);
  exitCode = 1;
}
await cleanup();

const summary = writeHarnessSummary(harnessError ? { error: harnessError } : {});
if (harnessError) summary.status = "error";
writeFileSync(SUMMARY_PATH, JSON.stringify(summary, null, 2) + "\n");

const t = summary.totals;
log(
  `${summary.status.toUpperCase()}: ${t.passed} passed, ${t.failed} failed, ${t.flaky} flaky, ` +
    `${t.skipped} skipped in ${seconds(Date.now() - startedAt)} total ` +
    `(prepare ${seconds(timings["prepare"] ?? 0)}, CLI build ${seconds(timings["build CLI"] ?? 0)}, ` +
    `server start ${seconds(timings["start wrangler dev"] ?? 0)}, tests ${seconds(timings["tests"] ?? 0)}). ` +
    `Summary: ${relative(process.cwd(), SUMMARY_PATH)}`,
);
if (summary.status === "incomplete" && !allowSkips) {
  log(
    "INCOMPLETE counts as a failure: some selected tests did not run. Use --allow-skips to accept.",
  );
  exitCode = 1;
} else if (summary.status !== "passed" && summary.status !== "incomplete" && exitCode === 0) {
  exitCode = 1;
}
process.exit(interrupted ? 130 : exitCode);
