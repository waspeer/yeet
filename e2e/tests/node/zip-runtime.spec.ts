// Must-test item 13 (docs/design/zip.md), workerd: the Worker copy of zip.ts
// builds the fixture zips inside `wrangler dev` (a throwaway Worker,
// e2e/zip/runtime/, without nodejs_compat); Node validates them with check.py
// and the other local readers. The browsers: tests/browser/zip-runtime.spec.ts.
// Node itself: zip-format.spec.ts.

import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { expect, startServer, test } from "../../lib/index.js";
import { fixtureEntries } from "../../zip/fixtures.js";
import { failures, manifestOf, validateZip } from "../../zip/validate.js";

const CONFIG = fileURLToPath(new URL("../../zip/runtime/wrangler.jsonc", import.meta.url));
const MTIME = Date.UTC(2026, 9, 7, 12, 34, 56);

test("workerd (no nodejs_compat): fixture zips pass check.py and the local readers", async ({
  tmp,
}) => {
  test.setTimeout(180_000);
  const worker = await startServer({
    token: "unused-by-this-worker",
    config: CONFIG,
    readyPath: "/info",
  });
  try {
    // nodejs_compat is off by configuration (e2e/zip/runtime/wrangler.jsonc).
    const info = (await (await fetch(`${worker.baseURL}/info`)).json()) as {
      userAgent: string;
      formats: Record<string, boolean>;
    };
    expect(info.userAgent).toBe("Cloudflare-Workers");
    expect(info.formats["deflate-raw"]).toBe(true);
    // workerd's local zone is UTC: DOS times are UTC unless ?tz= says otherwise.
    const tz = -new Date(MTIME).getTimezoneOffset();
    for (const query of [
      "sizes=known",
      "sizes=unknown",
      "sizes=mixed",
      "sizes=known&compress=0",
      `sizes=known&tz=${tz}`,
    ]) {
      const params = new URLSearchParams(query);
      const sizes = params.get("sizes") as "known" | "unknown" | "mixed";
      const res = await fetch(`${worker.baseURL}/zip?${query}`);
      expect(res.status, query).toBe(200);
      const path = join(tmp, `${query.replace(/[^a-z0-9]+/gi, "-")}.zip`);
      await writeFile(path, new Uint8Array(await res.arrayBuffer()));
      const manifest = await manifestOf(fixtureEntries({ sizes }));
      const results = await validateZip(path, manifest, {
        mtime: MTIME,
        tzMinutes: params.has("tz") ? tz : 0,
        // Not ditto: it reads only the DOS time, so UTC DOS times extract off by
        // this machine's offset (docs/design/zip.md). check.py ("structural")
        // checks the DOS fields against the zone they were written in.
        readers: [
          "unzip -t",
          "unzip -x",
          "python zipfile",
          "bsdtar",
          "bsdtar (stdin)",
          "structural",
        ],
      });
      expect(failures(results), query).toEqual([]);
    }
  } finally {
    await worker.stop();
  }
});
