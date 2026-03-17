#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, statSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import argon2 from "argon2";

// ---------------------------------------------------------------------------
// Config — set via environment variables
// ---------------------------------------------------------------------------

const RCLONE_REMOTE = process.env.YEET_RCLONE_REMOTE ?? "storagebox";
const UPLOADS_PATH = process.env.YEET_UPLOADS_PATH ?? "uploads";
const DOMAIN = process.env.YEET_DOMAIN ?? "https://dl.example.com";
const DEFAULT_EXPIRES_DAYS = Number(process.env.YEET_DEFAULT_EXPIRES_DAYS ?? "30");

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
  list [--downloads] Show all uploaded files (optionally with download history)`;

function parseArgs(argv: string[]): Args {
  const args = argv.slice(2);

  if (args[0] === "--help" || args[0] === "-h" || args.length === 0) {
    process.stdout.write(USAGE + "\n");
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
  let expires = DEFAULT_EXPIRES_DAYS;
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
  return { command: "upload", filepath, expires, password };
}

function parseDuration(s: string): number {
  const match = s.match(/^(\d+)(d|h|m)$/i);
  if (!match) die(`Invalid duration: ${s}. Use format like 7d, 24h, or 60m`);
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

  const remote = `${RCLONE_REMOTE}:${UPLOADS_PATH}`;

  // Get all upload directories
  let dirsJson: string;
  try {
    dirsJson = execFileSync("rclone", ["lsjson", remote, "--dirs-only"], { encoding: "utf-8" });
  } catch {
    die("Failed to list uploads. Check your rclone configuration and connectivity.");
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

    const url = `${DOMAIN}/${id}/${encodeURIComponent(meta.filename)}`;
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
  const dest = `${RCLONE_REMOTE}:${UPLOADS_PATH}/${id}`;
  try {
    execFileSync("rclone", ["copy", stagingDir, dest, "--progress"], { stdio: "inherit" });
  } catch {
    die("Upload failed. Check your rclone configuration and connectivity.");
  }

  const url = `${DOMAIN}/${id}/${encodeURIComponent(filename)}`;
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
