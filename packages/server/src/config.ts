import { StorageClient, type StorageClientConfig } from './storage.js';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function buildStorageConfig(): StorageClientConfig {
  return {
    baseUrl: requireEnv('STORAGE_BASE_URL'),
    username: requireEnv('STORAGE_USERNAME'),
    password: requireEnv('STORAGE_PASSWORD'),
    uploadsPath: process.env['STORAGE_UPLOADS_PATH'] ?? '/uploads',
  };
}

/** Singleton StorageClient configured from environment variables:
 *
 *  STORAGE_BASE_URL     — WebDAV host, e.g. "https://u12345.your-storagebox.de"
 *  STORAGE_USERNAME     — sub-account username (read-only, restricted to uploads/)
 *  STORAGE_PASSWORD     — sub-account password
 *  STORAGE_UPLOADS_PATH — path prefix for uploads (default: "/uploads")
 */
export const storage = new StorageClient(buildStorageConfig());
