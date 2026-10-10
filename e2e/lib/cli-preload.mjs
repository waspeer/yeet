// Loaded into a CLI child with `node --import <this file>` (cli()'s
// `stubs` option) to stub file-system calls the tests cannot arrange for
// real. Each stub is off unless its variable is set:
//
// - YEET_STUB_FREE_BYTES=<n>: fs.statfs() reports n free bytes (bsize 1).
// - YEET_STUB_SLOW_READ_MS=<ms>: every read of a file whose name starts with
//   "slow" waits that long first, so zipping takes long enough to be
//   interrupted.
// - YEET_STUB_ENOSPC_AFTER=<n>: writes to a file named "upload.zip" (the
//   CLI's temporary zip) fail with ENOSPC once n bytes have been written, as
//   on a disk that fills up after the free-space check.

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

const enospcAfter = process.env.YEET_STUB_ENOSPC_AFTER;
if (enospcAfter) {
  const realOpen = fsp.open;
  fsp.open = async (path, ...rest) => {
    const handle = await realOpen(path, ...rest);
    if (basename(String(path)) === "upload.zip") {
      let written = 0;
      const realWrite = handle.write.bind(handle);
      handle.write = async (buffer, offset = 0, length = buffer.length - offset, ...more) => {
        if (written + length > Number(enospcAfter)) {
          throw Object.assign(new Error("ENOSPC: no space left on device, write"), {
            code: "ENOSPC",
            errno: -28,
            syscall: "write",
          });
        }
        const r = await realWrite(buffer, offset, length, ...more);
        written += r.bytesWritten;
        return r;
      };
    }
    return handle;
  };
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
