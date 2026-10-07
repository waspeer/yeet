// workerd: start the throwaway Worker with `wrangler dev` (local only), download
// zips streamed by it, and validate them. Usage: node scripts/worker-test.ts
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fixtureEntries } from "../fixtures.ts";
import { manifestOf, printResults, validateZip } from "./validate.ts";

const here = new URL(".", import.meta.url).pathname;
const PORT = 8799;
const MTIME = Date.UTC(2026, 9, 7, 12, 34, 56);

const wrangler = spawn(
  join(here, "../node_modules/.bin/wrangler"),
  ["dev", "--port", String(PORT), "--ip", "127.0.0.1"],
  {
    cwd: join(here, "../worker"),
    env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
let log = "";
wrangler.stdout.on("data", (d) => (log += d));
wrangler.stderr.on("data", (d) => (log += d));

let allOk = true;
const dir = await mkdtemp(join(tmpdir(), "yeet-zip-worker-"));
try {
  const base = `http://127.0.0.1:${PORT}`;
  for (let i = 0; ; i++) {
    if (i > 120) throw new Error("wrangler dev did not start:\n" + log);
    try {
      if ((await fetch(`${base}/info`)).ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  const versionLine = /workerd|wrangler [\d.]+/i.exec(log)?.[0];
  console.log(`wrangler dev up (${versionLine ?? "?"})`);
  console.log("info:", JSON.stringify(await (await fetch(`${base}/info`)).json()));
  console.log("bench:", JSON.stringify(await (await fetch(`${base}/bench`)).json()));

  for (const query of [
    "sizes=known",
    "sizes=unknown",
    "sizes=mixed",
    "sizes=known&zip64=always",
    "sizes=known&compress=0",
    `sizes=known&tz=${-new Date(MTIME).getTimezoneOffset()}`,
  ]) {
    const sizes = new URLSearchParams(query).get("sizes") as "known" | "unknown" | "mixed";
    const path = join(dir, `${query.replace(/[^a-z0-9]+/gi, "-")}.zip`);
    const response = await fetch(`${base}/zip?${query}`);
    if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
    await pipeline(Readable.fromWeb(response.body as never), createWriteStream(path));
    const size = (await stat(path)).size;
    const manifest = await manifestOf(fixtureEntries({ sizes }));
    const results = await validateZip(path, manifest, { mtime: MTIME });
    const expectFail = query.includes("zip64=always") ? ["ditto -x -k"] : [];
    allOk = printResults(`workerd /zip?${query} — ${size} bytes`, results, expectFail) && allOk;
  }
} finally {
  wrangler.kill("SIGINT");
  await rm(dir, { recursive: true, force: true });
}
console.log(allOk ? "\nALL PASS" : "\nSOME FAILURES");
process.exitCode = allOk ? 0 : 1;
