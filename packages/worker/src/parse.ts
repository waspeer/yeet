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

/**
 * Whether a request makes a Bearer attempt: it has an Authorization header,
 * even an empty one. Such a request is decided by that header alone, and a
 * wrong (or empty) one counts as a failed guess.
 */
export function isBearerAttempt(header: string | null | undefined): header is string {
  return typeof header === "string";
}
