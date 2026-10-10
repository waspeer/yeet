// The upload itself, in a dedicated Web Worker so the page stays responsive
// (docs/design/browser-upload.md). One worker per upload.
//
// A single file is sent as-is: part n is `file.slice(start, end)`, a Blob that
// the browser reads from disk while sending, so nothing is copied into memory.
// Parts are exactly `part_size` bytes except the last, two in flight.
//
// Parts go out with XMLHttpRequest because fetch() reports no upload progress.
// Every request is same-origin and authenticated by the yeet_session cookie,
// which the browser attaches itself; this code never sees a token.

import type { FailureKind, FromWorker, ToWorker } from "./protocol.js";

declare const self: DedicatedWorkerGlobalScope;

/** Parts in flight. Drops to 1 after the first retry. */
const PARALLEL = 2;
/** Attempts per request, the first included. */
const MAX_ATTEMPTS = 4;
/** Backoff before attempt k+1: BASE * 2^(k-1), ±25% jitter, or the server's Retry-After. */
const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 60_000;
const PROGRESS_INTERVAL_MS = 100;
const DELETE_TIMEOUT_MS = 5000;

class UploadError extends Error {
  constructor(
    readonly kind: FailureKind | "cancelled",
    message: string,
    readonly status?: number,
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }

  /** Network errors, 5xx, 408 and 429 may go away; everything else will not. */
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

  constructor(
    private readonly file: File,
    private readonly expiresIn: number,
  ) {}

  async run(): Promise<void> {
    const size = this.file.size;
    try {
      const created = await this.withRetries(0, () =>
        this.json("POST", "/api/uploads", {
          filename: this.file.name,
          size,
          expires_in: this.expiresIn,
        }),
      );
      const id = created?.["id"];
      const partSize = created?.["part_size"];
      if (typeof id !== "string" || !Number.isSafeInteger(partSize) || (partSize as number) <= 0) {
        throw new UploadError("server", "Unexpected response when starting the upload");
      }
      this.id = id;
      this.check();
      post({ type: "started", id });
      this.progress(true);

      const count = Math.max(1, Math.ceil(size / (partSize as number)));
      const parts: { part_number: number; etag: string }[] = [];
      let next = 1;
      const slot = async (index: number): Promise<void> => {
        while (!this.stopped && index < this.parallel && next <= count) {
          const n = next++;
          const start = (n - 1) * (partSize as number);
          const end = Math.min(start + (partSize as number), size);
          const etag = await this.withRetries(n, () => this.sendPart(n, start, end));
          parts.push({ part_number: n, etag });
          this.inFlight.delete(n);
          this.doneBytes += end - start;
          this.progress(true);
        }
      };
      await Promise.all(Array.from({ length: Math.min(this.parallel, count) }, (_, i) => slot(i)));
      // Never complete after a failed or cancelled part.
      this.check();
      if (parts.length !== count) throw new UploadError("server", "Not every part was sent");
      parts.sort((a, b) => a.part_number - b.part_number);

      this.completing = true;
      post({ type: "finishing" });
      const completed = await this.withRetries(0, () =>
        this.json("POST", `/api/uploads/${id}/complete`, { parts, size }),
      );
      this.check();
      const url = completed?.["url"];
      if (typeof url !== "string") throw new UploadError("server", "Unexpected response");
      this.finished = true;
      post({ type: "done", url });
    } catch (err) {
      if (this.stopped) return; // cancel() reports for itself
      this.stopped = true;
      this.abortAll();
      const error =
        err instanceof UploadError ? err : new UploadError("server", (err as Error)?.message ?? "");
      if (!this.completing) await this.deleteOnServer();
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
    this.stopped = true;
    this.abortAll();
    await this.deleteOnServer();
    post({ type: "cancelled" });
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

  /** Best effort; the hourly cleanup removes uploads left pending for 24 h. */
  private async deleteOnServer(): Promise<void> {
    if (!this.id) return;
    try {
      await fetch(`/api/uploads/${encodeURIComponent(this.id)}`, {
        method: "DELETE",
        signal: AbortSignal.timeout(DELETE_TIMEOUT_MS),
      });
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
    post({ type: "progress", sent, total: this.file.size });
  }

  /** Run `attempt`, retrying retryable failures with backoff. `part` 0 = not a part. */
  private async withRetries<T>(part: number, attempt: () => Promise<T>): Promise<T> {
    for (let n = 1; ; n++) {
      this.check();
      try {
        return await attempt();
      } catch (err) {
        const error = err instanceof UploadError ? err : new UploadError("network", String(err));
        if (this.stopped || !error.retryable || n >= MAX_ATTEMPTS) throw error;
        const delayMs = error.retryAfterMs ?? backoff(n);
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

  /** PUT one part; resolves with its etag. */
  private sendPart(n: number, start: number, end: number): Promise<string> {
    const body = this.file.slice(start, end);
    const length = end - start;
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
    current = new Upload(message.file, message.expiresIn);
    void current.run();
  } else if (message.type === "cancel") {
    if (current) void current.cancel();
    else post({ type: "cancelled" });
  }
};
