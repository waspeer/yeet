// Messages between the upload page (main.ts) and its Web Worker (worker.ts).

import type { ZipPlan } from "./selection.js";

/** A part the server has acknowledged. */
export interface Part {
  part_number: number;
  etag: string;
}

/**
 * An upload to continue rather than start: still open (pending) on the
 * server, with the parts it already has. Only for the very same file, or
 * the very same stored zip (whose bytes are fully determined).
 */
export interface Resume {
  id: string;
  partSize: number;
  parts: Part[];
}

/** What to upload: one file as-is, or a zip made while uploading. */
export type Job = { kind: "file"; file: File } | { kind: "zip"; plan: ZipPlan };

/** Page → worker. */
export type ToWorker =
  | {
      type: "start";
      job: Job;
      /** `expires_in` for POST /api/uploads, in seconds. */
      expiresIn: number;
      /** The download password, if the user set one. */
      password?: string;
      /** Continue this upload instead of creating one (expiresIn and password are its own). */
      resume?: Resume;
      /** For a zip of unknown size: the most parts the server completes (MAX_UNSIZED_PARTS). */
      maxUnsizedParts: number;
    }
  /** Stop: abort requests in flight and delete the upload on the server. */
  | { type: "cancel" };

/**
 * Why an upload stopped:
 * - `network`: the connection failed and retries did not help;
 * - `session`: the server answered 401, the login has expired;
 * - `server`: a 5xx/429 that retries did not fix, or a response we cannot use;
 * - `rejected`: a 4xx about this file (e.g. its name), `message` says why;
 * - `file`: a file can no longer be read (iOS Safari revokes access to a
 *   picked file when the screen locks: `NotFoundError`). Not retried, and
 *   the upload is kept on the server, so it can continue (a single file, a
 *   stored zip) or be replaced (a deflated zip) once the files are chosen
 *   again;
 * - `zip`: the zip could not be made (a file changed while it was read).
 */
export type FailureKind = "network" | "session" | "server" | "rejected" | "file" | "zip";

/** Worker → page. */
export type FromWorker =
  /** The server created (or still has) the upload; the page needs the ID to clean up on pagehide. */
  | { type: "started"; id: string; partSize: number }
  /** The server acknowledged a part. */
  | { type: "part"; part: Part }
  /** Bytes of the input uploaded so far (for a zip: estimated from the zip's ratio so far). */
  | { type: "progress"; sent: number; total: number }
  /** A zip started reading file `index` (1-based) of `count`. */
  | { type: "entry"; index: number; count: number; path: string }
  /** A part failed and will be sent again after `delayMs`. */
  | { type: "retrying"; part: number; attempt: number; delayMs: number }
  /** Every byte is sent; the server is assembling the file. */
  | { type: "finishing" }
  | { type: "done"; url: string }
  | { type: "failed"; kind: FailureKind; message: string; status?: number }
  /** A cancel finished: requests aborted, delete sent. */
  | { type: "cancelled" };
