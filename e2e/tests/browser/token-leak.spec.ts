// The UPLOAD_TOKEN must never reach the browser (docs/design/api.md): after a
// full login → upload → copy flow it occurs nowhere the page can see or send,
// except in the one login form post the person typed it into.

import type { Request } from "@playwright/test";
import { expect, KiB, logIn, randomFile, server, shareLink, test } from "../../lib/index.js";

test("the upload token never reaches the page", async ({ page, context, tmp, browserName }) => {
  if (browserName === "chromium") {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  }
  const token = server.token;
  // context-level events include the Web Worker's requests.
  const requests: Request[] = [];
  const bodies: Promise<{ url: string; text: string }>[] = [];
  context.on("request", (request) => requests.push(request));
  context.on("response", (response) => {
    const type = response.request().resourceType();
    if (["document", "script", "stylesheet", "fetch", "xhr", "other"].includes(type)) {
      bodies.push(
        response
          .text()
          .then((text) => ({ url: response.url(), text }))
          .catch(() => ({ url: response.url(), text: "" })), // redirects have no body
      );
    }
  });

  const file = await randomFile(tmp, 200 * KiB, "leak check.bin");
  await logIn(page);
  await page.locator("#file-input").setInputFiles(file.path);
  await shareLink(page);
  await page.getByRole("button", { name: "Copy link" }).click();
  await expect(page.locator("#copy-note")).toHaveText("Link copied.");

  // Everything the browser sent.
  const leaks: string[] = [];
  let loginPosts = 0;
  for (const request of requests) {
    const url = new URL(request.url());
    const headers = await request.allHeaders();
    const body = request.postDataBuffer();
    const isLogin = request.method() === "POST" && url.pathname === "/login";
    if (isLogin) {
      loginPosts++;
      expect(body?.includes(token), "the scan finds the token in the login post").toBe(true);
      continue;
    }
    const where = `${request.method()} ${url.pathname}`;
    if (request.url().includes(token)) leaks.push(`${where}: URL`);
    for (const [name, value] of Object.entries(headers)) {
      if (value.includes(token)) leaks.push(`${where}: header ${name}`);
    }
    if (body?.includes(token)) leaks.push(`${where}: body`);
  }
  expect(loginPosts).toBe(1);
  const workerParts = requests.filter((r) => r.method() === "PUT" && r.url().includes("/parts/"));
  expect(workerParts.length, "the worker's part requests were captured").toBe(1);

  // Everything the browser received: HTML and every script (page and worker).
  const received = await Promise.all(bodies);
  for (const { url, text } of received) {
    if (text.includes(token)) leaks.push(`response ${url}`);
  }
  const scripts = received.map(({ url }) => new URL(url).pathname);
  expect(scripts).toEqual(expect.arrayContaining(["/upload.js", "/upload-worker.js"]));
  if ((await page.content()).includes(token)) leaks.push("page HTML");

  // Storage the page can read.
  const storage = await page.evaluate(async () => {
    const dump = (s: Storage) =>
      Object.entries({ ...s })
        .flat()
        .join("\n");
    const databases = "databases" in indexedDB ? await indexedDB.databases() : [];
    return {
      local: dump(localStorage),
      session: dump(sessionStorage),
      indexedDB: databases.map((db) => db.name ?? "").join("\n"),
      documentCookie: document.cookie,
    };
  });
  for (const [where, value] of Object.entries(storage)) {
    if (value.includes(token)) leaks.push(where);
  }
  // HttpOnly: the session cookie is invisible to page JS.
  expect(storage.documentCookie).not.toContain("yeet_session");

  // Cookies: only the HMAC-derived session value.
  const cookies = await context.cookies();
  for (const cookie of cookies) {
    if (cookie.value.includes(token) || cookie.name.includes(token))
      leaks.push(`cookie ${cookie.name}`);
  }
  const session = cookies.find((cookie) => cookie.name === "yeet_session");
  expect(session?.value).toMatch(/^v1\.\d+\.[A-Za-z0-9_-]+$/);
  expect(session?.httpOnly).toBe(true);

  expect(leaks).toEqual([]);
});
