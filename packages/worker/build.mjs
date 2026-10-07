import * as esbuild from "esbuild";
import { solidPlugin } from "esbuild-plugin-solid";

await esbuild.build({
  entryPoints: ["src/client.tsx"],
  bundle: true,
  outfile: "public/client.js",
  format: "esm",
  minify: true,
  plugins: [solidPlugin()],
});
