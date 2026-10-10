// Deflate throughput and ratio in Node:
//   CompressionStream("deflate-raw") vs node:zlib createDeflateRaw (levels 1, 3, 6),
//   each wrapped as a Web Streams transform exactly as the CLI would inject it,
//   plus end-to-end createZip (incl. CRC-32) with each compressor.
// Inputs (all held in memory first so disk speed is excluded):
//   random     64 MiB xorshift noise
//   synth-wav  64 MiB synthetic 16-bit stereo WAV, ~50% digital silence
//   stems      the real stems folder (read-only), if present
// Usage: node e2e/zip/bench/bench-compress.ts [runs=3] [--e2e]   (--e2e: only the end-to-end stems section)
import { createReadStream } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import { Duplex, Readable } from "node:stream";
import zlib from "node:zlib";
import { generatedStream, noise, wavFill } from "../fixtures.ts";
import { createZip, crc32Js, type ByteTransform } from "../../../packages/cli/src/zip.ts";

const RUNS = Number(process.argv.slice(2).find((a) => /^\d+$/.test(a)) ?? 3);
const E2E_ONLY = process.argv.includes("--e2e");
const STEMS = "/Users/wannessalome/Downloads/tien-voor-sil-148bpm";
const CHUNK = 64 * 1024;
const MiB = 1024 * 1024;

async function collect(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function chunked(data: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let i = 0; i < data.length; i += CHUNK) out.push(data.subarray(i, i + CHUNK));
  return out;
}

