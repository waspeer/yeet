// Deterministic test content, isomorphic (Node, workerd, browsers).
// The same fixture set is zipped in every runtime; Node recomputes the
// expected SHA-256 of each entry independently and compares after extraction.

import type { ZipEntry } from "./zip.ts";

const CHUNK = 64 * 1024;

/** A stream of `size` bytes produced by `fill(chunk, offsetOfChunk)`. */
export function generatedStream(
  size: number,
  fill: (chunk: Uint8Array, offset: number) => void,
  chunkSize = CHUNK,
): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= size) {
        controller.close();
        return;
      }
      const chunk = new Uint8Array(Math.min(chunkSize, size - offset));
      fill(chunk, offset);
      offset += chunk.length;
      controller.enqueue(chunk);
    },
  });
}

/** Seeded xorshift32 noise. Each call continues the same sequence. */
export function noise(seed: number): (chunk: Uint8Array) => void {
  let x = seed >>> 0 || 1;
  return (chunk) => {
    const n = chunk.length;
    for (let i = 0; i < n; i += 4) {
      x ^= x << 13;
      x ^= x >>> 17;
      x ^= x << 5;
      chunk[i] = x;
      if (i + 1 < n) chunk[i + 1] = x >>> 8;
      if (i + 2 < n) chunk[i + 2] = x >>> 16;
      if (i + 3 < n) chunk[i + 3] = x >>> 24;
    }
  };
}

/**
 * Synthetic 16-bit stereo 44.1 kHz WAV resembling a multitrack stem:
 * repeating 8 s cycle of 4 s digital silence, 2 s tone (440 Hz + harmonics,
 * low noise floor), 2 s full-band noise at -12 dBFS. ~50% silence.
 */
export function wavFill(totalSize: number, seed = 7): (chunk: Uint8Array, offset: number) => void {
  const header = new Uint8Array(44);
  const v = new DataView(header.buffer);
  const dataSize = totalSize - 44;
  v.setUint32(0, 0x52494646); // "RIFF"
  v.setUint32(4, totalSize - 8, true);
  v.setUint32(8, 0x57415645); // "WAVE"
  v.setUint32(12, 0x666d7420); // "fmt "
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 2, true); // stereo
  v.setUint32(24, 44100, true);
  v.setUint32(28, 44100 * 4, true);
  v.setUint16(32, 4, true);
  v.setUint16(34, 16, true);
  v.setUint32(36, 0x64617461); // "data"
  v.setUint32(40, dataSize, true);
  let x = seed >>> 0 || 1;
  const rand = () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return (x >>> 0) / 0x100000000 - 0.5;
  };
  return (chunk, offset) => {
    for (let i = 0; i < chunk.length; i++) {
      const pos = offset + i;
      if (pos < 44) {
        chunk[i] = header[pos];
        continue;
      }
      // One 16-bit little-endian sample per 2 bytes; compute on the low byte.
      const byte = (pos - 44) & 1;
      if (byte === 1) continue; // filled together with the low byte below
      const frame = Math.floor((pos - 44) / 4);
      const t = frame / 44100;
      const phase = t % 8;
      let s = 0;
      if (phase < 4) s = 0;
      else if (phase < 6) {
        s =
          0.3 * Math.sin(2 * Math.PI * 440 * t) +
          0.1 * Math.sin(2 * Math.PI * 880 * t) +
          0.05 * Math.sin(2 * Math.PI * 1320 * t) +
          0.002 * rand();
      } else s = 0.25 * rand() * 2;
      const sample = Math.max(-32768, Math.min(32767, Math.round(s * 32767)));
      chunk[i] = sample & 0xff;
      if (i + 1 < chunk.length) chunk[i + 1] = (sample >> 8) & 0xff;
      // A sample split across chunk boundaries keeps a zero high byte; with
      // even chunk sizes (always the case here) that never happens.
    }
  };
}

const TEXT = new TextEncoder().encode(
  "yeet zips files while streaming. ".repeat(2000) + "\nThe end.\n",
);

export interface FixtureOptions {
  /** Whether entries declare `size` up front: affects ZIP64 local headers. */
  sizes: "known" | "unknown" | "mixed";
  /** Fixed mtime so archives are reproducible. */
  lastModified?: number;
}

/** The standard fixture set (~14 MiB uncompressed). */
export function fixtureEntries(opts: FixtureOptions): ZipEntry[] {
  const lastModified = opts.lastModified ?? Date.UTC(2026, 9, 7, 12, 34, 56);
  const defs: {
    path: string;
    size: number;
    fill?: () => (c: Uint8Array, o: number) => void;
    compress?: boolean;
  }[] = [
    {
      path: "hello.txt",
      size: TEXT.length,
      fill: () => (c, o) => c.set(TEXT.subarray(o, o + c.length)),
    },
    { path: "empty.bin", size: 0, fill: () => () => {} },
    { path: "random.bin", size: 3 * 1024 * 1024 + 7, fill: () => noise(1) },
    {
      path: "audio/stem silence-heavy.wav",
      size: 8 * 1024 * 1024 + 44,
      fill: () => wavFill(8 * 1024 * 1024 + 44),
    },
    { path: "photos/IMG_0001.JPG", size: 1024 * 1024, fill: () => noise(2) },
    {
      path: "Ünïcödé/日本語 — 🎵 ñ.txt",
      size: TEXT.length,
      fill: () => (c, o) => c.set(TEXT.subarray(o, o + c.length)),
    },
    {
      path: "forced-store.txt",
      size: TEXT.length,
      fill: () => (c, o) => c.set(TEXT.subarray(o, o + c.length)),
      compress: false,
    },
    {
      path: "deep/a/b/c/d/e.txt",
      size: 5,
      fill: () => (c) => c.set(new TextEncoder().encode("deep\n")),
    },
    { path: "empty-dir/", size: 0 },
  ];
  return defs.map((d, index) => {
    const known = opts.sizes === "known" || (opts.sizes === "mixed" && index % 2 === 0);
    return {
      path: d.path,
      lastModified,
      size: d.path.endsWith("/") || !known ? undefined : d.size,
      compress: d.compress,
      stream: d.fill ? () => generatedStream(d.size, d.fill!()) : undefined,
    };
  });
}
