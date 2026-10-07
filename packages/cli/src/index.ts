#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, statSync, existsSync, readFileSync } from "node:fs";
import { join, basename } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import argon2 from "argon2";

// ---------------------------------------------------------------------------
// Config — set via environment variables
// ---------------------------------------------------------------------------

const README_URL = "https://github.com/waspeer/yeet#configuration";

interface Config {
  remote: string;
  uploadsPath: string;
  domain: string;
}

const REQUIRED_ENV = {
  YEET_RCLONE_REMOTE: "name of your rclone remote, e.g. r2",
  YEET_UPLOADS_PATH: "bucket and prefix on that remote, e.g. yeet/uploads",
  YEET_DOMAIN: "public URL of your yeet server, e.g. https://dl.example.com",
} as const;

/**
 * Storage configuration, read from the environment with no fallbacks. These
 * three say *where* files go, so there is no value that is right in general:
 * a stale default would silently upload to the wrong backend, or print a URL
 * that never resolves. Read at the point of use rather than on import, so
 * `--help` still works with nothing configured.
 */
function loadConfig(): Config {
  const missing = (Object.keys(REQUIRED_ENV) as (keyof typeof REQUIRED_ENV)[]).filter(
    (name) => !process.env[name],
  );
  if (missing.length > 0) {
    die(
      [
        `yeet is not configured. Missing environment variable${missing.length > 1 ? "s" : ""}:`,
        ...missing.map((name) => `  ${name.padEnd(20)} ${REQUIRED_ENV[name]}`),
        "",
        `See ${README_URL}`,
      ].join("\n"),
    );
  }

  const domain = process.env.YEET_DOMAIN!.replace(/\/+$/, "");
  if (!/^https?:\/\/[^/]+/.test(domain)) {
    die(`Invalid YEET_DOMAIN: "${domain}" (expected a URL like https://dl.example.com)`);
  }

  return {
    remote: process.env.YEET_RCLONE_REMOTE!.replace(/:$/, ""),
    uploadsPath: process.env.YEET_UPLOADS_PATH!.replace(/\/+$/, ""),
    domain,
  };
}

/** Default link lifetime in days: YEET_DEFAULT_EXPIRES (a duration like 30d) or 30. */
function defaultExpiresDays(): number {
  const raw = process.env.YEET_DEFAULT_EXPIRES;
  if (!raw) return 30;
  return parseDuration(raw, "YEET_DEFAULT_EXPIRES");
}

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

interface UploadArgs {
  command: "upload";
  filepath: string;
  expires: number; // days
  password: string | undefined;
}

interface ListArgs {
  command: "list";
  showDownloads: boolean;
}

type Args = UploadArgs | ListArgs;

const USAGE = `Usage: yeet <command>

Commands:
  upload <filepath> [--expires <duration>] [--password <string>]
                     Upload a file and print its share link
                     --expires   link lifetime, e.g. 7d, 24h, 90m (default 30d)
                     --password  require this password to download
  list [--downloads] Show all uploaded files (optionally with download history)

Options:
  -h, --help         Show this help
  -v, --version      Show the version

Configuration (environment variables):
  YEET_RCLONE_REMOTE    rclone remote to upload to, e.g. r2
  YEET_UPLOADS_PATH     bucket and prefix on that remote, e.g. yeet/uploads
  YEET_DOMAIN           public URL of your yeet server, e.g. https://dl.example.com
  YEET_DEFAULT_EXPIRES  default link lifetime (optional, default 30d)`;

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

  if (command === "list") {
    const showDownloads = args.includes("--downloads") || args.includes("-d");
    return { command: "list", showDownloads };
  }

  if (command !== "upload") {
    die(USAGE);
  }

  let filepath: string | undefined;
  let expires: number | undefined;
  let password: string | undefined;

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
    } else if (!arg.startsWith("--")) {
      filepath = arg;
    } else {
      die(`Unknown flag: ${arg}`);
    }
  }

  if (!filepath) die("Usage: yeet upload <filepath> [--expires <duration>] [--password <string>]");
  return { command: "upload", filepath, expires: expires ?? defaultExpiresDays(), password };
}

