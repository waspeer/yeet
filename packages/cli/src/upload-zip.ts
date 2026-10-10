// Upload several files or a folder as one zip. Three ways, by what is known
// up front (docs/design/zip.md, "Callers"):
//
// - Every file stored (`--store`, or only already-compressed files): the
//   zip's exact size is known before it is written (storedZipSize()). It is
//   sent at create, and the zip is streamed into the upload.
// - Compressed, and certain to stay within the server's limit for uploads of
//   unknown size (MAX_UNSIZED_PARTS parts, see zipSizeBound()): streamed
//   into the upload, its size sent at `complete`.
// - Compressed and possibly larger: zipped once into a temporary file (mode
//   600, in a fresh mkdtemp folder in os.tmpdir()), which is then uploaded
//   with its exact size at create. The file is always removed: on success,
//   on an error, on Ctrl-C, SIGTERM or SIGHUP, and on a quick exit.
//
// Streamed or read back from the temporary file, the zip is cut into parts
// of exactly `part_size` (the last one shorter) and uploaded CONCURRENCY at
// a time, so at most CONCURRENCY + 1 parts are held in memory. On any error
// (a file that cannot be read or changed while it was read, a part that
// failed after its retries, Ctrl-C) the multipart upload is deleted (after
// the parts in flight finish) and never completed, so no truncated zip is
// ever published.

import { rmSync } from "node:fs";
import fsp, { mkdtemp, open, rm, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Duplex } from "node:stream";
import zlib from "node:zlib";
import { api, withRetries, type Config } from "./api.js";
import { MAX_DELETE_ROUNDS, maxUnsizedParts } from "./limits.js";
import type { Plan } from "./selection.js";
import { CONCURRENCY, countingStream, formatSize, Progress } from "./transfer.js";
import {
  createZip,
  isCompressedPath,
  storedZipSize,
  type ByteTransform,
  type ZipEntry,
  type ZipOptions,
} from "./zip.js";

export type ZipPlan = Extract<Plan, { kind: "zip" }>;

/** The exit code for a signal: 128 + its number (Ctrl-C 130, SIGTERM 143, SIGHUP 129). */
const exitCodeFor = (signal: NodeJS.Signals) =>
  signal === "SIGTERM" ? 143 : signal === "SIGHUP" ? 129 : 130;

/** The signals that cancel a zip upload. */
const SIGNALS: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];

/** Ctrl-C (or SIGTERM, SIGHUP) during an upload: the caller exits with `exitCode`. */
export class InterruptedError extends Error {
  constructor(readonly signal: NodeJS.Signals = "SIGINT") {
    super("Interrupted");
  }

  get exitCode(): number {
    return exitCodeFor(this.signal);
  }
}

/** How long a failed upload waits for its parts in flight before it aborts them and deletes. */
const IN_FLIGHT_GRACE_MS = 30_000;

/** Bytes read from disk per chunk. */
const READ_CHUNK = 1024 * 1024;

/**
 * Free space the temporary zip leaves on its disk, at the least: room for
 * the system and other programs while yeet writes up to several GB.
 */
export const FREE_SPACE_MARGIN = 256 * 1024 * 1024;

/**
 * The most bytes the zip of `plan` can take: every byte of input, plus for
 * each deflated file 1/1024 of its size and 64 bytes, plus 256 bytes and
 * twice its name per entry (headers and extras: at most 166 bytes and the
 * name twice, local and central), plus 256 for the end records.
 *
 * zlib's own worst case for raw deflate (deflateBound(), window 15 and
 * memLevel 8, as Node's createDeflateRaw()) is n + n/4096 + n/16384 +
 * n/2^25 + 7 bytes, about +0.031 %, and level 1 reaches it on random data
 * (measured with Node 24.16 / zlib 1.3.1: 64 MiB → +0.0305 %). 1/1024 is
 * +0.098 %, more than three times that, so a different zlib build with a
 * looser bound is covered too.
 */
