// Child process for the time-zone tests: writes a zip in a process whose TZ
// the test sets, so the default DOS offset (the producer's local zone, taken
// per entry mtime) is exercised for real.
//
//   node tz-child.ts <out.zip> '<json [{path, mtime}]>' [timeZoneOffset]
//
// The zip module comes from YEET_ZIP_MODULE (see module.ts).

import { writeZip } from "./module.ts";

const [out, json, offset] = process.argv.slice(2);
const entries = (JSON.parse(json!) as { path: string; mtime: number }[]).map((e) => {
  const data = new TextEncoder().encode(`${e.path}\n`);
  return {
    path: e.path,
    lastModified: e.mtime,
    size: data.length,
    stream: () =>
      new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(data);
          c.close();
        },
      }),
  };
});
await writeZip(out!, entries, offset === undefined ? {} : { timeZoneOffset: Number(offset) });
