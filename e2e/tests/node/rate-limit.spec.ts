import { pbkdf2Sync, randomBytes } from "node:crypto";
import {
  api,
  clientIp,
  expect,
  loginCookie,
  postLogin,
  readUploadMeta,
  server,
  sessionFetch,
  sleep,
  submitDownloadForm,
  test,
  uploadViaApi,
  writeUploadMeta,
} from "../../lib/index.js";

// Each test uses fresh client addresses (CF-Connecting-IP), so counters start at zero.

function expectRetryAfter(res: Response): number {
  const retryAfter = Number(res.headers.get("retry-after"));
  expect(Number.isInteger(retryAfter), `Retry-After ${res.headers.get("retry-after")}`).toBe(true);
  expect(retryAfter).toBeGreaterThanOrEqual(1);
  expect(retryAfter).toBeLessThanOrEqual(60);
  return retryAfter;
}

/** A stored password hash as the Worker writes it, with any iteration count. */
function pbkdf2Hash(password: string, iterations: number): string {
  const salt = randomBytes(16);
  const hash = pbkdf2Sync(password, salt, iterations, 32, "sha256");
  return `pbkdf2-sha256$${iterations}$${salt.toString("base64url")}$${hash.toString("base64url")}`;
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

  test("login: IPv6 clients are counted per /64, not per address", async () => {
    const hex = () => randomBytes(2).toString("hex");
    const net = `2001:db8:${hex()}:${hex()}`; // a random /64 of the documentation range
    for (let i = 1; i <= 5; i++) {
      // Five addresses of the same /64, in several spellings.
      const ip = [`${net}::${i}`, `${net}:0:0:0:${i}`, `${net.toUpperCase()}::${i}:${i}`][i % 3]!;
      expect((await postLogin(`wrong-${i}-abcdefghij`, { ip })).status, ip).toBe(401);
    }
    const limited = await postLogin(server.token, { ip: `${net}:ffff:ffff:ffff:fffe` });
    expect(limited.status, "another address of the same /64").toBe(429);
    // The neighbouring /64 has its own budget.
    const [a, b, c, d] = net.split(":");
    const next = `${a}:${b}:${c}:${(Number.parseInt(d!, 16) ^ 1).toString(16)}::1`;
    expect((await postLogin(server.token, { ip: next })).status, next).toBe(303);
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

  test("download passwords: a parallel burst gets 5 passwords checked, the right one included", async () => {
    const { id, url } = await uploadViaApi({ filename: "burst.bin", data: randomBytes(16) });
    // A slow hash (100,000 iterations, the most Workers allow) widens the time
    // between an attempt being let in and its password being known.
    const meta = (await readUploadMeta(id))!;
    await writeUploadMeta(id, { ...meta, password_hash: pbkdf2Hash("right", 100_000) });

    const BURST = 40;
    const burst = async (position: number, staggered: boolean) => {
      const ip = clientIp(); // each burst from its own client
      const send = (i: number) =>
        submitDownloadForm(url, i === position ? "right" : `wrong-${i}`, { ip }).then(
          (res) => res.status,
        );
      if (!staggered) return Promise.all(Array.from({ length: BURST }, (_, i) => send(i)));
      // The first 5 attempts, then a moment later the other 35 at once.
      const first = Array.from({ length: 5 }, (_, i) => send(i));
      await sleep(50);
      return Promise.all([...first, ...Array.from({ length: BURST - 5 }, (_, i) => send(i + 5))]);
    };
    const count = (statuses: number[], status: number) =>
      statuses.filter((s) => s === status).length;

    // All 40 at once, the right password somewhere in the middle. Exactly 5
    // attempts are let in, in the order they reach the server (which is not
    // their order here); the other 35 are refused before any hashing. A right
    // password that is not among those 5 gets the same 429 as a wrong one.
    // Without an atomic check-and-count, every attempt of the burst passes the
    // check before any failure is counted, and the right one always gets in.
    let rightRefused = 0;
    for (const position of [10, 15, 20, 25, 30]) {
      const statuses = await burst(position, false);
      const detail = `all at once, right password at ${position}: ${statuses.join(",")}`;
      expect([303, 429], detail).toContain(statuses[position]);
      const wrong401 = count(statuses, 401);
      if (statuses[position] === 429) {
        rightRefused++;
        expect(wrong401, detail).toBe(5);
      } else {
        // A correct password gives its slot back, so one more wrong one may follow.
        expect([4, 5], detail).toContain(wrong401);
      }
      expect(count(statuses, 429), detail).toBe(
        BURST - wrong401 - (statuses[position] === 303 ? 1 : 0),
      );
    }
    // With 5 of 40 let in, a right password in the middle is rarely among them.
    expect(rightRefused, "bursts in which the right password was refused").toBeGreaterThanOrEqual(
      2,
    );

    // The first 5 a little ahead: the right password gets in only if it is
    // among them, else the same 429 as a wrong one.
    for (const position of [4, 5]) {
      const statuses = await burst(position, true);
      const detail = `staggered, right password at ${position}: ${statuses.join(",")}`;
      const inFirstFive = position < 5;
      expect(statuses[position], detail).toBe(inFirstFive ? 303 : 429);
      // Wrong passwords hashed: 5 at most. (A correct password gives its slot
      // back, so after it one more wrong one may still be checked.)
      const wrong401 = count(statuses, 401);
      if (inFirstFive) expect([4, 5], detail).toContain(wrong401);
      else expect(wrong401, detail).toBe(5);
      expect(count(statuses, 429), detail).toBe(BURST - wrong401 - (inFirstFive ? 1 : 0));
    }
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
