// The browser upload page (/upload): log in with the form, upload one file,
// copy the link. The upload runs in a Web Worker; Playwright's page.route()
// and page "request" events do see that worker's requests in all three
// engines (Playwright 1.63), which is how the failure tests inject errors.

import type { Page, Request, Route } from "@playwright/test";
import {
  deleteUpload,
  downloadSha256,
  dropFile,
  eventually,
  expect,
  fileWith,
  instrumentUploadPage,
  KiB,
  listUploads,
  logIn,
  MiB,
  pageStats,
  randomFile,
  readUploadMeta,
  resetStats,
  serverLog,
  shareLink,
  sleep,
  test,
  uploadObjects,
} from "../../lib/index.js";

type Via = "input" | "drop";

async function choose(page: Page, via: Via, path: string): Promise<void> {
  if (via === "input") await page.locator("#file-input").setInputFiles(path);
  else await dropFile(page, path);
}

/** Resolves with the ID of the next upload the page creates. */
function createdId(page: Page): Promise<string> {
  return page
    .waitForResponse(
      (res) => res.request().method() === "POST" && new URL(res.url()).pathname === "/api/uploads",
    )
    .then(async (res) => ((await res.json()) as { id: string }).id);
}

/**
 * Resolves with the JSON body of the page's next `POST /api/uploads`. The
 * page must always send `size`: without it, `complete` refuses uploads of
 * more than MAX_UNSIZED_PARTS parts (round 1K).
 */
function createBody(page: Page): Promise<Record<string, unknown>> {
  return page
    .waitForRequest(
      (req) => req.method() === "POST" && new URL(req.url()).pathname === "/api/uploads",
    )
    .then((req) => req.postDataJSON() as Record<string, unknown>);
}

function isPart(request: Request, n?: number): boolean {
  const match = new URL(request.url()).pathname.match(/^\/api\/uploads\/[^/]+\/parts\/(\d+)$/);
  return request.method() === "PUT" && !!match && (n === undefined || Number(match[1]) === n);
}

/** PUT lines for this upload in wrangler's log (requests that reached the server). */
async function partRequests(id: string): Promise<string[]> {
  return (await serverLog())
    .split("\n")
    .filter((line) => line.includes(`PUT /api/uploads/${id}/parts/`));
}

/** Nothing left of an upload: no objects (file or pending sidecar) and not listed. */
async function expectGone(id: string): Promise<void> {
  await eventually(async () => (await uploadObjects(id)).length === 0, {
    message: `uploads/${id}/ to be empty`,
  });
  expect((await listUploads()).map((upload) => upload.id)).not.toContain(id);
}

/**
 * Hold matching part requests (never answered) until the test ends. Only part
 * URLs are routed, so the DELETE a cancel sends is not touched by Playwright.
 */
async function hold(page: Page, match: (request: Request) => boolean): Promise<Route[]> {
  const held: Route[] = [];
  await page.route("**/api/uploads/*/parts/*", (route) => {
    if (match(route.request())) held.push(route);
    else return route.fallback();
  });
  return held;
}

