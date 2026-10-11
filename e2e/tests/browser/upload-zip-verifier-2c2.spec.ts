// Round 2C+2 verifier: gaps in upload-zip.spec.ts that mutations survived.
//
// - Names the person chose (folders, files) never reach the page as HTML:
//   the collision message and every line of the upload and done states.
// - A stored zip of exactly one part (`part_size` bytes): no empty second
//   part, no part cut a byte short.
// - The page's test hook can only lower the MAX_UNSIZED_PARTS limit (100
//   parts since round 2F), never raise it.
// - After a cancel, the DELETE is repeated while the server answers 202, at
//   most 5 times.

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Page, Request, Route } from "@playwright/test";
import {
  deleteUploadFully,
  downloadBytes,
  dropTree,
  eventually,
  expect,
  logIn,
  MiB,
  randomFile,
  serverLog,
  setFolder,
  shareLink,
  sleep,
  test,
} from "../../lib/index.js";
import { formatBytes, MAX_UNSIZED_PARTS } from "../../../packages/worker/src/upload/selection.js";
import { storedZipSize } from "../../../packages/worker/src/zip.js";
import { parseZip } from "../../zip/parse.js";

const PART_SIZE = 52_428_800;

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

/** Every POST /api/uploads the page makes from now on. */
function countCreates(page: Page): string[] {
  const creates: string[] = [];
  page.context().on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/api/uploads") {
      creates.push(request.url());
    }
  });
  return creates;
}

/** Fails the test if anything the page shows was parsed as HTML. */
async function expectNoInjectedHtml(page: Page): Promise<void> {
  expect(await page.evaluate(() => (window as unknown as { __xss?: unknown }).__xss)).toBe(
    undefined,
  );
  expect(await page.locator('img[src="x"], b.injected').count()).toBe(0);
}

const EVIL_DIR = `<img src=x onerror="window.__xss='dir'">`;
const EVIL_FILE = `<b class=injected onmouseover="window.__xss='file'">x</b>.txt`;

test.describe("verifier 2C+2: names never reach the page as HTML", () => {
  test("in the collision message", async ({ page }) => {
    await logIn(page);
    const creates = countCreates(page);
    await dropTree(page, [
      {
        name: EVIL_DIR,
        mtime: Date.now(),
        children: [
          { name: EVIL_FILE, text: "a" },
          { name: EVIL_FILE.toUpperCase(), text: "b" },
        ],
      },
    ]);
    const error = page.locator("#idle-error");
    await expect(error).toBeVisible();
    await expect(error).toContainText(`“${EVIL_DIR}/`);
    await expectNoInjectedHtml(page);
    await sleep(300);
    expect(creates).toEqual([]);
  });

  test("while uploading, when done, and on the download page", async ({ page }) => {
    await logIn(page);
    await page.route("**/api/uploads/*/complete", async (route) => {
      // Long enough to look at the uploading state.
      await sleep(500);
      return route.fallback();
    });
    await dropTree(page, [
      {
        name: EVIL_DIR,
        mtime: Date.now(),
        children: [
          { name: EVIL_FILE, text: "a" },
          { name: "second.txt", text: "b" },
        ],
      },
    ]);
    await expect(page.locator("#up-name")).toHaveText(`${EVIL_DIR}.zip`);
    // The rename note quotes the names as chosen.
    await expect(page.locator("#up-warn")).toContainText(EVIL_FILE);
    await expectNoInjectedHtml(page);
    const url = await shareLink(page);
    await expect(page.locator("#done-name")).toHaveText(`${EVIL_DIR}.zip`);
    await expectNoInjectedHtml(page);
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await page.goto(url);
    await expect(page.getByText(`${EVIL_DIR}.zip`).first()).toBeVisible();
    await expectNoInjectedHtml(page);
  });
});