export function zipSizeBound(plan: ZipPlan, store: boolean): number {
  const encoder = new TextEncoder();
  const entry = (path: string) => 256 + 2 * encoder.encode(path).length;
  let total = 256;
  for (const f of plan.files) {
    const deflated = !store && !isCompressedPath(f.path);
    total += entry(f.path) + f.size + (deflated ? Math.ceil(f.size / 1024) + 64 : 0);
  }
  for (const d of plan.dirs) total += entry(d.path);
  return total;
}

/**
 * `bound`, or less for the e2e tests: YEET_TEST_ZIP_SIZE_BOUND (an integer
 * from 0) lowers it, so the guard against a zip outgrowing its estimate can
 * be reached (0 streams any zip). Higher or malformed values are ignored, so
 * the hook can never send a zip to the temporary file that would stream.
 */
export function testZipSizeBound(bound: number): number {
  const raw = process.env.YEET_TEST_ZIP_SIZE_BOUND;
  const n = Number(raw);
  return raw && Number.isSafeInteger(n) && n >= 0 ? Math.min(n, bound) : bound;
}

/** The error code of a failed file-system call ("ENOSPC", …), if any. */
const codeOf = (err: unknown) => (err as NodeJS.ErrnoException | undefined)?.code;

/**
 * A file's contents as a stream, opened when first pulled (so a folder of
 * 10,000 files never holds more than one open) and closed at the end, on an
 * error or when cancelled.
 */
function fileStream(path: string, onBytes: (n: number) => void): ReadableStream<Uint8Array> {
  let handle: FileHandle | undefined;
  const close = async () => {
    const h = handle;
    handle = undefined;
    await h?.close().catch(() => {});
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        handle ??= await open(path, "r");
        const buffer = new Uint8Array(READ_CHUNK);
        const { bytesRead } = await handle.read(buffer, 0, READ_CHUNK, null);
        if (bytesRead === 0) {
          await close();
          controller.close();
          return;
        }
        onBytes(bytesRead);
        controller.enqueue(bytesRead === READ_CHUNK ? buffer : buffer.subarray(0, bytesRead));
      } catch (err) {
        await close();
        throw err;
      }
    },
    cancel: close,
  });
}

/** The CLI's compressor and CRC-32 (docs/design/zip.md): zlib level 1, and zlib.crc32 where Node has it. */
export function cliZipOptions(store: boolean): ZipOptions {
  const crc32 = (zlib as { crc32?: (data: Uint8Array, previous: number) => number }).crc32;
  return {
    compress: !store,
    deflateRaw: () => Duplex.toWeb(zlib.createDeflateRaw({ level: 1 })) as unknown as ByteTransform,
    ...(crc32 ? { crc32 } : {}),
  };
}

/** The zip's entries; `onFile` gets "file k of n" when a file is reached, `onBytes` each chunk read. */
function zipEntries(
  plan: ZipPlan,
  onFile: (note: string) => void,
  onBytes: (n: number) => void,
): ZipEntry[] {
  let fileNumber = 0;
  return [
    ...plan.files.map((f) => ({
      path: f.path,
      size: f.size,
      lastModified: f.mtimeMs,
      stream: () => {
        onFile(`file ${++fileNumber} of ${plan.files.length}`);
        return fileStream(f.source, onBytes);
      },
    })),
    ...plan.dirs.map((d) => ({ path: d.path, lastModified: d.mtimeMs })),
  ];
}

/**
 * Delete an unfinished upload, best effort. A server deletes at most 100
 * objects per request and answers `done: false` while more is left (an
 * upload of unknown size has a record per part), so ask until it is done;
 * whatever a failure leaves is pending, never listed, and the server's
 * cleanup removes it.
 */
async function abortUpload(config: Config, id: string): Promise<void> {
  try {
    for (let round = 0; round < MAX_DELETE_ROUNDS; round++) {
      const r = await withRetries(() =>
        api<{ done?: unknown } | undefined>(config, "DELETE", `/uploads/${id}`),
      );
      if (r?.done !== false) return;
    }
  } catch {
    // Left for the server's cleanup.
  }
}

/**
 * One zip upload's state, shared by its phases: the first failure, which
 * stops everything (`stop`), and the signals. The first Ctrl-C (SIGTERM,
 * SIGHUP) is a failure like any other: the upload stops, its parts in
 * flight finish, it is deleted. A signal once the upload has failed (a
 * second Ctrl-C, or one while a failed upload waits for its parts in
 * flight or deletes it) quits at once: the temporary zip, if any, is
 * removed by its "exit" handler, and the server's cleanup removes the
 * upload.
 */
