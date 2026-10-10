// Messages between the upload page (main.ts) and its Web Worker (worker.ts).

/** A part the server has acknowledged. */
export interface Part {
  part_number: number;
  etag: string;
}

/**
 * An upload to continue rather than start: still open (pending) on the
 * server, with the parts it already has. Only for the very same file.
 */
export interface Resume {
  id: string;
  partSize: number;
  parts: Part[];
}

/** Page → worker. */
export type ToWorker =
  | {
      type: "start";
      file: File;
      /** `expires_in` for POST /api/uploads, in seconds. */
      expiresIn: number;
      /** The download password, if the user set one. */
      password?: string;
      /** Continue this upload instead of creating one (expiresIn and password are its own). */
      resume?: Resume;
    }
  /** Stop: abort requests in flight and delete the upload on the server. */
  | { type: "cancel" };

/**
 * Why an upload stopped:
 * - `network`: the connection failed and retries did not help;
 * - `session`: the server answered 401, the login has expired;
 * - `server`: a 5xx/429 that retries did not fix, or a response we cannot use;
 * - `rejected`: a 4xx about this file (e.g. its name), `message` says why;
 * - `file`: the file can no longer be read (iOS Safari revokes access to a
 *   picked file when the screen locks: `NotFoundError`). Not retried, and
 *   the upload is kept on the server, so it can continue once the same
 *   file is chosen again.
 */
export type FailureKind = "network" | "session" | "server" | "rejected" | "file";

/** Worker → page. */
export type FromWorker =
  /** The server created (or still has) the upload; the page needs the ID to clean up on pagehide. */
  | { type: "started"; id: string; partSize: number }
  /** The server acknowledged a part. */
  | { type: "part"; part: Part }
  | { type: "progress"; sent: number; total: number }
  /** A part failed and will be sent again after `delayMs`. */
  | { type: "retrying"; part: number; attempt: number; delayMs: number }
  /** Every byte is sent; the server is assembling the file. */
  | { type: "finishing" }
  | { type: "done"; url: string }
  | { type: "failed"; kind: FailureKind; message: string; status?: number }
  /** A cancel finished: requests aborted, delete sent. */
  | { type: "cancelled" };
