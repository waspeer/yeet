// Strict parsing of raw request values. No Workers APIs, so the e2e suite
// unit-tests it in Node (e2e/tests/node/parsing.spec.ts).

/**
 * An expiry timestamp as signed: a positive decimal integer of at most 12
 * digits, without leading zeros. Signatures cover the number, so any other
 * spelling of it ("0123", "123.0", "0x7b") would otherwise pass as the same.
 */
export function parseExpiry(value: string | undefined): number | null {
  return value && /^[1-9]\d{0,11}$/.test(value) ? Number(value) : null;
}

/** R2 keys are at most 1,024 bytes; so is the key a listing cursor holds. */
const MAX_KEY_BYTES = 1024;

function toBase64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * The opaque `cursor` of GET /api/uploads for the key the next page starts
 * after: base64url (no padding) of its UTF-8 bytes. parseListCursor()
 * reads it back.
 */
export function encodeListCursor(key: string): string {
  return toBase64url(new TextEncoder().encode(key));
}

/**
 * The key a `cursor` of GET /api/uploads holds, or null if it is not one
 * the server could have made for `prefix` (`<UPLOADS_PREFIX>/`): only
 * base64url characters, the one canonical spelling (re-encoding gives the
 * same text, so no padding and no stray bits), valid UTF-8, at most 1,024
 * bytes, and starting with `prefix`. The listing only ever lists under
 * `prefix` whatever the key, so this is strictness, not the boundary.
 */
export function parseListCursor(value: string, prefix: string): string | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length > Math.ceil((MAX_KEY_BYTES * 4) / 3)) {
    return null;
  }
  let bytes: Uint8Array;
  try {
    const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
    bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
  } catch {
    return null; // e.g. a length of 4n + 1
  }
  if (bytes.length > MAX_KEY_BYTES || toBase64url(bytes) !== value) return null;
  let key: string;
  try {
    key = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return null;
  }
  return key.startsWith(prefix) ? key : null;
}

/**
 * Whether a request makes a Bearer attempt: it has an Authorization header,
 * even an empty one. Such a request is decided by that header alone, and a
 * wrong (or empty) one counts as a failed guess.
 */
export function isBearerAttempt(header: string | null | undefined): header is string {
  return typeof header === "string";
}

/**
 * The part of a client address the rate limits are keyed by: an IPv4 address
 * as is, an IPv6 address by its /64 (`2001:db8:1:2::/64`). One IPv6 client
 * usually gets a whole /64 and can pick any address in it, so keying by the
 * full address would give it 2^64 budgets. Anything else is used as is.
 */
export function rateLimitClient(ip: string): string {
  if (!ip.includes(":")) return ip;
  // An IPv4 client written as IPv6 is that IPv4 client.
  const mapped = ip.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i);
  if (mapped) return mapped[1]!;
  const halves = ip.toLowerCase().split("%")[0]!.split("::"); // without a zone ID
  if (halves.length > 2) return ip;
  const groups = (half: string | undefined) => (half ? half.split(":") : []);
  const head = groups(halves[0]);
  const tail = groups(halves[1]);
  // An embedded IPv4 address (::ffff:192.0.2.1) takes the last two groups.
  const count = [...head, ...tail].reduce((n, group) => n + (group.includes(".") ? 2 : 1), 0);
  const zeros = 8 - count;
  if (halves.length === 1 ? zeros !== 0 : zeros < 1) return ip;
  const all = [...head, ...Array<string>(halves.length === 2 ? zeros : 0).fill("0"), ...tail];
  const prefix = all.slice(0, 4);
  if (!prefix.every((group) => /^[0-9a-f]{1,4}$/.test(group))) return ip;
  return `${prefix.map((group) => Number.parseInt(group, 16).toString(16)).join(":")}::/64`;
}
