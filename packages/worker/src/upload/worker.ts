// The upload itself, in a dedicated Web Worker so the page stays responsive
// (docs/design/browser-upload.md). One worker per upload.
//
// A single file is sent as-is: part n is `file.slice(start, end)`, a Blob that
// the browser reads from disk while sending, so nothing is copied into memory.
//
// Several files or a folder are zipped here while uploading (round 2C+2):
// zip.ts with the browser's defaults (CompressionStream, pure-JS CRC-32),
// each file read in 4 MiB slices (never File.stream(), which has no
// backpressure in Safari), the zip cut into parts of exactly `part_size`
// bytes, each sent as a Blob built from the zip's output and kept until it is
// acknowledged (for retries). The zip waits while the parts in flight are,
// so at most PARALLEL parts plus the one being cut are in memory.
//
// Parts are exactly `part_size` bytes except the last, two in flight. They go
// out with XMLHttpRequest because fetch() reports no upload progress. Every
// request is same-origin and authenticated by the yeet_session cookie, which
// the browser attaches itself; this code never sees a token.

import { createZip } from "../zip.js";
import type { FailureKind, FromWorker, Job, Part, Resume, ToWorker } from "./protocol.js";
import { zipEntries, type ZipFile, type ZipPlan } from "./selection.js";

declare const self: DedicatedWorkerGlobalScope;

/** Parts in flight. Drops to 1 after the first retry. */
const PARALLEL = 2;
/** Attempts per request, the first included. */
const MAX_ATTEMPTS = 4;
/** Backoff before attempt k+1: BASE * 2^(k-1), ±25% jitter, or the server's Retry-After. */
const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 60_000;
/**
 * The least wait before `complete` is sent again. Its first attempt may
 * still be running on the server (the answer was lost, not the request);
 * the server copes with a second one meanwhile (docs/design/api.md, "Errors
 * R2 raises at complete"), but one after the first has ended is simpler.
 * How long a `complete` takes on real R2 is not measured.
 */
const COMPLETE_RETRY_MIN_MS = 5000;
const PROGRESS_INTERVAL_MS = 100;
const DELETE_TIMEOUT_MS = 5000;
/** DELETE requests per upload: an upload of unknown size has a record per part, 100 objects go per request. */
const DELETE_ROUNDS = 5;
/**
 * After a failure or cancel of an upload of unknown size, how long the
 * parts in flight may finish before they are aborted and the upload is
 * deleted: a part the server is still storing could otherwise write its
 * part record after the DELETE (docs/design/api.md, "A late part record").
 */
const IN_FLIGHT_GRACE_MS = 6000;
/** Bytes read from a file at a time (docs/design/browser-upload.md). */
const SLICE = 4 * 1024 * 1024;

class UploadError extends Error {
  constructor(
    readonly kind: FailureKind | "cancelled",
    message: string,
    readonly status?: number,
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }

  /** Network errors, 5xx, 408 and 429 may go away; everything else (a lost file too) will not. */
  get retryable(): boolean {
    return this.kind === "network" || this.kind === "server";
  }
}

function post(message: FromWorker): void {
  self.postMessage(message);
}

/**
 * Error for a non-2xx response. Its message is the server's own `error` from
 * a JSON body; anything else (an HTML error page with a stack trace,
 * Cloudflare's own 413 page) is never shown, so the page only says the status.
 */
function httpError(status: number, body: string, retryAfter: string | null): UploadError {
  let message = "";
  try {
    const parsed = JSON.parse(body) as { error?: unknown } | null;
    if (typeof parsed?.error === "string") message = parsed.error.slice(0, 200);
  } catch {
    // not JSON: show the status only
  }
  if (status === 401) return new UploadError("session", message, status);
  if (status === 408 || status === 429 || status >= 500) {
    return new UploadError("server", message, status, parseRetryAfter(retryAfter));
  }
  return new UploadError("rejected", message, status);
}

/** Retry-After as delta-seconds or an HTTP date, in ms; undefined if absent or unusable. */
function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - Date.now();
  return Number.isFinite(ms) && ms >= 0 ? Math.min(ms, MAX_DELAY_MS) : undefined;
}

function backoff(attempt: number): number {
  const base = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** (attempt - 1));
  return Math.round(base * (0.75 + Math.random() * 0.5));
}

/** A failed read of a picked file: access to it is lost (iOS: the screen locked). */
function lostFile(err: unknown): UploadError {
  const name = err instanceof Error ? err.name : "Error";
  return new UploadError("file", `${name}: ${(err as Error)?.message ?? ""}`.trim());
}

