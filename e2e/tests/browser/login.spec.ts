import type { Page, Response } from "@playwright/test";
import { expect, server, test, uploadViaApi } from "../../lib/index.js";

async function logIn(page: Page, token = server.token): Promise<void> {
  await page.goto("/upload");
  await page.getByLabel("Upload token").fill(token);
  await Promise.all([
    page.waitForURL("**/upload"),
    page.waitForResponse((res) => res.url().endsWith("/login")),
    page.getByRole("button", { name: "Log in" }).click(),
  ]);
}

test.describe("upload page login", () => {
  test("log in with the token, get a session cookie, log out again", async ({ page, context }) => {
    await logIn(page);
    await expect(page.getByRole("button", { name: "Log out" })).toBeVisible();
    await expect(page.getByLabel("Upload token")).toHaveCount(0);

    const cookies = await context.cookies();
    expect(cookies).toHaveLength(1);
    const [session] = cookies;
    expect(session).toMatchObject({
      name: "yeet_session",
      path: "/",
      httpOnly: true,
      secure: false,
      sameSite: "Strict",
    });
    const ninetyDays = Date.now() / 1000 + 90 * 24 * 3600;
    expect(Math.abs(session!.expires - ninetyDays)).toBeLessThan(60);
    // HttpOnly: invisible to scripts.
    expect(await page.evaluate(() => document.cookie)).toBe("");

    // Still logged in after a reload.
    await page.reload();
    await expect(page.getByRole("button", { name: "Log out" })).toBeVisible();

    await Promise.all([
      page.waitForURL("**/upload"),
      page.getByRole("button", { name: "Log out" }).click(),
    ]);
    await expect(page.getByLabel("Upload token")).toBeVisible();
    expect(await context.cookies()).toHaveLength(0);
  });

  test("a wrong token shows a message and sets no cookie", async ({ page, context }) => {
    await page.goto("/upload");
    await page.getByLabel("Upload token").fill("this is not the token");
    const [res] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith("/login")),
      page.getByRole("button", { name: "Log in" }).click(),
    ]);
    expect(res.status()).toBe(401);
    await expect(page.locator(".error")).toHaveText("That token is not correct.");
    expect(await context.cookies()).toHaveLength(0);
  });

  test("a pasted token with surrounding whitespace logs in", async ({ page }) => {
    await logIn(page, ` ${server.token}  `);
    await expect(page.getByRole("button", { name: "Log out" })).toBeVisible();
  });

  test("the page's own fetch() calls use the session for the whole API", async ({ page }) => {
    await logIn(page);
    const result = await page.evaluate(async () => {
      const statuses: Record<string, number> = {};
      const json = { "Content-Type": "application/json" };
      const me = await fetch("/api/me");
      statuses.me = me.status;
      const created = await fetch("/api/uploads", {
        method: "POST",
        headers: json,
        body: JSON.stringify({ filename: "browser.txt", expires_in: 3600 }),
      });
      statuses.create = created.status;
      const { id } = await created.json();
      const part = await fetch(`/api/uploads/${id}/parts/1`, {
        method: "PUT",
        body: new Blob(["hello from the browser"]),
      });
      statuses.part = part.status;
      const complete = await fetch(`/api/uploads/${id}/complete`, {
        method: "POST",
        headers: json,
        body: JSON.stringify({ parts: [await part.json()] }),
      });
      statuses.complete = complete.status;
      // Every page of the listing (round 1I: one page per request; the
      // shared test bucket may hold the new upload on any of them).
      let listed: { file_size: number } | undefined;
      let cursor: string | null = null;
      for (let page = 0; page < 100 && !listed; page++) {
        const list = await fetch(
          cursor === null ? "/api/uploads" : `/api/uploads?cursor=${encodeURIComponent(cursor)}`,
        );
        statuses.list = Math.max(statuses.list ?? 0, list.status);
        const body = (await list.json()) as {
          uploads: { id: string; file_size: number }[];
          cursor: string | null;
        };
        listed = body.uploads.find((u) => u.id === id);
        if (body.cursor === null) break;
        cursor = body.cursor;
      }
      const removed = await fetch(`/api/uploads/${id}`, { method: "DELETE" });
      statuses.delete = removed.status;
      return { statuses, size: listed?.file_size };
    });
    expect(result.statuses).toEqual({
      me: 200,
      create: 201,
      part: 200,
      complete: 200,
      list: 200,
      delete: 200,
    });
    expect(result.size).toBe("hello from the browser".length);
  });

  test("the upload token appears in no response, cookie or storage", async ({ page, context }) => {
    const responses: Response[] = [];
    page.on("response", (res) => responses.push(res));

    await logIn(page);
    await page.evaluate(() => fetch("/api/me").then((r) => r.text()));
    await page.reload();

    const leaks: string[] = [];
    for (const res of responses) {
      const headers = JSON.stringify(await res.allHeaders());
      let body = "";
      try {
        body = (await res.body()).toString("utf-8");
      } catch {
        // redirects have no body
      }
      if (headers.includes(server.token) || body.includes(server.token)) leaks.push(res.url());
    }
    expect(responses.length).toBeGreaterThan(3);
    expect(leaks).toEqual([]);
    const cookies = JSON.stringify(await context.cookies());
    expect(cookies.includes(server.token)).toBe(false);
    const storage = await page.evaluate(() =>
      JSON.stringify({ ...localStorage, ...sessionStorage }),
    );
    expect(storage.includes(server.token)).toBe(false);
  });
});

test.describe("download pass", () => {
  test("after one correct password the page no longer asks for it", async ({ page, context }) => {
    const password = "open sesame";
    const { url } = await uploadViaApi({
      filename: "passed.txt",
      data: Buffer.from("pass me"),
      password,
    });
    const other = await uploadViaApi({
      filename: "other.txt",
      data: Buffer.from("not me"),
      password,
    });

    await page.goto(url);
    await page.getByLabel("Password required").fill(password);
    const [first] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("button", { name: "Download" }).click(),
    ]);
    expect(await first.failure()).toBeNull();

    const pass = (await context.cookies()).find((c) => c.name.startsWith("yeet_dl_"));
    expect(pass).toMatchObject({ httpOnly: true, sameSite: "Lax", secure: false });

    await page.goto(url);
    await expect(page.getByLabel("Password required")).toHaveCount(0);
    const [second] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("button", { name: "Download" }).click(),
    ]);
    expect(await second.failure()).toBeNull();

    // Another upload with the same password is not unlocked.
    await page.goto(other.url);
    await expect(page.getByLabel("Password required")).toBeVisible();
  });
});
