// Password hashing, upload-token checks and signed download links. Everything
// here uses WebCrypto, which is native to Workers and cheap on CPU time.

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
// CPU a free-plan Worker gets per request; 50k iterations takes a few ms. The
// hash lives in a private bucket, so it is only exposed if the bucket is.
const PBKDF2_ITERATIONS = 50_000;

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

/** Check an `Authorization: Bearer <token>` header against the UPLOAD_TOKEN secret. */
export async function isAuthorized(header: string | undefined, token: string): Promise<boolean> {
  if (!header?.startsWith("Bearer ")) return false;
  return safeEqual(header.slice("Bearer ".length), token);
}

// ---------------------------------------------------------------------------
// Signed download links
// ---------------------------------------------------------------------------

// Download links are signed with a key derived from UPLOAD_TOKEN, so there is
// no second secret to configure. Rotating the token invalidates open links.
async function signingKey(token: string): Promise<CryptoKey> {
  const material = await crypto.subtle.digest("SHA-256", encoder.encode(`yeet-download:${token}`));
  return crypto.subtle.importKey("raw", material, { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
}

export async function signDownload(token: string, id: string, expires: number): Promise<string> {
  const key = await signingKey(token);
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(`${id}:${expires}`));
  return toBase64Url(signature);
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
