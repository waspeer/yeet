import { existsSync } from "node:fs";
import { readFile, rm, stat } from "node:fs/promises";
import {
  cli,
  cliUpload,
  downloadSha256,
  eventually,
  expect,
  FILENAMES,
  MiB,
  randomFile,
  server,
  serverLog,
  test,
} from "../../lib/index.js";

/** A share link for a file on the test server: <origin>/<6-char id>/<encoded name>. */
function shareUrlPattern(filename: string): RegExp {
  const origin = server.baseURL.replace(/[.]/g, "\\.");
  return new RegExp(`^${origin}/[A-Za-z0-9_-]{6}/${escapeRegExp(encodeURIComponent(filename))}$`);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

test.describe("yeet login", () => {
  test("a wrong token fails with a clear message and exit code 1", async () => {
    const result = await cli(["login", server.baseURL], { stdin: "not-the-token\n" });

    expect(result.code, result.stderr).toBe(1);
    expect(result.stderr).toContain("The server rejected the upload token");
    expect(result.stdout).toBe("");
    expect(existsSync(result.configPath)).toBe(false);
  });

  test("a valid token is saved to a config file with mode 0600", async () => {
    const result = await cli(["login", server.baseURL], { stdin: `${server.token}\n` });

    expect(result.code, result.stderr).toBe(0);
    expect(result.stderr).toContain(`Logged in to ${server.baseURL}`);
    const info = await stat(result.configPath);
    expect((info.mode & 0o777).toString(8)).toBe("600");
    const config = JSON.parse(await readFile(result.configPath, "utf-8"));
    expect(config).toMatchObject({ url: server.baseURL, token: server.token });

    // The saved config is what later commands use.
    const list = await cli(["list"], { configHome: result.configHome });
    expect(list.code, list.stderr).toBe(0);
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
    expect(list.code, list.stderr).toBe(0);
    expect(list.stdout).toContain(file.name);
    expect(list.stdout).toContain(url);

    const del = await cli(["delete", url], { auth: true });
    expect(del.code, del.stderr).toBe(0);
    expect(del.stderr).toContain(`Deleted ${id}`);

    const page = await fetch(url);
    expect(page.status).toBe(404);
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

      const del = await cli(["delete", url], { auth: true });
      expect(del.code, del.stderr).toBe(0);
      expect((await fetch(url)).status).toBe(404);
    },
  );
});
