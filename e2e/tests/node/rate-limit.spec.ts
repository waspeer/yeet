import { randomBytes } from "node:crypto";
import {
  api,
  clientIp,
  expect,
  loginCookie,
  postLogin,
  server,
  sessionFetch,
  submitDownloadForm,
  test,
  uploadViaApi,
} from "../../lib/index.js";

// Each test uses fresh client addresses (CF-Connecting-IP), so counters start at zero.

function expectRetryAfter(res: Response): number {
  const retryAfter = Number(res.headers.get("retry-after"));
  expect(Number.isInteger(retryAfter), `Retry-After ${res.headers.get("retry-after")}`).toBe(true);
  expect(retryAfter).toBeGreaterThanOrEqual(1);
  expect(retryAfter).toBeLessThanOrEqual(60);
  return retryAfter;
}

test.describe("rate limits", () => {
  test("login: the 6th failure within a minute gets 429, even with the right token", async () => {
    const ip = clientIp();
    for (let i = 1; i <= 5; i++) {
      expect((await postLogin(`wrong-token-${i}-abcdefgh`, { ip })).status, `failure ${i}`).toBe(
        401,
      );
    }
    const limited = await postLogin("wrong-token-6-abcdefgh", { ip });
    expect(limited.status).toBe(429);
    const retryAfter = expectRetryAfter(limited);
    const html = await limited.text();
    expect(html).toContain(`Too many attempts. Try again in ${retryAfter} seconds.`);
    expect(html).toContain('action="/login"');

    // The right token gets the same answer: the limit is no oracle.
    const right = await postLogin(server.token, { ip });
    expect(right.status).toBe(429);
    expect(right.headers.get("set-cookie")).toBeNull();

    // Other clients are unaffected.
    expect((await postLogin(server.token, { ip: clientIp() })).status).toBe(303);
  });

  test("login: successes do not count", async () => {
    const ip = clientIp();
    for (let i = 0; i < 8; i++) expect((await postLogin(server.token, { ip })).status).toBe(303);
    for (let i = 1; i <= 4; i++)
      expect((await postLogin(`nope-${i}-xxxxxxxxxx`, { ip })).status).toBe(401);
    for (let i = 0; i < 3; i++) expect((await postLogin(server.token, { ip })).status).toBe(303);
    // Fifth failure is still a plain 401; only the sixth attempt is refused.
    expect((await postLogin("nope-5-xxxxxxxxxx", { ip })).status).toBe(401);
    expect((await postLogin(server.token, { ip })).status).toBe(429);
  });

  test("download passwords: 5 wrong per upload and client, then 429", async () => {
    const data = randomBytes(32);
    const a = await uploadViaApi({ filename: "limited.bin", data, password: "right" });
    const b = await uploadViaApi({ filename: "other.bin", data, password: "right" });
    const ip = clientIp();

    for (let i = 1; i <= 5; i++) {
      expect((await submitDownloadForm(a.url, `wrong-${i}`, { ip })).status, `failure ${i}`).toBe(
        401,
      );
    }
    const limited = await submitDownloadForm(a.url, "wrong-6", { ip });
    expect(limited.status).toBe(429);
    const retryAfter = expectRetryAfter(limited);
    const html = await limited.text();
    expect(html).toContain(`Too many attempts. Try again in ${retryAfter} seconds.`);
    expect(html).toContain('name="password"');

    const right = await submitDownloadForm(a.url, "right", { ip });
    expect(right.status).toBe(429);
    expect(right.headers.get("location")).toBeNull();
    expect(right.headers.get("set-cookie")).toBeNull();

    // Per upload: the same client can still try the other one; per client: others can try this one.
    expect((await submitDownloadForm(b.url, "right", { ip })).status).toBe(303);
    expect((await submitDownloadForm(a.url, "right", { ip: clientIp() })).status).toBe(303);
  });

  test("download passwords: correct ones do not count", async () => {
    const { url } = await uploadViaApi({
      filename: "fine.bin",
      data: randomBytes(8),
      password: "right",
    });
    const ip = clientIp();
    for (let i = 0; i < 6; i++)
      expect((await submitDownloadForm(url, "right", { ip })).status).toBe(303);
    for (let i = 1; i <= 5; i++)
      expect((await submitDownloadForm(url, "bad", { ip })).status).toBe(401);
    expect((await submitDownloadForm(url, "right", { ip })).status).toBe(429);
  });

  test("bearer: the 21st wrong token within a minute gets 429, even the right one", async () => {
    const ip = clientIp();
    for (let i = 1; i <= 20; i++) {
      const res = await api("/api/me", { token: `wrong-${i}-0123456789`, ip });
      expect(res.status, `failure ${i}`).toBe(401);
    }
    const limited = await api("/api/me", { token: "wrong-21-0123456789", ip });
    expect(limited.status).toBe(429);
    const retryAfter = expectRetryAfter(limited);
    expect(await limited.json()).toEqual({ error: `Too many attempts, retry in ${retryAfter} s` });

    expect((await api("/api/me", { ip })).status).toBe(429);
    // Another client, and a browser session from the same address, are unaffected.
    expect((await api("/api/me", { ip: clientIp() })).status).toBe(200);
    const cookie = await loginCookie({ ip: clientIp() });
    const session = await sessionFetch("/api/me", cookie, { headers: { "CF-Connecting-IP": ip } });
    expect(session.status).toBe(200);
  });

  test("bearer: successes and cookie-less requests do not count", async () => {
    const ip = clientIp();
    for (let i = 0; i < 25; i++) expect((await api("/api/me", { ip })).status).toBe(200);
    // No credentials at all are not a guess.
    for (let i = 0; i < 25; i++)
      expect((await api("/api/me", { ip, token: null })).status).toBe(401);
    for (let i = 1; i <= 20; i++) {
      expect((await api("/api/me", { ip, token: `bad-${i}-0123456789` })).status).toBe(401);
    }
    expect((await api("/api/me", { ip })).status).toBe(429);
  });
});
