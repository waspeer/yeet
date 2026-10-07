// Run the built yeet CLI as a child process, isolated from the real user:
// HOME and XDG_CONFIG_HOME point into the run's temp directory and inherited
// YEET_* variables are dropped, so ~/.config/yeet is never read or written.

import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { server } from "./env.js";

export interface CliOptions {
  /** Written to stdin, which is then closed. Default: empty stdin. */
  stdin?: string | Uint8Array;
  /** Extra environment variables; `undefined` removes one. */
  env?: Record<string, string | undefined>;
  /** Reuse a config home (from an earlier call or newConfigHome()). Default: a fresh one. */
  configHome?: string;
  /** Set YEET_URL and YEET_TOKEN for the test server, skipping `yeet login`. */
  auth?: boolean;
  timeoutMs?: number;
  cwd?: string;
}

export interface CliResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  /** XDG_CONFIG_HOME used for this run. */
  configHome: string;
  /** Where the CLI reads and writes its config ($XDG_CONFIG_HOME/yeet/config.json). */
  configPath: string;
  durationMs: number;
}

/** A fresh, empty XDG_CONFIG_HOME inside the run's temp directory. */
export function newConfigHome(): Promise<string> {
  return mkdtemp(join(server.tmpRoot, "xdg-"));
}

export async function cli(args: string[], opts: CliOptions = {}): Promise<CliResult> {
  const configHome = opts.configHome ?? (await newConfigHome());
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !key.startsWith("YEET_")) env[key] = value;
  }
  env.HOME = configHome;
  env.XDG_CONFIG_HOME = configHome;
  env.NO_COLOR = "1";
  if (opts.auth) {
    env.YEET_URL = server.baseURL;
    env.YEET_TOKEN = server.token;
  }
  for (const [key, value] of Object.entries(opts.env ?? {})) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }

  const started = Date.now();
  const child = spawn(process.execPath, [server.cliPath, ...args], {
    cwd: opts.cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf-8").on("data", (chunk: string) => (stdout += chunk));
  child.stderr.setEncoding("utf-8").on("data", (chunk: string) => (stderr += chunk));
  child.stdin.on("error", () => {}); // the CLI may exit before reading stdin
  child.stdin.end(opts.stdin ?? "");

  const timeoutMs = opts.timeoutMs ?? 60_000;
  const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
  const [code, signal] = await new Promise<[number | null, NodeJS.Signals | null]>(
    (resolve, reject) => {
      child.on("error", reject);
      child.on("close", (c, s) => resolve([c, s]));
    },
  ).finally(() => clearTimeout(timer));

  if (signal === "SIGKILL") stderr += `\n[cli helper] killed after ${timeoutMs} ms`;
  return {
    code,
    signal,
    stdout,
    stderr,
    configHome,
    configPath: join(configHome, "yeet", "config.json"),
    durationMs: Date.now() - started,
  };
}

/**
 * `yeet upload <file> [...args]` against the test server; throws unless it
 * exits 0 with exactly one link on stdout. Returns that link and its ID.
 */
export async function cliUpload(
  file: string,
  args: string[] = [],
  opts: CliOptions = {},
): Promise<{ url: string; id: string; result: CliResult }> {
  const result = await cli(["upload", file, ...args], { auth: true, ...opts });
  const lines = result.stdout.split("\n").filter(Boolean);
  if (result.code !== 0 || lines.length !== 1) {
    throw new Error(
      `yeet upload exited ${result.code} with stdout ${JSON.stringify(result.stdout)}, stderr ${JSON.stringify(result.stderr)}`,
    );
  }
  const url = lines[0]!;
  return { url, id: new URL(url).pathname.split("/")[1]!, result };
}
