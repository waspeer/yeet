import * as esbuild from "esbuild";
import { solidPlugin } from "esbuild-plugin-solid";

await esbuild.build({
  entryPoints: ["src/client.tsx"],
  bundle: true,
  outfile: "dist/client.js",
  format: "esm",
  minify: true,
  plugins: [solidPlugin()],
});
