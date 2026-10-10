// Bundled by node-compat.ts and executed by older Node binaries. Reports
// capabilities and writes two fixture zips (CompressionStream default and
// zlib-injected) for validation by the current Node.
import { createWriteStream } from "node:fs";
import { Duplex, Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import zlib from "node:zlib";
import { fixtureEntries } from "../fixtures.ts";
import { createZip, type ZipOptions } from "../../../packages/cli/src/zip.ts";

const [defaultOut, zlibOut] = process.argv.slice(2) as [string, string];

async function deflateRawWorks(): Promise<string> {
  try {
    const cs = new CompressionStream("deflate-raw" as CompressionFormat);
    const out = await new Response(
      new Blob([new Uint8Array(16)]).stream().pipeThrough(cs),
    ).arrayBuffer();
    return `yes (${out.byteLength} bytes)`;
  } catch (error) {
    return `no: ${(error as Error).message}`;
  }
}

async function write(path: string, options: ZipOptions): Promise<string> {
  try {
    await pipeline(
      Readable.fromWeb(createZip(fixtureEntries({ sizes: "mixed" }), options) as never),
      createWriteStream(path),
    );
    return "written";
  } catch (error) {
    return `error: ${(error as Error).message}`;
  }
}

const report = {
  node: process.version,
  CompressionStream: typeof globalThis.CompressionStream,
  deflateRaw: typeof globalThis.CompressionStream === "function" ? await deflateRawWorks() : "n/a",
  "zlib.crc32": typeof (zlib as { crc32?: unknown }).crc32,
  "Duplex.toWeb": typeof (Duplex as { toWeb?: unknown }).toWeb,
  defaultZip: await write(defaultOut, {}),
  zlibZip:
    typeof (Duplex as { toWeb?: unknown }).toWeb === "function"
      ? await write(zlibOut, {
          deflateRaw: () => Duplex.toWeb(zlib.createDeflateRaw({ level: 1 })) as never,
        })
      : "n/a",
};
console.log(JSON.stringify(report));
