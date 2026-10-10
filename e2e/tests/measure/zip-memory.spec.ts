// Opt-in measurement (round 2C+2), not part of `npm run verify`: the memory
// of the browser while the upload page zips and uploads a ~1 GiB folder.
// Run it with
//
//   YEET_E2E_MEASURE=1 npm run verify -- --project=measure-chromium --workers=1
//
// (or measure-webkit, measure-firefox). It samples the RSS of every process
// below this Playwright worker (the browser and its helpers: renderer, GPU,
// network, the Web Worker's process) every 100 ms with `ps`, from just
// before the folder is chosen until 10 s after the link is shown, and
// prints the sum before, at its peak and at the end. RSS only, sampled (a
// short peak between samples is missed), and in Playwright's engines, whose
// instrumentation copies request bodies (docs/design/browser-upload.md,
// "Measurement traps"): an upper bound for the page, not Safari's numbers.

import { execFile } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  deleteUploadFully,
  downloadSha256,
  expect,
  idFromUrl,
  logIn,
  MiB,
  randomFile,
  shareLink,
  silentWavFile,
  test,
} from "../../lib/index.js";

const run = promisify(execFile);

/**
 * RSS in KiB of every process below `root` (not `root` itself), plus every
 * process run from `browserDir` (WebKit's WebContent and Networking
 * processes are XPC services started by launchd, not children of the
 * browser). Only one Playwright run may be active (the harness's rule).
 */
async function treeRss(
  root: number,
  browserDir: string,
): Promise<{ kib: number; processes: number; largest: string }> {
  const { stdout } = await run("ps", ["-A", "-o", "pid=,ppid=,rss=,command="], {
    maxBuffer: 16 * 1024 * 1024,
  });
  const children = new Map<number, number[]>();
  const rss = new Map<number, number>();
  const names = new Map<number, string>();
  const counted = new Set<number>();
  for (const line of stdout.trim().split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);
    if (!match) continue;
    const [pid, ppid, kib] = [Number(match[1]), Number(match[2]), Number(match[3])];
    rss.set(pid, kib);
    names.set(pid, match[4]!.split(" ")[0]!.split("/").pop()!);
    children.set(ppid, [...(children.get(ppid) ?? []), pid]);
    if (match[4]!.startsWith(browserDir)) counted.add(pid);
  }
  const stack = [...(children.get(root) ?? [])];
  while (stack.length) {
    const pid = stack.pop()!;
    counted.add(pid);
    stack.push(...(children.get(pid) ?? []));
  }
  let kib = 0;
  for (const pid of counted) kib += rss.get(pid) ?? 0;
  const largest = [...counted]
    .sort((a, b) => (rss.get(b) ?? 0) - (rss.get(a) ?? 0))
    .slice(0, 3)
    .map((pid) => `${names.get(pid)} ${Math.round((rss.get(pid) ?? 0) / 1024)}`)
    .join(", ");
  return { kib, processes: counted.size, largest };
}

const MiBof = (kib: number) => Math.round(kib / 1024);

for (const kind of ["compressed", "stored"] as const) {
  test(`peak RSS of the browser for a 1 GiB folder, ${kind}`, async ({
    page,
    tmp,
    browserName,
  }, info) => {
    test.setTimeout(15 * 60_000);
    const root = join(tmp, `Stems ${kind}`);
    await mkdir(root);
    // 8 × 128 MiB. Compressed: 4 noise WAVs (incompressible, deflated
    // anyway) and 4 mostly silent WAVs; stored: 8 noise MP3s.
    for (let i = 1; i <= 8; i++) {
      if (kind === "stored") await randomFile(root, 128 * MiB, `take ${i}.mp3`);
      else if (i % 2) await randomFile(root, 128 * MiB, `noise ${i}.wav`);
      else await silentWavFile(root, (128 * MiB - 44) / 176_400, { name: `quiet ${i}.wav` });
    }
    // The browser's install directory, e.g. ~/Library/Caches/ms-playwright/webkit-2293/.
    const executable = page.context().browser()!.browserType().executablePath();
    const browserDir = executable.slice(
      0,
      executable.indexOf("/", executable.indexOf("ms-playwright/") + 14) + 1,
    );
    const rssNow = () => treeRss(process.pid, browserDir);
    await logIn(page);
    await page.waitForTimeout(2000);
    const before = await rssNow();
    let peak = before;
    let sampling = true;
    const sampler = (async () => {
      while (sampling) {
        const now = await rssNow();
        if (now.kib > peak.kib) peak = now;
        await new Promise((r) => setTimeout(r, 100));
      }
    })();
    const started = Date.now();
    await page.locator("#folder-input").setInputFiles(root);
    const url = await shareLink(page, 14 * 60_000);
    const seconds = (Date.now() - started) / 1000;
    await page.waitForTimeout(10_000);
    sampling = false;
    await sampler;
    const after = await rssNow();
    const { size } = await downloadSha256(url);
    const report =
      `${browserName} ${kind} 1 GiB folder: ${seconds.toFixed(1)} s, zip ${size} bytes; ` +
      `RSS of ${after.processes} browser processes: before ${MiBof(before.kib)} MiB, ` +
      `peak ${MiBof(peak.kib)} MiB (+${MiBof(peak.kib - before.kib)}), ` +
      `10 s after ${MiBof(after.kib)} MiB; largest at the peak: ${peak.largest} MiB`;
    console.log(report);
    info.annotations.push({ type: "measurement", description: report });
    expect((await deleteUploadFully(idFromUrl(url))).status).toBe(200);
    await rm(root, { recursive: true, force: true });
  });
}
