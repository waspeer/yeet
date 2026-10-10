// Run the zip module under older Node versions. Pass paths to node binaries:
//   node e2e/zip/bench/node-compat.ts /path/to/node-v20.11.1/bin/node ...
// Each binary runs a bundled node-compat-runner; its zips are validated here.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fixtureEntries } from "../fixtures.ts";
import { manifestOf, printResults, validateZip } from "../validate.ts";

const here = new URL(".", import.meta.url).pathname;
// esbuild from packages/worker (installed by `npm run verify`).
const esbuild = createRequire(new URL("../../../packages/worker/package.json", import.meta.url))(
  "esbuild",
) as typeof import("esbuild");
const dir = await mkdtemp(join(tmpdir(), "yeet-zip-compat-"));
try {
  const runner = join(dir, "runner.mjs");
  await esbuild.build({
    entryPoints: [join(here, "node-compat-runner.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node18",
    outfile: runner,
  });
  const manifest = await manifestOf(fixtureEntries({ sizes: "mixed" }));
  for (const node of process.argv.slice(2)) {
    const a = join(dir, "default.zip");
    const b = join(dir, "zlib.zip");
    await rm(a, { force: true });
    await rm(b, { force: true });
    const out = execFileSync(node, [runner, a, b], { encoding: "utf8" }).trim();
    console.log(`\n# ${out}`);
    for (const [label, path] of [
      ["default (CompressionStream)", a],
      ["zlib injected", b],
    ] as const) {
      if (!existsSync(path)) continue;
      const results = await validateZip(path, manifest, {
        readers: ["unzip -t", "python zipfile", "ditto -x -k", "7za t"],
      });
      printResults(`${label}`, results);
    }
  }
} finally {
  await rm(dir, { recursive: true, force: true });
}
