import { existsSync } from "node:fs";
import { readFile, rm, stat } from "node:fs/promises";
import {
  api,
  cli,
  cliUpload,
  describeRun,
  downloadSha256,
  eventually,
  expect,
  expectExitCode,
  FILENAMES,
  fileWith,
  listUploads,
  MiB,
  randomFile,
  server,
  serverLog,
  startServer,
  test,
  uploadObjects,
} from "../../lib/index.js";

/** A share link for a file on the test server: <origin>/<6-char id>/<encoded name>. */
function shareUrlPattern(filename: string): RegExp {
  const origin = server.baseURL.replace(/[.]/g, "\\.");
  return new RegExp(`^${origin}/[A-Za-z0-9_-]{6}/${escapeRegExp(encodeURIComponent(filename))}$`);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The link lifetime the server stored for an upload, in seconds. */
async function storedLifetimeSeconds(id: string): Promise<number> {
  const upload = (await listUploads()).find((u) => u.id === id);
  if (!upload) throw new Error(`Upload ${id} is not in GET /api/uploads`);
  return (Date.parse(upload.expires_at) - Date.parse(upload.uploaded_at)) / 1000;
}

test.describe("yeet login", () => {
  test("a wrong token fails with a clear message and exit code 1", async () => {
    const result = await cli(["login", server.baseURL], { stdin: "not-the-token\n" });

    expectExitCode(result, 1);
    expect(result.stderr).toBe(
      `That upload token is not correct for ${server.baseURL}. Check it and try again.\n`,
    );
    expect(result.stdout).toBe("");
    expect(existsSync(result.configPath)).toBe(false);
  });

  test("other commands with a wrong token advise running yeet login again", async ({ tmp }) => {
    const env = { YEET_TOKEN: "not-the-token-0123456789" };
    const list = await cli(["list"], { auth: true, env });
    expectExitCode(list, 1);
    expect(list.stderr).toBe("The server rejected the upload token. Run `yeet login` again.\n");

    const file = await fileWith(tmp, "rejected.txt", "never uploaded\n");
    const upload = await cli(["upload", file.path], { auth: true, env });
    expectExitCode(upload, 1);
    expect(upload.stderr).toContain("Run `yeet login` again.");
    expect(upload.stdout).toBe("");
  });

  test("rate-limited (429): login and other commands say when to try again", async () => {
    // Its own server: the CLI sends no CF-Connecting-IP, so all of its
    // requests share one address, which must not be rate-limited on the
    // server that the other tests use.
    test.setTimeout(120_000);
    const srv = await startServer({ token: server.token });
    try {
      for (let i = 1; i <= 20; i++) {
        const res = await api("/api/me", { baseURL: srv.baseURL, token: `wrong-${i}-0123456789` });
        expect(res.status, `failure ${i}`).toBe(401);
      }

      const tooMany =
        /^Too many wrong upload tokens were tried from this address\. Try again in (\d+) seconds?\./;
      for (const token of ["still-wrong-0123456789", server.token]) {
        const login = await cli(["login", srv.baseURL], { stdin: `${token}\n` });
        expectExitCode(login, 1);
        expect(login.stderr, describeRun(login)).toMatch(tooMany);
        expect(login.stderr).not.toContain("yeet login");
        expect(existsSync(login.configPath)).toBe(false);
      }

      const list = await cli(["list"], {
        env: { YEET_URL: srv.baseURL, YEET_TOKEN: "still-wrong-0123456789" },
      });
      expectExitCode(list, 1);
      expect(list.stderr, describeRun(list)).toMatch(tooMany);
      expect(list.stderr).toContain("run `yeet login`");
      const seconds = Number(list.stderr.match(tooMany)![1]);
      expect(seconds).toBeGreaterThanOrEqual(1);
      expect(seconds).toBeLessThanOrEqual(60);
    } finally {
      await srv.stop();
    }
  });

  test("a valid token is saved to a config file with mode 0600", async () => {
    const result = await cli(["login", server.baseURL], { stdin: `${server.token}\n` });

    expectExitCode(result, 0);
    expect(result.stderr).toContain(`Logged in to ${server.baseURL}`);
    const info = await stat(result.configPath);
    expect((info.mode & 0o777).toString(8)).toBe("600");
    const config = JSON.parse(await readFile(result.configPath, "utf-8"));
    expect(config).toMatchObject({ url: server.baseURL, token: server.token });

    // The saved config is what later commands use.
    expectExitCode(await cli(["list"], { configHome: result.configHome }), 0);
  });
});

test.describe("yeet upload, list and delete", () => {
  test("a small file: link on stdout, listed, downloadable, deleted by URL", async ({ tmp }) => {
    const file = await randomFile(tmp, 200 * 1024, FILENAMES.spaces);

    const { url, id, result } = await cliUpload(file.path, ["--expires", "7d"]);
    expect(result.stdout).toBe(`${url}\n`);
    expect(url).toMatch(shareUrlPattern(file.name));
    expect(await downloadSha256(url)).toEqual({ sha256: file.sha256, size: file.size });

    const list = await cli(["list"], { auth: true });
    expectExitCode(list, 0);
    expect(list.stdout).toContain(file.name);
    expect(list.stdout).toContain(url);

    const del = await cli(["delete", url], { auth: true });
    expectExitCode(del, 0);
    expect(del.stderr).toContain(`Deleted ${id}`);

    // Every object of the upload is gone, not just its metadata.
    await eventually(async () => (await uploadObjects(id)).length === 0, {
      message: `uploads/${id}/ to be empty after yeet delete`,
    });
    expect((await fetch(url)).status).toBe(404);
    const after = await cli(["list"], { auth: true });
    expect(after.stdout).not.toContain(url);
  });

  test(
    "a 120 MB file is uploaded in 50 MiB parts and downloads intact",
    { tag: "@slow" },
    async ({ tmp }) => {
      test.setTimeout(5 * 60_000);
      const file = await randomFile(tmp, 120 * MiB, "big-120MiB.bin");

      const { url, id, result } = await cliUpload(file.path, [], { timeoutMs: 4 * 60_000 });
      expect(result.stdout).toBe(`${url}\n`);
      expect(url).toMatch(shareUrlPattern(file.name));
      await rm(file.path); // free disk early; the hash is kept

      // 120 MiB in 50 MiB parts: three part PUTs, each answered 200.
      const parts = await eventually(
        async () => {
          const lines = (await serverLog())
            .split("\n")
            .filter((line) => line.includes(`PUT /api/uploads/${id}/parts/`));
          return lines.length >= 3 && lines;
        },
        { message: "three part uploads in the wrangler log" },
      );
      expect(parts.map((line) => line.match(/parts\/(\d+) (\d{3})/)?.slice(1)).sort()).toEqual([
        ["1", "200"],
        ["2", "200"],
        ["3", "200"],
      ]);

      const list = await cli(["list"], { auth: true });
      expect(list.stdout).toContain(url);
      expect(list.stdout).toContain("125.8 MB"); // 120 MiB in the CLI's decimal units

      expect(await downloadSha256(url)).toEqual({ sha256: file.sha256, size: file.size });

      expectExitCode(await cli(["delete", url], { auth: true }), 0);
      await eventually(async () => (await uploadObjects(id)).length === 0, {
        message: `uploads/${id}/ to be empty after yeet delete`,
      });
      expect((await fetch(url)).status).toBe(404);
    },
  );
});

test.describe("yeet upload --expires", () => {
  test("--expires 90m stores a 90 minute lifetime", async ({ tmp }) => {
    const file = await fileWith(tmp, "ninety.txt", "90 minutes\n");
    const { id } = await cliUpload(file.path, ["--expires", "90m"]);
    expect(await storedLifetimeSeconds(id)).toBeCloseTo(5400, -1); // ±5 s
  });

  test("YEET_DEFAULT_EXPIRES sets the lifetime; --expires overrides it", async ({ tmp }) => {
    const file = await fileWith(tmp, "default.txt", "default expiry\n");
    const env = { YEET_DEFAULT_EXPIRES: "2h" };

    const { id } = await cliUpload(file.path, [], { env });
    expect(await storedLifetimeSeconds(id)).toBeCloseTo(7200, -1);

    const { id: overridden } = await cliUpload(file.path, ["--expires", "3d"], { env });
    expect(await storedLifetimeSeconds(overridden)).toBeCloseTo(3 * 86400, -1);
  });

  test("without any setting the lifetime is 30 days", async ({ tmp }) => {
    const file = await fileWith(tmp, "thirty.txt", "30 days\n");
    const { id } = await cliUpload(file.path);
    expect(await storedLifetimeSeconds(id)).toBeCloseTo(30 * 86400, -1);
  });

  for (const value of ["0d", "5x", "7"]) {
    test(`an invalid --expires ${value} exits 1 with a clear message`, async ({ tmp }) => {
      const file = await fileWith(tmp, "never.txt", "never uploaded\n");
      const result = await cli(["upload", file.path, "--expires", value], { auth: true });

      expectExitCode(result, 1);
      expect(result.stderr, describeRun(result)).toContain(`Invalid --expires: "${value}"`);
      expect(result.stdout).toBe("");
    });
  }

  test("an invalid YEET_DEFAULT_EXPIRES exits 1 with a clear message", async ({ tmp }) => {
    const file = await fileWith(tmp, "never.txt", "never uploaded\n");
    const result = await cli(["upload", file.path], {
      auth: true,
      env: { YEET_DEFAULT_EXPIRES: "5x" },
    });

    expectExitCode(result, 1);
    expect(result.stderr, describeRun(result)).toContain('Invalid YEET_DEFAULT_EXPIRES: "5x"');
    expect(result.stdout).toBe("");
  });
});
