#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, statSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import argon2 from 'argon2';

// ---------------------------------------------------------------------------
// Config — set via environment variables
// ---------------------------------------------------------------------------

const RCLONE_REMOTE = process.env.YEET_RCLONE_REMOTE ?? 'storagebox';
const UPLOADS_PATH = process.env.YEET_UPLOADS_PATH ?? '/uploads';
const DOMAIN = process.env.YEET_DOMAIN ?? 'https://dl.example.com';
const DEFAULT_EXPIRES_DAYS = Number(process.env.YEET_DEFAULT_EXPIRES_DAYS ?? '30');

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

interface UploadArgs {
  filepath: string;
  expires: number; // days
  password: string | undefined;
}

function parseArgs(argv: string[]): UploadArgs {
  const args = argv.slice(2);

  const usage = `Usage: yeet upload <filepath> [--expires <duration>] [--password <string>]`;

  if (args[0] === '--help' || args[0] === '-h' || args.length === 0) {
    process.stdout.write(usage + '\n');
    process.exit(0);
  }

  if (args[0] !== 'upload') {
    die(usage);
  }

  let filepath: string | undefined;
  let expires = DEFAULT_EXPIRES_DAYS;
  let password: string | undefined;

  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--expires') {
      const val = args[++i];
      if (!val) die('--expires requires a value (e.g. 7d, 24h)');
      expires = parseDuration(val);
    } else if (arg === '--password') {
      const val = args[++i];
      if (!val) die('--password requires a value');
      password = val;
    } else if (!arg.startsWith('--')) {
      filepath = arg;
    } else {
      die(`Unknown flag: ${arg}`);
    }
  }

  if (!filepath) die('Usage: yeet upload <filepath> [--expires <duration>] [--password <string>]');
  return { filepath, expires, password };
}

function parseDuration(s: string): number {
  const match = s.match(/^(\d+)(d|h|m)$/i);
  if (!match) die(`Invalid duration: ${s}. Use format like 7d, 24h, or 60m`);
  const [, n, unit] = match as [string, string, string];
  const num = Number(n);
  if (unit.toLowerCase() === 'd') return num;
  if (unit.toLowerCase() === 'h') return num / 24;
  if (unit.toLowerCase() === 'm') return num / (24 * 60);
  die(`Invalid duration unit: ${unit}`);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function die(msg: string): never {
  process.stderr.write(msg + '\n');
  process.exit(1);
}

function generateId(): string {
  return randomBytes(4).toString('base64url').slice(0, 6);
}

function checkRclone(): void {
  try {
    execFileSync('rclone', ['version'], { stdio: 'ignore' });
  } catch {
    die('rclone is required but not found. Install it from https://rclone.org/install/');
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv);

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
  const tmpDir = mkdtempSync(join(tmpdir(), 'yeet-'));
  const stagingDir = join(tmpDir, id);
  mkdirSync(stagingDir);
  writeFileSync(join(stagingDir, '.meta.json'), JSON.stringify(meta, null, 2));

  // Copy original file into staging dir (rclone will pick up the whole dir)
  execFileSync('cp', [args.filepath, join(stagingDir, filename)]);

  // Upload via rclone
  const dest = `${RCLONE_REMOTE}:${UPLOADS_PATH}/${id}`;
  try {
    execFileSync(
      'rclone',
      ['copy', stagingDir, dest, '--progress'],
      { stdio: 'inherit' },
    );
  } catch {
    die('Upload failed. Check your rclone configuration and connectivity.');
  }

  const url = `${DOMAIN}/${id}/${encodeURIComponent(filename)}`;
  process.stdout.write(url + '\n');
}

main().catch((err: unknown) => {
  die(String(err instanceof Error ? err.message : err));
});
