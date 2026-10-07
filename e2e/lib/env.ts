// Connection details of the server under test. scripts/verify.mjs starts
// `wrangler dev` and passes these to Playwright as environment variables.

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is not set. Run the tests through \`npm run verify\` (from e2e/), ` +
        "which starts the Worker and passes its address to Playwright.",
    );
  }
  return value;
}

export const server = {
  /** Origin of the local Worker, e.g. http://127.0.0.1:53123 (no trailing slash). */
  get baseURL(): string {
    return required("YEET_E2E_BASE_URL");
  },
  /** The UPLOAD_TOKEN the Worker was started with. */
  get token(): string {
    return required("YEET_E2E_TOKEN");
  },
  /** Run-wide temp directory; verify.mjs deletes it on exit. */
  get tmpRoot(): string {
    return required("YEET_E2E_TMP");
  },
  /** wrangler's --persist-to directory (local R2 state). */
  get persistDir(): string {
    return required("YEET_E2E_PERSIST_DIR");
  },
  /** packages/worker, for running wrangler commands against the same state. */
  get workerDir(): string {
    return required("YEET_E2E_WORKER_DIR");
  },
  /** The built CLI entry point (packages/cli/dist/index.js). */
  get cliPath(): string {
    return required("YEET_E2E_CLI");
  },
  /** wrangler dev's output (one line per request), see serverLog(). */
  get wranglerLog(): string {
    return required("YEET_E2E_WRANGLER_LOG");
  },
  /** R2 bucket name from wrangler.jsonc. */
  bucketName: "yeet",
  /** Key prefix of uploads inside the bucket (UPLOADS_PREFIX). */
  uploadsPrefix: "uploads",
};
