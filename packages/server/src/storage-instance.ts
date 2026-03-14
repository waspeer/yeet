import { StorageClient } from './storage.js';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

export const storage = new StorageClient({
  baseUrl: requireEnv('WEBDAV_BASE_URL'),
  username: requireEnv('WEBDAV_USERNAME'),
  password: requireEnv('WEBDAV_PASSWORD'),
  uploadsPath: requireEnv('WEBDAV_UPLOADS_PATH'),
});
