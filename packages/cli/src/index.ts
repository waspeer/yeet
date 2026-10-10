#!/usr/bin/env node

import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { api, ApiError, withRetries, type Config } from "./api.js";
import { MAX_DELETE_ROUNDS, MAX_LIST_PAGES } from "./limits.js";
import { planUpload, SelectionError } from "./selection.js";
import { CONCURRENCY, countingStream, formatSize, Progress } from "./transfer.js";
import { InterruptedError, uploadZip } from "./upload-zip.js";

const README_URL = "https://github.com/waspeer/yeet#readme";

// ---------------------------------------------------------------------------
// Config — ~/.config/yeet/config.json, written by `yeet login`.
// YEET_URL / YEET_TOKEN / YEET_DEFAULT_EXPIRES override it.
// ---------------------------------------------------------------------------

interface StoredConfig {
  url?: string;
  token?: string;
  defaultExpires?: string;
}

function configPath(): string {
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "yeet", "config.json");
}

function readStoredConfig(): StoredConfig {
  const path = configPath();
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as StoredConfig;
  } catch {
    die(`Could not read ${path}. Fix or delete it, then run \`yeet login\` again.`);
  }
}

function writeStoredConfig(config: StoredConfig): void {
  const path = configPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  chmodSync(path, 0o600); // also tighten a file that already existed
}

function normalizeUrl(raw: string): string {
  const url = raw.trim().replace(/\/+$/, "");
  const withScheme = /^https?:\/\//.test(url) ? url : `https://${url}`;
  try {
    return new URL(withScheme).origin;
  } catch {
    die(`Invalid server URL: "${raw}" (expected something like https://yeet.example.workers.dev)`);
  }
}

function loadConfig(): Config {
  const stored = readStoredConfig();
  const url = process.env.YEET_URL || stored.url;
  const token = process.env.YEET_TOKEN || stored.token;
  if (!url || !token) {
    die(
      "yeet is not set up yet. Run:\n\n" +
        "  yeet login <your-server-url>\n\n" +
        `Don't have a server yet? See ${README_URL}`,
    );
  }
  return { url: normalizeUrl(url), token };
}

/** Default link lifetime in days: YEET_DEFAULT_EXPIRES, the config file, or 30. */
function defaultExpiresDays(): number {
  if (process.env.YEET_DEFAULT_EXPIRES) {
    return parseDuration(process.env.YEET_DEFAULT_EXPIRES, "YEET_DEFAULT_EXPIRES");
  }
  const stored = readStoredConfig().defaultExpires;
  if (stored) return parseDuration(stored, `defaultExpires in ${configPath()}`);
  return 30;
}

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

type Args =
  | { command: "login"; url: string | undefined }
  | {
      command: "upload";
      filepaths: string[];
      expires: number;
      password: string | undefined;
      store: boolean;
    }
  | { command: "list"; showDownloads: boolean }
  | { command: "delete"; ids: string[] };

const USAGE = `Usage: yeet <command>

Commands:
  login [url]        Connect to your yeet server (asks for the upload token)
  upload <path...> [--expires <duration>] [--password <string>] [--store]
                     Upload a file as it is, or several files or a folder as
                     one zip (zipped while it uploads), and print its share link
                     --expires   link lifetime, e.g. 7d, 24h, 90m (default 30d, at most 365d)
                     --password  require this password to download
                     --store     zip without compressing (faster for audio, video, photos)
  list [--downloads] Show all uploaded files (optionally with download history)
  delete <id|url...> Delete uploads before they expire

Options:
  -h, --help         Show this help
  -v, --version      Show the version

Settings are stored in ${configPath()}.
Environment variables YEET_URL, YEET_TOKEN and YEET_DEFAULT_EXPIRES override them.`;

function version(): string {
  const pkgPath = new URL("../package.json", import.meta.url);
  return (JSON.parse(readFileSync(pkgPath, "utf-8")) as { version: string }).version;
}