function parseDuration(s: string, source = "--expires"): number {
  const match = s.match(/^(\d+)(d|h|m)$/i);
  if (!match || Number(match[1]) === 0) {
    die(`Invalid ${source}: "${s}". Use a positive duration like 7d, 24h, or 60m`);
  }
  const [, n, unit] = match as [string, string, string];
  const num = Number(n);
  if (unit.toLowerCase() === "d") return num;
  if (unit.toLowerCase() === "h") return num / 24;
  if (unit.toLowerCase() === "m") return num / (24 * 60);
  die(`Invalid duration unit: ${unit}`);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function die(msg: string): never {
  process.stderr.write(msg + "\n");
  process.exit(1);
}

function generateId(): string {
  return randomBytes(4).toString("base64url").slice(0, 6);
}

function checkRclone(): void {
  try {
    execFileSync("rclone", ["version"], { stdio: "ignore" });
  } catch {
    die("rclone is required but not found. Install it from https://rclone.org/install/");
  }
}

/** Fail early with a clear message if the configured remote does not exist in rclone. */
function checkRemote(remote: string): void {
  let remotes: string[];
  try {
    remotes = execFileSync("rclone", ["listremotes"], { encoding: "utf-8" })
      .split("\n")
      .map((line) => line.trim().replace(/:$/, ""))
      .filter(Boolean);
  } catch {
    return; // let the actual rclone call report the problem
  }
  if (!remotes.includes(remote)) {
    die(
      `rclone has no remote named "${remote}" (YEET_RCLONE_REMOTE).\n` +
        `Configured remotes: ${remotes.length ? remotes.join(", ") : "none"}. ` +
        `Create one with \`rclone config\`.`,
    );
  }
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

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function formatSize(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  if (bytes >= 1e3) return `${(bytes / 1e3).toFixed(1)} KB`;
  return `${bytes} B`;
}

function formatDate(iso: string): string {
  return iso.slice(0, 10);
}

// ---------------------------------------------------------------------------
// List command
// ---------------------------------------------------------------------------

interface DownloadRecord {
  at: string;
}

interface UploadMeta {
  filename: string;
  file_size: number;
  uploaded_at: string;
  expires_at: string;
  password_hash?: string;
  downloads?: DownloadRecord[];
}

async function listFiles(showDownloads: boolean): Promise<void> {
  checkRclone();

  const config = loadConfig();
  checkRemote(config.remote);
  const remote = `${config.remote}:${config.uploadsPath}`;

  // Get all upload directories
  let dirsJson: string;
  try {
    dirsJson = execFileSync("rclone", ["lsjson", remote, "--dirs-only"], { encoding: "utf-8" });
  } catch {
    die(`Failed to list ${remote}. Check your rclone configuration and connectivity.`);
  }

  const dirs = JSON.parse(dirsJson) as { Path: string; Name: string }[];

  if (dirs.length === 0) {
    process.stdout.write("No files found.\n");
    return;
  }

  // Read metadata for each upload
  const entries: { id: string; meta: UploadMeta }[] = [];

  for (const dir of dirs) {
    const metaPath = `${remote}/${dir.Path}/.meta.json`;
    try {
      const raw = execFileSync("rclone", ["cat", metaPath], { encoding: "utf-8" });
      const meta = JSON.parse(raw) as UploadMeta;
      entries.push({ id: dir.Path, meta });
    } catch {
      process.stderr.write(`Warning: could not read metadata for ${dir.Path}, skipping\n`);
    }
  }

  // Sort newest first
  entries.sort(
    (a, b) => new Date(b.meta.uploaded_at).getTime() - new Date(a.meta.uploaded_at).getTime(),
  );

  const now = new Date();
  let active = 0;
  let expired = 0;

  for (const { id, meta } of entries) {
    const isExpired = new Date(meta.expires_at) < now;
    if (isExpired) expired++;
    else active++;

    const wrap = isExpired ? dim : (s: string) => s;

    const namePart = bold(meta.filename);
    const sizePart = dim(formatSize(meta.file_size));
    const lockPart = meta.password_hash ? ` ${yellow("\u{1F512}")}` : "";
    const line1 = `  ${namePart} \u00B7 ${sizePart}${lockPart}`;

    const dlCount = (meta.downloads ?? []).length;
    const dlPart = dlCount > 0 ? ` \u00B7 ${dlCount} download${dlCount !== 1 ? "s" : ""}` : "";

    const uploadedPart = `Uploaded ${formatDate(meta.uploaded_at)}`;
    const expiryLabel = isExpired ? "Expired" : "Expires";
    const expiryPart = `${expiryLabel} ${formatDate(meta.expires_at)}`;
    const line2 = `  ${dim(`${uploadedPart} \u00B7 ${expiryPart}${dlPart}`)}`;

    const url = `${config.domain}/${id}/${encodeURIComponent(meta.filename)}`;
    const line3 = `  ${cyan(url)}`;

    let dlLines = "";
    if (showDownloads && meta.downloads?.length) {
      const recent = meta.downloads.slice(-5);
      for (const dl of recent) {
        dlLines += wrap(dim(`    \u2193 ${new Date(dl.at).toLocaleString()}`)) + "\n";
      }
      if (meta.downloads.length > 5) {
        dlLines += wrap(dim(`    ... and ${meta.downloads.length - 5} more`)) + "\n";
      }
    }

    process.stdout.write(wrap(`${line1}\n${line2}\n${line3}`) + "\n" + dlLines + "\n");
  }

  process.stdout.write(
    dim(`${entries.length} files (${active} active, ${expired} expired)`) + "\n",
  );
}

// ---------------------------------------------------------------------------
// Upload command
// ---------------------------------------------------------------------------

async function upload(args: UploadArgs): Promise<void> {
  // Validate file
  if (!existsSync(args.filepath)) {
    die(`File not found: ${args.filepath}`);
  }
  const stat = statSync(args.filepath);
  if (!stat.isFile()) {
    die(`Not a file: ${args.filepath}`);
  }

  checkRclone();

  const config = loadConfig();
  checkRemote(config.remote);
  const filename = basename(args.filepath);
  const id = generateId();

  const uploadedAt = new Date();
  const expiresAt = new Date(uploadedAt.getTime() + args.expires * 24 * 60 * 60 * 1000);

  const meta: Record<string, unknown> = {
    filename,
    file_size: stat.size,
    uploaded_at: uploadedAt.toISOString(),
    expires_at: expiresAt.toISOString(),
  };

  if (args.password) {
    meta.password_hash = await argon2.hash(args.password, { type: argon2.argon2id });
  }

  // Build temp directory
  const tmpDir = mkdtempSync(join(tmpdir(), "yeet-"));
  const stagingDir = join(tmpDir, id);
  mkdirSync(stagingDir);
  writeFileSync(join(stagingDir, ".meta.json"), JSON.stringify(meta, null, 2));

  // Copy original file into staging dir (rclone will pick up the whole dir)
  execFileSync("cp", [args.filepath, join(stagingDir, filename)]);

  // Upload via rclone
  const dest = `${config.remote}:${config.uploadsPath}/${id}`;
  try {
    // Progress goes to stderr so stdout carries only the link, for piping.
    execFileSync("rclone", ["copy", stagingDir, dest, "--progress"], {
      stdio: ["inherit", 2, "inherit"],
    });
  } catch {
    die(`Upload to ${dest} failed. Check your rclone configuration and connectivity.`);
  }

  const url = `${config.domain}/${id}/${encodeURIComponent(filename)}`;
  process.stdout.write(url + "\n");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv);

  if (args.command === "list") {
    await listFiles(args.showDownloads);
  } else {
    await upload(args);
  }
}

main().catch((err: unknown) => {
  die(String(err instanceof Error ? err.message : err));
});
