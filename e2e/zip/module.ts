// The zip module under test, and helpers to run it.
//
// Tests import zip.ts through this file. YEET_ZIP_MODULE points it at another
// copy (scripts/mutate.mjs uses that to run the suite against mutants of
// zip.ts and check that each mutant is caught).

import { createWriteStream } from "node:fs";
import { open, stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

type ZipModule = typeof import("../../packages/cli/src/zip.js");
export type { ZipEntry, ZipOptions, ByteTransform } from "../../packages/cli/src/zip.js";

/** The CLI copy; the Worker copy is byte-identical (scripts/check-zip-copies.mjs). */
export const ZIP_MODULE_PATH =
  process.env.YEET_ZIP_MODULE ??
  fileURLToPath(new URL("../../packages/cli/src/zip.ts", import.meta.url));

export const zip: ZipModule = await import(pathToFileURL(ZIP_MODULE_PATH).href);

/** Write a zip stream to a file; returns its size. */
export async function writeZip(
  path: string,
  ...args: Parameters<ZipModule["createZip"]>
): Promise<number> {
  await pipeline(Readable.fromWeb(zip.createZip(...args) as never), createWriteStream(path));
  return (await stat(path)).size;
}

/** The whole zip in memory (small archives only). */
export async function zipBytes(...args: Parameters<ZipModule["createZip"]>): Promise<Uint8Array> {
  return new Uint8Array(await new Response(zip.createZip(...args)).arrayBuffer());
}

/** Read a stream to its end; resolves to the byte count, rejects with the stream's error. */
export async function drain(stream: ReadableStream<Uint8Array>): Promise<number> {
  const reader = stream.getReader();
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return n;
    n += value.length;
  }
}

/**
 * Write a zip to a sparse file: chunks (or 4 KiB blocks of them) that are all
 * zeros are skipped, so they stay holes, which read back as zeros. With
 * zero-filled entries a 5 GB archive takes a few KB on disk (APFS supports
 * sparse files) and check.py can still read it end to end.
 */
export async function writeSparseZip(
  path: string,
  stream: ReadableStream<Uint8Array>,
): Promise<{ size: number; written: number }> {
  const file = await open(path, "w");
  const BLOCK = 4096;
  const zeros = new Uint8Array(1 << 20);
  const isZero = (c: Uint8Array) => {
    for (let i = 0; i < c.length; i += zeros.length) {
      const part = c.subarray(i, i + zeros.length);
      if (Buffer.compare(part, zeros.subarray(0, part.length)) !== 0) return false;
    }
    return true;
  };
  let offset = 0;
  let written = 0;
  try {
    const reader = stream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!isZero(value)) {
        for (let i = 0; i < value.length; i += BLOCK) {
          const block = value.subarray(i, i + BLOCK);
          if (isZero(block)) continue;
          await file.write(block, 0, block.length, offset + i);
          written += block.length;
        }
      }
      offset += value.length;
    }
    await file.truncate(offset);
  } finally {
    await file.close();
  }
  return { size: offset, written };
}

/** A stream of `size` zero bytes in chunks of up to 1 MiB (one shared buffer, no allocation). */
export function zeroStream(size: number, chunk = 1 << 20): ReadableStream<Uint8Array> {
  const buffer = new Uint8Array(chunk);
  let left = size;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (left <= 0) return controller.close();
      const n = Math.min(chunk, left);
      left -= n;
      controller.enqueue(buffer.subarray(0, n));
    },
  });
}
