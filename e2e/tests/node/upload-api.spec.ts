import { MAX_UNSIZED_PARTS } from "../../../packages/worker/src/uploads.js";
import { randomBytes } from "node:crypto";
import {
  api,
  apiJson,
  downloadBytes,
  eventually,
  expect,
  listObjects,
  listUploads,
  putObject,
  readUploadMeta,
  server,
  test,
  uploadObjects,
} from "../../lib/index.js";

const PART_SIZE = 50 * 1024 * 1024;

async function create(body: Record<string, unknown>): Promise<string> {
  const { id, part_size } = await apiJson<{ id: string; part_size: number }>("/api/uploads", {
    method: "POST",
    body: JSON.stringify({ expires_in: 3600, ...body }),
  });
  expect(part_size).toBe(PART_SIZE);
  return id;
}

function putPart(id: string, n: number, data: Uint8Array): Promise<Response> {
  return api(`/api/uploads/${id}/parts/${n}`, {
    method: "PUT",
    body: data as Uint8Array<ArrayBuffer>,
  });
}

async function putPartJson(id: string, n: number, data: Uint8Array) {
  const res = await putPart(id, n, data);
  const text = await res.text();
  expect(res.status, text).toBe(200);
  return JSON.parse(text) as { part_number: number; etag: string };
}

