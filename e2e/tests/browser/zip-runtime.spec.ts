// Must-test item 13 (docs/design/zip.md), browsers: the Worker copy of zip.ts
// (the one the upload page bundles) builds the fixture zips in Chromium, WebKit
// and Firefox with the browser defaults (CompressionStream, crc32Js), from
// real File objects and from plain streams; Node validates them with check.py
// and the local readers. The page is served by page.route() from an https
// origin, so it is a secure context like the real upload page.

import { expect, test } from "@playwright/test";
import { createRequire } from "node:module";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fixtureEntries } from "../../zip/fixtures.js";
import { withScratch } from "../../zip/scratch.js";
import { failures, manifestOf, validateZip } from "../../zip/validate.js";

const ENTRY = fileURLToPath(new URL("../../zip/runtime/browser.ts", import.meta.url));
const WORKER_PACKAGE = fileURLToPath(
  new URL("../../../packages/worker/package.json", import.meta.url),
);
const ORIGIN = "https://zip-harness.test";

let html: string | undefined;
async function harnessPage(): Promise<string> {
  if (!html) {
    // esbuild from packages/worker (the harness installs its dependencies).
    const esbuild = createRequire(WORKER_PACKAGE)("esbuild") as {
      build(options: object): Promise<{ outputFiles: { text: string }[] }>;
    };
    const out = await esbuild.build({
      entryPoints: [ENTRY],
      bundle: true,
      format: "iife",
      target: "es2022",
      write: false,
    });
    html = `<!doctype html><meta charset="utf-8"><title>zip harness</title><script>${out.outputFiles[0]!.text}</script>`;
  }
  return html;
}

test("fixture zips built in the page pass check.py and the local readers", async ({ page }) => {
  test.setTimeout(120_000);
  const body = await harnessPage();
  await page.route(`${ORIGIN}/**`, (route) => route.fulfill({ body, contentType: "text/html" }));
  await page.goto(`${ORIGIN}/`);
  const formats = await page.evaluate(() => (globalThis as any).zipHarness.formats());
  expect(formats["deflate-raw"]).toBe(true);
  await withScratch(async (dir) => {
    for (const [sizes, viaFiles, compress] of [
      ["known", true, true],
      ["unknown", false, true],
      ["mixed", false, true],
      ["known", true, false],
    ] as const) {
      const { base64 } = await page.evaluate(
        ([s, f, c]) => (globalThis as any).zipHarness.zip(s, f, c),
        [sizes, viaFiles, compress] as const,
      );
      const path = join(dir, `${sizes}-${viaFiles}-${compress}.zip`);
      await writeFile(path, Buffer.from(base64 as string, "base64"));
      const results = await validateZip(path, await manifestOf(fixtureEntries({ sizes })), {
        readers: ["unzip -t", "unzip -x", "python zipfile", "bsdtar (stdin)", "structural"],
      });
      expect(
        failures(results),
        `sizes ${sizes}, File objects ${viaFiles}, compress ${compress}`,
      ).toEqual([]);
    }
  });
});
