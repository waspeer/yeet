// Everything a test needs: `import { test, expect, cli, ... } from "../../lib/index.js"`.

import { test as base } from "@playwright/test";
import { rm } from "node:fs/promises";
import { makeTempDir } from "./util.js";

export const test = base.extend<{
  /** A per-test temp directory for fixtures and downloads, removed afterwards. */
  tmp: string;
}>({
  // oxlint-disable-next-line no-empty-pattern -- Playwright fixtures must destructure
  tmp: async ({}, use) => {
    const dir = await makeTempDir("test-");
    await use(dir);
    await rm(dir, { recursive: true, force: true });
  },
});

export { expect } from "@playwright/test";
export * from "./api.js";
export * from "./bucket.js";
export * from "./cli.js";
export * from "./env.js";
export * from "./fixtures.js";
export * from "./util.js";