function complete(id: string, body: unknown): Promise<Response> {
  return api(`/api/uploads/${id}/complete`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

test.describe("upload API", () => {
  test("expires_in must be whole seconds from 1 to 365 days; nothing is created otherwise", async () => {
    const YEAR = 365 * 24 * 60 * 60;
    for (const expiresIn of [1e308, YEAR + 1, 1.5, 0, -60, 3600.25, "3600", null, true]) {
      const filename = `expires-${randomBytes(6).toString("hex")}.bin`;
      const res = await api("/api/uploads", {
        method: "POST",
        body: JSON.stringify({ filename, size: 1, expires_in: expiresIn }),
        headers: { "Content-Type": "application/json" },
      });
      const detail = `expires_in ${JSON.stringify(expiresIn)}`;
      expect(res.status, detail).toBe(400);
      expect(await res.json(), detail).toEqual({
        error: "Invalid expires_in: whole seconds from 1 to 31536000 (365 days)",
      });
      const keys = (await listObjects()).map((object) => object.key);
      expect(
        keys.filter((key) => key.endsWith(`/${filename}`)),
        detail,
      ).toEqual([]);
    }
    // The bounds themselves are fine.
    for (const expiresIn of [1, YEAR]) {
      const id = await create({ filename: "bounds.bin", size: 1, expires_in: expiresIn });
      const meta = (await readUploadMeta(id))!;
      expect(Date.parse(meta.expires_at) - Date.parse(meta.uploaded_at)).toBe(expiresIn * 1000);
      expect((await api(`/api/uploads/${id}`, { method: "DELETE" })).status).toBe(200);
    }
  });

  test("size is optional at create; file_size comes from the stored object", async () => {
    const data = randomBytes(12_345);
    const id = await create({ filename: "no-size.bin" });
    expect((await readUploadMeta(id))?.file_size).toBeUndefined();

    const part = await putPartJson(id, 1, data);
    const res = await complete(id, { parts: [part] });
    expect(res.status, await res.clone().text()).toBe(200);
    const { url } = await res.json();

    expect((await readUploadMeta(id))?.file_size).toBe(12_345);
    expect((await listUploads()).find((u) => u.id === id)?.file_size).toBe(12_345);
    // The part-size records are gone once complete. (Checked before the
    // download, which adds a download record.)
    expect((await uploadObjects(id)).map((o) => o.key).sort()).toEqual([
      `uploads/${id}/.meta.json`,
      `uploads/${id}/no-size.bin`,
    ]);
    expect((await downloadBytes(url)).equals(data)).toBe(true);
  });

  test("a size given at create or complete is checked against the stored object", async () => {
    const data = randomBytes(100);
    const id = await create({ filename: "sized.bin", size: 100 });
    const part = await putPartJson(id, 1, data);
    const res = await complete(id, { parts: [part], size: 100 });
    expect(res.status).toBe(200);
    expect((await readUploadMeta(id))?.file_size).toBe(100);
  });

  test("an invalid size at create or complete is a 400", async () => {
    for (const size of [-1, 1.5, "10", null, Number.MAX_SAFE_INTEGER + 2]) {
      const res = await api("/api/uploads", {
        method: "POST",
        body: JSON.stringify({ filename: "x.bin", size, expires_in: 60 }),
      });
      expect(res.status, JSON.stringify(size)).toBe(400);
      expect(await res.json()).toEqual({ error: "Invalid size" });
    }
    const id = await create({ filename: "x.bin" });
    const part = await putPartJson(id, 1, randomBytes(4));
    expect((await complete(id, { parts: [part], size: "4" })).status).toBe(400);
    expect((await complete(id, { parts: [part], size: 4 })).status).toBe(200);
  });

  test("size mismatch at complete: 422 with both numbers, and the upload is gone", async () => {
    const id = await create({ filename: "liar.bin" });
    const part = await putPartJson(id, 1, randomBytes(50));
    const res = await complete(id, { parts: [part], size: 100 });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body).toEqual({
      error: "Size mismatch: expected 100 bytes, stored 50",
      expected_size: 100,
      stored_size: 50,
    });
    await eventually(async () => (await uploadObjects(id)).length === 0, {
      message: `uploads/${id}/ to be empty`,
    });
    expect((await fetch(`${server.baseURL}/${id}/liar.bin`)).status).toBe(404);
  });

  test("a part number must be plain decimal digits without leading zeros", async () => {
    const id = await create({ filename: "part-numbers.bin" });
    for (const n of ["1.0", "0x1", "01", "+1", "1e0", " 1", "0", "10001"]) {
      const res = await api(`/api/uploads/${id}/parts/${encodeURIComponent(n)}`, {
        method: "PUT",
        body: "x",
      });
      expect(res.status, `part "${n}"`).toBe(400);
      expect(await res.json(), `part "${n}"`).toEqual({ error: "Invalid upload or part number" });
    }
    expect((await putPart(id, 1, Buffer.from("x"))).status).toBe(200);
    expect((await api(`/api/uploads/${id}`, { method: "DELETE" })).status).toBe(200);
  });

  test("a part without Content-Length is refused with 411", async () => {
    const id = await create({ filename: "chunked.bin" });
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(10));
        controller.close();
      },
    });
    const res = await api(`/api/uploads/${id}/parts/1`, {
      method: "PUT",
      body: stream,
      duplex: "half",
    } as RequestInit);
    expect(res.status).toBe(411);
    expect(await res.json()).toEqual({ error: "Content-Length required" });
    await api(`/api/uploads/${id}`, { method: "DELETE" });
  });

  test("a part larger than part_size is refused with 413", async () => {
    const id = await create({ filename: "big.bin" });
    let data: Buffer | null = Buffer.alloc(PART_SIZE + 1);
    const res = await putPart(id, 1, data);
    data = null;
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "Part larger than part_size" });
    // Exactly part_size is fine.
    expect((await putPart(id, 1, Buffer.alloc(PART_SIZE))).status).toBe(200);
    await api(`/api/uploads/${id}`, { method: "DELETE" });
  });

  test("size known: a part of the wrong length or beyond the end is refused right away", async () => {
    const id = await create({ filename: "known.bin", size: PART_SIZE + 10 });

    const short = await putPart(id, 1, randomBytes(10));
    expect(short.status).toBe(400);
    expect((await short.json()).error).toBe(
      `Part 1 must be ${PART_SIZE} bytes, got 10: every part except the last must be exactly part_size (${PART_SIZE} bytes)`,
    );

    const wrongLast = await putPart(id, 2, randomBytes(11));
    expect(wrongLast.status).toBe(400);
    expect((await wrongLast.json()).error).toMatch(/^Part 2 must be 10 bytes, got 11/);

    const beyond = await putPart(id, 3, randomBytes(1));
    expect(beyond.status).toBe(400);
    expect((await beyond.json()).error).toBe(
      `Part 3 is beyond the declared size of ${PART_SIZE + 10} bytes`,
    );

    // The right length for the last part is accepted.
    expect((await putPart(id, 2, randomBytes(10))).status).toBe(200);
    await api(`/api/uploads/${id}`, { method: "DELETE" });
  });

  test("size unknown: a short part followed by a higher one is a clear 400 at complete", async () => {
    const id = await create({ filename: "layout.bin" });
    const one = await putPartJson(id, 1, randomBytes(10));
    const two = await putPartJson(id, 2, randomBytes(10));

    const res = await complete(id, { parts: [one, two] });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe(
      `Part 1 is 10 bytes but is followed by more parts: every part except the last must be exactly part_size (${PART_SIZE} bytes)`,
    );
    // Not completed: still pending, and part 1 alone is a valid layout.
    expect((await readUploadMeta(id))?.pending_upload_id).toBeTruthy();
    expect((await complete(id, { parts: [one] })).status).toBe(200);
    expect((await readUploadMeta(id))?.file_size).toBe(10);
  });

  test("size unknown: completing with a part that was never uploaded is a 400", async () => {
    const id = await create({ filename: "gap.bin" });
    const one = await putPartJson(id, 1, randomBytes(10));
    const res = await complete(id, { parts: [one, { part_number: 2, etag: "made-up" }] });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Part 2 was not uploaded" });
    await api(`/api/uploads/${id}`, { method: "DELETE" });
  });

  /** Part records 2..n+1 of an upload, written directly (as `PUT` would, size 10). */
  async function seedPartRecords(id: string, n: number) {
    const keys = Array.from(
      { length: n },
      (_, i) => `${server.uploadsPrefix}/${id}/.parts/${i + 2}`,
    );
    for (let i = 0; i < keys.length; i += 50) {
      await Promise.all(
        keys.slice(i, i + 50).map((key) => putObject(key, "", { customMetadata: { size: "10" } })),
      );
    }
  }
  const TOO_MANY =
    `Too many parts to complete an upload of unknown size (at most ${MAX_UNSIZED_PARTS}); ` +
    `start the upload again and send its size ("size" in POST /api/uploads)`;

  test(`size unknown: more than ${MAX_UNSIZED_PARTS} part records is a 400 before completing`, async () => {
    // Round 1K: MAX_UNSIZED_PARTS records at most (before: as many as 46 R2
    // calls could list and delete, 4,100 at 100 per call). Records of parts
    // not in the request count too. Seeded directly.
    const id = await create({ filename: "many-parts.bin" });
    const one = await putPartJson(id, 1, randomBytes(10));
    await seedPartRecords(id, MAX_UNSIZED_PARTS);

    const res = await complete(id, { parts: [one] });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: TOO_MANY });
    // Nothing changed: still pending, every record still there.
    expect((await readUploadMeta(id))?.pending_upload_id).toBeTruthy();
    expect(await listObjects(`${server.uploadsPrefix}/${id}/.parts/`)).toHaveLength(
      MAX_UNSIZED_PARTS + 1,
    );
    expect((await api(`/api/uploads/${id}`, { method: "DELETE" })).status).toBe(200);
  });

  test(`size unknown: exactly ${MAX_UNSIZED_PARTS} part records complete, and the records are deleted`, async () => {
    const id = await create({ filename: "limit-parts.bin" });
    const one = await putPartJson(id, 1, randomBytes(10));
    await seedPartRecords(id, MAX_UNSIZED_PARTS - 1);

    const res = await complete(id, { parts: [one] });
    expect(res.status).toBe(200);
    expect((await readUploadMeta(id))?.file_size).toBe(10);
    expect(await listObjects(`${server.uploadsPrefix}/${id}/.parts/`)).toHaveLength(0);
    expect((await api(`/api/uploads/${id}`, { method: "DELETE" })).status).toBe(200);
  });

  test(`size unknown: a parts array of more than ${MAX_UNSIZED_PARTS} is a 400 at once`, async () => {
    const id = await create({ filename: "long-array.bin" });
    const parts = Array.from({ length: MAX_UNSIZED_PARTS + 1 }, (_, i) => ({
      part_number: i + 1,
      etag: "made-up",
    }));
    const res = await complete(id, { parts });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: TOO_MANY });
    expect((await readUploadMeta(id))?.pending_upload_id).toBeTruthy();
    // With the size known at create, the same array is not refused for its
    // length (R2's own error for the made-up etags instead).
    const sized = await create({
      filename: "long-array-sized.bin",
      size: (MAX_UNSIZED_PARTS + 1) * PART_SIZE,
    });
    const other = await complete(sized, { parts });
    expect(other.status).toBe(400);
    expect((await other.json()).error).not.toBe(TOO_MANY);
    for (const upload of [id, sized]) {
      expect((await api(`/api/uploads/${upload}`, { method: "DELETE" })).status).toBe(200);
    }
  });

  test("an invalid parts array is a 400 before anything is completed", async () => {
    const id = await create({ filename: "parts.bin" });
    const part = await putPartJson(id, 1, randomBytes(10));
    const cases: [unknown, string][] = [
      [{}, "Missing parts"],
      [{ parts: [] }, "Missing parts"],
      [{ parts: "1" }, "Missing parts"],
      [{ parts: [part, part] }, "Invalid parts: part 1 is listed twice"],
      [
        { parts: [{ ...part, part_number: 2 }] },
        "Invalid parts: part 1 is missing (parts must be numbered 1 to 1)",
      ],
      [
        { parts: [{ ...part, part_number: 0 }] },
        "Invalid parts: every part needs a part_number of 1 or more",
      ],
      [
        { parts: [{ ...part, part_number: "1" }] },
        "Invalid parts: every part needs a part_number of 1 or more",
      ],
      [{ parts: [{ part_number: 1, etag: 7 }] }, "Invalid parts: part 1 needs an etag string"],
      [{ parts: [{ part_number: 1 }] }, "Invalid parts: part 1 needs an etag string"],
      [{ parts: [null] }, "Invalid parts: every part needs a part_number of 1 or more"],
    ];
    for (const [body, error] of cases) {
      const res = await complete(id, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(await res.json(), JSON.stringify(body)).toEqual({ error });
    }
    // None of those completed it.
    expect((await readUploadMeta(id))?.pending_upload_id).toBeTruthy();
    expect((await complete(id, { parts: [part] })).status).toBe(200);
  });
});
