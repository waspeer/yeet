// Must-test items 14 (the two copies of zip.ts are byte-identical) and 15
// (the 7za tooling guard) of docs/design/zip.md.

import { expect, test } from "@playwright/test";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { run, withScratch } from "../../zip/scratch.js";
import { assertSevenZip } from "../../zip/validate.js";

const SCRIPT = fileURLToPath(new URL("../../../scripts/check-zip-copies.mjs", import.meta.url));
const CLI_COPY = fileURLToPath(new URL("../../../packages/cli/src/zip.ts", import.meta.url));
const WORKER_COPY = fileURLToPath(new URL("../../../packages/worker/src/zip.ts", import.meta.url));

const check = async (...paths: string[]) => {
  try {
    const { stdout } = await run(process.execPath, [SCRIPT, ...paths]);
    return { code: 0, out: stdout };
  } catch (err) {
    const e = err as { code: number; stdout: string; stderr: string };
    return { code: e.code, out: e.stdout + e.stderr };
  }
};

test.describe("zip 14: the CLI and Worker copies of zip.ts", () => {
  test("are byte-identical", async () => {
    expect(await readFile(CLI_COPY)).toEqual(await readFile(WORKER_COPY));
    const r = await check();
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("2 copies of zip.ts are identical");
  });

  test("scripts/check-zip-copies.mjs fails when they differ, or one is missing", async () => {
    await withScratch(async (dir) => {
      const a = join(dir, "a.ts");
      const b = join(dir, "b.ts");
      const source = await readFile(CLI_COPY);
      await writeFile(a, source);
      await writeFile(b, source);
      expect((await check(a, b)).code).toBe(0);
      // One byte more (a trailing newline) is enough.
      await writeFile(b, Buffer.concat([source, Buffer.from("\n")]));
      const differ = await check(a, b);
      expect(differ.code).toBe(1);
      expect(differ.out).toContain("the copies of zip.ts differ");
      const missing = await check(a, join(dir, "missing.ts"));
      expect(missing.code).toBe(1);
      expect(missing.out).toContain("cannot read");
    });
  });
});

test.describe("zip 15: the 7za tooling guard", () => {
  test("a 7za without the exec bit fails with a chmod hint; with it, it passes", async () => {
    await withScratch(async (dir) => {
      const fake = join(dir, "7za");
      await writeFile(fake, "#!/bin/sh\necho 7-Zip\n");
      await chmod(fake, 0o644);
      await expect(assertSevenZip(fake)).rejects.toThrow(`chmod +x "${fake}"`);
      await expect(assertSevenZip(join(dir, "missing"))).rejects.toThrow(
        /missing or not executable/,
      );
      await chmod(fake, 0o755);
      await expect(assertSevenZip(fake)).resolves.toBe(fake);
    });
  });
});
