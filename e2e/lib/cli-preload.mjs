// Loaded into a CLI child with `node --import <this file>` (cli()'s
// `stubs` option) to stub file-system calls the tests cannot arrange for
// real. Each stub is off unless its variable is set:
//
// - YEET_STUB_FREE_BYTES=<n>: fs.statfs() reports n free bytes (bsize 1).
// - YEET_STUB_SLOW_READ_MS=<ms>: every read of a file whose name starts with
//   "slow" waits that long first, so zipping takes long enough to be
//   interrupted.

import fsp from "node:fs/promises";
import { basename } from "node:path";
import { syncBuiltinESMExports } from "node:module";

const free = process.env.YEET_STUB_FREE_BYTES;
if (free) {
  fsp.statfs = async () => ({
    type: 0,
    bsize: 1,
    blocks: Number(free),
    bfree: Number(free),
    bavail: Number(free),
    files: 0,
    ffree: 0,
  });
}

const slowMs = Number(process.env.YEET_STUB_SLOW_READ_MS);
if (slowMs > 0) {
  const realOpen = fsp.open;
  fsp.open = async (path, ...rest) => {
    const handle = await realOpen(path, ...rest);
    if (basename(String(path)).startsWith("slow")) {
      const realRead = handle.read.bind(handle);
      handle.read = async (...args) => {
        await new Promise((resolve) => setTimeout(resolve, slowMs));
        return realRead(...args);
      };
    }
    return handle;
  };
}

syncBuiltinESMExports();
