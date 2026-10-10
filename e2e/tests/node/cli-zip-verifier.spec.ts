// Gaps found by the round 2B verification's own mutants of the CLI's zip
// upload (packages/cli/src/upload-zip.ts), against a minimal stand-in server:
//
// - a zip that ends exactly on a part boundary: no empty extra part, no
//   dropped last part (cli-zip.spec.ts never lands on a boundary);
// - a second Ctrl-C quits at once while parts are still in flight (the
//   first one waits up to 30 s for them; claimed, but not tested before).

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  cli,
  expect,
  expectExitCode,
  fileWith,
  KiB,
  newConfigHome,
  randomFile,
  server,
  sleep,
  spawnCli,
  test,
} from "../../lib/index.js";
import { checkStructure, manifestOfFiles } from "../../zip/validate.js";

/** A stand-in yeet API with part size `partSize`; `hold` leaves every PUT unanswered. */
async function standIn(partSize: number, { hold = false } = {}) {
  const puts = new Map<number, Buffer>();
  let create: Record<string, unknown> | undefined;
  let complete: Record<string, unknown> | undefined;
  const deletes: string[] = [];
  const srv = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("error", () => {});
    req.on("end", () => {
      const path = new URL(req.url!, "http://x").pathname;
      const body = Buffer.concat(chunks);
      const part = path.match(/\/parts\/(\d+)$/);
      const json = (status: number, value: unknown) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(value));
      };
      if (req.method === "POST" && path === "/api/uploads") {
        create = JSON.parse(body.toString());
        return json(201, { id: "up1", part_size: partSize });
      }
      if (part) {
        puts.set(Number(part[1]), body);
        if (hold) return;
        return json(200, { part_number: Number(part[1]), etag: `e${part[1]}` });
      }
      if (path.endsWith("/complete")) {
        complete = JSON.parse(body.toString());
        return json(200, { url: "http://127.0.0.1/up1/stand-in.zip" });
      }
      if (req.method === "DELETE") deletes.push(path);
      return json(200, { deleted: "up1" });
    });
  });
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  return {
    env: { YEET_URL: url, YEET_TOKEN: "a-token-of-16-chars-or-more" },
    puts,
    create: () => create,
    complete: () => complete,
    deletes,
    zip: () => Buffer.concat([...puts.entries()].sort(([a], [b]) => a - b).map(([, body]) => body)),
    close: async () => {
      srv.closeAllConnections();
      await new Promise((resolve) => srv.close(resolve));
    },
  };
}

/** Upload `root` (a small folder) in one 1 MiB part; returns the zip it produced. */
async function zipOf(root: string, args: string[]): Promise<Buffer> {
  const s = await standIn(1024 * KiB);
  try {
    expectExitCode(await cli(["upload", root, ...args], { env: s.env }), 0);
    return s.zip();
  } finally {
    await s.close();
  }
}

test.describe("yeet upload <folder> (verifier): a zip that ends on a part boundary", () => {
  for (const store of [true, false]) {
    test(`${store ? "--store" : "deflated"}: exactly the parts it needs, none empty, none dropped`, async ({
      tmp,
    }) => {
      const root = join(tmp, "edge");
      await mkdir(root);
      const files = [
        await randomFile(root, 7 * KiB, "noise.bin"),
        await fileWith(root, "notes.txt", "boundary ".repeat(500)),
      ];
      const args = store ? ["--store"] : [];
      let whole = await zipOf(root, args);
      if (store && whole.length % 2 === 1) {
        // A stored zip grows by one byte with its input: make it even.
        await appendFile(files[1]!.path, "!");
        whole = await zipOf(root, args);
      }
      expect(store ? whole.length % 2 : 0).toBe(0);
      // --store: two parts of exactly half; deflated: one part of exactly all.
      const partSize = store ? whole.length / 2 : whole.length;
      const s = await standIn(partSize);
      try {
        const r = await cli(["upload", root, ...args], { env: s.env });
        expectExitCode(r, 0);
        const count = store ? 2 : 1;
        expect([...s.puts.keys()].sort()).toEqual(Array.from({ length: count }, (_, i) => i + 1));
        expect([...s.puts.values()].map((b) => b.length)).toEqual(Array(count).fill(partSize));
        expect(s.complete()).toEqual({
          size: whole.length,
          parts: Array.from({ length: count }, (_, i) => ({
            part_number: i + 1,
            etag: `e${i + 1}`,
          })),
        });
        if (store) expect(s.create()).toMatchObject({ size: whole.length });
        expect(s.zip().equals(whole)).toBe(true);
        const path = join(tmp, "got.zip");
        await writeFile(path, s.zip());
        const zipFiles = files.map((f) => ({
          source: f.path,
          path: `edge/${f.path.slice(root.length + 1)}`,
        }));
        const check = await checkStructure(path, await manifestOfFiles(zipFiles));
        expect(check.ok, check.output).toBe(true);
      } finally {
        await s.close();
      }
    });
  }
});

test.describe("yeet upload <folder> (verifier): Ctrl-C twice", () => {
  test("the second Ctrl-C quits at once, without waiting for the parts in flight", async ({
    tmp,
  }) => {
    const root = join(tmp, "album");
    await mkdir(root);
    await randomFile(root, 20 * KiB, "noise.bin");
    const s = await standIn(1000, { hold: true });
    const home = await newConfigHome();
    try {
      const child = spawnCli([server.cliPath, "upload", root], {
        env: { ...process.env, ...s.env, HOME: home, XDG_CONFIG_HOME: home, NO_COLOR: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stderr = "";
      child.stderr!.setEncoding("utf-8").on("data", (c: string) => (stderr += c));
      const closed = new Promise<number | null>((resolve) => child.on("close", resolve));
      const deadline = Date.now() + 10_000;
      while (s.puts.size === 0 && Date.now() < deadline) await sleep(20);
      expect(s.puts.size, "a part in flight").toBeGreaterThan(0);
      child.kill("SIGINT");
      // The first Ctrl-C waits for the held parts (up to 30 s): still running.
      const early = await Promise.race([closed, sleep(500).then(() => "running" as const)]);
      expect(early, stderr).toBe("running");
      const second = performance.now();
      child.kill("SIGINT");
      const code = await Promise.race([closed, sleep(5_000).then(() => "still running")]);
      expect(code, stderr).toBe(130);
      expect(performance.now() - second).toBeLessThan(5_000);
      expect(s.complete()).toBeUndefined();
    } finally {
      await s.close();
    }
  });
});