/**
 * A file's contents in SLICE-sized chunks, each read with
 * `slice().arrayBuffer()` only when the zip asks for it. A failed read is
 * a lost file (UploadError "file"), which errors the zip.
 */
function sliceStream(file: File, onBytes: (n: number) => void): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        if (offset >= file.size) {
          controller.close();
          return;
        }
        const end = Math.min(offset + SLICE, file.size);
        let buffer: ArrayBuffer;
        try {
          buffer = await file.slice(offset, end).arrayBuffer();
        } catch (err) {
          throw lostFile(err);
        }
        offset = end;
        onBytes(buffer.byteLength);
        controller.enqueue(new Uint8Array(buffer));
      },
    },
    { highWaterMark: 0 },
  );
}

class Upload {
  private id: string | null = null;
  /** Set once the upload failed or was cancelled: nothing new may start. */
  private stopped = false;
  private finished = false;
  /**
   * Set once `complete` is sent: from then on the upload may be finished on
   * the server whatever this worker hears back, so it is never deleted
   * (a cancel is ignored, a failure leaves it to the hourly cleanup).
   */
  private completing = false;
  private parallel = PARALLEL;
  private readonly controller = new AbortController();
  private readonly requests = new Set<XMLHttpRequest>();
  private readonly timers = new Set<() => void>();
  /** Bytes of acknowledged parts, plus bytes sent so far of parts in flight. */
  private doneBytes = 0;
  private readonly inFlight = new Map<number, number>();
  private lastProgressAt = 0;
  /** The zip's size is sent at create (a single file, a stored zip). */
  private readonly sized: boolean;
  /** Zip only: input bytes read, zip bytes made, the file read last, the zip's reader. */
  private inputRead = 0;
  private produced = 0;
  private lastSent = 0;
  private currentFile: File | null = null;
  private zipReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  /** Zip only: parts being sent (each with its retries). */
  private readonly tasks = new Set<Promise<void>>();

  constructor(
    private readonly job: Job,
    private readonly expiresIn: number,
    private readonly password: string | undefined,
    private readonly maxUnsizedParts: number,
  ) {
    this.sized = job.kind === "file" || job.plan.size !== undefined;
  }

  private get total(): number {
    return this.job.kind === "file" ? this.job.file.size : this.job.plan.totalSize;
  }

  async run(resume?: Resume): Promise<void> {
    const job = this.job;
    const declared = job.kind === "file" ? job.file.size : job.plan.size;
    try {
      let id: string;
      let partSize: number;
      const parts: Part[] = [];
      if (resume) {
        // The same file (or stored zip) again, after its access was lost:
        // continue the upload that is still open on the server.
        ({ id, partSize } = resume);
        parts.push(...resume.parts);
      } else {
        const created = await this.withRetries(0, () =>
          this.json("POST", "/api/uploads", {
            filename: job.kind === "file" ? job.file.name : job.plan.name,
            ...(declared !== undefined ? { size: declared } : {}),
            expires_in: this.expiresIn,
            ...(this.password ? { password: this.password } : {}),
          }),
        );
        const newId = created?.["id"];
        const newPartSize = created?.["part_size"];
        if (
          typeof newId !== "string" ||
          typeof newPartSize !== "number" ||
          !Number.isSafeInteger(newPartSize) ||
          newPartSize <= 0
        ) {
          throw new UploadError("server", "Unexpected response when starting the upload");
        }
        id = newId;
        partSize = newPartSize;
      }
      this.id = id;
      this.check();
      post({ type: "started", id, partSize });

      const size =
        job.kind === "file"
          ? (await this.sendFile(job.file, partSize, parts), job.file.size)
          : await this.sendZip(job.plan, partSize, parts);
      // Never complete after a failed or cancelled part.
      this.check();
      parts.sort((a, b) => a.part_number - b.part_number);

      this.completing = true;
      post({ type: "finishing" });
      const completed = await this.withRetries(
        0,
        () => this.json("POST", `/api/uploads/${id}/complete`, { parts, size }),
        COMPLETE_RETRY_MIN_MS,
      );
      this.check();
      const url = completed?.["url"];
      if (typeof url !== "string") throw new UploadError("server", "Unexpected response");
      this.finished = true;
      post({ type: "done", url });
    } catch (err) {
      if (this.stopped) return; // cancel() reports for itself
      const error =
        err instanceof UploadError ? err : new UploadError("server", (err as Error)?.message ?? "");
      // Kept on the server: after `complete` it may be finished; after a
      // lost file it can go on (or be replaced) once the file is chosen
      // again. Otherwise the hourly cleanup removes what is left after 24 hours.
      await this.stop(!this.completing && error.kind !== "file");
      post({
        type: "failed",
        kind: error.kind as FailureKind,
        message: error.message,
        status: error.status,
      });
    }
  }

