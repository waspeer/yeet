import { formatRange, parseRange } from "../../../packages/worker/src/range.js";
import { expect, test } from "../../lib/index.js";

// What R2 receives for a Range header: checked on the Worker's module itself,
// since the request to R2 is not observable from outside. The e2e cases in
// http.spec.ts check the bytes that come back.

test.describe("Range header sent to R2", () => {
  for (const [header, sent] of [
    ["bytes=0-99999999999999999999999", "bytes=0-9007199254740991"],
    ["bytes=99999999999999999999999-", "bytes=9007199254740991-"],
    ["bytes=-99999999999999999999999", "bytes=-9007199254740991"],
    ["bytes=1-9007199254740993", "bytes=1-9007199254740991"],
    ["bytes=000001-0000003", "bytes=1-3"],
    ["bytes=-5", "bytes=-5"],
    ["bytes=7-", "bytes=7-"],
  ] as const) {
    test(`"${header}" goes to R2 as "${sent}"`, () => {
      const range = parseRange(header);
      expect(range).not.toBeNull();
      const formatted = formatRange(range!);
      expect(formatted).toBe(sent);
      expect(formatted).toMatch(/^bytes=(\d+-\d*|-\d+)$/);
    });
  }
});
