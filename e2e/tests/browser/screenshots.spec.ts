// Screenshots of the upload page in each state, at desktop and phone width,
// for a person to judge the look: e2e/screenshots/2c/<engine>/
// (git-ignored, overwritten by every run). Login, idle, uploading (part 2
// of 2 held), "choose the file again" (the file taken away mid-upload, see
// upload-resume.spec.ts) and done (after continuing). The test also checks
// that each state is the one shown.

import { mkdir, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Request, Route } from "@playwright/test";
import {
  dropTree,
  eventually,
  expect,
  logIn,
  MiB,
  randomFile,
  shareLink,
  test,
} from "../../lib/index.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../screenshots/2c");
const WIDTHS = { desktop: { width: 1280, height: 800 }, phone: { width: 375, height: 667 } };

function isPart(request: Request, n: number): boolean {
  const match = new URL(request.url()).pathname.match(/^\/api\/uploads\/[^/]+\/parts\/(\d+)$/);
  return request.method() === "PUT" && !!match && Number(match[1]) === n;
}

test("screenshots of every state", async ({ page, tmp, browserName }) => {
  test.setTimeout(120_000);
  const dir = join(ROOT, browserName);
  await mkdir(dir, { recursive: true });
  const shoot = async (state: string) => {
    for (const [name, size] of Object.entries(WIDTHS)) {
      await page.setViewportSize(size);
      await page.screenshot({ path: join(dir, `${state}-${name}.png`), fullPage: true });
    }
    await page.setViewportSize(WIDTHS.desktop);
  };

  await page.goto("/upload");
  await expect(page.getByRole("button", { name: "Log in" })).toBeVisible();
  await shoot("1-login");

  await logIn(page);
  await page.getByLabel("Password (optional)").fill("velvet tractor");
  await shoot("2-idle");

  const file = await randomFile(tmp, 60 * MiB, "Final mix (master) v3.wav");
  const held: Route[] = [];
  await page.route("**/api/uploads/*/parts/*", (route) => {
    if (isPart(route.request(), 2)) held.push(route);
    else return route.fallback();
  });
  const part1 = page.waitForResponse((res) => isPart(res.request(), 1) && res.ok());
  await page.locator("#file-input").setInputFiles(file.path);
  await part1;
  await eventually(() => held.length > 0, { message: "part 2 in flight" });
  await expect(page.locator("#percent")).toHaveText("83%");
  await shoot("3-uploading");

  await rename(file.path, `${file.path}.away`);
  await held[0]!.abort("connectionreset");
  await expect(page.getByRole("button", { name: "Choose the file again" })).toBeVisible();
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await rename(`${file.path}.away`, file.path);
  await shoot("4-choose-again");

  await page.locator("#file-input").setInputFiles(file.path);
  await shareLink(page);
  await shoot("5-done");
});

// Round 2C+2: the states of zip uploads, to e2e/screenshots/2c2/<engine>/:
// idle (Choose files, Choose folder), a selection refused (a name
// collision), the warning before a selection too large to compress safely
// is stored (the limit lowered with the page's test hook), a folder being
// zipped and uploaded (part 2 held), its files lost (choose the folder
// again), and done.
test("screenshots of the zip states", async ({ page, tmp, browserName }) => {
  test.setTimeout(120_000);
  const dir = join(dirname(ROOT), "2c2", browserName);
  await mkdir(dir, { recursive: true });
  const shoot = async (state: string) => {
    for (const [name, size] of Object.entries(WIDTHS)) {
      await page.setViewportSize(size);
      await page.screenshot({ path: join(dir, `${state}-${name}.png`), fullPage: true });
    }
    await page.setViewportSize(WIDTHS.desktop);
  };
  await page.addInitScript(() => {
    (window as unknown as { __yeetE2E: unknown }).__yeetE2E = { maxUnsizedParts: 1 };
  });

  await logIn(page);
  await expect(page.getByRole("button", { name: "Choose folder" })).toBeVisible();
  await shoot("1-idle");

  await dropTree(page, [
    {
      name: "Stems",
      mtime: Date.now(),
      children: [
        { name: "Kick.wav", text: "a" },
        { name: "kick.wav", text: "b" },
      ],
    },
  ]);
  await expect(page.locator("#idle-error")).toBeVisible();
  await shoot("2-collision");

  const root = join(tmp, "Session – Final mix (v3)");
  await mkdir(join(root, "drums"), { recursive: true });
  await randomFile(root, 40 * MiB, "Final mix (master) v3.wav");
  await randomFile(join(root, "drums"), 15 * MiB, "kick.wav");
  await randomFile(join(root, "drums"), 5 * MiB, "snare.wav");
  await page.locator("#folder-input").setInputFiles(root);
  await expect(page.getByRole("button", { name: "Upload anyway" })).toBeVisible();
  await shoot("3-too-large-warning");

  const held: Route[] = [];
  await page.route("**/api/uploads/*/parts/*", (route) => {
    if (isPart(route.request(), 2)) held.push(route);
    else return route.fallback();
  });
  const part1 = page.waitForResponse((res) => isPart(res.request(), 1) && res.ok());
  await page.getByRole("button", { name: "Upload anyway" }).click();
  await part1;
  await eventually(() => held.length > 0, { message: "part 2 in flight" });
  await expect(page.locator("#up-files")).toHaveText(/^File 3 of 3: /);
  await shoot("4-zip-progress");

  const snare = join(root, "drums", "snare.wav");
  await rename(snare, `${snare}.away`);
  await held[0]!.abort("connectionreset");
  await expect(page.getByRole("button", { name: "Choose the folder again" })).toBeVisible();
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await rename(`${snare}.away`, snare);
  await shoot("5-choose-folder-again");

  await page.locator("#folder-input").setInputFiles(root);
  await shareLink(page, 60_000);
  await shoot("6-done");
});

// Round 2D: the welcome page on /, to e2e/screenshots/2d/<engine>/, at
// desktop and phone width.
test("screenshots of the welcome page", async ({ page, browserName }) => {
  const dir = join(dirname(ROOT), "2d", browserName);
  await mkdir(dir, { recursive: true });
  await page.goto("/");
  await expect(page.getByRole("link", { name: "Upload files" })).toBeVisible();
  for (const [name, size] of Object.entries(WIDTHS)) {
    await page.setViewportSize(size);
    await page.screenshot({ path: join(dir, `welcome-${name}.png`), fullPage: true });
  }
});
