// Password hashing, upload-token checks, and everything signed with keys
// derived from the token: download links, browser sessions and download
// passes. Everything here uses WebCrypto, which is native to Workers and cheap
// on CPU time.

import { parseExpiry } from "./parse.js";

const encoder = new TextEncoder();

function toBase64Url(bytes: ArrayBuffer | Uint8Array): string {
  const array = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  for (const byte of array) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): Uint8Array {
  const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

/** Constant-time comparison of two strings, via fixed-length digests. */
async function safeEqual(a: string, b: string): Promise<boolean> {
  const [da, db] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(a)),
    crypto.subtle.digest("SHA-256", encoder.encode(b)),
  ]);
  return crypto.subtle.timingSafeEqual(da, db);
}

// ---------------------------------------------------------------------------
// Passwords
// ---------------------------------------------------------------------------

// PBKDF2-SHA256. Argon2 would be stronger, but it does not fit in the 10 ms of
// CPU a free-plan Worker gets per request. Measured on Cloudflare, 50k
// iterations cost ~11-20 ms; 20k keeps a password check near 10 ms at p90.
// The hash lives in a private bucket, so it is only exposed if the bucket is,
// and online guessing is rate limited. See docs/design/api.md.
const PBKDF2_ITERATIONS = 20_000;

async function pbkdf2(
  password: string,
  salt: Uint8Array,
  iterations: number,
): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, [
    "deriveBits",
  ]);
  return crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256);
}

/** Hash a password as `pbkdf2-sha256$<iterations>$<salt>$<hash>`. */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2-sha256$${PBKDF2_ITERATIONS}$${toBase64Url(salt)}$${toBase64Url(hash)}`;
}

/** True for hashes this Worker can check. Argon2 hashes from yeet < 0.2 cannot be. */
export function isSupportedHash(stored: string): boolean {
  return stored.startsWith("pbkdf2-sha256$");
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, iterations, salt, expected] = stored.split("$");
  if (scheme !== "pbkdf2-sha256" || !iterations || !salt || !expected) return false;
  const hash = await pbkdf2(password, fromBase64Url(salt), Number(iterations));
  return safeEqual(toBase64Url(hash), expected);
}

// ---------------------------------------------------------------------------
// Upload token
// ---------------------------------------------------------------------------

export const MIN_TOKEN_LENGTH = 16;

export const TOKEN_TOO_SHORT = `UPLOAD_TOKEN must be set and at least ${MIN_TOKEN_LENGTH} characters long`;

/** A missing or short token is refused outright: everything else is derived from it. */
export function isUsableToken(token: string | undefined): token is string {
  return typeof token === "string" && token.length >= MIN_TOKEN_LENGTH;
}

/** Check an `Authorization: Bearer <token>` header against the UPLOAD_TOKEN secret. */
export async function isAuthorized(header: string | undefined, token: string): Promise<boolean> {
  if (!header?.startsWith("Bearer ")) return false;
  return safeEqual(header.slice("Bearer ".length), token);
}

/** Constant-time check of a token typed into the login form. */
export function isCorrectToken(candidate: string, token: string): Promise<boolean> {
  return safeEqual(candidate, token);
}

// ---------------------------------------------------------------------------
// Keys derived from the token
// ---------------------------------------------------------------------------

// Every signature uses its own HMAC key derived from UPLOAD_TOKEN, so there is
// no second secret to configure, and rotating the token invalidates sessions,
// download passes and open download links at once:
//
//   key(label) = SHA-256("yeet-" + label + ":" + UPLOAD_TOKEN)

type KeyLabel = "download" | "session" | "dlpass";

// Imported keys are reused within an isolate; deriving them costs a digest and an import.
const keyCache = new Map<string, Promise<CryptoKey>>();

function signingKey(token: string, label: KeyLabel): Promise<CryptoKey> {
  const cacheKey = `${label}:${token}`;
  let key = keyCache.get(cacheKey);
  if (!key) {
    key = crypto.subtle
      .digest("SHA-256", encoder.encode(`yeet-${label}:${token}`))
      .then((material) =>
        crypto.subtle.importKey("raw", material, { name: "HMAC", hash: "SHA-256" }, false, [
          "sign",
        ]),
      );
    // A rotated token leaves at most a few stale entries behind.
    if (keyCache.size > 16) keyCache.clear();
    keyCache.set(cacheKey, key);
  }
  return key;
}

async function sign(token: string, label: KeyLabel, message: string): Promise<string> {
  const key = await signingKey(token, label);
  return toBase64Url(await crypto.subtle.sign("HMAC", key, encoder.encode(message)));
}

/** Seconds since the epoch, as an integer. */
export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

// ---------------------------------------------------------------------------
// Signed download links
// ---------------------------------------------------------------------------

export function signDownload(token: string, id: string, expires: number): Promise<string> {
  return sign(token, "download", `${id}:${expires}`);
}

export async function verifyDownload(
  token: string,
  id: string,
  expires: number,
  signature: string,
): Promise<boolean> {
  if (!Number.isFinite(expires) || expires * 1000 < Date.now()) return false;
  return safeEqual(await signDownload(token, id, expires), signature);
}

// ---------------------------------------------------------------------------
// Browser sessions: v1.<expires>.<base64url(HMAC(key("session"), "session:v1:" + expires))>
// ---------------------------------------------------------------------------

export const SESSION_MAX_AGE = 90 * 24 * 60 * 60;

export async function createSession(token: string): Promise<string> {
  const expires = nowSeconds() + SESSION_MAX_AGE;
  return `v1.${expires}.${await sign(token, "session", `session:v1:${expires}`)}`;
}

export async function verifySession(token: string, value: string | undefined): Promise<boolean> {
  const [version, rawExpires, signature, ...rest] = (value ?? "").split(".");
  const expires = parseExpiry(rawExpires);
  if (version !== "v1" || expires === null || !signature || rest.length > 0) return false;
  if (expires <= nowSeconds()) return false;
  return safeEqual(await sign(token, "session", `session:v1:${expires}`), signature);
}

// ---------------------------------------------------------------------------
// Download passes: <expires>.<base64url(HMAC(key("dlpass"), id + ":" + expires))>
// ---------------------------------------------------------------------------

export async function createDownloadPass(
  token: string,
  id: string,
  expires: number,
): Promise<string> {
  return `${expires}.${await sign(token, "dlpass", `${id}:${expires}`)}`;
}

export async function verifyDownloadPass(
  token: string,
  id: string,
  value: string | undefined,
): Promise<boolean> {
  const [rawExpires, signature, ...rest] = (value ?? "").split(".");
  const expires = parseExpiry(rawExpires);
  if (expires === null || !signature || rest.length > 0) return false;
  if (expires <= nowSeconds()) return false;
  return safeEqual(await sign(token, "dlpass", `${id}:${expires}`), signature);
}
