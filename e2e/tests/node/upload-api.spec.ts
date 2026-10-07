import { randomBytes } from "node:crypto";
import {
  api,
  apiJson,
  downloadBytes,
  eventually,
  expect,
  listUploads,
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
    expect((await downloadBytes(url)).equals(data)).toBe(true);
    // The part-size records are gone once complete.
    expect((await uploadObjects(id)).map((o) => o.key).sort()).toEqual([
      `uploads/${id}/.meta.json`,
      `uploads/${id}/no-size.bin`,
    ]);
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
