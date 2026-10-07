// Browsers: bundle browser/harness.ts (which imports the same zip.ts), load it
// in Chromium, WebKit and Firefox via Playwright, build zips in the page,
// return the bytes to Node and validate them.
// Usage: node scripts/browser-test.ts [--bench] [--stems]
// --stems serves the real stems folder (read-only, streamed from disk, never copied) to the page
// and measures CompressionStream("deflate-raw") on it.
import { createReadStream } from "node:fs";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as esbuild from "esbuild";
import { chromium, firefox, webkit } from "playwright";
import { fixtureEntries } from "../fixtures.ts";
import { manifestOf, printResults, validateZip } from "./validate.ts";

const here = new URL(".", import.meta.url).pathname;
const MTIME = Date.UTC(2026, 9, 7, 12, 34, 56);
const bench = process.argv.includes("--bench");
const stems = process.argv.includes("--stems");
const STEMS = "/Users/wannessalome/Downloads/tien-voor-sil-148bpm";
const stemNames = stems ? (await readdir(STEMS)).filter((n) => n.endsWith(".wav")).sort() : [];

const bundle = await esbuild.build({
  entryPoints: [join(here, "../browser/harness.ts")],
  bundle: true,
  format: "iife",
  target: "es2022",
  write: false,
});
const script = bundle.outputFiles[0].text;
const html = `<!doctype html><meta charset="utf-8"><title>zip harness</title><script>${script}</script>`;

// Served from localhost so the page is a secure context, like the real upload page.
const server = createServer((req, res) => {
  const name = decodeURIComponent(req.url ?? "/").replace(/^\/stems\//, "");
  if (req.url?.startsWith("/stems/") && stemNames.includes(name)) {
    res.writeHead(200, { "content-type": "application/octet-stream" });
    createReadStream(join(STEMS, name)).pipe(res);
    return;
  }
  res.writeHead(200, { "content-type": "text/html" }).end(html);
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;

let allOk = true;
const dir = await mkdtemp(join(tmpdir(), "yeet-zip-browser-"));
try {
  for (const type of [chromium, webkit, firefox]) {
    const browser = await type.launch();
    try {
      const page = await browser.newPage();
      await page.goto(url);
      const info = await page.evaluate(() => (globalThis as any).zipHarness.info());
      console.log(`\n# ${type.name()} ${browser.version()}: ${JSON.stringify(info.formats)}`);
      if (bench)
        console.log(
          "bench:",
          JSON.stringify(await page.evaluate(() => (globalThis as any).zipHarness.bench())),
        );
      if (stems) {
        const urls = stemNames.map((n) => `${url}stems/${encodeURIComponent(n)}`);
        console.log(
          "stems:",
          JSON.stringify(
            await page.evaluate((u) => (globalThis as any).zipHarness.benchUrls(u), urls),
          ),
        );
      }
      for (const [sizes, viaFiles] of [
        ["known", true],
        ["unknown", false],
        ["mixed", false],
      ] as const) {
        const { base64, ms } = await page.evaluate(
          ([s, f]) => (globalThis as any).zipHarness.zip(s, f),
          [sizes, viaFiles] as const,
        );
        const bytes = Buffer.from(base64, "base64");
        const path = join(dir, `${type.name()}-${sizes}.zip`);
        await writeFile(path, bytes);
        const manifest = await manifestOf(fixtureEntries({ sizes }));
        const results = await validateZip(path, manifest, { mtime: MTIME });
        const label = `${type.name()} sizes=${sizes}${viaFiles ? " (File objects)" : ""} — ${bytes.length} bytes in ${ms.toFixed(0)} ms`;
        allOk = printResults(label, results) && allOk;
      }
    } finally {
      await browser.close();
    }
  }
} finally {
  server.close();
  await rm(dir, { recursive: true, force: true });
}
console.log(allOk ? "\nALL PASS" : "\nSOME FAILURES");
process.exitCode = allOk ? 0 : 1;