function parseArgs(argv: string[]): Args {
  const args = argv.slice(2);

  if (args[0] === "--help" || args[0] === "-h" || args.length === 0) {
    process.stdout.write(USAGE + "\n");
    process.exit(0);
  }

  if (args[0] === "--version" || args[0] === "-v") {
    process.stdout.write(version() + "\n");
    process.exit(0);
  }

  const command = args[0];

  if (command === "login") {
    return { command: "login", url: args[1] };
  }

  if (command === "list") {
    const showDownloads = args.includes("--downloads") || args.includes("-d");
    return { command: "list", showDownloads };
  }

  if (command === "delete") {
    const ids = args.slice(1).map(parseIdOrUrl);
    if (ids.length === 0) die("Usage: yeet delete <id|url...>");
    return { command: "delete", ids };
  }

  if (command !== "upload") {
    die(USAGE);
  }

  const filepaths: string[] = [];
  let expires: number | undefined;
  let password: string | undefined;
  let store = false;

  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--expires") {
      const val = args[++i];
      if (!val) die("--expires requires a value (e.g. 7d, 24h)");
      expires = parseDuration(val);
    } else if (arg === "--password") {
      const val = args[++i];
      if (!val) die("--password requires a value");
      password = val;
    } else if (arg === "--store") {
      store = true;
    } else if (!arg.startsWith("--")) {
      filepaths.push(arg);
    } else {
      die(`Unknown flag: ${arg}`);
    }
  }

  if (filepaths.length === 0) {
    die("Usage: yeet upload <path...> [--expires <duration>] [--password <string>] [--store]");
  }
  return {
    command: "upload",
    filepaths,
    expires: expires ?? defaultExpiresDays(),
    password,
    store,
  };
}

/** The longest link lifetime the server accepts. */
const MAX_EXPIRES_DAYS = 365;

function parseDuration(s: string, source = "--expires"): number {
  const match = s.match(/^(\d+)(d|h|m)$/i);
  if (!match || Number(match[1]) === 0) {
    die(`Invalid ${source}: "${s}". Use a positive duration like 7d, 24h, or 60m`);
  }
  const [, n, unit] = match as [string, string, string];
  const num = Number(n);
  const days =
    unit.toLowerCase() === "d" ? num : unit.toLowerCase() === "h" ? num / 24 : num / (24 * 60);
  if (days > MAX_EXPIRES_DAYS) {
    die(`Invalid ${source}: "${s}". The longest lifetime is ${MAX_EXPIRES_DAYS} days (365d)`);
  }
  return days;
}

/** Accept either a bare upload ID or a share link. */
function parseIdOrUrl(value: string): string {
  if (/^https?:\/\//.test(value)) {
    const id = new URL(value).pathname.split("/")[1];
    if (id) return id;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function die(msg: string): never {
  process.stderr.write(msg + "\n");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// ANSI formatting
// ---------------------------------------------------------------------------

const isTTY = process.stdout.isTTY;

function bold(s: string): string {
  return isTTY ? `\x1b[1m${s}\x1b[22m` : s;
}
function dim(s: string): string {
  return isTTY ? `\x1b[2m${s}\x1b[22m` : s;
}
function cyan(s: string): string {
  return isTTY ? `\x1b[36m${s}\x1b[39m` : s;
}
function yellow(s: string): string {
  return isTTY ? `\x1b[33m${s}\x1b[39m` : s;
}

function formatDate(iso: string): string {
  return iso.slice(0, 10);
}

// ---------------------------------------------------------------------------
// Login command
// ---------------------------------------------------------------------------

function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) =>
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    }),
  );
}

/** Read a secret without echoing it. Falls back to a plain line when piped. */
function promptSecret(question: string): Promise<string> {
  if (!process.stdin.isTTY) return prompt("");
  process.stderr.write(question);
  return new Promise((resolve) => {
    let value = "";
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf-8");
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") {
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdin.off("data", onData);
          process.stderr.write("\n");
          resolve(value.trim());
          return;
        }
        if (ch === "\u0003") process.exit(130); // Ctrl-C
        if (ch === "\u007f") value = value.slice(0, -1);
        else value += ch;
      }
    };
    process.stdin.on("data", onData);
  });
}

