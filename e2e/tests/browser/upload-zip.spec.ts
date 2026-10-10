// The upload page zips several files or a folder while uploading (round
// 2C+2; packages/worker/src/upload/selection.ts decides, worker.ts zips with
// zip.ts). Every download is checked with check.py (the structural oracle,
// with per-entry SHA-256 and mtimes), Python's zipfile and `unzip -t`.
//
// Folders come from the folder picker (Playwright's setInputFiles() of a
// directory on a webkitdirectory input, in all three engines) or from a
// drop. No test can make a browser drop a real folder, so drops carry
// stand-ins for the browser's FileSystemEntry objects around real File
// objects (lib/browser.ts dropTree()); the folder picker reports no empty
// folders, a drop does.
//
// The 150-part limit for uploads of unknown size (7.86 GB) is lowered with
// the page's test hook (`window.__yeetE2E.maxUnsizedParts`), so the
// forced-store path needs 51 MiB, not 8 GB.

import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Page, Request, Route } from "@playwright/test";
import {
  deleteUploadFully,
  downloadBytes,
  downloadSha256,
  dropFiles,
  dropTree,
  eventually,
  expect,
  FILENAMES,
  fileWith,
  instrumentUploadPage,
  KiB,
  listUploads,
  logIn,
  MiB,
  pageStats,
  randomFile,
  readUploadMeta,
  serverLog,
  shareLink,
  silentWavFile,
  sleep,
  test,
  treeOf,
  uploadObjects,
  type FileFixture,
} from "../../lib/index.js";
import { worstCaseZipSize } from "../../../packages/worker/src/upload/selection.js";
import { parseZip } from "../../zip/parse.js";
import { failures, manifestOfFiles, validateZip } from "../../zip/validate.js";

const PART_SIZE = 52_428_800;

function isPart(request: Request, n?: number): boolean {
  const match = new URL(request.url()).pathname.match(/^\/api\/uploads\/[^/]+\/parts\/(\d+)$/);
  return request.method() === "PUT" && !!match && (n === undefined || Number(match[1]) === n);
}

function nextRequestBody(page: Page, suffix: string): Promise<Record<string, unknown>> {
  return page
    .waitForRequest(
      (req) => req.method() === "POST" && new URL(req.url()).pathname.endsWith(suffix),
    )
    .then((req) => req.postDataJSON() as Record<string, unknown>);
}
const createBody = (page: Page) => nextRequestBody(page, "/api/uploads");
const completeBody = (page: Page) => nextRequestBody(page, "/complete");

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

/** Lower the page's limit for uploads of unknown size (its e2e test hook). Before goto. */
async function capParts(page: Page, maxUnsizedParts: number): Promise<void> {
  await page.addInitScript((n) => {
    (window as unknown as { __yeetE2E: unknown }).__yeetE2E = { maxUnsizedParts: n };
  }, maxUnsizedParts);
}

interface Album {
  root: string;
  name: string;
  files: { rel: string; fixture: FileFixture }[];
  /** Relative paths of empty folders. */
  empty: string[];
}

/**
 * A folder of stems with awkward names (FILENAMES: unicode, spaces,
 * punctuation), nested folders, an empty folder and .DS_Store files.
 */
async function album(tmp: string, name = "Ünïcødé stems – 名前 (v2) #1"): Promise<Album> {
  const root = join(tmp, name);
  await mkdir(join(root, "drums", "deep", "er"), { recursive: true });
  await mkdir(join(root, "empty"), { recursive: true });
  const files = [
    { rel: FILENAMES.unicode, fixture: await randomFile(root, 200 * KiB, FILENAMES.unicode) },
    { rel: FILENAMES.spaces, fixture: await silentWavFile(root, 1, { name: FILENAMES.spaces }) },
    {
      rel: `drums/${FILENAMES.punctuation}`,
      fixture: await fileWith(join(root, "drums"), FILENAMES.punctuation, "la ".repeat(5000)),
    },
    {
      rel: "drums/kick.mp3",
      fixture: await randomFile(join(root, "drums"), 100 * KiB, "kick.mp3"),
    },
    {
      rel: "drums/deep/er/snare.wav",
      fixture: await silentWavFile(join(root, "drums", "deep", "er"), 1, { name: "snare.wav" }),
    },
  ];
  await writeFile(join(root, ".DS_Store"), "finder");
  await writeFile(join(root, "drums", ".DS_Store"), "finder");
  return { root, name, files, empty: ["empty"] };
}