test.describe("upload page", () => {
  test.afterEach(async ({ page }) => {
    await page.unrouteAll({ behavior: "ignoreErrors" });
  });

  for (const via of ["input", "drop"] as const) {
    test(`a small file via ${via === "input" ? "Choose file" : "drag and drop"}`, async ({
      page,
      tmp,
    }) => {
      const file = await randomFile(tmp, 300 * KiB, `small ${via}.bin`);
      await instrumentUploadPage(page);
      await logIn(page);
      const id = createdId(page);
      const body = createBody(page);
      await choose(page, via, file.path);

      const url = await shareLink(page);
      expect(url).toMatch(new RegExp(`/${await id}/small%20${via}\\.bin$`));
      expect(await body).toMatchObject({ size: file.size });
      await expect(page.locator("#done-name")).toHaveText(file.name);
      expect((await pageStats(page)).progress.at(-1)).toBe(100);

      const downloaded = await downloadSha256(url);
      expect(downloaded).toEqual({ sha256: file.sha256, size: file.size });
      // Default lifetime: 30 days.
      const meta = await readUploadMeta(await id);
      const days = (Date.parse(meta!.expires_at) - Date.parse(meta!.uploaded_at)) / 86_400_000;
      expect(days).toBeCloseTo(30, 3);
    });

    test(
      `a 120 MB file in 3 parts via ${via === "input" ? "Choose file" : "drag and drop"}`,
      { tag: "@slow" },
      async ({ page, tmp, browserName }, testInfo) => {
        test.setTimeout(180_000);
        const file = await randomFile(tmp, 120 * MiB, `big ${via}.bin`);
        await instrumentUploadPage(page);
        await logIn(page);
        const id = createdId(page);
        await choose(page, via, file.path);
        await expect(page.locator("#state-uploading")).toBeVisible();
        await resetStats(page); // lag from here on: the upload, not the file picking
        const started = Date.now();

        const url = await shareLink(page, 120_000);
        const seconds = (Date.now() - started) / 1000;
        const stats = await pageStats(page);
        expect(stats.progress.at(-1)).toBe(100);
        // Part boundaries are at 41.7%, 83.3% and 100%; values in between can
        // only come from XHR upload.onprogress with the Blob bodies.
        const boundaries = [0, (50 / 120) * 100, (100 / 120) * 100, 100];
        const between = stats.progress.filter((v) =>
          boundaries.every((b) => Math.abs(v - b) > 0.5),
        );
        expect(between.length, `progress values ${stats.progress.join(", ")}`).toBeGreaterThan(0);

        const report =
          `${browserName} ${via}: 120 MiB in ${seconds.toFixed(1)} s, main-thread max lag ` +
          `${stats.maxLagMs.toFixed(0)} ms over ${stats.lagSamples} ticks of 10 ms, ` +
          `${stats.progress.length} progress updates (${between.length} mid-part)`;
        console.log(report);
        testInfo.annotations.push({ type: "measurement", description: report });

        expect(await partRequests(await id)).toHaveLength(3);
        const downloaded = await downloadSha256(url);
        expect(downloaded).toEqual({ sha256: file.sha256, size: file.size });
      },
    );
  }

  test("an empty file uploads and downloads as 0 bytes", async ({ page, tmp }) => {
    const file = await fileWith(tmp, "empty.txt", "");
    await logIn(page);
    const body = createBody(page);
    await choose(page, "input", file.path);
    const url = await shareLink(page);
    // size 0 is sent, not left out.
    expect(await body).toMatchObject({ size: 0 });
    expect(await downloadSha256(url)).toEqual({ sha256: file.sha256, size: 0 });
  });

  test("Copy link puts the link on the clipboard", async ({ page, context, tmp, browserName }) => {
    if (browserName === "chromium") {
      await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    }
    const file = await randomFile(tmp, 10 * KiB, "copy me.bin");
    await logIn(page);
    await choose(page, "input", file.path);
    const url = await shareLink(page);

    await page.getByRole("button", { name: "Copy link" }).click();
    await expect(page.locator("#copy-note")).toHaveText("Link copied.");
    if (browserName === "webkit") {
      // Playwright's WebKit refuses clipboard.readText(); paste it instead.
      await page.evaluate(() => {
        const area = document.createElement("textarea");
        area.id = "e2e-paste";
        document.body.append(area);
      });
      await page.locator("#e2e-paste").focus();
      await page.keyboard.press("Meta+V");
      await expect(page.locator("#e2e-paste")).toHaveValue(url);
    } else {
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(url);
    }
  });

  test("Copy link without the Clipboard API selects the link instead", async ({ page, tmp }) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "clipboard", {
        value: { writeText: () => Promise.reject(new Error("denied")) },
      });
    });
    const file = await randomFile(tmp, 10 * KiB, "fallback.bin");
    await logIn(page);
    await choose(page, "input", file.path);
    const url = await shareLink(page);

    await page.getByRole("button", { name: "Copy link" }).click();
    await expect(page.locator("#copy-note")).toHaveText(
      /^(Link copied\.|Press Ctrl\+C \(⌘C on a Mac\) to copy the selected link\.)$/,
    );
    const selection = await page.locator("#link").evaluate((input: HTMLInputElement) => ({
      focused: document.activeElement === input,
      selected: input.value.slice(input.selectionStart ?? 0, input.selectionEnd ?? 0),
    }));
    expect(selection).toEqual({ focused: true, selected: url });
  });

  test("Cancel mid-upload stops it and deletes the upload", async ({ page, tmp }) => {
    const file = await randomFile(tmp, 300 * KiB, "cancel me.bin");
    await logIn(page);
    const held = await hold(page, (request) => isPart(request));
    const created = createdId(page);
    await choose(page, "input", file.path);
    const id = await created;
    await eventually(() => held.length > 0, { message: "a part request" });

    const deleted = page.waitForResponse(
      (res) => res.request().method() === "DELETE" && res.url().endsWith(`/api/uploads/${id}`),
    );
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(page.locator("#idle-note")).toHaveText("Upload cancelled.");
    await expect(page.getByRole("button", { name: "Choose file" })).toBeVisible();
    expect((await deleted).status()).toBe(200);
    await expectGone(id);
    expect(await serverLog()).not.toContain(`/api/uploads/${id}/complete`);
  });

  // No page.route() here: with any route active, Playwright's WebKit cancels
  // the keepalive DELETE sent from pagehide (it never reaches the server),
  // while without interception it arrives. So the upload is kept "in flight"
  // by its size instead, and the test leaves as soon as the first part starts.
  test(
    "leaving the page mid-upload deletes the upload",
    { tag: "@slow" },
    async ({ page, tmp }) => {
      test.setTimeout(120_000);
      const file = await randomFile(tmp, 120 * MiB, "leave me.bin");
      await logIn(page);
      const created = createdId(page);
      const firstPart = page.waitForRequest((request) => isPart(request));
      await choose(page, "input", file.path);
      const id = await created;
      await firstPart;

      // The page asks before leaving mid-upload; leave anyway.
      page.once("dialog", (dialog) => void dialog.accept());
      await page.goto("/");
      await expectGone(id);
      expect(await serverLog()).not.toContain(`/api/uploads/${id}/complete`);
    },
  );

  // Once `complete` is sent the upload may already be finished on the
  // server: a cleanup DELETE then would destroy it (round 2C).
  test("once complete is sent, neither Cancel nor leaving the page deletes the upload", async ({
    page,
    context,
    tmp,
  }) => {
    const file = await randomFile(tmp, 10 * KiB, "completing.bin");
    await logIn(page);
    const deletes: string[] = [];
    context.on("request", (request) => {
      if (request.method() === "DELETE") deletes.push(request.url());
    });
    const held: Route[] = [];
    await page.route("**/api/uploads/*/complete", (route) => void held.push(route));
    const created = createdId(page);
    await choose(page, "input", file.path);
    const id = await created;
    await eventually(() => held.length > 0, { message: "the complete request" });

    await expect(page.locator("#up-note")).toHaveText("Finishing…");
    await expect.soft(page.getByRole("button", { name: "Cancel" })).toBeHidden({ timeout: 2000 });
    page.once("dialog", (dialog) => void dialog.accept());
    await page.goto("/");
    await sleep(1500);
    expect.soft(deletes).toEqual([]);
    expect(await serverLog()).not.toContain(`DELETE /api/uploads/${id}`);
    // The complete never reached the server: clean up the pending upload.
    expect((await deleteUpload(id)).status).toBe(200);
  });

  test("a complete whose answer is lost is sent again and still shows the link", async ({
    page,
    tmp,
  }) => {
    const file = await randomFile(tmp, 10 * KiB, "answer lost.bin");
    await logIn(page);
    let completes = 0;
    await page.route("**/api/uploads/*/complete", async (route) => {
      if (completes++ > 0) return route.fallback();
      // The server completes the upload, but its answer never arrives.
      const response = await route.fetch();
      await response.body();
      return route.abort("connectionreset");
    });
    await choose(page, "input", file.path);
    const url = await shareLink(page);
    expect(completes).toBe(2);
    expect(await downloadSha256(url)).toEqual({ sha256: file.sha256, size: file.size });
  });

  test("a part that fails once (network error) is sent again", async ({ page, tmp }) => {
    const file = await randomFile(tmp, 300 * KiB, "retry network.bin");
    await logIn(page);
    let failures = 0;
    await page.route("**/api/uploads/**", (route) => {
      if (isPart(route.request()) && failures++ === 0) return route.abort("connectionreset");
      return route.fallback();
    });
    const id = createdId(page);
    await choose(page, "input", file.path);

    const url = await shareLink(page);
    expect(failures).toBe(2);
    expect(await partRequests(await id)).toHaveLength(1); // the aborted one never arrived
    expect(await downloadSha256(url)).toEqual({ sha256: file.sha256, size: file.size });
  });

  test("a 503 with Retry-After is retried after that delay", async ({ page, tmp }) => {
    const file = await randomFile(tmp, 300 * KiB, "retry 503.bin");
    await logIn(page);
    const attempts: number[] = [];
    await page.route("**/api/uploads/**", (route) => {
      if (!isPart(route.request())) return route.fallback();
      attempts.push(Date.now());
      if (attempts.length === 1) {
        return route.fulfill({
          status: 503,
          headers: { "Retry-After": "2" },
          json: { error: "Busy" },
        });
      }
      return route.fallback();
    });
    await choose(page, "input", file.path);

    const url = await shareLink(page);
    expect(attempts).toHaveLength(2);
    expect(attempts[1]! - attempts[0]!).toBeGreaterThanOrEqual(1900);
    expect(await downloadSha256(url)).toEqual({ sha256: file.sha256, size: file.size });
  });

  test(
    "a 120 MB upload whose second part fails once is still correct",
    { tag: "@slow" },
    async ({ page, tmp }) => {
      test.setTimeout(180_000);
      const file = await randomFile(tmp, 120 * MiB, "retry big.bin");
      await logIn(page);
      let failed = false;
      await page.route("**/api/uploads/**", (route) => {
        if (isPart(route.request(), 2) && !failed) {
          failed = true;
          return route.abort("connectionreset");
        }
        return route.fallback();
      });
      const id = createdId(page);
      await choose(page, "input", file.path);

      const url = await shareLink(page, 120_000);
      expect(failed).toBe(true);
      expect(await partRequests(await id)).toHaveLength(3);
      expect(await downloadSha256(url)).toEqual({ sha256: file.sha256, size: file.size });
    },
  );

  test("a server error that persists shows a readable message, not a stack trace", async ({
    page,
    tmp,
  }) => {
    test.setTimeout(60_000);
    const file = await randomFile(tmp, 50 * KiB, "always 500.bin");
    await logIn(page);
    let attempts = 0;
    await page.route("**/api/uploads/**", (route) => {
      if (!isPart(route.request())) return route.fallback();
      attempts++;
      return route.fulfill({ status: 500, json: { error: "Internal server error" } });
    });
    const id = createdId(page);
    await choose(page, "input", file.path);

    const message = page.locator("#error-message");
    await expect(message).toHaveText(
      "Something went wrong on the server. Please try again in a moment. (Error 500: Internal server error)",
      { timeout: 30_000 },
    );
    expect(attempts).toBe(4);
    await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
    await expectGone(await id);
  });

  test("a refused part (413) fails at once with the server's reason", async ({ page, tmp }) => {
    const file = await randomFile(tmp, 50 * KiB, "too big.bin");
    await logIn(page);
    let attempts = 0;
    await page.route("**/api/uploads/**", (route) => {
      if (!isPart(route.request())) return route.fallback();
      attempts++;
      return route.fulfill({ status: 413, json: { error: "Part larger than part_size" } });
    });
    const id = createdId(page);
    await choose(page, "input", file.path);

    const message = page.locator("#error-message");
    await expect(message).toHaveText(
      "The server refused this file. (Error 413: Part larger than part_size)",
    );
    // No "at foo.js:1:2" or "fn@http://…" frames.
    expect(await message.textContent()).not.toMatch(/@|\.js:\d|\bat\s+\w+\s*\(/);
    expect(attempts).toBe(1);
    await expectGone(await id);
  });

  // An error page that is not ours (an HTML 500 with a stack, Cloudflare's
  // own 413): only the plain-language message and the status are shown.
  const HTML_500 =
    "<!DOCTYPE html><html><head><title>500 Internal Server Error</title></head><body>" +
    "<h1>Internal Server Error</h1><pre>TypeError: Cannot read properties of undefined\n" +
    "    at handlePart (worker.js:123:45)\n    at async dispatch (index.js:9:1)</pre></body></html>";
  const HTML_413 =
    "<html><head><title>413 Request Entity Too Large</title></head><body><center>" +
    "<h1>413 Request Entity Too Large</h1></center><hr><center>cloudflare</center></body></html>";
  for (const [status, body, expected] of [
    [
      500,
      HTML_500,
      "Something went wrong on the server. Please try again in a moment. (Error 500)",
    ],
    [413, HTML_413, "The server refused this file. (Error 413)"],
  ] as const) {
    test(`an HTML ${status} page is not shown, only a readable message`, async ({ page, tmp }) => {
      test.setTimeout(60_000);
      const file = await randomFile(tmp, 50 * KiB, `html ${status}.bin`);
      await logIn(page);
      await page.route("**/api/uploads/**", (route) =>
        isPart(route.request())
          ? route.fulfill({ status, contentType: "text/html", body })
          : route.fallback(),
      );
      const id = createdId(page);
      await choose(page, "input", file.path);

      const message = page.locator("#error-message");
      await expect(message).toHaveText(expected, { timeout: 30_000 });
      const text = (await page.locator("body").innerText()).toLowerCase();
      for (const leak of ["<", "html", "typeerror", "worker.js", "cloudflare", "entity"]) {
        expect(text, `page text contains "${leak}"`).not.toContain(leak);
      }
      await expectGone(await id);
    });
  }

  test("an expired session mid-upload asks to log in again", async ({ page, context, tmp }) => {
    const file = await randomFile(tmp, 300 * KiB, "expired.bin");
    await logIn(page);
    // Let the upload be created, then lose the session before the first part.
    await page.route("**/api/uploads", async (route) => {
      const response = await route.fetch();
      await context.clearCookies();
      await route.fulfill({ response });
    });
    const id = createdId(page);
    await choose(page, "input", file.path);

    await expect(page.locator("#error-message")).toHaveText(
      "Your login has expired. Log in again, then upload the file again.",
    );
    await expect(page.getByRole("button", { name: "Retry" })).toBeHidden();
    await page.getByRole("link", { name: "Log in again" }).click();
    await expect(page.locator('input[name="token"]')).toBeVisible();
    // The worker's DELETE had no session either; clean up with the token.
    expect((await deleteUpload(await id)).status).toBe(200);
  });

  test("Retry after a failure uploads the same file again", async ({ page, tmp }) => {
    const file = await randomFile(tmp, 50 * KiB, "retry button.bin");
    await logIn(page);
    await page.route("**/api/uploads/**", (route) =>
      isPart(route.request())
        ? route.fulfill({ status: 413, json: { error: "Part larger than part_size" } })
        : route.fallback(),
    );
    await choose(page, "input", file.path);
    await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();

    await page.unrouteAll();
    await page.getByRole("button", { name: "Retry" }).click();
    const url = await shareLink(page);
    expect(await downloadSha256(url)).toEqual({ sha256: file.sha256, size: file.size });
  });

  // One Web Worker per upload, terminated once the upload has ended, however
  // it ended: no worker (and the File it holds) outlives its upload.
  test.describe("the upload's Web Worker is terminated", () => {
    /** Resolves when the next worker the page starts has been terminated. */
    function nextWorkerClosed(page: Page): Promise<void> {
      return new Promise((resolve) => {
        page.once("worker", (worker) => worker.once("close", () => resolve()));
      });
    }

    async function expectNoWorkers(page: Page, closed: Promise<void>): Promise<void> {
      await Promise.race([
        closed,
        sleep(5000).then(() => {
          throw new Error(`the upload's worker is still running (${page.workers().length} live)`);
        }),
      ]);
      expect(page.workers()).toHaveLength(0);
    }

    test("after success", async ({ page, tmp }) => {
      const file = await randomFile(tmp, 10 * KiB, "worker done.bin");
      await logIn(page);
      expect(page.workers()).toHaveLength(0);
      const closed = nextWorkerClosed(page);
      await choose(page, "input", file.path);
      await shareLink(page);
      await expectNoWorkers(page, closed);
    });

    test("after a failure", async ({ page, tmp }) => {
      const file = await randomFile(tmp, 10 * KiB, "worker failed.bin");
      await logIn(page);
      await page.route("**/api/uploads/**", (route) =>
        isPart(route.request())
          ? route.fulfill({ status: 413, json: { error: "Part larger than part_size" } })
          : route.fallback(),
      );
      const closed = nextWorkerClosed(page);
      await choose(page, "input", file.path);
      await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
      await expectNoWorkers(page, closed);
    });

    test("after Cancel", async ({ page, tmp }) => {
      const file = await randomFile(tmp, 300 * KiB, "worker cancelled.bin");
      await logIn(page);
      const held = await hold(page, (request) => isPart(request));
      const closed = nextWorkerClosed(page);
      await choose(page, "input", file.path);
      await eventually(() => held.length > 0, { message: "a part request" });
      await page.getByRole("button", { name: "Cancel" }).click();
      await expect(page.locator("#idle-note")).toHaveText("Upload cancelled.");
      // Terminated once its delete is done, well before the 10 s fallback.
      await expectNoWorkers(page, closed);
    });
  });

  test("Log out ends the session", async ({ page }) => {
    await logIn(page);
    await page.getByRole("button", { name: "Log out" }).click();
    await expect(page.locator('input[name="token"]')).toBeVisible();
    await page.goto("/upload");
    await expect(page.locator('input[name="token"]')).toBeVisible();
  });
});