class Run {
  failure: unknown;
  readonly stop = new AbortController();
  /** An upload on the server that is neither complete nor deleted yet. */
  pending: string | undefined;

  private readonly onSignal = (signal: NodeJS.Signals) => {
    if (this.failure !== undefined) {
      if (this.pending !== undefined) {
        process.stderr.write(
          "\nQuit without waiting; the server's cleanup removes the unfinished upload.\n",
        );
      }
      process.exit(exitCodeFor(signal));
    }
    this.fail(new InterruptedError(signal));
  };

  constructor() {
    for (const signal of SIGNALS) process.on(signal, this.onSignal);
  }

  fail = (err: unknown): void => {
    if (this.failure === undefined) {
      this.failure = err;
      this.stop.abort(err);
    }
  };

  /** Throw the failure, if there is one. */
  check(): void {
    if (this.failure !== undefined) throw this.failure;
  }

  end(): void {
    for (const signal of SIGNALS) process.off(signal, this.onSignal);
  }
}

interface Target {
  id: string;
  partSize: number;
}

/**
 * Upload `source` as the parts of `target` and complete it. `size` is the
 * size sent at create, or undefined: then it is sent at `complete`, and
 * the upload may have at most maxUnsizedParts() parts (the guard below; the
 * caller only streams a zip of unknown size that zipSizeBound() keeps a
 * part below that). On any failure the upload is deleted, after its parts
 * in flight finish, and never completed.
 */
async function sendParts(
  config: Config,
  run: Run,
  target: Target,
  size: number | undefined,
  source: ReadableStream<Uint8Array>,
  progress: { read?: (bytes: number) => void; uploaded: (bytes: number) => void },
): Promise<string> {
  const onUploaded = progress.uploaded;
  const { id, partSize } = target;
  run.pending = id;
  // After a failure no new part starts and no retry is made (`run.stop`),
  // but parts in flight are let finish before the DELETE: one the server is
  // still storing could otherwise land after it (and leave a part record
  // nothing removes). Only if they take longer than IN_FLIGHT_GRACE_MS are
  // their requests aborted (`requests`).
  const requests = new AbortController();
  const maxParts = maxUnsizedParts();
  const limit = maxParts * partSize;
  const tooLarge = () =>
    new Error(
      `The zip grew past ${formatSize(limit)} (${maxParts} parts of ${formatSize(partSize)}), ` +
        `the most the server completes when it is not told the size up front, though yeet ` +
        `expected it to stay below that (a bug in yeet). Use --store (no compression: the ` +
        `size is then known in advance).`,
    );

  const parts: { part_number: number; etag: string }[] = [];
  const inFlight = new Set<Promise<void>>();
  let produced = 0;
  const uploadPart = async (partNumber: number, data: Uint8Array) => {
    let counted = 0;
    const part = await withRetries(
      () => {
        onUploaded(-counted); // undo progress from a failed attempt
        counted = 0;
        return api<{ part_number: number; etag: string }>(
          config,
          "PUT",
          `/uploads/${id}/parts/${partNumber}`,
          undefined,
          {
            body: countingStream(data, (bytes) => {
              counted += bytes;
              onUploaded(bytes);
            }),
            headers: {
              "Content-Type": "application/octet-stream",
              "Content-Length": String(data.length),
            },
            duplex: "half",
            signal: requests.signal,
          } as RequestInit,
        );
      },
      4,
      run.stop.signal,
    );
    parts.push(part);
  };
  /** Start uploading a part; wait while CONCURRENCY parts are in flight (backpressure on the source). */
  const dispatch = async (partNumber: number, data: Uint8Array) => {
    // The guard: never upload a part the server will not complete.
    if (size === undefined && partNumber > maxParts) throw tooLarge();
    const task: Promise<void> = uploadPart(partNumber, data)
      .catch(run.fail)
      .finally(() => inFlight.delete(task));
    inFlight.add(task);
    while (inFlight.size >= CONCURRENCY && run.failure === undefined) await Promise.race(inFlight);
    run.check();
  };

  const reader = source.getReader();
  try {
    let partNumber = 0;
    let buffer = new Uint8Array(partSize);
    let filled = 0;
    for (;;) {
      const { done, value } = await reader.read();
      run.check();
      if (done) break;
      produced += value.length;
      progress.read?.(value.length);
      for (let offset = 0; offset < value.length; ) {
        const n = Math.min(partSize - filled, value.length - offset);
        buffer.set(value.subarray(offset, offset + n), filled);
        filled += n;
        offset += n;
        if (filled === partSize) {
          await dispatch(++partNumber, buffer);
          buffer = new Uint8Array(partSize);
          filled = 0;
        }
      }
    }
    if (filled > 0 || partNumber === 0) await dispatch(++partNumber, buffer.subarray(0, filled));
    await Promise.all(inFlight);
    run.check();
    if (size !== undefined && produced !== size) {
      throw new Error(`The zip came out ${produced} bytes, not the ${size} announced (a bug)`);
    }
    parts.sort((a, b) => a.part_number - b.part_number);
    const { url } = await withRetries(
      () =>
        api<{ url: string }>(config, "POST", `/uploads/${id}/complete`, { parts, size: produced }),
      4,
      run.stop.signal,
    );
    run.pending = undefined;
    return url;
  } catch (err) {
    run.fail(err);
    // Stop reading (cancels the zip and its current source, or the
    // temporary file), let the parts in flight finish, then delete the
    // multipart upload.
    await reader.cancel(run.failure).catch(() => {});
    const grace = setTimeout(() => requests.abort(run.failure), IN_FLIGHT_GRACE_MS);
    await Promise.allSettled(inFlight);
    clearTimeout(grace);
    await abortUpload(config, id);
    run.pending = undefined;
    throw run.failure;
  }
}