/** Download the zip behind `url`, check it with every reader, and return its entries. */
async function checkZip(
  url: string,
  tmp: string,
  files: { path: string; source: string }[],
  dirs: { path: string; source: string }[] = [],
) {
  const bytes = await downloadBytes(url);
  const path = join(tmp, `download-${Date.now()}.zip`);
  await writeFile(path, bytes);
  const manifest = await manifestOfFiles(files, dirs);
  const results = await validateZip(path, manifest, {
    readers: ["structural", "python zipfile", "unzip -t"],
  });
  expect(failures(results)).toEqual([]);
  return { bytes, central: parseZip(bytes).central };
}

const albumFiles = (a: Album) =>
  a.files.map((f) => ({ path: `${a.name}/${f.rel}`.normalize("NFC"), source: f.fixture.path }));
const albumDirs = (a: Album) =>
  a.empty.map((rel) => ({ path: `${a.name}/${rel}/`.normalize("NFC"), source: join(a.root, rel) }));

/** Every text the "File k of n" line shows, from page load on. */
async function recordFileLines(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const lines: string[] = [];
    (window as unknown as { __fileLines: string[] }).__fileLines = lines;
    new MutationObserver((records) => {
      for (const record of records) {
        const node = record.target;
        const target = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
        if (target?.id === "up-files") lines.push(target.textContent ?? "");
      }
    }).observe(document, { subtree: true, childList: true, characterData: true });
  });
}
const fileLines = (page: Page) =>
  page.evaluate(() => (window as unknown as { __fileLines: string[] }).__fileLines);