async function login(urlArg: string | undefined): Promise<void> {
  const url = normalizeUrl(urlArg || (await prompt("Server URL: ")));
  const token = await promptSecret("Upload token: ");
  if (!token) die("No token given.");

  try {
    await api({ url, token }, "GET", "/me");
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      die(`That upload token is not correct for ${url}. Check it and try again.`);
    }
    die(err instanceof ApiError ? err.forLogin : err instanceof Error ? err.message : String(err));
  }

  writeStoredConfig({ ...readStoredConfig(), url, token });
  process.stderr.write(`Logged in to ${url}. Settings saved to ${configPath()}\n`);
}

// ---------------------------------------------------------------------------
// List and delete commands
// ---------------------------------------------------------------------------

interface ListedUpload {
  id: string;
  filename: string;
  file_size: number;
  uploaded_at: string;
  expires_at: string;
  has_password: boolean;
  download_count: number;
  /** The last five download times. */
  recent_downloads: string[];
  url: string;
}

/** One page of `GET /api/uploads`. */
interface UploadsPage {
  uploads: ListedUpload[];
  /** Where the next page starts (`?cursor=`); null or absent on the last page. */
  cursor?: string | null;
  /** More pages exist. Without a cursor: a server from before paginated listing, which lists one page only. */
  truncated?: boolean;
}

/**
 * Every upload, fetched page by page, one request after the other (each
 * request does a small, bounded amount of work on the server). A page that
 * fails with a network error, 5xx or 429 is retried with backoff
 * (withRetries()). If the first page fails, that is the error; if a later
 * one does (or is not a page at all), or the page cap is reached, what was fetched so far comes back
 * with a note saying why the list is incomplete.
 */
async function fetchAllUploads(
  config: Config,
): Promise<{ uploads: ListedUpload[]; incomplete?: string; partial?: string }> {
  const byId = new Map<string, ListedUpload>();
  const fetchedSoFar = (reason: string) => ({
    uploads: [...byId.values()],
    // (Without the reason's own final period: "(… in 2 minutes); run".)
    incomplete: `Could not fetch every page (${reason.replace(/\.$/, "")}); run \`yeet list\` again for the rest.`,
  });
  let cursor: string | null = null;
  for (let pages = 0; ; pages++) {
    if (pages >= MAX_LIST_PAGES) {
      return {
        uploads: [...byId.values()],
        incomplete: `Stopped after ${MAX_LIST_PAGES} pages; the server kept saying there is more.`,
      };
    }
    const path: string =
      cursor === null ? "/uploads" : `/uploads?cursor=${encodeURIComponent(cursor)}`;
    let page: UploadsPage;
    try {
      page = await withRetries(() => api<UploadsPage>(config, "GET", path));
    } catch (err) {
      if (pages === 0) throw err;
      return fetchedSoFar(err instanceof Error ? err.message : String(err));
    }
    if (!Array.isArray(page?.uploads)) {
      if (pages === 0) {
        throw new ApiError("The server sent a list of uploads yeet does not understand", 0);
      }
      // A later page: what was fetched so far, as for any other failure.
      return fetchedSoFar("the server sent a page yeet does not understand");
    }
    for (const upload of page.uploads) byId.set(upload.id, upload);
    if (typeof page.cursor === "string" && page.cursor !== "") {
      cursor = page.cursor;
      continue;
    }
    // A server from before paginated listing: one page, and `truncated` if there is more.
    return page.truncated
      ? {
          uploads: [...byId.values()],
          partial:
            "Note: the bucket holds more than the server can list in one request; " +
            "only part of your uploads is shown. Update the server to list them all.",
        }
      : { uploads: [...byId.values()] };
  }
}

