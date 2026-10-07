// Test file generators. Every generator returns the path, size and SHA-256 of
// what it wrote, so tests can compare downloads against the source.

import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";

export const KiB = 1024;
export const MiB = 1024 * 1024;

export interface FileFixture {
  path: string;
  /** Basename, which the CLI uses as the upload's filename. */
  name: string;
  size: number;
  sha256: string;
}

/** Filenames that exercise URL and Content-Disposition encoding. */
export const FILENAMES = {
  spaces: "holiday photos (final) v2.bin",
  unicode: "Ünïcødé sämple – 名前 🎵.wav",
  /** RFC 8187 must escape these sub-delimiters in Content-Disposition. */
  punctuation: "it's (really) #1 & 50% done!.txt",
} as const;

/** SHA-256 hex digest of a file (given its path) or of a buffer. */
export async function sha256(input: string | Uint8Array): Promise<string> {
  const hash = createHash("sha256");
  if (typeof input !== "string") return hash.update(input).digest("hex");
  for await (const chunk of createReadStream(input)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/** Write chunks produced by `next(offset, length)` to a file, hashing as it goes. */
async function writeChunked(
  path: string,
  size: number,
  next: (offset: number, length: number) => Uint8Array,
): Promise<string> {
  const hash = createHash("sha256");
  const file = await open(path, "w");
  try {
    const CHUNK = 4 * MiB;
    for (let offset = 0; offset < size; offset += CHUNK) {
      const chunk = next(offset, Math.min(CHUNK, size - offset));
      hash.update(chunk);
      await file.write(chunk);
    }
  } finally {
    await file.close();
  }
  return hash.digest("hex");
}

/**
 * A file of `size` random (incompressible) bytes, e.g. `randomFile(dir, 120 * MiB)`.
 * Streams to disk, so large sizes do not need that much memory.
 */
export async function randomFile(
  dir: string,
  size: number,
  name = `random-${size}.bin`,
): Promise<FileFixture> {
  const path = join(dir, name);
  const digest = await writeChunked(path, size, (_offset, length) => randomBytes(length));
  return { path, name, size, sha256: digest };
}

/**
 * A 16-bit PCM WAV of `seconds` seconds that is mostly digital silence, with a
 * short 440 Hz beep at the start of every second — the shape of a typical
 * voice memo or rehearsal recording, which compresses extremely well.
 */
export async function silentWavFile(
  dir: string,
  seconds: number,
  { name = `silence-${seconds}s.wav`, sampleRate = 44_100, channels = 2 } = {},
): Promise<FileFixture> {
  const bytesPerFrame = channels * 2;
  const frames = Math.round(seconds * sampleRate);
  const dataSize = frames * bytesPerFrame;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + dataSize, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16); // fmt chunk size
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * bytesPerFrame, 28); // byte rate
  header.writeUInt16LE(bytesPerFrame, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write("data", 36, "ascii");
  header.writeUInt32LE(dataSize, 40);

  const beepFrames = Math.round(sampleRate * 0.05);
  const path = join(dir, name);
  const size = header.length + dataSize;
  // Chunks start at even offsets and the header is 44 bytes, so a chunk never
  // splits a 16-bit sample.
  const digest = await writeChunked(path, size, (offset, length) => {
    const chunk = Buffer.alloc(length); // zeros: silence
    if (offset < header.length)
      header.copy(chunk, 0, offset, Math.min(header.length, offset + length));
    const first = Math.max(offset, header.length);
    for (let pos = first; pos + 1 < offset + length; pos += 2) {
      const frame = Math.floor((pos - header.length) / bytesPerFrame);
      if (frame % sampleRate >= beepFrames) continue;
      const sample = Math.round(Math.sin((2 * Math.PI * 440 * frame) / sampleRate) * 8000);
      chunk.writeInt16LE(sample, pos - offset);
    }
    return chunk;
  });
  return { path, name, size, sha256: digest };
}

/** A file with the given text or bytes. */
export async function fileWith(
  dir: string,
  name: string,
  content: string | Uint8Array,
): Promise<FileFixture> {
  const data = typeof content === "string" ? Buffer.from(content) : content;
  const path = join(dir, name);
  const digest = await writeChunked(path, data.length, (offset, length) =>
    data.subarray(offset, offset + length),
  );
  return { path, name, size: data.length, sha256: digest };
}