test.describe("upload page: several files or a folder", () => {
  test.afterEach(async ({ page }) => {
    await page.unrouteAll({ behavior: "ignoreErrors" });
  });

  test("a folder via Choose folder: <folder>.zip, compressed, the size sent at complete", async ({
    page,
    tmp,
  }) => {
    const a = await album(tmp);
    await instrumentUploadPage(page);
    await recordFileLines(page);
    await logIn(page);
    await expect(page.getByRole("button", { name: "Choose folder" })).toBeVisible();
    const create = createBody(page);
    const complete = completeBody(page);
    await page.locator("#folder-input").setInputFiles(a.root);
    const url = await shareLink(page);

    await expect(page.locator("#done-name")).toHaveText(`${a.name}.zip`.normalize("NFC"));
    await expect(page.locator("#done-files")).toHaveText("5 files in one zip file.");
    expect(await create).not.toHaveProperty("size");
    expect((await create).filename).toBe(`${a.name}.zip`.normalize("NFC"));
    // The folder picker reports no empty folders.
    const { bytes, central } = await checkZip(url, tmp, albumFiles(a));
    expect((await complete).size).toBe(bytes.length);
    const methods = Object.fromEntries(central.map((e) => [e.name.split("/").pop(), e.method]));
    expect(methods).toEqual({
      [FILENAMES.unicode]: 8,
      [FILENAMES.spaces]: 8,
      [FILENAMES.punctuation]: 8,
      "kick.mp3": 0, // already compressed: stored
      "snare.wav": 8,
    });
    expect((await pageStats(page)).progress.at(-1)).toBe(100);
    const lines = await fileLines(page);
    expect(lines[0]).toBe("5 files, zipped while uploading");
    // In zip order: folder by folder, sorted.
    expect(lines.slice(1)).toEqual([
      "File 1 of 5: snare.wav",
      `File 2 of 5: ${FILENAMES.punctuation}`,
      "File 3 of 5: kick.mp3",
      `File 4 of 5: ${FILENAMES.spaces}`,
      `File 5 of 5: ${FILENAMES.unicode}`,
    ]);
  });

  test("a folder dropped: the folder's zip, .DS_Store skipped, the empty folder kept", async ({
    page,
    tmp,
  }) => {
    const a = await album(tmp);
    await logIn(page);
    const create = createBody(page);
    await dropTree(page, [await treeOf(a.root)]);
    const url = await shareLink(page);
    expect((await create).filename).toBe(`${a.name}.zip`.normalize("NFC"));
    const { central } = await checkZip(url, tmp, albumFiles(a), albumDirs(a));
    expect(central.map((e) => e.name)).not.toContainEqual(expect.stringContaining(".DS_Store"));
  });

  for (const via of ["Choose files", "drop"] as const) {
    test(`several files via ${via}: yeet-<timestamp>.zip, the files at the top level`, async ({
      page,
      tmp,
    }) => {
      const files = [
        await randomFile(tmp, 120 * KiB, FILENAMES.unicode),
        await fileWith(tmp, FILENAMES.punctuation, "text ".repeat(2000)),
        await randomFile(tmp, 3 * KiB, FILENAMES.spaces),
      ];
      await logIn(page);
      const create = createBody(page);
      if (via === "drop")
        await dropFiles(
          page,
          files.map((f) => f.path),
        );
      else await page.locator("#file-input").setInputFiles(files.map((f) => f.path));
      const url = await shareLink(page);
      const name = (await create).filename as string;
      expect(name).toMatch(/^yeet-\d{8}-\d{6}\.zip$/);
      await expect(page.locator("#done-name")).toHaveText(name);
      await checkZip(
        url,
        tmp,
        files.map((f) => ({ path: f.name.normalize("NFC"), source: f.path })),
      );
    });
  }

  test("a single dropped or picked file is still uploaded as it is", async ({ page, tmp }) => {
    const file = await randomFile(tmp, 20 * KiB, "one take.wav");
    await logIn(page);
    const create = createBody(page);
    await dropTree(page, [{ name: file.name, source: file.path }]);
    const url = await shareLink(page);
    expect(await create).toMatchObject({ filename: "one take.wav", size: file.size });
    expect(await downloadSha256(url)).toEqual({ sha256: file.sha256, size: file.size });
  });

  test("only already-compressed files: stored, the exact size sent at create", async ({
    page,
    tmp,
  }) => {
    const root = join(tmp, "Mixes");
    await mkdir(root);
    const files = [
      await randomFile(root, 300 * KiB, "mix 1.mp3"),
      await randomFile(root, 200 * KiB, "cover.JPG"),
      await fileWith(root, "empty notes.txt", ""),
    ];
    await logIn(page);
    const create = createBody(page);
    const complete = completeBody(page);
    await page.locator("#folder-input").setInputFiles(root);
    const url = await shareLink(page);
    const { bytes, central } = await checkZip(
      url,
      tmp,
      files.map((f) => ({ path: `Mixes/${f.name}`, source: f.path })),
    );
    expect((await create).size).toBe(bytes.length);
    expect((await complete).size).toBe(bytes.length);
    expect(central.map((e) => e.method)).toEqual([0, 0, 0]);
  });

  test("compressed across parts, near the (lowered) limit: the size at complete, below the worst case", async ({
    page,
    tmp,
  }) => {
    test.setTimeout(120_000);
    // 2 parts allowed (100 MiB); 60 MiB of random data deflates to a bit more.
    await capParts(page, 2);
    const root = join(tmp, "Noise");
    await mkdir(root);
    const big = await randomFile(root, 60 * MiB, "noise.bin");
    await logIn(page);
    const create = createBody(page);
    const id = createdId(page);
    await page.locator("#folder-input").setInputFiles(root);
    const url = await shareLink(page, 90_000);
    expect(await create).not.toHaveProperty("size");
    const puts = (await serverRequests(await id)).filter((line) => line.includes("PUT"));
    expect(puts).toHaveLength(2);
    const { bytes, central } = await checkZip(url, tmp, [
      { path: "Noise/noise.bin", source: big.path },
    ]);
    expect(central[0]!.method).toBe(8);
    const worst = worstCaseZipSize({
      files: [
        {
          file: undefined as unknown as File,
          path: "Noise/noise.bin",
          size: big.size,
          lastModified: 0,
          compress: true,
        },
      ],
      dirs: [],
    });
    expect(bytes.length).toBeGreaterThan(big.size);
    expect(bytes.length).toBeLessThanOrEqual(worst);
    expect(worst).toBeLessThanOrEqual(2 * PART_SIZE);
  });

  test("too large to compress safely: a warning first, then everything stored with its size", async ({
    page,
    tmp,
  }) => {
    test.setTimeout(120_000);
    await capParts(page, 1); // 52 MB
    const root = join(tmp, "Session");
    await mkdir(root);
    const take = await randomFile(root, 51 * MiB, "take 1.wav");
    const notes = await fileWith(root, "notes.txt", "bpm 120");
    await logIn(page);
    const creates = countCreates(page);
    await page.locator("#folder-input").setInputFiles(root);

    const message = page.locator("#confirm-message");
    await expect(message).toHaveText(
      "This is more than about 52 MB, so yeet uploads it without compressing it: the upload " +
        "takes longer and the download is bigger. For a smaller download, zip it yourself " +
        "first (on a Mac: right-click the folder and choose Compress) and upload that zip " +
        "file instead.",
    );
    await expect(page.locator("#confirm-name")).toHaveText("Session.zip");
    await expect(page.locator("#confirm-size")).toHaveText("2 files, 53 MB");
    await sleep(500);
    expect(creates).toEqual([]); // nothing uploaded before the choice

    // Choose again: back to the start, then the same folder once more.
    await page.getByRole("button", { name: "Choose again" }).click();
    await expect(page.getByRole("button", { name: "Choose files" })).toBeVisible();
    await page.locator("#folder-input").setInputFiles(root);
    await expect(message).toBeVisible();
    const create = createBody(page);
    await page.getByRole("button", { name: "Upload anyway" }).click();
    const url = await shareLink(page, 90_000);
    const { bytes, central } = await checkZip(url, tmp, [
      { path: "Session/notes.txt", source: notes.path },
      { path: "Session/take 1.wav", source: take.path },
    ]);
    expect((await create).size).toBe(bytes.length);
    expect(central.map((e) => e.method)).toEqual([0, 0]);
    expect(creates).toHaveLength(1);
  });

  test("as large, but nothing would compress anyway: no warning, stored with its size", async ({
    page,
    tmp,
  }) => {
    test.setTimeout(120_000);
    await capParts(page, 1);
    const root = join(tmp, "Videos");
    await mkdir(root);
    const clip = await randomFile(root, 51 * MiB, "clip.mp4");
    await logIn(page);
    const create = createBody(page);
    await page.locator("#folder-input").setInputFiles(root);
    await expect(page.locator("#state-uploading")).toBeVisible();
    await expect(page.locator("#state-confirm")).toBeHidden();
    const url = await shareLink(page, 90_000);
    const { bytes } = await checkZip(url, tmp, [{ path: "Videos/clip.mp4", source: clip.path }]);
    expect((await create).size).toBe(bytes.length);
  });

  test("nothing to upload (only .DS_Store and empty folders): a clear message, nothing created", async ({
    page,
    tmp,
  }) => {
    const root = join(tmp, "Nothing here");
    await mkdir(join(root, "empty", "deeper"), { recursive: true });
    await writeFile(join(root, ".DS_Store"), "finder");
    await logIn(page);
    const creates = countCreates(page);
    await dropTree(page, [await treeOf(root)]);
    await expect(page.locator("#idle-error")).toHaveText(
      "There is nothing to upload: no files were chosen, only empty folders (.DS_Store files are left out).",
    );
    await expect(page.getByRole("button", { name: "Choose files" })).toBeVisible();
    await sleep(500);
    expect(creates).toEqual([]);
  });

  for (const [what, tree, pair] of [
    [
      "two files whose names differ only in case",
      [
        {
          name: "Mix",
          mtime: Date.now(),
          children: [
            { name: "Kick.wav", text: "a" },
            { name: "kick.wav", text: "b" },
          ],
        },
      ],
      ["Mix/Kick.wav", "Mix/kick.wav"],
    ],
    [
      "a file and a folder whose names differ only in case",
      [
        { name: "a", text: "file" },
        { name: "A", mtime: Date.now(), children: [{ name: "x.txt", text: "x" }] },
      ],
      ["A", "a"],
    ],
  ] as const) {
    test(`a name collision (${what}) is refused before anything is uploaded`, async ({ page }) => {
      await logIn(page);
      const creates = countCreates(page);
      await dropTree(page, tree as never);
      await expect(page.locator("#idle-error")).toHaveText(
        new RegExp(
          `^“${pair[0]}” and “${pair[1]}” would have the same name in the zip .*Rename one of them and try again\\.$`,
        ),
      );
      await sleep(500);
      expect(creates).toEqual([]);
    });
  }

  test("Cancel mid-upload deletes a compressed zip and its part records", async ({ page, tmp }) => {
    test.setTimeout(90_000);
    const root = join(tmp, "Cancelled");
    await mkdir(root);
    await randomFile(root, 60 * MiB, "noise.bin");
    await logIn(page);
    const held: Route[] = [];
    await page.route("**/api/uploads/*/parts/*", (route) => {
      if (isPart(route.request(), 2)) held.push(route);
      else return route.fallback();
    });
    const id = createdId(page);
    const part1 = page.waitForResponse((res) => isPart(res.request(), 1) && res.ok());
    await page.locator("#folder-input").setInputFiles(root);
    await part1;
    await eventually(() => held.length > 0, { message: "part 2 in flight" });
    // Part 1 left its size record (an upload of unknown size).
    expect((await uploadObjects(await id)).map((o) => o.key)).toContainEqual(
      expect.stringContaining("/.parts/1"),
    );
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(page.locator("#idle-note")).toHaveText("Upload cancelled.");
    await expectGone(await id);
    expect(await serverLog()).not.toContain(`/api/uploads/${await id}/complete`);
  });

  test("once complete is sent, leaving the page deletes nothing", async ({
    page,
    context,
    tmp,
  }) => {
    const a = await album(tmp, "Finishing");
    await logIn(page);
    const deletes: string[] = [];
    context.on("request", (request) => {
      if (request.method() === "DELETE") deletes.push(request.url());
    });
    const held: Route[] = [];
    await page.route("**/api/uploads/*/complete", (route) => void held.push(route));
    const id = createdId(page);
    await page.locator("#folder-input").setInputFiles(a.root);
    await eventually(() => held.length > 0, { message: "the complete request" });
    await expect(page.locator("#up-note")).toHaveText("Finishing…");
    await expect(page.getByRole("button", { name: "Cancel" })).toBeHidden();
    page.once("dialog", (dialog) => void dialog.accept());
    await page.goto("/");
    await sleep(1500);
    expect(deletes).toEqual([]);
    expect(await serverLog()).not.toContain(`DELETE /api/uploads/${await id}`);
    // The complete never reached the server: clean up (it has part records).
    expect((await deleteUploadFully(await id)).status).toBe(200);
  });

  test("the upload's Web Worker is terminated after a zip upload", async ({ page, tmp }) => {
    const a = await album(tmp, "Worker");
    await logIn(page);
    const closed = new Promise<void>((resolve) => {
      page.once("worker", (worker) => worker.once("close", () => resolve()));
    });
    await page.locator("#folder-input").setInputFiles(a.root);
    await shareLink(page);
    await Promise.race([
      closed,
      sleep(5000).then(() => {
        throw new Error("the upload's worker is still running");
      }),
    ]);
    expect(page.workers()).toHaveLength(0);
  });
});