function source(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream({
    pull(c) {
      if (i < chunks.length) c.enqueue(chunks[i++]);
      else c.close();
    },
  });
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<number> {
  let n = 0;
  for await (const c of stream as unknown as AsyncIterable<Uint8Array>) n += c.length;
  return n;
}

const compressors: [string, () => ByteTransform][] = [
  [
    "CompressionStream deflate-raw",
    () => new CompressionStream("deflate-raw") as unknown as ByteTransform,
  ],
  ...[1, 3, 6].map(
    (level) =>
      [
        `zlib level ${level} (Duplex.toWeb)`,
        () => Duplex.toWeb(zlib.createDeflateRaw({ level })) as unknown as ByteTransform,
      ] as [string, () => ByteTransform],
  ),
];

interface Input {
  label: string;
  files: Uint8Array[][]; // chunked files
  bytes: number;
}

async function inputs(): Promise<Input[]> {
  const size = 64 * MiB;
  const random = await collect(generatedStream(size, noise(11)));
  const wav = await collect(generatedStream(size, wavFill(size)));
  const list: Input[] = [
    { label: "random 64 MiB", files: [chunked(random)], bytes: size },
    { label: "synth-wav 64 MiB", files: [chunked(wav)], bytes: size },
  ];
  try {
    const names = (await readdir(STEMS)).filter((n) => n.endsWith(".wav")).sort();
    const files = await Promise.all(names.map((n) => readFile(join(STEMS, n))));
    const bytes = files.reduce((a, f) => a + f.length, 0);
    list.push({
      label: `stems ${names.length} WAV ${(bytes / 1e6).toFixed(1)} MB`,
      files: files.map((f) => chunked(new Uint8Array(f.buffer, f.byteOffset, f.length))),
      bytes,
    });
  } catch (error) {
    console.log(`(stems not available: ${(error as Error).message})`);
  }
  return list;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}

console.log(
  `${process.version}, ${os.cpus()[0]!.model}, ${os.cpus().length} cores, zlib ${process.versions.zlib}; median of ${RUNS} runs; MB = 1e6 bytes of input`,
);
for (const input of E2E_ONLY ? [] : await inputs()) {
  console.log(`\n## ${input.label}`);
  console.log(
    `  ${"compressor".padEnd(34)} ${"ratio".padStart(7)} ${"deflate MB/s".padStart(13)} ${"createZip MB/s".padStart(15)}`,
  );
  for (const [label, make] of compressors) {
    const times: number[] = [];
    const zipTimes: number[] = [];
    let out = 0;
    for (let run = 0; run < RUNS; run++) {
      let t = performance.now();
      out = 0;
      for (const file of input.files) out += await drain(source(file).pipeThrough(make()));
      times.push(performance.now() - t);
      t = performance.now();
      const zlibCrc = (zlib as { crc32?: (d: Uint8Array, p: number) => number }).crc32 ?? crc32Js;
      await drain(
        createZip(
          input.files.map((file, i) => ({
            path: `f${i}.wav`,
            size: file.reduce((a, c) => a + c.length, 0),
            stream: () => source(file),
          })),
          { deflateRaw: make, crc32: zlibCrc },
        ),
      );
      zipTimes.push(performance.now() - t);
    }
    const mbps = (ms: number) => (input.bytes / 1e6 / (ms / 1000)).toFixed(0);
    console.log(
      `  ${label.padEnd(34)} ${((out / input.bytes) * 100).toFixed(1).padStart(6)}% ${mbps(median(times)).padStart(13)} ${mbps(median(zipTimes)).padStart(15)}`,
    );
  }
  // Store baseline: createZip without compression (CRC + framing only).
  const crcs: [string, (d: Uint8Array, p: number) => number][] = [["crc32Js", crc32Js]];
  const nativeCrc = (zlib as { crc32?: (d: Uint8Array, p: number) => number }).crc32;
  if (nativeCrc) crcs.push(["zlib.crc32", nativeCrc]);
  for (const [crcLabel, crc] of crcs) {
    const storeTimes: number[] = [];
    for (let run = 0; run < RUNS; run++) {
      const t = performance.now();
      await drain(
        createZip(
          input.files.map((file, i) => ({
            path: `f${i}.wav`,
            size: file.reduce((a, c) => a + c.length, 0),
            compress: false,
            stream: () => source(file),
          })),
          { crc32: crc },
        ),
      );
      storeTimes.push(performance.now() - t);
    }
    const label = `store (${crcLabel})`;
    console.log(
      `  ${label.padEnd(34)} ${"100.0%".padStart(7)} ${"-".padStart(13)} ${(input.bytes / 1e6 / (median(storeTimes) / 1000)).toFixed(0).padStart(15)}`,
    );
  }
}

// End to end like the CLI would run it: stems read from disk (warm page
// cache) through createZip, output drained (no upload).
try {
  const names = (await readdir(STEMS)).filter((n) => n.endsWith(".wav")).sort();
  const sizes = await Promise.all(names.map(async (n) => (await stat(join(STEMS, n))).size));
  const bytes = sizes.reduce((a, b) => a + b, 0);
  const entries = () =>
    names.map((n, i) => ({
      path: `tien-voor-sil-148bpm/${n}`,
      size: sizes[i],
      stream: () =>
        Readable.toWeb(createReadStream(join(STEMS, n))) as unknown as ReadableStream<Uint8Array>,
    }));
  console.log(
    `\n## end to end from disk: stems folder (${(bytes / 1e6).toFixed(1)} MB), median of ${RUNS}`,
  );
  const nativeCrc = (zlib as { crc32?: (d: Uint8Array, p: number) => number }).crc32 ?? crc32Js;
  const configs: [string, Parameters<typeof createZip>[1]][] = [
    ["defaults (CompressionStream, crc32Js)", {}],
    [
      "zlib level 1 + zlib.crc32 (CLI proposal)",
      { deflateRaw: compressors[1]![1], crc32: nativeCrc },
    ],
    ["store + zlib.crc32 (--store)", { compress: false, crc32: nativeCrc }],
  ];
  for (const [label, options] of configs) {
    const times: number[] = [];
    let out = 0;
    for (let run = 0; run < RUNS; run++) {
      const t = performance.now();
      out = await drain(createZip(entries(), options));
      times.push(performance.now() - t);
    }
    const ms = median(times);
    console.log(
      `  ${label.padEnd(42)} ${((out / bytes) * 100).toFixed(1).padStart(6)}% ${(bytes / 1e6 / (ms / 1000)).toFixed(0).padStart(6)} MB/s  (${(ms / 1000).toFixed(2)} s)`,
    );
  }
} catch (error) {
  console.log(`(end-to-end skipped: ${(error as Error).message})`);
}
