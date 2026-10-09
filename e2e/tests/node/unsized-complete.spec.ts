import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  MAX_UNSIZED_PARTS,
  PART_RECORDS_BUDGET,
  Uploads,
} from "../../../packages/worker/src/uploads.js";
import { cli, expect, fileWith, randomFile, test } from "../../lib/index.js";
import { REAL_R2_CAPS, StrictBucket } from "../../lib/strict-r2.js";

// Round 1K: `POST /api/uploads/:id/complete` of an upload of unknown size
// reads at most MAX_UNSIZED_PARTS part records and refuses more (CPU: 4,000
// records took 82 to 138 ms on Workers Free in phase 1J). The CLI and the
// upload page always send the size, so they never meet that limit: the CLI
// is checked here against a stand-in server, the page in
// tests/browser/upload.spec.ts. The server side is in upload-api.spec.ts
// (wrangler dev) and r2-budget.spec.ts (R2 calls).

const P = "uploads";

test.describe("readPartSizes with a record limit", () => {
  test(`lists at most ${MAX_UNSIZED_PARTS + 1} records, on full and random short pages`, async () => {
    for (const randomPages of [false, true]) {
      for (const seed of [1, 2, 3, 4, 5]) {
        for (const parts of [0, 1, 299, MAX_UNSIZED_PARTS, MAX_UNSIZED_PARTS + 1, 4000]) {
          const b = new StrictBucket({ randomPages, seed: seed * 10_000 + parts, maxCalls: 1000 });
          Object.assign(b, REAL_R2_CAPS);
          for (let n = 1; n <= parts; n++) b.seed(`${P}/x/.parts/${n}`, "", { size: "5" });
          b.reset();
          const r = await new Uploads(b, P).readPartSizes(
            "x",
            PART_RECORDS_BUDGET,
            MAX_UNSIZED_PARTS,
          );
          const label = `${randomPages ? "random" : "full"} pages, seed ${seed}, ${parts} records`;
          expect(b.listed, label).toBeLessThanOrEqual(MAX_UNSIZED_PARTS + 1);
          expect(b.calls["list"] ?? 0, label).toBeLessThanOrEqual(PART_RECORDS_BUDGET);
          if (parts > MAX_UNSIZED_PARTS) expect(r, label).toBeNull();
          // Short pages may use up the call budget first (refused, never
          // wrong); with full pages every allowed upload is read whole.
          if (r) expect(r.keys, label).toHaveLength(parts);
          if (!randomPages && parts <= MAX_UNSIZED_PARTS) {
            expect(r?.keys, label).toHaveLength(parts);
            expect(b.calls["list"], label).toBe(1);
          }
        }
      }
    }
  });

  test("without a record limit it reads every record within its budget (as before)", async () => {
    const b = new StrictBucket({ maxCalls: 1000 });
    Object.assign(b, REAL_R2_CAPS);
    for (let n = 1; n <= 4000; n++) b.seed(`${P}/x/.parts/${n}`, "", { size: "5" });
    b.reset();
    const r = await new Uploads(b, P).readPartSizes("x", PART_RECORDS_BUDGET);
    expect(r?.keys).toHaveLength(4000);
  });
});

test.describe("the CLI always sends the size", () => {
  /**
   * A stand-in server that answers an upload with a tiny part size, so a
   * small file takes several parts, and records every request body.
   */
  async function upload(path: string, partSize: number) {
    const requests: { method: string; path: string; body: string }[] = [];
    const fake = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        const path = new URL(req.url!, "http://x").pathname;
        requests.push({ method: req.method!, path, body: Buffer.concat(chunks).toString() });
        const part = path.match(/\/parts\/(\d+)$/);
        const reply =
          req.method === "POST" && path === "/api/uploads"
            ? { id: "up1", part_size: partSize }
            : part
              ? { part_number: Number(part[1]), etag: `e${part[1]}` }
              : path.endsWith("/complete")
                ? { url: "http://127.0.0.1/up1/f" }
                : {};
        res.writeHead(req.method === "POST" && path === "/api/uploads" ? 201 : 200, {
          "Content-Type": "application/json",
        });
        res.end(JSON.stringify(reply));
      });
    });
    await new Promise<void>((resolve) => fake.listen(0, "127.0.0.1", resolve));
    try {
      const { port } = fake.address() as AddressInfo;
      const r = await cli(["upload", path], {
        env: { YEET_URL: `http://127.0.0.1:${port}`, YEET_TOKEN: "a-token-of-16-chars-or-more" },
      });
      return { code: r.code, requests };
    } finally {
      fake.closeAllConnections();
      await new Promise((resolve) => fake.close(resolve));
    }
  }

  test("an empty file, a one-part file and a many-part file: size in POST /api/uploads", async ({
    tmp,
  }) => {
    const empty = await fileWith(tmp, "empty.bin", "");
    const small = await randomFile(tmp, 10, "small.bin");
    // 1,000 bytes at a part size of 3: 334 parts, more than MAX_UNSIZED_PARTS.
    const many = await randomFile(tmp, 1000, "many.bin");
    for (const file of [empty, small, many]) {
      const r = await upload(file.path, 3);
      expect(r.code, file.name).toBe(0);
      const create = r.requests.find((h) => h.method === "POST" && h.path === "/api/uploads");
      expect(JSON.parse(create!.body), file.name).toMatchObject({ size: file.size });
      const parts = r.requests.filter((h) => h.method === "PUT").length;
      expect(parts, file.name).toBe(Math.max(1, Math.ceil(file.size / 3)));
    }
  });
});
