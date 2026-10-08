import { isBearerAttempt, parseExpiry } from "../../../packages/worker/src/parse.js";
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
