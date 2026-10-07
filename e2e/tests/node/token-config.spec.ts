import { createHash, createHmac, randomBytes } from "node:crypto";
import {
  api,
  cookiePair,
  expect,
  loginCookie,
  postLogin,
  putObject,
  sessionFetch,
  startServer,
  test,
  type ExtraServer,
} from "../../lib/index.js";

// These tests start their own `wrangler dev` (see e2e/lib/servers.ts), which
// takes a few seconds each.

const TOO_SHORT = "UPLOAD_TOKEN must be set and at least 16 characters long";

/** Upload through the API of `srv` and return the share link. */
async function uploadTo(
  srv: ExtraServer,
  opts: { filename: string; data: Buffer; password?: string },
): Promise<{ id: string; url: string }> {
  const init = (body: unknown) => ({
    method: "POST",
    token: srv.token,
    baseURL: srv.baseURL,
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
  const created = await api(
    "/api/uploads",
    init({ filename: opts.filename, expires_in: 3600, password: opts.password }),
  );
  expect(created.status).toBe(201);
  const { id } = await created.json();
  const part = await api(`/api/uploads/${id}/parts/1`, {
    method: "PUT",
    token: srv.token,
    baseURL: srv.baseURL,
    body: opts.data as Uint8Array<ArrayBuffer>,
  });
  expect(part.status).toBe(200);
  const done = await api(`/api/uploads/${id}/complete`, init({ parts: [await part.json()] }));
  expect(done.status).toBe(200);
  return done.json();
}

test.describe("token rotation", () => {
  test("a new UPLOAD_TOKEN invalidates sessions, download passes and download links", async () => {
    test.setTimeout(180_000);
    const oldToken = randomBytes(24).toString("base64url");
    const newToken = randomBytes(24).toString("base64url");

    const before = await startServer({ token: oldToken });
    let after: ExtraServer | undefined;
    try {
      const data = randomBytes(1024);
      const { id, url } = await uploadTo(before, {
        filename: "rotate.bin",
        data,
        password: "pw",
      });
      const path = new URL(url).pathname;

      // Everything works with the old token.
      const session = await loginCookie({ token: oldToken, baseURL: before.baseURL });
      expect((await sessionFetch("/api/me", session, { baseURL: before.baseURL })).status).toBe(
        200,
      );
      const form = await fetch(`${before.baseURL}/${id}/download`, {
        method: "POST",
        body: new URLSearchParams({ password: "pw" }),
        redirect: "manual",
      });
      expect(form.status).toBe(303);
      const pass = cookiePair(form.headers.get("set-cookie"));
      const link = new URL(form.headers.get("location")!, before.baseURL);
      expect((await fetch(link)).status).toBe(200);
      const passPage = await fetch(before.baseURL + path, { headers: { Cookie: pass } });
      expect(await passPage.text()).not.toContain('name="password"');

      // Restart on the same bucket with another token.
      await before.stop();
      after = await startServer({ token: newToken, persistDir: before.persistDir });
      const base = after.baseURL;

      // The upload itself survived, so the refusals below are about the token.
      expect((await fetch(base + path)).status).toBe(200);

      const me = await sessionFetch("/api/me", session, { baseURL: base });
      expect(me.status).toBe(401);
      expect(await me.json()).toEqual({ error: "Invalid upload token" });
      expect(await (await sessionFetch("/upload", session, { baseURL: base })).text()).toContain(
        'action="/login"',
      );
      expect((await api("/api/me", { token: oldToken, baseURL: base })).status).toBe(401);
      expect((await postLogin(oldToken, { baseURL: base })).status).toBe(401);

      const page = await fetch(base + path, { headers: { Cookie: pass } });
      expect(await page.text()).toContain('name="password"');
      const noPassword = await fetch(`${base}/${id}/download`, {
        method: "POST",
        body: new URLSearchParams(),
        headers: { Cookie: pass },
        redirect: "manual",
      });
      expect(noPassword.status).toBe(401);

      expect((await fetch(base + link.pathname + link.search)).status).toBe(403);

      // The new token works.
      const fresh = await loginCookie({ token: newToken, baseURL: base });
      expect((await sessionFetch("/api/me", fresh, { baseURL: base })).status).toBe(200);
      const again = await fetch(`${base}/${id}/download`, {
        method: "POST",
        body: new URLSearchParams({ password: "pw" }),
        redirect: "manual",
      });
      expect(again.status).toBe(303);
      const file = await fetch(new URL(again.headers.get("location")!, base));
      expect(Buffer.from(await file.arrayBuffer()).equals(data)).toBe(true);
    } finally {
      await before.stop();
      await after?.stop();
    }
  });
});

test.describe("token requirements", () => {
  test("a token shorter than 16 characters is refused everywhere it is needed", async () => {
    test.setTimeout(120_000);
    const token = "fifteen-chars!!"; // 15
    expect(token).toHaveLength(15);
    const srv = await startServer({ token });
    try {
      const base = srv.baseURL;

      for (const [method, path] of [
        ["GET", "/api/me"],
        ["GET", "/api/uploads"],
        ["POST", "/api/uploads"],
      ] as const) {
        const res = await api(path, { method, token, baseURL: base });
        expect(res.status, `${method} ${path}`).toBe(500);
        expect(await res.json()).toEqual({ error: TOO_SHORT });
      }
      // Also without any credentials: the server says what is wrong.
      expect(await (await api("/api/me", { token: null, baseURL: base })).json()).toEqual({
        error: TOO_SHORT,
      });

      const uploadPage = await fetch(`${base}/upload`);
      expect(uploadPage.status).toBe(500);
      expect(await uploadPage.text()).toContain(TOO_SHORT);

      const login = await postLogin(token, { baseURL: base });
      expect(login.status).toBe(500);
      expect(login.headers.get("set-cookie")).toBeNull();
      expect(await login.text()).toContain(TOO_SHORT);

      // Seed one open and one protected upload directly in this server's bucket.
      const meta = (filename: string, extra: Record<string, unknown> = {}) =>
        JSON.stringify({
          filename,
          file_size: 5,
          uploaded_at: new Date().toISOString(),
          expires_at: new Date(Date.now() + 3600_000).toISOString(),
          ...extra,
        });
      await putObject("uploads/OPEN01/open.txt", "hello", { baseURL: base });
      await putObject("uploads/OPEN01/.meta.json", meta("open.txt"), { baseURL: base });
      await putObject("uploads/LOCK01/lock.txt", "hello", { baseURL: base });
      await putObject(
        "uploads/LOCK01/.meta.json",
        meta("lock.txt", {
          password_hash:
            "pbkdf2-sha256$1000$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        }),
        { baseURL: base },
      );

      // Unprotected downloads keep working.
      const open = await fetch(`${base}/OPEN01/open.txt`);
      expect(open.status).toBe(200);
      const openForm = await fetch(`${base}/OPEN01/download`, {
        method: "POST",
        redirect: "manual",
      });
      expect(openForm.status).toBe(303);
      const file = await fetch(new URL(openForm.headers.get("location")!, base));
      expect(await file.text()).toBe("hello");

      // Password downloads are refused with the message.
      const locked = await fetch(`${base}/LOCK01/lock.txt`);
      expect(locked.status).toBe(500);
      expect(await locked.text()).toContain(TOO_SHORT);
      const lockedForm = await fetch(`${base}/LOCK01/download`, {
        method: "POST",
        body: new URLSearchParams({ password: "x" }),
        redirect: "manual",
      });
      expect(lockedForm.status).toBe(500);
      expect(await lockedForm.text()).toContain(TOO_SHORT);

      // A weak token makes download links forgeable: never for protected files.
      const forge = (id: string) => {
        const expires = Math.floor(Date.now() / 1000) + 600;
        const key = createHash("sha256").update(`yeet-download:${token}`).digest();
        const sig = createHmac("sha256", key).update(`${id}:${expires}`).digest("base64url");
        return `${base}/_dl/${id}?expires=${expires}&sig=${sig}`;
      };
      expect((await fetch(forge("LOCK01"))).status).toBe(500);
      expect((await fetch(forge("OPEN01"))).status).toBe(200);
    } finally {
      await srv.stop();
    }
  });
});
