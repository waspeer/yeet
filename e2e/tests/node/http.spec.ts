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