// Losing access to the files mid-upload (iOS revokes it when the screen
// locks), simulated as in upload-resume.spec.ts: the file being read is
// renamed away while a part is held, then that part fails.
test.describe("upload page: the browser loses access to the files of a zip", () => {
  test("a compressed zip starts over, and the old upload is deleted when the new one starts", async ({
    page,
    tmp,
  }) => {
    const root = join(tmp, "Lost stems");
    await mkdir(root);
    const a = await randomFile(root, 300 * KiB, "a.wav");
    const b = await randomFile(root, 300 * KiB, "b.wav");
    await logIn(page);
    const held: Route[] = [];
    await page.route("**/api/uploads/*/parts/*", (route) => {
      if (isPart(route.request(), 1)) held.push(route);
      else return route.fallback();
    });
    const created = createdId(page);
    await page.locator("#folder-input").setInputFiles(root);
    const oldId = await created;
    await eventually(() => held.length > 0, { message: "part 1 in flight" });
    await rename(b.path, `${b.path}.away`);
    try {
      await held[0]!.abort("connectionreset");
      await expect(page.locator("#error-message")).toHaveText(
        "The browser lost access to the folder. On an iPhone this happens when the screen " +
          "locks or you switch apps. Choose the same folder again to upload it: the upload " +
          "starts over from the beginning, because a compressed zip can't continue where it " +
          "stopped.",
      );
    } finally {
      await page.unrouteAll({ behavior: "ignoreErrors" });
      await rename(`${b.path}.away`, b.path);
    }
    // Kept until something is chosen again.
    expect((await readUploadMeta(oldId))?.pending_upload_id).toBeTruthy();
    expect((await serverRequests(oldId)).filter((line) => line.includes("DELETE"))).toEqual([]);
    await expect(page.getByRole("button", { name: "Retry" })).toBeHidden();

    const next = createdId(page);
    const chooser = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "Choose the folder again" }).click();
    await (await chooser).setFiles(root);
    const newId = await next;
    const url = await shareLink(page);
    expect(newId).not.toBe(oldId);
    await checkZip(url, tmp, [
      { path: "Lost stems/a.wav", source: a.path },
      { path: "Lost stems/b.wav", source: b.path },
    ]);
    await expectGone(oldId);
  });

  test("a stored zip continues from the first unacknowledged part", async ({ page, tmp }) => {
    test.setTimeout(120_000);
    // Stored (mp3), 60 MiB: part 1 is a.mp3 and most of b.mp3, part 2 the rest.
    const root = join(tmp, "Lost mixes");
    await mkdir(root);
    const a = await randomFile(root, 30 * MiB, "a.mp3");
    const b = await randomFile(root, 30 * MiB, "b.mp3");
    await logIn(page);
    const creates = countCreates(page);
    const held: Route[] = [];
    await page.route("**/api/uploads/*/parts/*", (route) => {
      if (isPart(route.request(), 2)) held.push(route);
      else return route.fallback();
    });
    const created = createdId(page);
    const part1 = page.waitForResponse((res) => isPart(res.request(), 1) && res.ok());
    await page.locator("#folder-input").setInputFiles(root);
    const id = await created;
    await part1;
    await eventually(() => held.length > 0, { message: "part 2 in flight" });
    await rename(b.path, `${b.path}.away`);
    try {
      await held[0]!.abort("connectionreset");
      await expect(page.locator("#error-message")).toHaveText(
        "The browser lost access to the folder. On an iPhone this happens when the screen " +
          "locks or you switch apps. Choose the same folder again to continue where it stopped.",
      );
    } finally {
      await page.unrouteAll({ behavior: "ignoreErrors" });
      await rename(`${b.path}.away`, b.path);
    }
    expect((await readUploadMeta(id))?.pending_upload_id).toBeTruthy();

    const chooser = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "Choose the folder again" }).click();
    await (await chooser).setFiles(root);
    const url = await shareLink(page, 90_000);
    expect(url).toContain(`/${id}/`);
    expect(creates).toHaveLength(1);
    const puts = (await serverRequests(id)).filter((line) => line.includes("PUT"));
    // Part 1 once (made again but not sent), part 2 once (the aborted attempt never arrived).
    expect(puts.filter((line) => line.includes("/parts/1 "))).toHaveLength(1);
    expect(puts.filter((line) => line.includes("/parts/2 "))).toHaveLength(1);
    await checkZip(url, tmp, [
      { path: "Lost mixes/a.mp3", source: a.path },
      { path: "Lost mixes/b.mp3", source: b.path },
    ]);
  });

  test("a stored zip chosen again with another file in it starts afresh", async ({ page, tmp }) => {
    const root = join(tmp, "Changed");
    await mkdir(root);
    const a = await randomFile(root, 20 * KiB, "a.mp3");
    await logIn(page);
    const held: Route[] = [];
    await page.route("**/api/uploads/*/parts/*", (route) => {
      if (isPart(route.request(), 1)) held.push(route);
      else return route.fallback();
    });
    const created = createdId(page);
    await page.locator("#folder-input").setInputFiles(root);
    const oldId = await created;
    await eventually(() => held.length > 0, { message: "part 1 in flight" });
    await rename(a.path, `${a.path}.away`);
    try {
      await held[0]!.abort("connectionreset");
      await expect(page.locator("#error-message")).toHaveText(/^The browser lost access/);
    } finally {
      await page.unrouteAll({ behavior: "ignoreErrors" });
      await rename(`${a.path}.away`, a.path);
    }
    const extra = await randomFile(root, 1 * KiB, "b.mp3");
    const next = createdId(page);
    await page.locator("#folder-input").setInputFiles(root);
    const newId = await next;
    const url = await shareLink(page);
    expect(newId).not.toBe(oldId);
    await checkZip(url, tmp, [
      { path: "Changed/a.mp3", source: a.path },
      { path: "Changed/b.mp3", source: extra.path },
    ]);
    await expectGone(oldId);
  });
});

// Round 2C+2, leftover (b) of the 2C+ verifier: a `complete` whose answer
// was lost may still be running on the server; the page waits at least
// 5 s before it sends it again (before: the backoff's 1 s).
test("a complete whose answer is lost is sent again only after 5 s", async ({ page, tmp }) => {
  const file = await randomFile(tmp, 10 * KiB, "patient.bin");
  await logIn(page);
  const at: number[] = [];
  await page.route("**/api/uploads/*/complete", async (route) => {
    at.push(Date.now());
    if (at.length > 1) return route.fallback();
    const response = await route.fetch();
    await response.body();
    return route.abort("connectionreset");
  });
  await page.locator("#file-input").setInputFiles(file.path);
  const url = await shareLink(page, 30_000);
  expect(at).toHaveLength(2);
  expect(at[1]! - at[0]!).toBeGreaterThanOrEqual(4900);
  expect(await downloadSha256(url)).toEqual({ sha256: file.sha256, size: file.size });
  await page.unrouteAll({ behavior: "ignoreErrors" });
});
