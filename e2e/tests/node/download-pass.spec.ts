import { createHash, createHmac, randomBytes } from "node:crypto";
import {
  clientIp,
  cookiePair,
  downloadBytes,
  expect,
  server,
  submitDownloadForm,
  test,
  uploadViaApi,
} from "../../lib/index.js";

/** A download pass signed with the test token, mirroring createDownloadPass(). */
function forgePass(id: string, expires: number, token = server.token): string {
  const key = createHash("sha256").update(`yeet-dlpass:${token}`).digest();
  const sig = createHmac("sha256", key).update(`${id}:${expires}`).digest("base64url");
  return `yeet_dl_${id}=${expires}.${sig}`;
}

async function pageHasPasswordField(url: string, cookie?: string): Promise<boolean> {
  const res = await fetch(url, { headers: cookie ? { Cookie: cookie } : {} });
  expect(res.status).toBe(200);
  return (await res.text()).includes('name="password"');
}

test.describe("download pass", () => {
  test("a correct password sets yeet_dl_<id>, scoped to /<id>", async () => {
    const { id, url } = await uploadViaApi({
      filename: "pass.bin",
      data: randomBytes(64),
      password: "letmein",
    });
    const res = await submitDownloadForm(url, "letmein", { ip: clientIp() });
    expect(res.status).toBe(303);

    const setCookie = res.headers.get("set-cookie")!;
    const match = setCookie.match(new RegExp(`^yeet_dl_${id}=(\\d+)\\.([A-Za-z0-9_-]+); (.*)$`));
    expect(match, setCookie).not.toBeNull();
    const attributes = match![3]!.split("; ");
    const maxAge = Number(attributes.find((a) => a.startsWith("Max-Age="))?.slice(8));
    expect(maxAge).toBeGreaterThan(3500); // the upload expires in an hour
    expect(maxAge).toBeLessThanOrEqual(3600);
    expect(attributes.filter((a) => !a.startsWith("Max-Age=")).sort()).toEqual([
      "HttpOnly",
      `Path=/${id}`,
      "SameSite=Lax",
    ]);
    const now = Math.floor(Date.now() / 1000);
    expect(Math.abs(Number(match![1]) - (now + maxAge))).toBeLessThanOrEqual(2);
    expect(cookiePair(setCookie)).toBe(forgePass(id, Number(match![1])));

    // Wrong passwords set nothing.
    const wrong = await submitDownloadForm(url, "nope", { ip: clientIp() });
    expect(wrong.status).toBe(401);
    expect(wrong.headers.get("set-cookie")).toBeNull();
  });

  test("Max-Age is capped at 24 hours for long-lived uploads", async () => {
    const { url } = await uploadViaApi({
      filename: "long.bin",
      data: randomBytes(16),
      password: "pw",
      expiresInSeconds: 7 * 24 * 3600,
    });
    const res = await submitDownloadForm(url, "pw", { ip: clientIp() });
    expect(res.headers.get("set-cookie")).toContain("; Max-Age=86400;");
  });

  test("with the pass: no password field, and the form downloads without one", async () => {
    const data = randomBytes(2048);
    const { url } = await uploadViaApi({ filename: "unlock.bin", data, password: "pw-123" });
    const res = await submitDownloadForm(url, "pw-123", { ip: clientIp() });
    const cookie = cookiePair(res.headers.get("set-cookie"));

    expect(await pageHasPasswordField(url)).toBe(true);
    expect(await pageHasPasswordField(url, cookie)).toBe(false);

    const again = await submitDownloadForm(url, undefined, { cookie, ip: clientIp() });
    expect(again.status).toBe(303);
    const location = again.headers.get("location")!;
    const file = await fetch(new URL(location, url));
    expect(Buffer.from(await file.arrayBuffer()).equals(data)).toBe(true);
  });

  test("a pass unlocks only its own upload, and must be genuine and current", async () => {
    const a = await uploadViaApi({ filename: "a.bin", data: randomBytes(8), password: "same" });
    const b = await uploadViaApi({ filename: "b.bin", data: randomBytes(8), password: "same" });
    const passA = cookiePair(
      (await submitDownloadForm(a.url, "same", { ip: clientIp() })).headers.get("set-cookie"),
    );
    const [, value] = passA.split("=");
    const [expires, sig] = value!.split(".");
    const now = Math.floor(Date.now() / 1000);

    const rejectedForB = {
      "a's pass under its own name": passA,
      "a's pass renamed to b": `yeet_dl_${b.id}=${value}`,
      "flipped signature": `yeet_dl_${b.id}=${expires}.${(sig![0] === "A" ? "B" : "A") + sig!.slice(1)}`,
      "expired, correctly signed": forgePass(b.id, now - 5),
      "signed with another token": forgePass(b.id, now + 600, `${server.token}-old`),
      malformed: `yeet_dl_${b.id}=x.y.z`,
      "leading zero in the expiry": forgePass(b.id, now + 600).replace("=", "=0"),
    };
    for (const [name, cookie] of Object.entries(rejectedForB)) {
      expect(await pageHasPasswordField(b.url, cookie), name).toBe(true);
      const res = await submitDownloadForm(b.url, undefined, { cookie, ip: clientIp() });
      expect(res.status, name).toBe(401);
    }

    // A correctly signed, current pass for b works: the checks above are about the pass.
    const forged = forgePass(b.id, now + 600);
    expect(await pageHasPasswordField(b.url, forged)).toBe(false);
    expect((await submitDownloadForm(b.url, undefined, { cookie: forged })).status).toBe(303);
  });

  test("unprotected uploads set no pass", async () => {
    const { url } = await uploadViaApi({ filename: "free.bin", data: randomBytes(8) });
    const res = await submitDownloadForm(url);
    expect(res.status).toBe(303);
    expect(res.headers.get("set-cookie")).toBeNull();
    expect((await downloadBytes(url)).length).toBe(8);
  });
});
