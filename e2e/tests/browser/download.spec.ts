import type { Download, Page } from "@playwright/test";
import {
  cliUpload,
  expect,
  FILENAMES,
  KiB,
  randomFile,
  sha256,
  silentWavFile,
  test,
} from "../../lib/index.js";

/** Click the Download button and wait for the browser to save the file. */
async function clickDownload(page: Page): Promise<{ download: Download; sha256: string }> {
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Download" }).click(),
  ]);
  expect(await download.failure()).toBeNull();
  const path = await download.path();
  return { download, sha256: await sha256(path) };
}

test.describe("download page", () => {
  test("shows the filename and size", async ({ page, tmp }) => {
    const file = await randomFile(tmp, 1536 * KiB, FILENAMES.unicode);
    const { url } = await cliUpload(file.path);

    const response = await page.goto(url);
    expect(response?.status()).toBe(200);
    await expect(page).toHaveTitle(`yeet — ${file.name}`);
    await expect(page.locator(".filename")).toHaveText(file.name);
    await expect(page.locator(".meta")).toContainText("1.5 MB");
    await expect(page.getByRole("button", { name: "Download" })).toBeVisible();
    await expect(page.getByLabel("Password required")).toHaveCount(0);
  });

  test("Download saves the exact file under its name", async ({ page, tmp }) => {
    const file = await silentWavFile(tmp, 5, { name: FILENAMES.unicode });
    const { url } = await cliUpload(file.path);

    await page.goto(url);
    const { download, sha256: digest } = await clickDownload(page);

    expect(digest).toBe(file.sha256);
    // WebKit on macOS reports the name in Unicode NFD (decomposed), the others
    // as sent (NFC). Both are the same name.
    expect(download.suggestedFilename().normalize("NFC")).toBe(file.name.normalize("NFC"));
  });

  test("password: a wrong one shows an error, the right one downloads", async ({ page, tmp }) => {
    const password = "correct horse battery staple";
    const file = await randomFile(tmp, 256 * KiB, "secret plans.bin");
    const { url } = await cliUpload(file.path, ["--password", password]);

    await page.goto(url);
    const passwordField = page.getByLabel("Password required");
    await expect(passwordField).toBeVisible();

    await passwordField.fill("wrong password");
    const [rejected] = await Promise.all([
      page.waitForResponse((res) => res.request().method() === "POST"),
      page.getByRole("button", { name: "Download" }).click(),
    ]);
    expect(rejected.status()).toBe(401);
    await expect(page.locator(".error")).toHaveText("Incorrect password. Please try again.");

    await page.getByLabel("Password required").fill(password);
    const { sha256: digest } = await clickDownload(page);
    expect(digest).toBe(file.sha256);
  });

  test("the page at /<id> (no filename) downloads too", async ({ page, tmp }) => {
    const file = await randomFile(tmp, 64 * KiB, "short link.bin");
    const { id } = await cliUpload(file.path);

    const response = await page.goto(`/${id}`);
    expect(response?.status()).toBe(200);
    const { download, sha256: digest } = await clickDownload(page);
    expect(digest).toBe(file.sha256);
    expect(download.suggestedFilename()).toBe(file.name);
  });

  test("a protected upload at /<id>: wrong password, right one, then the download pass", async ({
    page,
    tmp,
  }) => {
    const password = "short-link password";
    const file = await randomFile(tmp, 64 * KiB, "short locked.bin");
    const { id } = await cliUpload(file.path, ["--password", password]);

    await page.goto(`/${id}`);
    await page.getByLabel("Password required").fill("wrong password");
    const [rejected] = await Promise.all([
      page.waitForResponse((res) => res.request().method() === "POST"),
      page.getByRole("button", { name: "Download" }).click(),
    ]);
    expect(rejected.status()).toBe(401);
    expect(new URL(rejected.url()).pathname).toBe(`/${id}/download`);
    await expect(page.locator(".error")).toHaveText("Incorrect password. Please try again.");

    await page.getByLabel("Password required").fill(password);
    expect((await clickDownload(page)).sha256).toBe(file.sha256);

    // With the download pass from the right password, /<id> has no password field.
    await page.goto(`/${id}`);
    await expect(page.getByLabel("Password required")).toHaveCount(0);
    expect((await clickDownload(page)).sha256).toBe(file.sha256);
  });

  test("an unknown link shows the 404 page", async ({ page }) => {
    const response = await page.goto("/AAAAAA/nothing-here.txt");
    expect(response?.status()).toBe(404);
    await expect(page.locator(".filename")).toHaveText("File not found");
  });
});
