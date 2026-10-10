// The upload page at phone width (an iPhone SE's 375 × 667 CSS pixels), in
// every engine: no sideways scrolling, touch-size targets (44 px, Apple's
// minimum), fields at 16 px (iOS Safari zooms into smaller ones on focus),
// and the file picker behind "Choose file". Playwright's engines on the
// desktop are not iOS Safari: the real phone is a human test.

import type { Page, Route } from "@playwright/test";
import {
  downloadSha256,
  expect,
  KiB,
  logIn,
  randomFile,
  server,
  shareLink,
  test,
} from "../../lib/index.js";

test.use({ viewport: { width: 375, height: 667 } });

interface LayoutProblems {
  scrollWidth: number;
  width: number;
  small: string[];
  outside: string[];
  smallText: string[];
}

/** Everything wrong with the visible layout at this width. */
function layoutProblems(page: Page): Promise<LayoutProblems> {
  return page.evaluate(() => {
    const width = window.innerWidth;
    const visible = (el: Element) => {
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && getComputedStyle(el).visibility !== "hidden";
    };
    const name = (el: Element) =>
      `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""} "${(el.textContent ?? "").trim().slice(0, 20)}"`;
    const targets = [
      ...document.querySelectorAll("button, select, input:not([type=file]), a.button"),
    ].filter(visible);
    const small: string[] = [];
    const outside: string[] = [];
    for (const el of targets) {
      const rect = el.getBoundingClientRect();
      if (rect.height < 44) small.push(`${name(el)}: ${rect.height.toFixed(0)} px high`);
      if (rect.left < 0 || rect.right > width) outside.push(name(el));
    }
    const smallText = [...document.querySelectorAll("select, input:not([type=file])")]
      .filter(visible)
      .filter((el) => parseFloat(getComputedStyle(el).fontSize) < 16)
      .map(name);
    return {
      scrollWidth: document.documentElement.scrollWidth,
      width,
      small,
      outside,
      smallText,
    };
  });
}

async function expectPhoneLayout(page: Page, state: string): Promise<void> {
  const problems = await layoutProblems(page);
  expect(problems.scrollWidth, `${state}: page wider than the screen`).toBeLessThanOrEqual(
    problems.width,
  );
  expect(problems.small, `${state}: targets under 44 px`).toEqual([]);
  expect(problems.outside, `${state}: targets off screen`).toEqual([]);
  expect(problems.smallText, `${state}: fields under 16 px`).toEqual([]);
}

test.describe("upload page at phone width", () => {
  test("login, idle and done fit the screen with touch-size targets", async ({ page, tmp }) => {
    await page.goto("/upload");
    await expectPhoneLayout(page, "login");

    await logIn(page);
    await expectPhoneLayout(page, "idle");

    // A long name must wrap, not widen the page.
    const file = await randomFile(tmp, 10 * KiB, `${"a-very-long-file-name-".repeat(6)}.wav`);
    const chooser = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "Choose file" }).click();
    await (await chooser).setFiles(file.path);
    const url = await shareLink(page);
    expect(url.startsWith(server.baseURL)).toBe(true);
    await expectPhoneLayout(page, "done");
    expect(await downloadSha256(url)).toEqual({ sha256: file.sha256, size: file.size });
  });

  test("the uploading and error states fit the screen", async ({ page, tmp }) => {
    const file = await randomFile(tmp, 10 * KiB, "refused.bin");
    await logIn(page);
    const held: Route[] = [];
    await page.route("**/api/uploads/*/parts/*", (route) => void held.push(route));
    await page.locator("#file-input").setInputFiles(file.path);
    await expect.poll(() => held.length).toBeGreaterThan(0);
    await expectPhoneLayout(page, "uploading");
    // The part is refused: the error state.
    await held[0]!.fulfill({ status: 413, json: { error: "Part larger than part_size" } });
    await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
    await expectPhoneLayout(page, "error");
    await page.unrouteAll({ behavior: "ignoreErrors" });
  });
});
