import {
  encodeListCursor,
  isBearerAttempt,
  parseExpiry,
  parseListCursor,
  partCount,
  rateLimitClient,
  readTextUpTo,
} from "../../../packages/worker/src/parse.js";
import { expect, test } from "../../lib/index.js";

// Decisions the Worker makes on raw header and cookie values, checked on its
// module directly where the HTTP path cannot show them.

test.describe("strict parsing", () => {
  // `wrangler dev` drops an empty Authorization header before the Worker sees
  // it (an empty X-Anything arrives), and so does Cloudflare's edge (measured
  // in phase 1H), so this cannot be shown end to end. Should an empty header
  // ever arrive, it must count as a failed Bearer attempt, never fall
  // through to the session cookie.
  test("an Authorization header, even an empty one, is a Bearer attempt", () => {
    expect(isBearerAttempt("")).toBe(true);
    expect(isBearerAttempt("Bearer x")).toBe(true);
    expect(isBearerAttempt(undefined)).toBe(false);
    expect(isBearerAttempt(null)).toBe(false); // Headers.get() of a missing header
  });

  test("rate limits key IPv4 by address and IPv6 by /64", () => {
    for (const [ip, key] of [
      ["192.0.2.7", "192.0.2.7"],
      ["unknown", "unknown"],
      ["2001:db8:1:2::1", "2001:db8:1:2::/64"],
      ["2001:0DB8:0001:0002:aaaa:bbbb:cccc:dddd", "2001:db8:1:2::/64"],
      ["2001:db8:1:2:3:4:5:6", "2001:db8:1:2::/64"],
      ["2001:db8::1", "2001:db8:0:0::/64"],
      ["2001:db8:1::", "2001:db8:1:0::/64"],
      ["::1", "0:0:0:0::/64"],
      ["::ffff:192.0.2.1", "192.0.2.1"], // IPv4-mapped: the IPv4 client
      ["2001:db8:1:2:3:4:192.0.2.1", "2001:db8:1:2::/64"],
      ["fe80::1%eth0", "fe80:0:0:0::/64"],
      // Not an IPv6 address: left as is rather than guessed at.
      ["2001:db8::1::2", "2001:db8::1::2"],
      ["1:2:3:4:5:6:7", "1:2:3:4:5:6:7"],
      ["1:2:3:4:5:6:7:8:9", "1:2:3:4:5:6:7:8:9"],
      ["g001:db8:1:2::1", "g001:db8:1:2::1"],
    ] as const) {
      expect(rateLimitClient(ip), ip).toBe(key);
    }
  });

  test("an expiry is only accepted spelled exactly as signed", () => {
    expect(parseExpiry("1791447043")).toBe(1791447043);
    expect(parseExpiry("1")).toBe(1);
    expect(parseExpiry("999999999999")).toBe(999999999999);
    for (const value of [
      "01791447043",
      "0",
      "1791447043.0",
      "0x6ac6f803",
      "1.791447043e9",
      " 1791447043",
      "+1791447043",
      "1000000000000",
      "",
      undefined,
    ]) {
      expect(parseExpiry(value), JSON.stringify(value)).toBeNull();
    }
  });

  test("a listing cursor: round trip, and only the server's own spelling of a key under the prefix", () => {
    const prefix = "uploads/";
    for (const key of [
      "uploads/",
      "uploads/aB3x_Q0",
      "uploads/aB3x_Q/.downloads/2026-06-01T00:00:00.000Z_0a1b2c3d",
      "uploads/a/é \u{1F600}~",
      `uploads/${"x".repeat(1024 - "uploads/".length)}`,
    ]) {
      const cursor = encodeListCursor(key);
      expect(cursor, key).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(parseListCursor(cursor, prefix), key).toBe(key);
    }
    const b64 = (text: string) => Buffer.from(text, "utf-8").toString("base64url");
    // 10 bytes: the last character carries 4 unused bits; setting one gives
    // a second spelling of the same bytes.
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const canonical = b64("uploads/ab");
    const nonCanonical = canonical.slice(0, -1) + alphabet[alphabet.indexOf(canonical.at(-1)!) | 1];
    expect(Buffer.from(nonCanonical, "base64url").toString()).toBe("uploads/ab");
    expect(parseListCursor(canonical, prefix)).toBe("uploads/ab");
    for (const [name, value] of [
      ["empty", ""],
      ["not base64url", "dXBsb2Fkcy9h+A"],
      ["padding", `${b64("uploads/ab")}==`],
      ["standard base64 alphabet", "dXBsb2Fkcy9hYj8/"],
      ["length 4n + 1", `${b64("uploads/abcd")}A`], // 16 + 1 characters
      ["non-canonical trailing bits", nonCanonical],
      ["outside the prefix", b64("other/a")],
      ["the prefix without its slash", b64("uploads")],
      ["a sibling prefix", b64("uploadsX/a")],
      ["dot-segments", b64("../uploads/a")],
      [
        "invalid UTF-8",
        Buffer.from([...Buffer.from("uploads/"), 0xff, 0xfe]).toString("base64url"),
      ],
      ["longer than an R2 key", b64(`uploads/${"x".repeat(1024)}`)],
      ["whitespace", ` ${b64("uploads/a")}`],
    ] as const) {
      expect(parseListCursor(value, prefix), name).toBeNull();
    }
  });

  test("the part count of a size: an empty file is one part", () => {
    const part = 50 * 1024 * 1024;
    for (const [size, count] of [
      [0, 1],
      [1, 1],
      [part - 1, 1],
      [part, 1],
      [part + 1, 2],
      [3 * part, 3],
      [10_000 * part, 10_000],
    ] as const) {
      expect(partCount(size, part), String(size)).toBe(count);
    }
  });

  test("a body is read up to a byte limit, and no further", async () => {
    const stream = (chunks: string[]) => {
      let pulled = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          const next = chunks[pulled++];
          if (next === undefined) controller.close();
          else controller.enqueue(new TextEncoder().encode(next));
        },
      });
      return { body, pulled: () => pulled };
    };
    expect(await readTextUpTo(null, 10)).toBe("");
    expect(await readTextUpTo(stream(["ab", "cd"]).body, 4)).toBe("abcd");
    // Multi-byte characters split across chunks decode whole.
    const euro = new TextEncoder().encode("€");
    const split = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(euro.slice(0, 1));
        controller.enqueue(euro.slice(1));
        controller.close();
      },
    });
    expect(await readTextUpTo(split, 3)).toBe("€");
    // Over the limit: null, and the rest is never pulled.
    const long = stream(["ab", "cd", "e", "f", "g"]);
    expect(await readTextUpTo(long.body, 4)).toBeNull();
    expect(long.pulled()).toBeLessThanOrEqual(4);
  });
});
