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
