// The welcome page on / (round 2D): what yeet is, this yeet's address (the
// request's origin, to keep for later) and one click to /upload. Public:
// no login, nothing secret. (No line about the command-line tool until
// phase 3 adds `yeet setup`.)

import { expect, expectPhoneLayout, server, test } from "../../lib/index.js";

const origin = () => new URL(server.baseURL).origin;

test.describe("welcome page", () => {
  test("says what yeet is and shows this yeet's address", async ({ page }) => {
    const res = await page.goto("/");
    expect(res?.status()).toBe(200);
    await expect(page).toHaveTitle("yeet");
    await expect(page.getByText("This is your yeet")).toBeVisible();
    await expect(page.getByText("yeet shares your files through links that expire.")).toBeVisible();
    const address = page.getByLabel("Your yeet address");
    await expect(address).toHaveValue(origin());
    // The same as the page's own origin, as the browser sees it.
    expect(await address.inputValue()).toBe(await page.evaluate(() => location.origin));
    await expect(address).toHaveJSProperty("readOnly", true);
    // No command-line tool line yet (phase 3).
    const text = await page.locator("body").innerText();
    expect(text).not.toContain("npx");
    expect(text).not.toContain("yeet login");
    await expect(page.locator("code")).toHaveCount(0);
    // Nothing that needs a login.
    await expect(page.locator('input[type="password"]')).toHaveCount(0);
    await expect(page.locator("form")).toHaveCount(0);
  });

  test("Upload files opens the upload page's login", async ({ page }) => {
    await page.goto("/");
    const link = page.getByRole("link", { name: "Upload files" });
    await expect(link).toHaveAttribute("href", "/upload");
    await link.click();
    await expect(page).toHaveURL(`${origin()}/upload`);
    await expect(page.getByRole("button", { name: "Log in" })).toBeVisible();
  });

  test("Copy address puts the address on the clipboard", async ({ page, context, browserName }) => {
    if (browserName === "chromium") {
      await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    }
    await page.goto("/");
    await page.getByRole("button", { name: "Copy address" }).click();
    await expect(page.locator("#copy-note")).toHaveText("Address copied.");
    if (browserName === "webkit") {
      // Playwright's WebKit refuses clipboard.readText(); paste it instead.
      await page.evaluate(() => {
        const area = document.createElement("textarea");
        area.id = "e2e-paste";
        document.body.append(area);
      });
      await page.locator("#e2e-paste").focus();
      await page.keyboard.press("Meta+V");
      await expect(page.locator("#e2e-paste")).toHaveValue(origin());
    } else {
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(origin());
    }
  });

  test("Copy address without the Clipboard API selects the address instead", async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "clipboard", {
        value: { writeText: () => Promise.reject(new Error("denied")) },
      });
    });
    await page.goto("/");
    await page.getByRole("button", { name: "Copy address" }).click();
    await expect(page.locator("#copy-note")).toHaveText(
      /^(Address copied\.|Select the address and copy it\.)$/,
    );
    const selection = await page.locator("#address").evaluate((input: HTMLInputElement) => ({
      focused: document.activeElement === input,
      selected: input.value.slice(input.selectionStart ?? 0, input.selectionEnd ?? 0),
    }));
    expect(selection).toEqual({ focused: true, selected: origin() });
  });

  test.describe("at phone width", () => {
    test.use({ viewport: { width: 375, height: 667 } });

    test("fits the screen with touch-size targets", async ({ page }) => {
      await page.goto("/");
      await expectPhoneLayout(page, "welcome");
      // The link is a touch-size target too, and works.
      const box = await page.getByRole("link", { name: "Upload files" }).boundingBox();
      expect(box?.height).toBeGreaterThanOrEqual(44);
      await page.getByRole("link", { name: "Upload files" }).click();
      await expect(page).toHaveURL(`${origin()}/upload`);
    });
  });
});
