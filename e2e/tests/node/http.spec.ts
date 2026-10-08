import { randomBytes } from "node:crypto";
import { expect, FILENAMES, signedDownloadUrl, test, uploadViaApi } from "../../lib/index.js";

// One upload shared by the tests in this file (per worker).
const data = randomBytes(300 * 1024);
let shareUrl: string;

test.beforeAll(async () => {
  ({ url: shareUrl } = await uploadViaApi({ filename: "range-test.bin", data }));
});

test.describe("signed download link", () => {
  test("serves the whole file with an attachment Content-Disposition", async () => {
    const res = await fetch(await signedDownloadUrl(shareUrl));

    expect(res.status).toBe(200);
    expect(res.headers.get("content-length")).toBe(String(data.length));
    expect(res.headers.get("accept-ranges")).toBe("bytes");
    expect(res.headers.get("content-disposition")).toBe(
      "attachment; filename*=UTF-8''range-test.bin",
    );
    expect(Buffer.from(await res.arrayBuffer()).equals(data)).toBe(true);
  });

  test("encodes special characters in the Content-Disposition filename (RFC 8187)", async () => {
    const { url } = await uploadViaApi({
      filename: FILENAMES.punctuation,
      data: Buffer.from("x"),
    });
    const res = await fetch(await signedDownloadUrl(url));
    expect(res.headers.get("content-disposition")).toBe(
      "attachment; filename*=UTF-8''it%27s%20%28really%29%20%231%20%26%2050%25%20done%21.txt",
    );
  });

  test("a Range request returns 206 with exactly those bytes", async () => {
    const link = await signedDownloadUrl(shareUrl);

    const res = await fetch(link, { headers: { Range: "bytes=1000-1999" } });
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe(`bytes 1000-1999/${data.length}`);
    expect(res.headers.get("content-length")).toBe("1000");
    expect(Buffer.from(await res.arrayBuffer()).equals(data.subarray(1000, 2000))).toBe(true);

    // Open-ended range, as a resuming download sends it.
    const tailRes = await fetch(link, { headers: { Range: `bytes=${data.length - 10}-` } });
    expect(tailRes.status).toBe(206);
    expect(tailRes.headers.get("content-range")).toBe(
      `bytes ${data.length - 10}-${data.length - 1}/${data.length}`,
    );
    expect(Buffer.from(await tailRes.arrayBuffer()).equals(data.subarray(-10))).toBe(true);
  });

  test("a range starting past the end returns 416", async () => {
    const res = await fetch(await signedDownloadUrl(shareUrl), {
      headers: { Range: `bytes=${data.length}-` },
    });
    expect(res.status).toBe(416);
    expect(res.headers.get("content-range")).toBe(`bytes */${data.length}`);
  });

  test.describe("Range headers on a 5-byte file", () => {
    const five = Buffer.from("01234");
    let link: string;

    test.beforeAll(async () => {
      link = await signedDownloadUrl(
        (await uploadViaApi({ filename: "five.txt", data: five })).url,
      );
    });

    // RFC 9110 §14.2: a Range header that is invalid, or that the server does not
    // support (several ranges, another unit), is ignored: 200 with the whole file.
    for (const range of [
      "bytes=3-1",
      "bytes=abc",
      "bytes=1-x",
      "bytes=",
      "bytes=-",
      "bytes=0-1,3-4",
      "bytes=1-2, 4-",
      "items=0-1",
      "0-1",
    ]) {
      test(`"${range}" is ignored: 200 with the whole file`, async () => {
        const res = await fetch(link, { headers: { Range: range } });
        expect(res.status).toBe(200);
        expect(res.headers.get("content-range")).toBeNull();
        expect(res.headers.get("content-length")).toBe("5");
        expect(res.headers.get("accept-ranges")).toBe("bytes");
        expect(Buffer.from(await res.arrayBuffer()).toString()).toBe("01234");
      });
    }

    for (const [range, start, end] of [
      ["bytes=1-3", 1, 3],
      ["bytes=0-0", 0, 0],
      ["bytes=4-4", 4, 4],
      ["bytes=2-", 2, 4],
      ["bytes=2-100", 2, 4], // a last position past the end is clamped
      ["bytes=-2", 3, 4],
      ["bytes=-5", 0, 4],
      ["bytes=-10", 0, 4], // a suffix longer than the file is the whole file
      ["BYTES=1-2", 1, 2], // the unit is case-insensitive
      // Numbers too big for a double still mean "past the end": never 1e+23.
      ["bytes=0-99999999999999999999999", 0, 4],
      ["bytes=2-99999999999999999999999", 2, 4],
      ["bytes=1-9007199254740993", 1, 4],
      ["bytes=-99999999999999999999999", 0, 4],
      ["bytes=000001-0000003", 1, 3], // leading zeros
    ] as const) {
      test(`"${range}" returns 206 with bytes ${start}-${end}`, async () => {
        const res = await fetch(link, { headers: { Range: range } });
        expect(res.status).toBe(206);
        expect(res.headers.get("content-range")).toBe(`bytes ${start}-${end}/5`);
        expect(res.headers.get("content-length")).toBe(String(end - start + 1));
        expect(Buffer.from(await res.arrayBuffer()).toString()).toBe(
          five.subarray(start, end + 1).toString(),
        );
      });
    }

    for (const range of [
      "bytes=5-",
      "bytes=5-9",
      "bytes=99-",
      "bytes=-0",
      "bytes=99999999999999999999999-",
      "bytes=99999999999999999999999-99999999999999999999999",
      "bytes=-00",
    ]) {
      test(`"${range}" is unsatisfiable: 416`, async () => {
        const res = await fetch(link, { headers: { Range: range } });
        expect(res.status).toBe(416);
        expect(res.headers.get("content-range")).toBe("bytes */5");
        expect((await res.arrayBuffer()).byteLength).toBe(0);
      });
    }
  });

  test("an empty file: a suffix range is served whole, any first position is unsatisfiable", async () => {
    const empty = await uploadViaApi({ filename: "empty.txt", data: Buffer.alloc(0) });
    const link = await signedDownloadUrl(empty.url);

    const suffix = await fetch(link, { headers: { Range: "bytes=-5" } });
    expect(suffix.status).toBe(200);
    expect(suffix.headers.get("content-range")).toBeNull();
    expect(suffix.headers.get("content-length")).toBe("0");
    expect((await suffix.arrayBuffer()).byteLength).toBe(0);

    const open = await fetch(link, { headers: { Range: "bytes=0-" } });
    expect(open.status).toBe(416);
    expect(open.headers.get("content-range")).toBe("bytes */0");
  });

  test("a tampered signature or expiry returns 403", async () => {
    const link = new URL(await signedDownloadUrl(shareUrl));
    const sig = link.searchParams.get("sig")!;
    const expires = Number(link.searchParams.get("expires"));

    const badSig = new URL(link);
    badSig.searchParams.set("sig", (sig[0] === "A" ? "B" : "A") + sig.slice(1));
    expect((await fetch(badSig)).status).toBe(403);

    const laterExpiry = new URL(link);
    laterExpiry.searchParams.set("expires", String(expires + 3600));
    expect((await fetch(laterExpiry)).status).toBe(403);

    const noSig = new URL(link);
    noSig.searchParams.delete("sig");
    expect((await fetch(noSig)).status).toBe(403);

    // The untouched link still works, so the 403s above are about the tampering.
    expect((await fetch(link)).status).toBe(200);
  });
});