/** Free bytes for an unprivileged user on the disk holding `dir`, or undefined if unknown. */
async function freeSpace(dir: string): Promise<number | undefined> {
  // fs.statfs is in Node 18.15+; looked up when called, so a test can stub it.
  const statfs = (fsp as { statfs?: typeof fsp.statfs }).statfs;
  if (typeof statfs !== "function") return undefined;
  try {
    const s = await statfs(dir);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return undefined;
  }
}

/**
 * Write the zip of `plan` to `path` (created, mode 600), with a "Zipping"
 * progress line; returns its size. Stops at a failure (Ctrl-C included).
 */
async function writeZip(
  run: Run,
  path: string,
  plan: ZipPlan,
  zipOptions: ZipOptions,
): Promise<number> {
  const progress = new Progress(`Zipping ${plan.name}`, plan.totalSize);
  let inputRead = 0;
  const entries = zipEntries(
    plan,
    (note) => (progress.note = note),
    (n) => progress.set((inputRead += n)),
  );
  const reader = createZip(entries, zipOptions).getReader();
  let handle: FileHandle | undefined;
  let written = 0;
  try {
    handle = await open(path, "wx", 0o600);
    for (;;) {
      const { done, value } = await reader.read();
      run.check();
      if (done) break;
      for (let offset = 0; offset < value.length; ) {
        const { bytesWritten } = await handle.write(value, offset, value.length - offset);
        offset += bytesWritten;
      }
      written += value.length;
    }
    return written;
  } catch (err) {
    run.fail(err);
    await reader.cancel(err).catch(() => {});
    if (codeOf(err) === "ENOSPC") {
      throw new Error(
        `The disk holding the temporary zip (${tmpdir()}) is full. Use --store (no ` +
          `compression: no temporary file), free up space, or set TMPDIR to a folder on a ` +
          `disk with more room.`,
      );
    }
    throw err;
  } finally {
    await handle?.close().catch(() => {});
    progress.done();
  }
}

/**
 * The zip of `plan`, written to a temporary file first, then uploaded with
 * its exact size at create. The file is always removed: by the `finally`
 * below, or, on a quick exit (process.exit() from a second Ctrl-C), by the
 * "exit" handler.
 */