async function listFiles(showDownloads: boolean): Promise<void> {
  const config = loadConfig();
  const { uploads, incomplete, partial } = await fetchAllUploads(config);
  uploads.sort((a, b) => b.uploaded_at.localeCompare(a.uploaded_at));
  const notes = () => {
    if (partial) process.stdout.write(yellow(partial) + "\n");
    if (incomplete) {
      process.stdout.write(
        yellow(`Note: only part of your uploads is shown. ${incomplete}`) + "\n",
      );
      process.exitCode = 1;
    }
  };

  if (uploads.length === 0) {
    process.stdout.write("No files found.\n");
    notes();
    return;
  }

  const now = new Date();
  let active = 0;
  let expired = 0;

  for (const upload of uploads) {
    const isExpired = new Date(upload.expires_at) < now;
    if (isExpired) expired++;
    else active++;

    const wrap = isExpired ? dim : (s: string) => s;

    const lockPart = upload.has_password ? ` ${yellow("\u{1F512}")}` : "";
    const line1 = `  ${bold(upload.filename)} · ${dim(formatSize(upload.file_size))}${lockPart}`;

    const dlCount = upload.download_count;
    const dlPart = dlCount > 0 ? ` · ${dlCount} download${dlCount !== 1 ? "s" : ""}` : "";
    const expiryLabel = isExpired ? "Expired" : "Expires";
    const line2 = `  ${dim(
      `Uploaded ${formatDate(upload.uploaded_at)} · ${expiryLabel} ${formatDate(upload.expires_at)}${dlPart}`,
    )}`;
    const line3 = `  ${cyan(upload.url)}`;

    let dlLines = "";
    if (showDownloads && dlCount > 0) {
      for (const at of upload.recent_downloads) {
        dlLines += wrap(dim(`    ↓ ${new Date(at).toLocaleString()}`)) + "\n";
      }
      const older = dlCount - upload.recent_downloads.length;
      if (older > 0) dlLines += wrap(dim(`    ... and ${older} more`)) + "\n";
    }

    process.stdout.write(wrap(`${line1}\n${line2}\n${line3}`) + "\n" + dlLines + "\n");
  }

  process.stdout.write(
    dim(`${uploads.length} files (${active} active, ${expired} expired)`) + "\n",
  );
  notes();
}

/**
 * Delete one upload. A server deletes at most 100 objects per request and
 * answers `done: false` (202) while more is left, the upload already gone
 * for users; this asks again, up to MAX_DELETE_ROUNDS requests. Returns
 * whether objects may be left for the server's cleanup (the cap reached, or
 * a later request failed). An error of the first request is thrown.
 */
async function deleteUpload(config: Config, id: string): Promise<boolean> {
  const path = `/uploads/${encodeURIComponent(id)}`;
  for (let round = 1; ; round++) {
    let result: { done?: unknown } | undefined;
    try {
      result = await api<{ done?: unknown } | undefined>(config, "DELETE", path);
    } catch (err) {
      if (round === 1) throw err;
      // Deleted meanwhile (by the cleanup): nothing left.
      if (err instanceof ApiError && err.status === 404) return false;
      return true;
    }
    if (result?.done !== false) return false;
    if (round >= MAX_DELETE_ROUNDS) return true;
  }
}

async function deleteUploads(ids: string[]): Promise<void> {
  const config = loadConfig();
  let failed = false;
  for (const id of ids) {
    try {
      const left = await deleteUpload(config, id);
      process.stderr.write(
        left
          ? `Deleted ${id} (the server removes the rest of its storage in its hourly cleanup)\n`
          : `Deleted ${id}\n`,
      );
    } catch (err) {
      failed = true;
      process.stderr.write(`Could not delete ${id}: ${err instanceof Error ? err.message : err}\n`);
    }
  }
  if (failed) process.exit(1);
}

// ---------------------------------------------------------------------------
// Upload command
// ---------------------------------------------------------------------------

