import { pbkdf2Sync, randomBytes } from "node:crypto";
import {
  expect,
  readUploadMeta,
  seedLegacyUpload,
  submitDownloadForm,
  test,
  uploadViaApi,
} from "../../lib/index.js";

test.describe("password hashing", () => {
  test("new uploads are hashed with PBKDF2-SHA256 at 20,000 iterations", async () => {
    const { id } = await uploadViaApi({
      filename: "hashed.txt",
      data: Buffer.from("hi"),
      password: "a password",
    });
    const meta = await readUploadMeta(id);
    expect(meta?.password_hash).toMatch(/^pbkdf2-sha256\$20000\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/);
  });

  test("hashes with another iteration count (50,000) still verify", async () => {
    const password = "an older password";
    const salt = randomBytes(16);
    const hash = pbkdf2Sync(password, salt, 50_000, 32, "sha256");
    const { url } = await seedLegacyUpload({
      filename: "older.txt",
      data: Buffer.from("older"),
      meta: {
        password_hash: `pbkdf2-sha256$50000$${salt.toString("base64url")}$${hash.toString("base64url")}`,
      },
    });

    expect((await submitDownloadForm(url, "not it")).status).toBe(401);
    const right = await submitDownloadForm(url, password);
    expect(right.status).toBe(303);
    expect(right.headers.get("location")).toMatch(/^\/_dl\//);
  });
});
