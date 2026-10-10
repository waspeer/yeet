// Verifier of round 2D: the stored-zip resume after a time zone change.
// upload-zip.spec.ts tests a zip of one file whose offset moves by an hour;
// a check that compared only the first entry's offset passed it. Here the
// zone changes for summer dates only (as moving from Amsterdam to a zone
// without summer time would): the first entry, from January, keeps its
// offset, the second, from July, does not. The zip made again would get
// another DOS date for the second entry, so it must start over too.
//
// As there, the page's zone is changed by replacing getTimezoneOffset() on
// the page (no engine lets a test change the zone of a running page); what
// is tested is the decision to start over.

import { mkdir, rename, utimes } from "node:fs/promises";
import { join } from "node:path";
import type { Request, Route } from "@playwright/test";
import {
  eventually,
  expect,
  KiB,
  listUploads,
  logIn,
  randomFile,
  setFolder,
  shareLink,
  test,
  uploadObjects,
} from "../../lib/index.js";

function isPart(request: Request, n: number): boolean {
  const match = new URL(request.url()).pathname.match(/^\/api\/uploads\/[^/]+\/parts\/(\d+)$/);
  return request.method() === "PUT" && !!match && Number(match[1]) === n;
}

test("a stored zip starts over when only a later entry's zone offset changed", async ({
  page,
  tmp,
}) => {
  const root = join(tmp, "Seasons");
  await mkdir(root);
  const winter = await randomFile(root, 20 * KiB, "a-winter.mp3");
  const summer = await randomFile(root, 20 * KiB, "b-summer.mp3");
  const january = new Date("2024-01-15T12:00:00Z");
  const july = new Date("2024-07-15T12:00:00Z");
  await utimes(winter.path, january, january);
  await utimes(summer.path, july, july);

  await logIn(page);
  const held: Route[] = [];
  await page.route("**/api/uploads/*/parts/*", (route) => {
    if (isPart(route.request(), 1) && held.length === 0) held.push(route);
    else return route.fallback();
  });
  const created = page
    .waitForResponse(
      (res) => res.request().method() === "POST" && new URL(res.url()).pathname === "/api/uploads",
    )
    .then(async (res) => ((await res.json()) as { id: string }).id);
  await setFolder(page.locator("#folder-input"), root);
  const oldId = await created;
  await eventually(() => held.length > 0, { message: "part 1 in flight" });
  // The file read last goes away, so the failed part stops the upload.
  await rename(summer.path, `${summer.path}.away`);
  try {
    await held[0]!.abort("connectionreset");
    await expect(page.locator("#error-message")).toHaveText(
      /Choose the same folder again to continue where it stopped\.$/,
    );
  } finally {
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await rename(`${summer.path}.away`, summer.path);
  }

  // From now on, summer dates (April to September) are an hour further
  // west; winter dates keep their offset.
  const before = await page.evaluate(
    ([w, s]) => [new Date(w).getTimezoneOffset(), new Date(s).getTimezoneOffset()],
    [january.getTime(), july.getTime()] as const,
  );
  await page.evaluate(() => {
    const offset = Date.prototype.getTimezoneOffset;
    Date.prototype.getTimezoneOffset = function (this: Date) {
      const month = this.getUTCMonth();
      return offset.call(this) + (month >= 3 && month <= 8 ? 60 : 0);
    };
  });
  const after = await page.evaluate(
    ([w, s]) => [new Date(w).getTimezoneOffset(), new Date(s).getTimezoneOffset()],
    [january.getTime(), july.getTime()] as const,
  );
  expect(after[0]).toBe(before[0]);
  expect(after[1]).toBe(before[1]! + 60);

  const creates: string[] = [];
  page.context().on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/api/uploads") {
      creates.push(request.url());
    }
  });
  // The note may be replaced before an assertion polls it: record it.
  const notes: string[] = [];
  await page.exposeFunction("__note", (text: string) => void notes.push(text));
  await page.evaluate(() => {
    const note = document.getElementById("up-note")!;
    new MutationObserver(() => {
      (window as unknown as { __note: (t: string) => void }).__note(note.textContent ?? "");
    }).observe(note, { childList: true, characterData: true, subtree: true });
  });
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Choose the folder again" }).click();
  await setFolder(await chooser, root);
  const url = await shareLink(page);
  expect(notes).toContain("The time zone changed since the upload started, so it starts over.");
  expect(notes).not.toContain("Continuing where it stopped…");
  expect(url).not.toContain(`/${oldId}/`);
  expect(creates).toHaveLength(1);
  await eventually(async () => (await uploadObjects(oldId)).length === 0, {
    message: `uploads/${oldId}/ to be empty`,
  });
  expect((await listUploads()).map((upload) => upload.id)).not.toContain(oldId);
});

// setFolder() (lib/browser.ts, round 2D) replaces setInputFiles() for
// folders. Every test that uses it waits for something the page shows
// afterwards, so a setFolder() that returned at once passed them all. This
// pins its own promise: when it resolves, the page's change handler has run
// (it starts the upload synchronously), with no polling in between.
test("setFolder() resolves only after the page's change handler ran", async ({ page, tmp }) => {
  const root = join(tmp, "Picked");
  await mkdir(root);
  await randomFile(root, 4 * KiB, "one.mp3");
  await randomFile(root, 4 * KiB, "two.mp3");
  await logIn(page);
  // Hold the create, so the page stays in its upload state.
  const held: Route[] = [];
  await page.route("**/api/uploads", (route) => {
    if (route.request().method() === "POST") held.push(route);
    else return route.fallback();
  });
  await page.evaluate(() => {
    const input = document.getElementById("folder-input") as HTMLInputElement;
    const seen = { changes: 0, files: 0 };
    (window as unknown as { __seen: typeof seen }).__seen = seen;
    input.addEventListener("change", () => {
      seen.changes++;
      seen.files = input.files?.length ?? 0;
    });
  });
  await setFolder(page.locator("#folder-input"), root);
  const now = await page.evaluate(() => ({
    seen: (window as unknown as { __seen: { changes: number; files: number } }).__seen,
    name: document.getElementById("up-name")?.textContent,
  }));
  // The page's own listener (added first) emptied the input, so the files
  // this listener counts may be 0; that it ran, and the page's did, counts.
  expect(now.seen.changes).toBe(1);
  expect(now.name).toBe("Picked.zip");
  await page.unrouteAll({ behavior: "ignoreErrors" });
  for (const route of held) await route.abort().catch(() => {});
});