async function viaTempFile(
  config: Config,
  run: Run,
  plan: ZipPlan,
  zipOptions: ZipOptions,
  create: (size: number) => Promise<Target>,
  bound: number,
  limit: number,
): Promise<string> {
  const base = tmpdir();
  const need = bound + FREE_SPACE_MARGIN;
  const free = await freeSpace(base);
  if (free !== undefined && free < need) {
    throw new Error(
      `Not enough free disk space. A compressed zip that may be larger than ` +
        `${formatSize(limit)} is written to a temporary file before it is uploaded, which ` +
        `needs ${formatSize(need)} free in ${base} (${formatSize(free)} is free). Use --store ` +
        `(no compression: the zip is streamed, with no temporary file), free up space, or set ` +
        `TMPDIR to a folder on a disk with more room.`,
    );
  }
  process.stderr.write(
    `The zip may be larger than ${formatSize(limit)}, the most yeet streams without knowing ` +
      `its size up front: zipping it to a temporary file in ${base} first.\n`,
  );
  const dir = await mkdtemp(join(base, "yeet-"));
  const removeSync = () => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Nothing more to do while exiting.
    }
  };
  process.on("exit", removeSync);
  try {
    run.check();
    const path = join(dir, "upload.zip");
    const size = await writeZip(run, path, plan, zipOptions);
    run.check();
    const target = await create(size);
    const progress = new Progress(plan.name, size);
    let uploaded = 0;
    try {
      return await sendParts(
        config,
        run,
        target,
        size,
        fileStream(path, () => {}),
        {
          uploaded: (n) => progress.set((uploaded += n)),
        },
      );
    } finally {
      progress.done();
    }
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    process.off("exit", removeSync);
  }
}

export interface ZipUploadOptions {
  expiresDays: number;
  password: string | undefined;
  store: boolean;
}

export async function uploadZip(
  config: Config,
  plan: ZipPlan,
  { expiresDays, password, store }: ZipUploadOptions,
): Promise<string> {
  const zipOptions = cliZipOptions(store);
  const create = async (size: number | undefined): Promise<Target> => {
    const r = await api<{ id: string; part_size: number }>(config, "POST", "/uploads", {
      filename: plan.name,
      ...(size !== undefined ? { size } : {}),
      expires_in: Math.round(expiresDays * 24 * 60 * 60),
      ...(password ? { password } : {}),
    });
    return { id: r.id, partSize: r.part_size };
  };
  /** Zip while uploading, with the input bytes whose output has been uploaded as progress. */
  const stream = async (target: Target, size: number | undefined) => {
    const progress = new Progress(plan.name, plan.totalSize);
    let inputRead = 0;
    let produced = 0;
    let uploaded = 0;
    // Bytes of input whose zip output has been uploaded, assuming an even ratio.
    const draw = () => progress.set(produced ? inputRead * Math.min(1, uploaded / produced) : 0);
    const zip = createZip(
      zipEntries(
        plan,
        (note) => (progress.note = note),
        (n) => {
          inputRead += n;
          draw();
        },
      ),
      zipOptions,
    );
    try {
      return await sendParts(config, run, target, size, zip, {
        read: (n) => (produced += n),
        uploaded: (n) => {
          uploaded += n;
          draw();
        },
      });
    } finally {
      progress.done();
    }
  };

  const run = new Run();
  try {
    const known = storedZipSize(
      zipEntries(
        plan,
        () => {},
        () => {},
      ),
      zipOptions,
    );
    if (known !== undefined) return await stream(await create(known), known);

    const target = await create(undefined);
    const maxParts = maxUnsizedParts();
    const bound = testZipSizeBound(zipSizeBound(plan, store));
    // A part to spare: the bound is already a worst case (see zipSizeBound()).
    if (bound <= (maxParts - 1) * target.partSize) return await stream(target, undefined);

    // Possibly too large to stream: the size must be sent at create, so this
    // upload is not used.
    run.pending = target.id;
    await abortUpload(config, target.id);
    run.pending = undefined;
    run.check();
    return await viaTempFile(
      config,
      run,
      plan,
      zipOptions,
      create,
      bound,
      maxParts * target.partSize,
    );
  } finally {
    run.end();
  }
}
