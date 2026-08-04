import { StorageClient } from "./storage.js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function optionalPositiveInt(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Invalid ${name}: "${raw}" (expected a positive number of seconds)`);
  }
  return value;
}

export const storage = new StorageClient({
  endpoint: requireEnv("R2_ENDPOINT"),
  accessKeyId: requireEnv("R2_ACCESS_KEY_ID"),
  secretAccessKey: requireEnv("R2_SECRET_ACCESS_KEY"),
  bucket: requireEnv("R2_BUCKET"),
  uploadsPrefix: process.env.R2_UPLOADS_PREFIX || "uploads",
  presignExpirySeconds: optionalPositiveInt("R2_PRESIGN_EXPIRY_SECONDS"),
});
