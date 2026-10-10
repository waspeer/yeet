// CRC-32 throughput in Node: byte-table vs slice-by-8 (zip.ts) vs zlib.crc32.
// 64 MiB of random data in 64 KiB chunks; 7 runs, median reported.
import os from "node:os";
import zlib from "node:zlib";
import { noise } from "../fixtures.ts";
import { crc32Js } from "../../../packages/cli/src/zip.ts";

const SIZE = 64 * 1024 * 1024;
const CHUNK = 64 * 1024;
const data = new Uint8Array(SIZE);
noise(5)(data);
const chunks: Uint8Array[] = [];
for (let i = 0; i < SIZE; i += CHUNK) chunks.push(data.subarray(i, i + CHUNK));

const TABLE = new Int32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  TABLE[n] = c;
}
function crc32Table(d: Uint8Array, previous = 0): number {
  let c = ~previous;
  for (let i = 0; i < d.length; i++) c = TABLE[(c ^ d[i]!) & 0xff]! ^ (c >>> 8);
  return ~c >>> 0;
}

const impls: [string, (d: Uint8Array, p: number) => number][] = [
  ["byte table (1 KiB)", crc32Table],
  ["slice-by-8 (8 KiB, zip.ts)", crc32Js],
];
const zlibCrc = (zlib as { crc32?: (d: Uint8Array, p: number) => number }).crc32;
if (zlibCrc) impls.push(["zlib.crc32 (native)", zlibCrc]);

console.log(
  `${process.version} ${os.cpus()[0]!.model}, ${SIZE / 1024 / 1024} MiB random in ${CHUNK / 1024} KiB chunks, median of 7`,
);
let reference: number | undefined;
for (const [label, fn] of impls) {
  const times: number[] = [];
  let crc = 0;
  for (let run = 0; run < 7; run++) {
    const t = performance.now();
    crc = 0;
    for (const c of chunks) crc = fn(c, crc);
    times.push(performance.now() - t);
  }
  reference ??= crc;
  times.sort((a, b) => a - b);
  const median = times[3]!;
  console.log(
    `  ${label.padEnd(28)} ${(SIZE / 1e6 / (median / 1000)).toFixed(0).padStart(6)} MB/s  crc=${crc.toString(16)}${crc === reference ? "" : " MISMATCH"}`,
  );
}
