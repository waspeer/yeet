// Limits of the CLI's loops over server responses, in a module of their
// own so the e2e tests import them (index.ts runs the CLI when imported).

/**
 * The most pages `yeet list` fetches. A page holds about 75 uploads (at
 * least 5), so 1,000 pages are about 74,000 uploads, or 5,000 sidecars of
 * yeet < 0.2 without a summary; it stops a server that keeps answering with
 * more pages from keeping the CLI busy forever.
 */
export const MAX_LIST_PAGES = 1000;

/**
 * The most `DELETE /api/uploads/:id` requests `yeet delete` makes for one
 * upload. A server of round 1L or later deletes at most 100 objects per
 * request and answers `202` with `done: false` while more is left; 200
 * requests are 20,000 objects, twice the most part records an upload can
 * have. The upload is gone for users after the first request; the server's
 * hourly cleanup deletes whatever is left after the last.
 */
export const MAX_DELETE_ROUNDS = 200;

/**
 * The most parts a server completes for an upload whose size it was not told
 * at create (`MAX_UNSIZED_PARTS` in packages/worker/src/uploads.ts, round
 * 2F, 150 before; an e2e test keeps the two equal): at the 50 MiB part
 * size, 100 parts are 5.24 GB. A compressed zip's size is only known once
 * it is written, so the CLI streams one only when it cannot be larger than
 * that, a part to spare (99 parts, 5.19 GB; zipSizeBound() in
 * upload-zip.ts); a larger one is zipped to a
 * temporary file first and sent with its size, which has no such limit.
 * So does a zip whose size is known up front (every file stored: `--store`,
 * or only already-compressed files).
 */
export const MAX_UNSIZED_PARTS = 100;

/**
 * MAX_UNSIZED_PARTS, or less for the e2e tests: YEET_TEST_MAX_UNSIZED_PARTS
 * (1 to 99) lowers it, so a small zip takes the temporary-file path against
 * a server with 50 MiB parts. Higher values are ignored.
 */
export function maxUnsizedParts(): number {
  const n = Number(process.env.YEET_TEST_MAX_UNSIZED_PARTS);
  return Number.isInteger(n) && n >= 1 && n < MAX_UNSIZED_PARTS ? n : MAX_UNSIZED_PARTS;
}
