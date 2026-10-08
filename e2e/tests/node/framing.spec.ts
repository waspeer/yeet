import { randomBytes } from "node:crypto";
import {
  api,
  clientIp,
  deleteUpload,
  expect,
  forgeDownloadUrl,
  loginCookie,
  postLogin,
  server,
  sessionFetch,
  signedDownloadUrl,
  submitDownloadForm,
  test,
  uploadViaApi,
} from "../../lib/index.js";

// Pages that take input or offer a file must not be framed by another site
// (clickjacking): CSP frame-ancestors for current browsers, X-Frame-Options
// for older ones. Every response of the Worker carries both.

function expectNoFraming(res: Response, what: string): void {
  expect(res.headers.get("content-security-policy"), what).toBe("frame-ancestors 'none'");
  expect(res.headers.get("x-frame-options"), what).toBe("DENY");
}

test.describe("anti-framing headers", () => {
  test("on the login form, the upload page and every /login answer", async () => {
    expectNoFraming(await fetch(`${server.baseURL}/upload`), "GET /upload, logged out");
    const cookie = await loginCookie({ ip: clientIp() });
    expectNoFraming(await sessionFetch("/upload", cookie), "GET /upload, logged in");

    const ip = clientIp();
    expectNoFraming(await postLogin(server.token, { ip }), "POST /login, right token");
    expectNoFraming(await postLogin("wrong-token-abcdefgh", { ip }), "POST /login, wrong token");
    for (let i = 0; i < 5; i++) await postLogin(`wrong-${i}-abcdefghijk`, { ip });
    const limited = await postLogin("wrong-token-abcdefgh", { ip });
    expect(limited.status).toBe(429);
    expectNoFraming(limited, "POST /login, rate-limited");
  });

  test("on download pages, with and without a password", async () => {
    const open = await uploadViaApi({ filename: "open.bin", data: randomBytes(16) });
    expectNoFraming(await fetch(open.url), "download page");
    expectNoFraming(await fetch(`${server.baseURL}/${open.id}`), "download page without name");

    const locked = await uploadViaApi({
      filename: "locked.bin",
      data: randomBytes(16),
      password: "right",
    });
    expectNoFraming(await fetch(locked.url), "password page");
    const ip = clientIp();
    const wrong = await submitDownloadForm(locked.url, "wrong", { ip });
    expect(wrong.status).toBe(401);
    expectNoFraming(wrong, "wrong password");
    for (let i = 0; i < 5; i++) await submitDownloadForm(locked.url, `wrong-${i}`, { ip });
    const limited = await submitDownloadForm(locked.url, "wrong", { ip });
    expect(limited.status).toBe(429);
    expectNoFraming(limited, "rate-limited password page");
    expectNoFraming(await fetch(`${server.baseURL}/nope12/missing.bin`), "not found page");
  });

  // Not pages, but a file shown inline (an image, a PDF) or JSON could still
  // be framed; the headers are on every Worker response.
  test("on download links and API responses", async () => {
    const { id, url } = await uploadViaApi({ filename: "framed.bin", data: randomBytes(64) });
    const link = await signedDownloadUrl(url);
    expectNoFraming(await fetch(link), "/_dl, 200");
    expectNoFraming(await fetch(link, { headers: { Range: "bytes=0-9" } }), "/_dl, 206");
    expectNoFraming(await fetch(link, { headers: { Range: "bytes=999-" } }), "/_dl, 416");
    expectNoFraming(await fetch(link.replace(/sig=[^&]+/, "sig=AAAA")), "/_dl, 403");
    expectNoFraming(await fetch(forgeDownloadUrl("nope12", 4102444800)), "/_dl, 404");

    expectNoFraming(await api("/api/me"), "GET /api/me");
    expectNoFraming(await api("/api/uploads"), "GET /api/uploads");
    expectNoFraming(await api("/api/me", { token: null }), "/api, 401");
    expectNoFraming(await api("/api/uploads/nope12", { method: "DELETE" }), "/api, 404");
    expectNoFraming(await api("/api/uploads", { method: "POST", body: "{}" }), "/api, 400");
    const cookie = await loginCookie({ ip: clientIp() });
    expectNoFraming(
      await sessionFetch("/api/uploads", cookie, { headers: { "Sec-Fetch-Site": "cross-site" } }),
      "/api, 403",
    );
    expectNoFraming(await fetch(`${server.baseURL}/health`), "/health");
    expect((await deleteUpload(id)).status).toBe(200);
  });
});
