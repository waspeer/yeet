// When the browser loses access to the picked file mid-upload. On a real
// iPhone (docs/design/browser-upload.md, "Seen on a real iPhone") a part
// failed with status 0 and the next read of the File threw `NotFoundError`:
// iOS revokes access when the screen locks. Here the file is renamed away
// on disk while a part is held, and that part is then aborted: reading the
// File then fails in every engine (WebKit: "NotFoundError: The object can
// not be found here.", as on the iPhone; Chromium: NotFoundError; Firefox:
// AbortError), and its upload fails like a network error.
//
// The page must say so plainly, keep the upload open on the server, and
// continue it from the first unacknowledged part once the same file (name,
// size, lastModified) is chosen again; another file starts afresh and the
// old upload is deleted.

import { rename } from "node:fs/promises";
import type { Page, Request, Route } from "@playwright/test";
import {
  deleteUpload,
  downloadSha256,
  eventually,
  expect,
  KiB,
  listUploads,
  logIn,
  MiB,
  randomFile,
  readUploadMeta,
  serverLog,
  shareLink,
  sleep,
  test,
  uploadObjects,
} from "../../lib/index.js";

const LOST =
  "The browser lost access to the file. On an iPhone this happens when the screen locks " +
  "or you switch apps. Choose the same file again to continue where it stopped.";

function isPart(request: Request, n?: number): boolean {
  const match = new URL(request.url()).pathname.match(/^\/api\/uploads\/[^/]+\/parts\/(\d+)$/);
  return request.method() === "PUT" && !!match && (n === undefined || Number(match[1]) === n);
}

function createdId(page: Page): Promise<string> {
  return page
    .waitForResponse(
      (res) => res.request().method() === "POST" && new URL(res.url()).pathname === "/api/uploads",
    )
    .then(async (res) => ((await res.json()) as { id: string }).id);
}

/** Requests for this upload that reached the server, by wrangler's log. */
async function serverRequests(id: string): Promise<string[]> {
  return (await serverLog()).split("\n").filter((line) => line.includes(`/api/uploads/${id}`));
}

async function expectGone(id: string): Promise<void> {
  await eventually(async () => (await uploadObjects(id)).length === 0, {
    message: `uploads/${id}/ to be empty`,
  });
  expect((await listUploads()).map((upload) => upload.id)).not.toContain(id);
}

/**
 * Upload `path` until part `lostAt` is in flight, then take the file away
 * (rename it) and let that part fail: the page reports the lost file. The
 * file is renamed back before this returns. Resolves with the upload's ID.
 */
async function loseFileAt(page: Page, path: string, lostAt: number): Promise<string> {
  const held: Route[] = [];
  await page.route("**/api/uploads/*/parts/*", (route) => {
    if (isPart(route.request(), lostAt)) held.push(route);
    else return route.fallback();
  });
  const created = createdId(page);
  const earlier = Array.from({ length: lostAt - 1 }, (_, i) =>
    page.waitForResponse((res) => isPart(res.request(), i + 1) && res.status() === 200),
  );
  await page.locator("#file-input").setInputFiles(path);
  const id = await created;
  await Promise.all(earlier);
  await eventually(() => held.length > 0, { message: `part ${lostAt} in flight` });

  await rename(path, `${path}.away`);
  try {
    await held[0]!.abort("connectionreset");
    await expect(page.locator("#error-message")).toHaveText(
      /^The browser lost access to the file\. /,
    );
  } finally {
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await rename(`${path}.away`, path);
  }
  return id;
}