  /** Stop: abort what is in flight, delete the upload on the server, report. */
  async cancel(): Promise<void> {
    // Too late once complete is sent: the upload goes on and reports "done".
    if (this.stopped || this.finished || this.completing) return;
    await this.stop(true);
    post({ type: "cancelled" });
  }

  /**
   * Stop everything: no new part or attempt starts, the zip stops reading.
   * For an upload of unknown size the parts in flight may finish first (up
   * to IN_FLIGHT_GRACE_MS), so none lands after the DELETE.
   */
  private async stop(deleteIt: boolean): Promise<void> {
    this.stopped = true;
    void this.zipReader?.cancel().catch(() => {});
    for (const cancelTimer of this.timers) cancelTimer();
    this.timers.clear();
    if (deleteIt && !this.sized && this.tasks.size > 0) {
      await Promise.race([
        Promise.allSettled(this.tasks),
        new Promise((resolve) => setTimeout(resolve, IN_FLIGHT_GRACE_MS)),
      ]);
    }
    this.abortAll();
    if (deleteIt) await this.deleteOnServer();
  }

  private check(): void {
    if (this.stopped) throw new UploadError("cancelled", "Stopped");
  }

  private abortAll(): void {
    this.controller.abort();
    for (const xhr of this.requests) xhr.abort();
    this.requests.clear();
    for (const cancelTimer of this.timers) cancelTimer();
    this.timers.clear();
  }

  /**
   * Best effort; the hourly cleanup removes uploads left pending for 24 h.
   * The server deletes at most 100 objects per request and answers 202
   * while more is left (an upload of unknown size has a record per part).
   */
  private async deleteOnServer(): Promise<void> {
    if (!this.id) return;
    try {
      for (let round = 0; round < DELETE_ROUNDS; round++) {
        const res = await fetch(`/api/uploads/${encodeURIComponent(this.id)}`, {
          method: "DELETE",
          signal: AbortSignal.timeout(DELETE_TIMEOUT_MS),
        });
        if (res.status !== 202) return;
      }
    } catch {
      // offline or timed out: leave it to the cleanup
    }
  }

  private progress(force = false): void {
    const now = Date.now();
    if (!force && now - this.lastProgressAt < PROGRESS_INTERVAL_MS) return;
    this.lastProgressAt = now;
    let sent = this.doneBytes;
    for (const bytes of this.inFlight.values()) sent += bytes;
    if (this.job.kind === "zip") {
      // Zip bytes uploaded, as input bytes: the input read so far, times
      // the share of the zip made so far that is uploaded. Never backwards.
      const share = this.produced ? Math.min(1, sent / this.produced) : 0;
      sent = Math.max(this.lastSent, Math.round(this.inputRead * share));
      this.lastSent = sent;
    }
    post({ type: "progress", sent, total: this.total });
  }

  /** Run `attempt`, retrying retryable failures with backoff. `part` 0 = not a part. */
  private async withRetries<T>(
    part: number,
    attempt: () => Promise<T>,
    minDelayMs = 0,
  ): Promise<T> {
    for (let n = 1; ; n++) {
      this.check();
      try {
        return await attempt();
      } catch (err) {
        const error = err instanceof UploadError ? err : new UploadError("network", String(err));
        if (this.stopped || !error.retryable || n >= MAX_ATTEMPTS) throw error;
        const delayMs = Math.max(minDelayMs, error.retryAfterMs ?? backoff(n));
        if (part) {
          // Its bytes will be sent again; and go easy on a struggling connection.
          this.inFlight.set(part, 0);
          this.parallel = 1;
          this.progress(true);
        }
        post({ type: "retrying", part, attempt: n + 1, delayMs });
        await this.sleep(delayMs);
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const cancelTimer = () => {
        clearTimeout(timer);
        reject(new UploadError("cancelled", "Stopped"));
      };
      const timer = setTimeout(() => {
        this.timers.delete(cancelTimer);
        resolve();
      }, ms);
      this.timers.add(cancelTimer);
    });
  }

  // -------------------------------------------------------------------------
  // A single file
  // -------------------------------------------------------------------------

