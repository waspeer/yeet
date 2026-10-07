import * as esbuild from "esbuild";
import { solidPlugin } from "esbuild-plugin-solid";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Only touch an output file when it changes, so a second `wrangler dev` (as
 * the e2e harness starts for some tests) does not rewrite assets a running one
 * serves.
 */
function writeIfChanged(result) {
  for (const { path, contents } of result.outputFiles) {
    let current = null;
    try {
      current = readFileSync(path);
    } catch {
      // first build
    }
    if (!current || !Buffer.from(contents).equals(current)) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, contents);
    }
  }
}

writeIfChanged(
  await esbuild.build({
    entryPoints: ["src/client.tsx"],
    bundle: true,
    outfile: "public/client.js",
    format: "esm",
    minify: true,
    plugins: [solidPlugin()],
    write: false,
  }),
);

// The browser upload page and its Web Worker (a classic worker script, so it
// does not depend on module-worker support).
writeIfChanged(
  await esbuild.build({
    entryPoints: {
      upload: "src/upload/main.ts",
      "upload-worker": "src/upload/worker.ts",
    },
    bundle: true,
    outdir: "public",
    format: "iife",
    target: ["chrome109", "firefox115", "safari15"],
    minify: true,
    write: false,
  }),
);
