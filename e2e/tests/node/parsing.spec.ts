import {
  isBearerAttempt,
  parseExpiry,
  rateLimitClient,
} from "../../../packages/worker/src/parse.js";
import { expect, test } from "../../lib/index.js";

// Decisions the Worker makes on raw header and cookie values, checked on its
// module directly where the HTTP path cannot show them.

test.describe("strict parsing", () => {
  // `wrangler dev` drops an empty Authorization header before the Worker sees
  // it (an empty X-Anything arrives), so this cannot be shown end to end
  // locally. On Cloudflare the Worker gets whatever the edge passes on, and an
  // empty header present must count as a failed Bearer attempt, never fall
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
});
