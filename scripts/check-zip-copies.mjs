#!/usr/bin/env node
// zip.ts lives twice, byte for byte: packages/cli/src/zip.ts (the CLI) and
// packages/worker/src/zip.ts (the Worker and the browser upload page). Each
// package must stay self-contained, so the file is copied rather than shared.
// This fails (exit 1) when the copies differ. e2e's `npm run verify` runs it
// first; run it yourself with `npm run check:zip-copies`.
//
//   node scripts/check-zip-copies.mjs [<copy> <copy>...]   (default: the two above)

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const copies = args.length
  ? args
  : [join(root, "packages/cli/src/zip.ts"), join(root, "packages/worker/src/zip.ts")];

const hashes = copies.map((path) => {
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch (err) {
    console.error(`check-zip-copies: cannot read ${path}: ${err.message}`);
    process.exit(1);
  }
});

const name = (path) => relative(process.cwd(), path) || path;
if (new Set(hashes).size !== 1) {
  console.error("check-zip-copies: the copies of zip.ts differ:");
  copies.forEach((path, i) => console.error(`  ${hashes[i]}  ${name(path)}`));
  console.error(
    `Edit one and copy it over the other, e.g.: cp ${name(copies[0])} ${name(copies[1])}`,
  );
  process.exit(1);
}
console.log(
  `check-zip-copies: ${copies.length} copies of zip.ts are identical (sha256 ${hashes[0]})`,
);
