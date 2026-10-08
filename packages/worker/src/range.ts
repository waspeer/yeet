// Range headers of `GET /_dl/:id` (RFC 9110 §14). The Worker parses them
// itself and only hands R2 a range it accepted, as a normalized header.

/**
 * A single byte range: `bytes=<start>-[<end>]`, or `bytes=-<suffix>` (the last
 * `suffix` bytes). Every number is a safe integer.
 */
export type ByteRange = { start: number; end?: number } | { suffix: number };

/**
 * A position from the header. Any number of digits is valid HTTP; one past
 * Number.MAX_SAFE_INTEGER (8 PiB) is clamped to it, which still means "past the
 * end" for every object R2 can store, and keeps it an exact integer (a double
 * would turn 99999999999999999999999 into 1e+23).
 */
function position(digits: string): number {
  return Math.min(Number(digits), Number.MAX_SAFE_INTEGER);
}

/**
 * The byte range of a Range header, or null to ignore the header and serve
 * the whole file (200). RFC 9110 §14.2 lets a server ignore a Range header it
 * finds invalid (bad syntax, a last position before the first) or does not
 * support (several ranges, another unit).
 */
export function parseRange(header: string | undefined): ByteRange | null {
  const match = header?.match(/^bytes=[ \t]*(\d*)-(\d*)[ \t]*$/i);
  if (!match) return null;
  const [, first = "", last = ""] = match;
  if (first === "") return last === "" ? null : { suffix: position(last) };
  const start = position(first);
  if (last === "") return { start };
  const end = position(last);
  return end >= start ? { start, end } : null;
}

/** The Range header R2 gets: plain decimal integers only. */
export function formatRange(range: ByteRange): string {
  const decimal = (n: number) => BigInt(n).toString();
  return "suffix" in range
    ? `bytes=-${decimal(range.suffix)}`
    : `bytes=${decimal(range.start)}-${range.end === undefined ? "" : decimal(range.end)}`;
}
