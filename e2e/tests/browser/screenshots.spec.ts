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
import { eventually, expect, logIn, MiB, randomFile, shareLink, test } from "../../lib/index.js";

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
