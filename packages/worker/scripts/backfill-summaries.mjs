#!/usr/bin/env node
// One-time migration of a bucket written by yeet < 0.2 (or rclone): gives
// every upload sidecar without a summary its summary custom metadata in one
// go. The Worker's hourly cron does the same, but at most 10 per run; until a
// sidecar has its summary, the listing spends a read on it (and shows only
// 10 per page of a bucket full of them). Logic and safety rules: src/backfill.ts.
//
//   node scripts/backfill-summaries.mjs --remote --bucket yeet            # dry run
//   node scripts/backfill-summaries.mjs --remote --bucket yeet --apply    # write
//   node scripts/backfill-summaries.mjs --local --persist-to <dir> --bucket yeet
//
// Run from packages/worker after `npm install`. --remote binds the real
// bucket through wrangler's remote bindings, so it needs `wrangler login`
// with access to the bucket's account; --local uses the bucket `wrangler
// dev` keeps on disk (`.wrangler/state` here, or its --persist-to).
//
// It bundles src/backfill.ts with esbuild (a dev dependency) into a temporary
// file and starts wrangler's getPlatformProxy() with a temporary
// configuration that has only the bucket binding.

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const USAGE = `Usage: node scripts/backfill-summaries.mjs (--remote | --local [--persist-to <dir>])
         --bucket <name> [--prefix uploads] [--apply] [--verbose]

Gives every <prefix>/<id>/.meta.json without summary custom metadata its
summary. Without --apply it only reports what it would write.`;

const workerDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function fail(message) {
  process.stderr.write(`${message}\n\n${USAGE}\n`);
  process.exit(2);
}

let args;
try {
  args = parseArgs({
    options: {
      remote: { type: "boolean", default: false },
      local: { type: "boolean", default: false },
      "persist-to": { type: "string" },
      bucket: { type: "string" },
      prefix: { type: "string", default: "uploads" },
      apply: { type: "boolean", default: false },
      verbose: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  }).values;
} catch (error) {
  fail(error.message);
}
if (args.help) {
  process.stdout.write(`${USAGE}\n`);
  process.exit(0);
}
if (args.remote === args.local) fail("Choose exactly one of --remote and --local.");
if (!args.bucket) fail("--bucket is required (the bucket_name of the Worker's R2 binding).");
if (args.remote && args["persist-to"]) fail("--persist-to only goes with --local.");

const tmp = await mkdtemp(join(tmpdir(), "yeet-backfill-"));
let proxy;
try {
  const esbuild = await import("esbuild");
  const modulePath = join(tmp, "backfill.mjs");
  await esbuild.build({
    entryPoints: [join(workerDir, "src/backfill.ts")],
    bundle: true,
    format: "esm",
    platform: "node",
    outfile: modulePath,
    logLevel: "error",
  });
  const { backfillAdvice, backfillSummaries } = await import(pathToFileURL(modulePath).href);

  const configPath = join(tmp, "wrangler.json");
  await writeFile(
    configPath,
    JSON.stringify({
      name: "yeet-backfill-summaries",
      compatibility_date: "2026-09-01",
      r2_buckets: [{ binding: "BUCKET", bucket_name: args.bucket, remote: args.remote }],
    }),
  );
  const { getPlatformProxy } = await import("wrangler");
  const persistTo = resolve(args["persist-to"] ?? join(workerDir, ".wrangler/state"));
  proxy = await getPlatformProxy({
    configPath,
    envFiles: [],
    remoteBindings: args.remote,
    persist: args.local ? { path: join(persistTo, "v3") } : false,
  });

  const where = args.remote
    ? `remote bucket ${args.bucket}`
    : `local bucket ${args.bucket} in ${persistTo}`;
  process.stderr.write(
    `${args.apply ? "Writing" : "Dry run (no --apply)"}: ${where}, prefix ${args.prefix}/\n`,
  );
  const report = await backfillSummaries(proxy.env.BUCKET, args.prefix, {
    apply: args.apply,
    log: args.verbose ? (line) => process.stderr.write(`${line}\n`) : undefined,
  });
  const { ids: _, ...counts } = report;
  process.stdout.write(`${JSON.stringify({ apply: args.apply, ...counts })}\n`);
  const advice = backfillAdvice(report, args.apply);
  if (advice) process.stderr.write(`${advice}\n`);
} finally {
  await proxy?.dispose();
  await rm(tmp, { recursive: true, force: true });
}
