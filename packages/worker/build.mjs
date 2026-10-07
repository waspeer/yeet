import * as esbuild from "esbuild";
import { solidPlugin } from "esbuild-plugin-solid";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const outfile = "public/client.js";

const result = await esbuild.build({
  entryPoints: ["src/client.tsx"],
  bundle: true,
  outfile,
  format: "esm",
  minify: true,
  plugins: [solidPlugin()],
  write: false,
});

// Only touch the file when it changes, so a second `wrangler dev` (as the e2e
// harness starts for some tests) does not rewrite assets a running one serves.
const output = result.outputFiles[0].contents;
let current = null;
try {
  current = readFileSync(outfile);
} catch {
  // first build
}
if (!current || !Buffer.from(output).equals(current)) {
  mkdirSync(dirname(outfile), { recursive: true });
  writeFileSync(outfile, output);
}
