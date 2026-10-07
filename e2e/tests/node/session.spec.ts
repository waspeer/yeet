import { createHash, createHmac, randomBytes } from "node:crypto";
import {
  api,
  apiJson,
  clientIp,
  cookiePair,
  expect,
  loginCookie,
  postLogin,
  server,
  sessionFetch,
  test,
} from "../../lib/index.js";

const DAY = 24 * 60 * 60;

/** A session cookie value signed with the test token, mirroring createSession(). */
function forgeSession(expires: number, token = server.token): string {
  const key = createHash("sha256").update(`yeet-session:${token}`).digest();
  const sig = createHmac("sha256", key).update(`session:v1:${expires}`).digest("base64url");
  return `yeet_session=v1.${expires}.${sig}`;
}

test.describe("browser login", () => {
  test("GET /upload without a session shows the login form, never cached", async () => {
    const res = await fetch(`${server.baseURL}/upload`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const html = await res.text();
    expect(html).toContain('<form method="POST" action="/login">');
    expect(html).toMatch(
      /<input type="password" id="token" name="token"[^>]*autocapitalize="off" autocorrect="off" spellcheck="false" autocomplete="current-password">/,
    );
  });

  test("a correct token sets the session cookie with the contract's attributes", async () => {
    const res = await postLogin(server.token, { ip: clientIp() });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/upload");
    expect(res.headers.get("cache-control")).toBe("no-store");

    const setCookie = res.headers.get("set-cookie")!;
    const now = Math.floor(Date.now() / 1000);
    const match = setCookie.match(/^yeet_session=v1\.(\d+)\.([A-Za-z0-9_-]+); (.*)$/);
    expect(match, setCookie).not.toBeNull();
    const expires = Number(match![1]);
    expect(expires).toBeGreaterThanOrEqual(now + 90 * DAY - 5);
    expect(expires).toBeLessThanOrEqual(now + 90 * DAY + 5);
    const attributes = match![3]!.split("; ").sort();
    // Exactly these; no Secure on http, so WebKit keeps it on localhost.
    expect(attributes).toEqual(["HttpOnly", "Max-Age=7776000", "Path=/", "SameSite=Strict"]);

    // The cookie is what the contract says it is: forging it gives the same value.
    expect(cookiePair(setCookie)).toBe(forgeSession(expires));
  });

  test("with a session, GET /upload shows the upload page with a logout form", async () => {
    const cookie = await loginCookie({ ip: clientIp() });
    const res = await sessionFetch("/upload", cookie, { headers: { Origin: undefined } });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const html = await res.text();
    expect(html).toContain('action="/logout"');
    expect(html).not.toContain('action="/login"');
  });

  test("a wrong token: 401 with the login form and a message", async () => {
    const res = await postLogin("not-the-token-at-all", { ip: clientIp() });
    expect(res.status).toBe(401);
    expect(res.headers.get("set-cookie")).toBeNull();
    const html = await res.text();
    expect(html).toContain("That token is not correct.");
    expect(html).toContain('action="/login"');
    // A wrong token is not echoed back either.
    expect(html).not.toContain("not-the-token-at-all");
  });

  test("near misses of the token are refused", async () => {
    const ip = clientIp();
    for (const candidate of [server.token.slice(0, -1), `${server.token}x`, ""]) {
      const res = await postLogin(candidate, { ip });
      expect(res.status, JSON.stringify(candidate)).toBe(401);
    }
  });

  test("surrounding whitespace of a pasted token is ignored at login, but not for Bearer", async () => {
    const ip = clientIp();
    const res = await postLogin(`  ${server.token} \n`, { ip });
    expect(res.status).toBe(303);
    expect(res.headers.get("set-cookie")).toMatch(/^yeet_session=v1\./);

    // (Trailing whitespace of a header value is stripped by HTTP itself, so
    // only whitespace inside the value can reach the Worker.)
    for (const header of [`Bearer  ${server.token}`, `Bearer \t${server.token}`]) {
      const bearer = await api("/api/me", { token: null, ip, headers: { Authorization: header } });
      expect(bearer.status, JSON.stringify(header)).toBe(401);
    }
  });

  test("logout clears the cookie and redirects to /upload", async () => {
    const cookie = await loginCookie({ ip: clientIp() });
    const res = await sessionFetch("/logout", cookie, { method: "POST" });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/upload");
    const setCookie = res.headers.get("set-cookie")!;
    expect(setCookie).toMatch(/^yeet_session=;/);
    expect(setCookie.split("; ")).toContain("Max-Age=0");
    expect(setCookie.split("; ")).toContain("Path=/");
  });

  test("login and logout refuse cross-origin and Origin-less posts", async () => {
    const ip = clientIp();
    const cases: Record<string, string | undefined>[] = [
      { Origin: "https://evil.example" },
      { Origin: undefined },
      { "Sec-Fetch-Site": "cross-site" },
      { "Sec-Fetch-Site": "same-site" },
    ];
    for (const headers of cases) {
      const login = await fetch(`${server.baseURL}/login`, {
        method: "POST",
        body: new URLSearchParams({ token: server.token }),
        redirect: "manual",
        headers: Object.fromEntries(
          Object.entries({
            Origin: server.baseURL,
            "Sec-Fetch-Site": "same-origin",
            "CF-Connecting-IP": ip,
            ...headers,
          }).filter((entry): entry is [string, string] => entry[1] !== undefined),
        ),
      });
      expect(login.status, `login ${JSON.stringify(headers)}`).toBe(403);
      expect(login.headers.get("set-cookie")).toBeNull();

      const cookie = await loginCookie({ ip });
      const logout = await sessionFetch("/logout", cookie, { method: "POST", headers });
      expect(logout.status, `logout ${JSON.stringify(headers)}`).toBe(403);
      expect(logout.headers.get("set-cookie")).toBeNull();
    }
  });
});

test.describe("session cookie on /api", () => {
  test("a session works for /api/me and the whole upload flow", async () => {
    const cookie = await loginCookie({ ip: clientIp() });
    const json = async (res: Response) => {
      const body = await res.text();
      expect(res.ok, body).toBe(true);
      return JSON.parse(body);
    };

    expect(await json(await sessionFetch("/api/me", cookie))).toEqual({ ok: true });

    const data = randomBytes(1000);
    const { id } = await json(
      await sessionFetch("/api/uploads", cookie, {
        method: "POST",
        body: JSON.stringify({ filename: "from-browser.bin", expires_in: 3600 }),
        headers: { "Content-Type": "application/json" },
      }),
    );
    const part = await json(
      await sessionFetch(`/api/uploads/${id}/parts/1`, cookie, { method: "PUT", body: data }),
    );
    const done = await json(
      await sessionFetch(`/api/uploads/${id}/complete`, cookie, {
        method: "POST",
        body: JSON.stringify({ parts: [part] }),
        headers: { "Content-Type": "application/json" },
      }),
    );
    expect(done.id).toBe(id);

    const { uploads } = await json(await sessionFetch("/api/uploads", cookie));
    const listed = uploads.find((u: { id: string }) => u.id === id);
    expect(listed?.file_size).toBe(1000);

    expect(
      await json(await sessionFetch(`/api/uploads/${id}`, cookie, { method: "DELETE" })),
    ).toEqual({ deleted: id });
  });

  test("unsafe requests need our Origin; Sec-Fetch-Site must be same-origin", async () => {
    const cookie = await loginCookie({ ip: clientIp() });
    const { id } = await apiJson<{ id: string }>("/api/uploads", {
      method: "POST",
      body: JSON.stringify({ filename: "csrf-target.bin", expires_in: 3600 }),
    });

    const refused: Record<string, string | undefined>[] = [
      { Origin: undefined, "Sec-Fetch-Site": undefined },
      { Origin: undefined },
      { Origin: "https://evil.example" },
      { Origin: "null" },
      { Origin: server.baseURL.replace("127.0.0.1", "localhost") },
      { "Sec-Fetch-Site": "cross-site" },
      { "Sec-Fetch-Site": "same-site" },
      { "Sec-Fetch-Site": "none" },
    ];
    for (const headers of refused) {
      for (const [method, path] of [
        ["POST", "/api/uploads"],
        ["PUT", `/api/uploads/${id}/parts/1`],
        ["POST", `/api/uploads/${id}/complete`],
        ["DELETE", `/api/uploads/${id}`],
      ] as const) {
        const res = await sessionFetch(path, cookie, {
          method,
          body: method === "DELETE" ? undefined : "{}",
          headers,
        });
        const label = `${method} ${path} ${JSON.stringify(headers)}`;
        expect(res.status, label).toBe(403);
        expect(await res.json(), label).toEqual({ error: "Cross-origin request refused" });
      }
    }

    // Still pending: none of the refused requests touched it.
    expect((await api(`/api/uploads/${id}`, { method: "DELETE" })).status).toBe(200);
  });

  test("a cross-site GET with a session is refused; a same-origin one without Origin works", async () => {
    const cookie = await loginCookie({ ip: clientIp() });
    const crossSite = await sessionFetch("/api/uploads", cookie, {
      headers: { "Sec-Fetch-Site": "cross-site", Origin: undefined },
    });
    expect(crossSite.status).toBe(403);
    // Browsers send no Origin on same-origin GETs.
    const plain = await sessionFetch("/api/me", cookie, { headers: { Origin: undefined } });
    expect(plain.status).toBe(200);
  });

  test("tampered, expired, foreign and malformed session cookies are rejected", async () => {
    const valid = await loginCookie({ ip: clientIp() });
    const [, expires, sig] = valid.split("=")[1]!.split(".");
    const now = Math.floor(Date.now() / 1000);
    const flip = (s: string) => (s[0] === "A" ? "B" : "A") + s.slice(1);

    const rejected = {
      "flipped signature": `yeet_session=v1.${expires}.${flip(sig!)}`,
      "later expiry, same signature": `yeet_session=v1.${Number(expires) + 1}.${sig}`,
      "expired, correctly signed": forgeSession(now - 10),
      "signed with another token": forgeSession(now + DAY, `${server.token}-other`),
      "wrong version": `yeet_session=v2.${expires}.${sig}`,
      "no signature": `yeet_session=v1.${expires}.`,
      "extra field": `${valid}.x`,
      garbage: "yeet_session=hello",
      empty: "yeet_session=",
      "the token itself": `yeet_session=${server.token}`,
    };
    for (const [name, cookie] of Object.entries(rejected)) {
      const res = await sessionFetch("/api/me", cookie);
      expect(res.status, name).toBe(401);
      expect(await res.json(), name).toEqual({ error: "Invalid upload token" });
      const page = await (await sessionFetch("/upload", cookie)).text();
      expect(page, name).toContain('action="/login"');
    }

    // The same check passes for the genuine and a correctly forged, future cookie.
    expect((await sessionFetch("/api/me", valid)).status).toBe(200);
    expect((await sessionFetch("/api/me", forgeSession(now + 60))).status).toBe(200);
  });

  test("Bearer works without Origin, and a wrong Bearer is not rescued by a session", async () => {
    const cookie = await loginCookie({ ip: clientIp() });
    const res = await api("/api/uploads", {
      method: "POST",
      body: JSON.stringify({ filename: "cli.bin", size: 1, expires_in: 60 }),
      headers: { "Content-Type": "application/json", "Sec-Fetch-Site": "cross-site" },
    });
    expect(res.status).toBe(201);
    const { id } = await res.json();
    expect((await api(`/api/uploads/${id}`, { method: "DELETE" })).status).toBe(200);

    const mixed = await sessionFetch("/api/me", cookie, {
      headers: { Authorization: "Bearer wrong-token-here", "CF-Connecting-IP": clientIp() },
    });
    expect(mixed.status).toBe(401);
  });
});

test.describe("the upload token never reaches the browser", () => {
  test("no response body or Set-Cookie of the browser flow contains it", async () => {
    const ip = clientIp();
    const token = server.token;
    const needles = [token, encodeURIComponent(token), Buffer.from(token).toString("base64")];
    const seen: string[] = [];
    const check = async (label: string, res: Response) => {
      const body = await res.text();
      const cookies = res.headers.getSetCookie().join("\n");
      const headers = [...res.headers].map(([k, v]) => `${k}: ${v}`).join("\n");
      for (const needle of needles) {
        expect(body.includes(needle), `${label} body`).toBe(false);
        expect(cookies.includes(needle), `${label} Set-Cookie`).toBe(false);
        expect(headers.includes(needle), `${label} headers`).toBe(false);
      }
      seen.push(label);
    };

    await check("GET /upload (logged out)", await fetch(`${server.baseURL}/upload`));
    await check("POST /login wrong", await postLogin("wrong-token-1234567", { ip }));
    const login = await postLogin(token, { ip });
    expect(login.status).toBe(303);
    const cookie = cookiePair(login.headers.get("set-cookie"));
    await check("POST /login right", login);
    await check("GET /upload (logged in)", await sessionFetch("/upload", cookie));
    await check("GET /api/me", await sessionFetch("/api/me", cookie));
    await check("GET /", await fetch(`${server.baseURL}/`));
    await check("GET /client.js", await fetch(`${server.baseURL}/client.js`));
    await check("GET unknown download page", await fetch(`${server.baseURL}/AAAAAA/missing.txt`));
    await check("POST /logout", await sessionFetch("/logout", cookie, { method: "POST" }));
    expect(seen).toHaveLength(9);
  });
});
