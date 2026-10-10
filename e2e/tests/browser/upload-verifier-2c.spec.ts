// Round 2C verifier: cases the implementer's specs left open, each found
// by a mutation that survived them.
// - A `complete` that fails for good after the server finished the upload:
//   the worker must not delete it (mutation: drop `!this.completing` from
//   the failure cleanup in worker.ts).
// - A lost file replaced by one with the same name and size but another
//   date: a new upload, never a resume that mixes old and new parts
//   (mutation: drop the lastModified comparison in main.ts isSameFile()).
// - The download page, which shares the layout CSS, at phone width.

import { rename, utimes } from "node:fs/promises";
import type { Page, Request, Route } from "@playwright/test";
import {
  deleteUpload,
  downloadSha256,
  eventually,
  expect,
  KiB,
  logIn,
  randomFile,
  readUploadMeta,
  shareLink,
  test,
  uploadObjects,
} from "../../lib/index.js";

function isPart(request: Request, n: number): boolean {
  const match = new URL(request.url()).pathname.match(/^\/api\/uploads\/[^/]+\/parts\/(\d+)$/);
  return request.method() === "PUT" && !!match && Number(match[1]) === n;
}

function createdId(page: Page): Promise<string> {
  return page
    .waitForResponse(
      (res) => res.request().method() === "POST" && new URL(res.url()).pathname === "/api/uploads",
    )
    .then(async (res) => ((await res.json()) as { id: string }).id);
}

test.describe("upload page: round 2C verifier", () => {
  test("a complete that fails for good after the server finished it: nothing is deleted", async ({
    page,
    context,
    tmp,
  }) => {
    const file = await randomFile(tmp, 10 * KiB, "finished anyway.bin");
    await logIn(page);
    const deletes: string[] = [];
    context.on("request", (request) => {
      if (request.method() === "DELETE") deletes.push(request.url());
    });
    let completes = 0;
    await page.route("**/api/uploads/*/complete", async (route: Route) => {
      // The first reaches the server and finishes the upload; every
      // answer the page sees is a 500, so its retries run out.
      if (completes++ === 0) await (await route.fetch()).body();
      return route.fulfill({ status: 500, json: { error: "Internal server error" } });
    });
    const created = createdId(page);
    await page.locator("#file-input").setInputFiles(file.path);
    const id = await created;
    await expect(page.locator("#error-message")).toHaveText(/^Something went wrong on the server/, {
      timeout: 30_000,
    });
    expect(completes).toBeGreaterThan(1);
    await page.waitForTimeout(1000);
    expect(deletes).toEqual([]);
    const meta = await readUploadMeta(id);
    expect(meta?.pending_upload_id).toBeUndefined();
    expect((await uploadObjects(id)).map((o) => o.key.split("/").pop())).toContain(file.name);
    expect((await deleteUpload(id)).status).toBe(200);
  });

  test("the same name and size but another date is another file", async ({ page, tmp }) => {
    const lost = await randomFile(tmp, 10 * KiB, "same size.bin");
    await logIn(page);
    // Lose the file while part 1 is in flight (as upload-resume.spec.ts).
    const held: Route[] = [];
    await page.route("**/api/uploads/*/parts/*", (route) => {
      if (isPart(route.request(), 1)) held.push(route);
      else return route.fallback();
    });
    const created = createdId(page);
    await page.locator("#file-input").setInputFiles(lost.path);
    const oldId = await created;
    await eventually(() => held.length > 0, { message: "part 1 in flight" });
    await rename(lost.path, `${lost.path}.away`);
    await held[0]!.abort("connectionreset");
    await expect(page.locator("#error-message")).toHaveText(
      /^The browser lost access to the file\. /,
    );
    await page.unrouteAll({ behavior: "ignoreErrors" });

    // Overwritten in the meantime: same name, same size, new content and date.
    const changed = await randomFile(tmp, 10 * KiB, "same size.bin");
    const later = new Date(Date.now() + 120_000);
    await utimes(changed.path, later, later);

    const next = createdId(page);
    await page.locator("#file-input").setInputFiles(changed.path);
    const newId = await next;
    const url = await shareLink(page);
    expect(newId).not.toBe(oldId);
    expect(await downloadSha256(url)).toEqual({ sha256: changed.sha256, size: changed.size });
    await eventually(async () => (await uploadObjects(oldId)).length === 0, {
      message: `uploads/${oldId}/ to be empty`,
    });
  });
});

test.describe("download page at phone width (shared layout CSS)", () => {
  test.use({ viewport: { width: 375, height: 667 } });

  test("no sideways scroll, 44 px targets, 16 px password field", async ({ page, tmp }) => {
    const file = await randomFile(tmp, 2 * KiB, `${"a-long-download-name-".repeat(6)}.bin`);
    await logIn(page);
    await page.getByLabel("Password (optional)").fill("phone check");
    await page.locator("#file-input").setInputFiles(file.path);
    const url = await shareLink(page);
    await page.goto(url);
    await expect(page.getByPlaceholder("Enter password")).toBeVisible();
    const layout = await page.evaluate(() => {
      const box = (sel: string) => document.querySelector(sel)!.getBoundingClientRect();
      return {
        scrollWidth: document.documentElement.scrollWidth,
        width: window.innerWidth,
        button: box("button[type=submit]").height,
        input: box("#pw").height,
        font: parseFloat(getComputedStyle(document.querySelector("#pw")!).fontSize),
        inputRight: box("#pw").right,
      };
    });
    expect(layout.scrollWidth).toBeLessThanOrEqual(layout.width);
    expect(layout.inputRight).toBeLessThanOrEqual(layout.width);
    expect(layout.button).toBeGreaterThanOrEqual(44);
    expect(layout.input).toBeGreaterThanOrEqual(44);
    expect(layout.font).toBeGreaterThanOrEqual(16);
  });
});
