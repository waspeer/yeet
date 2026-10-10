// Upload several files or a folder as one zip, zipped while it uploads:
// zip.ts streams the archive, which is cut into parts of exactly `part_size`
// (the last one shorter) and uploaded CONCURRENCY at a time. Nothing is
// written to disk, and at most CONCURRENCY + 1 parts are held in memory.
//
// The size goes to the server at `complete` (a deflated zip's size is only
// known at its end), or already at create when it is known up front: every
// file stored (`--store`, or only already-compressed files), see
// storedZipSize(). On any error (a file that cannot be read or changed while
// it was read, a part that failed after its retries, Ctrl-C) the multipart
// upload is deleted (after the parts in flight finish) and never completed,
// so no truncated zip is ever published. See docs/design/zip.md.

import { open, type FileHandle } from "node:fs/promises";
import { Duplex } from "node:stream";
import zlib from "node:zlib";
import { api, withRetries, type Config } from "./api.js";
import { MAX_DELETE_ROUNDS, MAX_UNSIZED_PARTS } from "./limits.js";
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

/** Ctrl-C during an upload: the caller exits with 130. */
export class InterruptedError extends Error {
  constructor() {
    super("Interrupted");
  }
}

/** How long a failed upload waits for its parts in flight before it aborts them and deletes. */
const IN_FLIGHT_GRACE_MS = 30_000;

/** Bytes read from disk per chunk. */
const READ_CHUNK = 1024 * 1024;

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
  const progress = new Progress(plan.name, plan.totalSize);
  let inputRead = 0;
  let produced = 0;
  let uploaded = 0;
  let fileNumber = 0;
  const draw = () => {
    // Bytes of input whose zip output has been uploaded, assuming an even ratio.
    progress.set(produced ? inputRead * Math.min(1, uploaded / produced) : 0);
  };
  const entries = (): ZipEntry[] => [
    ...plan.files.map((f) => ({
      path: f.path,
      size: f.size,
      lastModified: f.mtimeMs,
      stream: () => {
        progress.note = `file ${++fileNumber} of ${plan.files.length}`;
        return fileStream(f.source, (n) => {
          inputRead += n;
          draw();
        });
      },
    })),
    ...plan.dirs.map((d) => ({ path: d.path, lastModified: d.mtimeMs })),
  ];
  const size = storedZipSize(entries(), zipOptions);

  const { id, part_size: partSize } = await api<{ id: string; part_size: number }>(
    config,
    "POST",
    "/uploads",
    {
      filename: plan.name,
      ...(size !== undefined ? { size } : {}),
      expires_in: Math.round(expiresDays * 24 * 60 * 60),
      ...(password ? { password } : {}),
    },
  );

  // After a failure no new part starts and no retry is made (`stop`), but
  // parts in flight are let finish before the DELETE: one the server is
  // still storing could otherwise land after it (and leave a part record
  // nothing removes). Only if they take longer than IN_FLIGHT_GRACE_MS are
  // their requests aborted (`requests`).
  const stop = new AbortController();
  const requests = new AbortController();
  let failure: unknown;
  const fail = (err: unknown) => {
    if (failure === undefined) {
      failure = err;
      stop.abort(err);
    }
  };
  // A second Ctrl-C quits at once (the server's cleanup removes the upload).
  const onSigint = () => {
    if (failure instanceof InterruptedError) process.exit(130);
    fail(new InterruptedError());
  };
  process.on("SIGINT", onSigint);

  const limit = MAX_UNSIZED_PARTS * partSize;
  const tooLarge = () =>
    new Error(
      `The zip would be larger than ${formatSize(limit)} (${MAX_UNSIZED_PARTS} parts of ` +
        `${formatSize(partSize)}), the most the server completes when it cannot be told the ` +
        `size up front. Use --store (no compression: the size is then known in advance), or ` +
        `upload the files in smaller groups.`,
    );

  const parts: { part_number: number; etag: string }[] = [];
  const inFlight = new Set<Promise<void>>();
  const uploadPart = async (partNumber: number, data: Uint8Array) => {
    let counted = 0;
    const part = await withRetries(
      () => {
        uploaded -= counted; // undo progress from a failed attempt
        counted = 0;
        return api<{ part_number: number; etag: string }>(
          config,
          "PUT",
          `/uploads/${id}/parts/${partNumber}`,
          undefined,
          {
            body: countingStream(data, (bytes) => {
              counted += bytes;
              uploaded += bytes;
              draw();
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
      stop.signal,
    );
    parts.push(part);
  };
  /** Start uploading a part; wait while CONCURRENCY parts are in flight (backpressure on the zip). */
  const dispatch = async (partNumber: number, data: Uint8Array) => {
    if (size === undefined && partNumber > MAX_UNSIZED_PARTS) throw tooLarge();
    const task: Promise<void> = uploadPart(partNumber, data)
      .catch(fail)
      .finally(() => inFlight.delete(task));
    inFlight.add(task);
    while (inFlight.size >= CONCURRENCY && failure === undefined) await Promise.race(inFlight);
    if (failure !== undefined) throw failure;
  };

  const reader = createZip(entries(), zipOptions).getReader();
  try {
    if (size === undefined) {
      // Stored files alone already make the zip at least this large.
      const stored = plan.files
        .filter((f) => store || isCompressedPath(f.path))
        .reduce((sum, f) => sum + f.size, 0);
      if (stored > limit) throw tooLarge();
    }
    let partNumber = 0;
    let buffer = new Uint8Array(partSize);
    let filled = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (failure !== undefined) throw failure;
      if (done) break;
      produced += value.length;
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
    if (failure !== undefined) throw failure;
    if (size !== undefined && produced !== size) {
      throw new Error(`The zip came out ${produced} bytes, not the ${size} announced (a bug)`);
    }
    parts.sort((a, b) => a.part_number - b.part_number);
    const { url } = await withRetries(
      () =>
        api<{ url: string }>(config, "POST", `/uploads/${id}/complete`, { parts, size: produced }),
      4,
      stop.signal,
    );
    return url;
  } catch (err) {
    fail(err);
    // Stop reading files (cancels the zip and its current source), let the
    // parts in flight finish, then delete the multipart upload.
    await reader.cancel(failure).catch(() => {});
    const grace = setTimeout(() => requests.abort(failure), IN_FLIGHT_GRACE_MS);
    await Promise.allSettled(inFlight);
    clearTimeout(grace);
    await abortUpload(config, id);
    throw failure;
  } finally {
    process.off("SIGINT", onSigint);
    progress.done();
  }
}