async function uploadFile(
  config: Config,
  filepath: string,
  expiresDays: number,
  password: string | undefined,
): Promise<string> {
  if (!existsSync(filepath)) throw new Error(`File not found: ${filepath}`);
  const stat = statSync(filepath);
  if (!stat.isFile()) throw new Error(`Not a file: ${filepath}`);

  const filename = basename(filepath);
  const { id, part_size: partSize } = await api<{ id: string; part_size: number }>(
    config,
    "POST",
    "/uploads",
    {
      filename,
      size: stat.size,
      expires_in: Math.round(expiresDays * 24 * 60 * 60),
      ...(password ? { password } : {}),
    },
  );

  const partCount = Math.max(1, Math.ceil(stat.size / partSize));
  const parts: { part_number: number; etag: string }[] = [];
  const progress = new Progress(filename, stat.size);
  const file = await open(filepath, "r");

  try {
    let next = 1;
    const worker = async () => {
      while (next <= partCount) {
        const partNumber = next++;
        const start = (partNumber - 1) * partSize;
        const length = Math.min(partSize, stat.size - start);
        const buffer = new Uint8Array(length);
        await file.read(buffer, 0, length, start);

        let counted = 0;
        const part = await withRetries(() => {
          progress.add(-counted); // undo progress from a failed attempt
          counted = 0;
          return api<{ part_number: number; etag: string }>(
            config,
            "PUT",
            `/uploads/${id}/parts/${partNumber}`,
            undefined,
            {
              body: countingStream(buffer, (bytes) => {
                counted += bytes;
                progress.add(bytes);
              }),
              headers: {
                "Content-Type": "application/octet-stream",
                "Content-Length": String(length),
              },
              duplex: "half",
            } as RequestInit,
          );
        });
        parts.push(part);
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, partCount) }, worker));

    parts.sort((a, b) => a.part_number - b.part_number);
    const { url } = await withRetries(() =>
      api<{ url: string }>(config, "POST", `/uploads/${id}/complete`, { parts }),
    );
    return url;
  } catch (err) {
    // Don't leave a half-finished upload behind.
    await api(config, "DELETE", `/uploads/${id}`).catch(() => {});
    throw err;
  } finally {
    progress.done();
    await file.close();
  }
}

/**
 * One file is uploaded as it is; several paths, or a folder, as one zip
 * (see selection.ts and upload-zip.ts). Either way: one share link.
 */
async function upload(
  filepaths: string[],
  expiresDays: number,
  password: string | undefined,
  store: boolean,
): Promise<void> {
  const config = loadConfig();
  let plan;
  try {
    plan = await planUpload(filepaths);
  } catch (err) {
    die(err instanceof SelectionError ? err.message : String(err));
  }
  if (plan.kind === "file") {
    try {
      const url = await uploadFile(config, plan.source, expiresDays, password);
      process.stdout.write(url + "\n");
    } catch (err) {
      die(`Upload of ${filepaths[0]} failed: ${err instanceof Error ? err.message : err}`);
    }
    return;
  }

  for (const warning of plan.warnings) process.stderr.write(yellow(`Note: ${warning}`) + "\n");
  const count = `${plan.files.length} file${plan.files.length === 1 ? "" : "s"}`;
  process.stderr.write(
    `Zipping ${count} (${formatSize(plan.totalSize)}) into ${plan.name}` +
      (store ? " without compression" : "") +
      "\n",
  );
  try {
    const url = await uploadZip(config, plan, { expiresDays, password, store });
    process.stdout.write(url + "\n");
  } catch (err) {
    if (err instanceof InterruptedError) {
      process.stderr.write(`Upload of ${plan.name} cancelled; nothing was kept.\n`);
      process.exit(130);
    }
    die(
      `Upload of ${plan.name} failed: ${err instanceof Error ? err.message : err}\n` +
        "Nothing was kept on the server.",
    );
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv);

  if (args.command === "login") await login(args.url);
  else if (args.command === "list") await listFiles(args.showDownloads);
  else if (args.command === "delete") await deleteUploads(args.ids);
  else await upload(args.filepaths, args.expires, args.password, args.store);
}

main().catch((err: unknown) => {
  die(String(err instanceof Error ? err.message : err));
});