  private async sendFile(file: File, partSize: number, parts: Part[]): Promise<void> {
    const size = file.size;
    const count = Math.max(1, Math.ceil(size / partSize));
    const bounds = (n: number) => {
      const start = (n - 1) * partSize;
      return { start, end: Math.min(start + partSize, size) };
    };
    const acknowledged = new Set(parts.map((part) => part.part_number));
    for (const n of acknowledged) {
      const { start, end } = bounds(n);
      this.doneBytes += end - start;
    }
    this.progress(true);

    // The parts still to send, lowest first: the first unacknowledged one
    // goes out first when resuming.
    const todo: number[] = [];
    for (let n = 1; n <= count; n++) if (!acknowledged.has(n)) todo.push(n);
    let next = 0;
    const slot = async (index: number): Promise<void> => {
      while (!this.stopped && index < this.parallel && next < todo.length) {
        const n = todo[next++]!;
        const { start, end } = bounds(n);
        const etag = await this.withRetries(n, () => this.sendReadablePart(file, n, start, end));
        const part = { part_number: n, etag };
        parts.push(part);
        post({ type: "part", part });
        this.inFlight.delete(n);
        this.doneBytes += end - start;
        this.progress(true);
      }
    };
    const slots = Math.max(1, Math.min(this.parallel, todo.length));
    await Promise.all(Array.from({ length: slots }, (_, i) => slot(i)));
    this.check();
    if (parts.length !== count) throw new UploadError("server", "Not every part was sent");
  }

  /**
   * PUT one part, after checking that the file can still be read: iOS
   * Safari revokes access to a picked file when the screen locks, after
   * which a read fails (`NotFoundError`; Firefox: `AbortError`) and an
   * upload of its slice fails like a network error. So the file is read
   * (1 byte) before each attempt and again after a failed one, and a read
   * that fails ends the upload as "file", not retried.
   */
  private async sendReadablePart(
    file: File,
    n: number,
    start: number,
    end: number,
  ): Promise<string> {
    await this.checkReadable(file, start, end);
    try {
      return await this.sendPart(n, file.slice(start, end), end - start);
    } catch (err) {
      if (!this.stopped) await this.checkReadable(file, start, end);
      throw err;
    }
  }

  private async checkReadable(file: File, start: number, end: number): Promise<void> {
    if (end <= start) return; // an empty file: nothing to read
    try {
      await file.slice(start, start + 1).arrayBuffer();
    } catch (err) {
      throw lostFile(err);
    }
  }

  // -------------------------------------------------------------------------
  // A zip of several files or a folder
  // -------------------------------------------------------------------------

  /**
   * Zip and upload. Resolves with the zip's size. When resuming a stored
   * zip (fully determined by its plan), the parts the server already has
   * are made again but not sent: that reads the files up to there once
   * more, without uploading them again.
   */
  private async sendZip(plan: ZipPlan, partSize: number, parts: Part[]): Promise<number> {
    if (!this.sized && (plan.worstCase ?? Infinity) > this.maxUnsizedParts * partSize) {
      // planSelection() keeps this from happening; refuse rather than fail halfway.
      throw new UploadError(
        "rejected",
        `The zip could need more than ${this.maxUnsizedParts} parts of ${partSize} bytes`,
      );
    }
    const acknowledged = new Set(parts.map((part) => part.part_number));
    const entries = zipEntries(plan, (file: ZipFile, index: number) => {
      this.currentFile = file.file;
      post({ type: "entry", index: index + 1, count: plan.files.length, path: file.path });
      return sliceStream(file.file, (n) => {
        this.inputRead += n;
        this.progress();
      });
    });
    const reader = createZip(entries).getReader();
    this.zipReader = reader;

    let failure: UploadError | undefined;
    let partNumber = 0;
    let chunks: Uint8Array[] = [];
    let filled = 0;
    /** Send the part cut so far; wait while PARALLEL parts are in flight. */
    const flush = async () => {
      const n = ++partNumber;
      const length = filled;
      const body = chunks;
      chunks = [];
      filled = 0;
      if (!this.sized && n > this.maxUnsizedParts) {
        throw new UploadError("rejected", `The zip needs more than ${this.maxUnsizedParts} parts`);
      }
      if (acknowledged.has(n)) {
        this.doneBytes += length;
        this.progress(true);
        return;
      }
      const blob = new Blob(body as BlobPart[]);
      const task: Promise<void> = this.withRetries(n, () => this.sendZipPart(n, blob, length))
        .then(
          (etag) => {
            const part = { part_number: n, etag };
            parts.push(part);
            post({ type: "part", part });
            this.inFlight.delete(n);
            this.doneBytes += length;
            this.progress(true);
          },
          (err: unknown) => {
            failure ??= err instanceof UploadError ? err : new UploadError("network", String(err));
          },
        )
        .finally(() => this.tasks.delete(task));
      this.tasks.add(task);
      while (this.tasks.size >= this.parallel && !failure && !this.stopped) {
        await Promise.race(this.tasks);
      }
      if (failure) throw failure;
      this.check();
    };

    for (;;) {
      let result: ReadableStreamReadResult<Uint8Array>;
      try {
        result = await reader.read();
      } catch (err) {
        if (err instanceof UploadError) throw err;
        // A file that changed while it was read, or a name the zip refuses.
        throw new UploadError("zip", (err as Error)?.message ?? String(err));
      }
      if (failure) throw failure;
      this.check();
      if (result.done) break;
      const value = result.value;
      this.produced += value.length;
      for (let offset = 0; offset < value.length; ) {
        const take = Math.min(partSize - filled, value.length - offset);
        chunks.push(value.subarray(offset, offset + take));
        filled += take;
        offset += take;
        if (filled === partSize) await flush();
      }
    }
    if (filled > 0 || partNumber === 0) await flush();
    while (this.tasks.size > 0) await Promise.race(this.tasks);
    if (failure) throw failure;
    this.check();
    if (plan.size !== undefined && this.produced !== plan.size) {
      throw new UploadError("zip", `The zip came out ${this.produced} bytes, not ${plan.size}`);
    }
    if (parts.length !== partNumber) throw new UploadError("server", "Not every part was sent");
    return this.produced;
  }