test.describe("upload page: the browser loses access to the file", () => {
  test("choosing the same file again continues from the first unacknowledged part", async ({
    page,
    tmp,
  }) => {
    test.setTimeout(120_000);
    // Two parts: 50 MiB and 1 MiB.
    const file = await randomFile(tmp, 51 * MiB, "lost and found.wav");
    await logIn(page);
    const creates: string[] = [];
    page.context().on("request", (request) => {
      if (request.method() === "POST" && new URL(request.url()).pathname === "/api/uploads") {
        creates.push(request.url());
      }
    });
    const id = await loseFileAt(page, file.path, 2);

    await expect(page.locator("#error-message")).toHaveText(LOST);
    await expect(page.getByRole("button", { name: "Retry" })).toBeHidden();
    await expect(page.getByRole("button", { name: "Choose the file again" })).toBeVisible();
    // Kept open on the server: nothing deleted, still pending, part 1 in.
    expect((await readUploadMeta(id))?.pending_upload_id).toBeTruthy();
    expect((await serverRequests(id)).filter((line) => line.includes("DELETE"))).toEqual([]);

    // Every status line shown from here on (the 1 MiB that is left can be
    // sent before a locator would see the first one).
    await page.evaluate(() => {
      const notes: string[] = [];
      (window as unknown as { __notes: string[] }).__notes = notes;
      const note = document.getElementById("up-note")!;
      new MutationObserver((records) => {
        for (const record of records) {
          for (const node of record.addedNodes) notes.push(node.textContent ?? "");
        }
      }).observe(note, { childList: true });
    });
    const chooser = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "Choose the file again" }).click();
    await (await chooser).setFiles(file.path);
    const url = await shareLink(page, 60_000);

    const notes = await page.evaluate(() => (window as unknown as { __notes: string[] }).__notes);
    expect(notes).toContain("Continuing where it stopped…");
    expect(url).toContain(`/${id}/`);
    expect(creates).toHaveLength(1);
    const puts = (await serverRequests(id)).filter((line) => line.includes("PUT"));
    // Part 1 once (not again), part 2 once (the aborted attempt never arrived).
    expect(puts.filter((line) => line.includes("/parts/1 "))).toHaveLength(1);
    expect(puts.filter((line) => line.includes("/parts/2 "))).toHaveLength(1);
    expect(await downloadSha256(url)).toEqual({ sha256: file.sha256, size: file.size });
  });

  test("another file starts a new upload and deletes the old one", async ({ page, tmp }) => {
    const lost = await randomFile(tmp, 10 * KiB, "first.bin");
    const other = await randomFile(tmp, 12 * KiB, "second.bin");
    await logIn(page);
    const oldId = await loseFileAt(page, lost.path, 1);
    await expect(page.locator("#error-message")).toHaveText(LOST);

    const created = createdId(page);
    const chooser = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "Choose the file again" }).click();
    await (await chooser).setFiles(other.path);
    const newId = await created;
    const url = await shareLink(page);

    expect(newId).not.toBe(oldId);
    expect(url).toContain(`/${newId}/second.bin`);
    expect(await downloadSha256(url)).toEqual({ sha256: other.sha256, size: other.size });
    await expectGone(oldId);
  });

  test("the same name with another size or date is another file", async ({ page, tmp }) => {
    const lost = await randomFile(tmp, 10 * KiB, "same name.bin");
    await logIn(page);
    const oldId = await loseFileAt(page, lost.path, 1);
    // Overwritten in the meantime: same name, new content and date.
    const changed = await randomFile(tmp, 11 * KiB, "same name.bin");

    const created = createdId(page);
    await page.locator("#file-input").setInputFiles(changed.path);
    const newId = await created;
    const url = await shareLink(page);
    expect(newId).not.toBe(oldId);
    expect(await downloadSha256(url)).toEqual({ sha256: changed.sha256, size: changed.size });
    await expectGone(oldId);
  });

  test("leaving the page then deletes nothing (the cleanup removes it after 24 hours)", async ({
    page,
    tmp,
  }) => {
    const lost = await randomFile(tmp, 10 * KiB, "left behind.bin");
    await logIn(page);
    const id = await loseFileAt(page, lost.path, 1);
    await page.goto("/");
    await sleep(1000);
    expect((await serverRequests(id)).filter((line) => line.includes("DELETE"))).toEqual([]);
    expect((await readUploadMeta(id))?.pending_upload_id).toBeTruthy();
    expect((await deleteUpload(id)).status).toBe(200);
  });

  test("Cancel upload gives up and deletes it", async ({ page, tmp }) => {
    const lost = await randomFile(tmp, 10 * KiB, "give up.bin");
    await logIn(page);
    const id = await loseFileAt(page, lost.path, 1);
    await page.getByRole("button", { name: "Cancel upload" }).click();
    await expect(page.locator("#idle-note")).toHaveText("Upload cancelled.");
    await expect(page.getByRole("button", { name: "Choose file" })).toBeVisible();
    await expectGone(id);
  });
});