test("verifier 2C+2: a stored zip of exactly part_size bytes is one part, whole", async ({
  page,
  tmp,
}) => {
  test.setTimeout(120_000);
  const root = join(tmp, "Exact");
  await mkdir(root);
  const lastModified = Date.now();
  const overhead = storedZipSize([
    { path: "Exact/a.mp3", size: 0, lastModified, compress: false },
  ])!;
  const a = await randomFile(root, PART_SIZE - overhead, "a.mp3");
  await logIn(page);
  const id = createdId(page);
  await setFolder(page.locator("#folder-input"), root);
  const url = await shareLink(page, 90_000);
  const uploadId = await id;
  const puts = (await serverLog())
    .split("\n")
    .filter((line) => line.includes(`/api/uploads/${uploadId}/parts/`));
  expect(puts).toHaveLength(1);
  const bytes = await downloadBytes(url);
  expect(bytes.length).toBe(PART_SIZE);
  const { central } = parseZip(bytes);
  expect(central.map((e) => [e.name, e.method])).toEqual([["Exact/a.mp3", 0]]);
  expect(a.size).toBe(PART_SIZE - overhead);
});

test("verifier 2C+2: the test hook cannot raise the part limit", async ({ page }) => {
  // A raised limit would let a selection whose deflate worst case exceeds
  // MAX_UNSIZED_PARTS parts (5.24 GB) be deflated with its size unknown. The
  // file is a stand-in of 7.9 GB (only its size is read before the warning).
  await page.addInitScript(() => {
    (window as unknown as { __yeetE2E: unknown }).__yeetE2E = { maxUnsizedParts: 100_000 };
  });
  await logIn(page);
  const creates = countCreates(page);
  await page.evaluate(() => {
    const file = { name: "huge.wav", size: 7_900_000_000, lastModified: Date.now(), type: "" };
    const entry = {
      isFile: false,
      isDirectory: true,
      name: "Huge",
      fullPath: "/Huge",
      createReader() {
        const batches = [
          [
            {
              isFile: true,
              isDirectory: false,
              name: "huge.wav",
              fullPath: "/Huge/huge.wav",
              file: (ok: (f: unknown) => void) => setTimeout(() => ok(file), 0),
            },
          ],
          [],
        ];
        return {
          readEntries: (ok: (e: unknown[]) => void) =>
            setTimeout(() => ok(batches.shift() ?? []), 0),
        };
      },
    };
    const data = {
      files: [],
      items: [{ kind: "file", type: "", webkitGetAsEntry: () => entry, getAsFile: () => null }],
      types: ["Files"],
      dropEffect: "none",
    };
    const target = document.getElementById("drop")!;
    for (const type of ["dragenter", "dragover", "drop"]) {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(event, "dataTransfer", { value: data });
      target.dispatchEvent(event);
    }
  });
  await expect(page.locator("#state-confirm")).toBeVisible();
  // The limit shown is the server's (100 × 52,428,800 bytes), not the hook's.
  expect(formatBytes(MAX_UNSIZED_PARTS * PART_SIZE)).toBe("5.2 GB");
  await expect(page.locator("#confirm-message")).toContainText("more than about 5.2 GB");
  await page.getByRole("button", { name: "Choose again" }).click();
  await sleep(300);
  expect(creates).toEqual([]);
});

test("verifier 2C+2: after a cancel the DELETE is repeated on 202, at most 5 times", async ({
  page,
  tmp,
}) => {
  test.setTimeout(90_000);
  const root = join(tmp, "Stubborn");
  await mkdir(root);
  await randomFile(root, 60 * MiB, "noise.wav");
  await logIn(page);
  const held: Route[] = [];
  await page.route("**/api/uploads/*/parts/*", (route) => {
    if (isPart(route.request(), 2)) held.push(route);
    else return route.fallback();
  });
  const deletes: string[] = [];
  await page.route("**/api/uploads/*", (route) => {
    if (route.request().method() !== "DELETE") return route.fallback();
    deletes.push(route.request().url());
    return route.fulfill({
      status: 202,
      contentType: "application/json",
      body: JSON.stringify({ deleted: "x", done: false }),
    });
  });
  const id = createdId(page);
  await setFolder(page.locator("#folder-input"), root);
  await eventually(() => held.length > 0, { message: "part 2 in flight", timeoutMs: 60_000 });
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.locator("#idle-note")).toHaveText("Upload cancelled.");
  // The worker grants parts in flight 6 s, then deletes.
  await eventually(() => deletes.length >= 5, { message: "5 DELETEs", timeoutMs: 20_000 });
  await sleep(2000);
  expect(deletes).toHaveLength(5);
  await page.unrouteAll({ behavior: "ignoreErrors" });
  expect((await deleteUploadFully(await id)).status).toBe(200);
});