  /**
   * PUT one part of the zip (held in memory, so it can be sent again), and
   * after a failed attempt check that the files can still be read: a lost
   * file (iOS) shows first as a failed upload, and the zip cannot go on
   * without it. Only the file read last is probed, not every one read so
   * far: iOS revokes them all at once, and the earlier ones' bytes are
   * already in the parts in memory (docs/design/api.md, "Lost files
   * during a zip").
   */
  private async sendZipPart(n: number, body: Blob, length: number): Promise<string> {
    try {
      return await this.sendPart(n, body, length);
    } catch (err) {
      const file = this.currentFile;
      if (!this.stopped && file) await this.checkReadable(file, 0, file.size);
      throw err;
    }
  }

  // -------------------------------------------------------------------------

  /** PUT one part; resolves with its etag. */
  private sendPart(n: number, body: Blob, length: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      this.requests.add(xhr);
      const settle = () => this.requests.delete(xhr);
      xhr.open("PUT", `/api/uploads/${encodeURIComponent(this.id ?? "")}/parts/${n}`);
      xhr.setRequestHeader("Content-Type", "application/octet-stream");
      xhr.upload.onprogress = (event) => {
        this.inFlight.set(n, Math.min(event.loaded, length));
        this.progress();
      };
      xhr.onload = () => {
        settle();
        if (xhr.status < 200 || xhr.status >= 300) {
          reject(httpError(xhr.status, xhr.responseText, xhr.getResponseHeader("Retry-After")));
          return;
        }
        try {
          const etag = (JSON.parse(xhr.responseText) as { etag?: unknown }).etag;
          if (typeof etag === "string") return resolve(etag);
        } catch {
          // fall through
        }
        reject(new UploadError("server", "Unexpected response to a part"));
      };
      xhr.onerror = () => {
        settle();
        reject(new UploadError("network", "Network error"));
      };
      xhr.onabort = () => {
        settle();
        reject(new UploadError("cancelled", "Stopped"));
      };
      xhr.send(body);
    });
  }

  private async json(
    method: string,
    path: string,
    body: unknown,
  ): Promise<Record<string, unknown> | null> {
    let res: Response;
    try {
      res = await fetch(path, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: this.controller.signal,
      });
    } catch (err) {
      if (this.stopped) throw new UploadError("cancelled", "Stopped");
      throw new UploadError("network", (err as Error)?.message ?? "Network error");
    }
    const text = await res.text().catch(() => "");
    if (!res.ok) throw httpError(res.status, text, res.headers.get("Retry-After"));
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new UploadError("server", "Unexpected response");
    }
  }
}

let current: Upload | null = null;

self.onmessage = (event: MessageEvent<ToWorker>) => {
  const message = event.data;
  if (message.type === "start" && !current) {
    current = new Upload(message.job, message.expiresIn, message.password, message.maxUnsizedParts);
    void current.run(message.resume);
  } else if (message.type === "cancel") {
    if (current) void current.cancel();
    else post({ type: "cancelled" });
  }
};
