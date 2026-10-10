// Shared by the workerd and browser harnesses (must-test item 13): build the
// fixture zips with the Worker copy of zip.ts (packages/worker/src/zip.ts,
// which the upload page bundles), using that runtime's defaults
// (CompressionStream, crc32Js). Only Web APIs, no Node.

import { createZip, type ZipEntry, type ZipOptions } from "../../../packages/worker/src/zip.ts";
import { fixtureEntries } from "../fixtures.ts";

export type Sizes = "known" | "unknown" | "mixed";

async function bytesOf(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Turn fixture entries into real File objects, then back into ZipEntry the way the upload page would. */
async function asFiles(entries: ZipEntry[]): Promise<ZipEntry[]> {
  const out: ZipEntry[] = [];
  for (const e of entries) {
    if (!e.stream) {
      out.push(e);
      continue;
    }
    const blob = await new Response(e.stream()).blob();
    const file = new File([blob], e.path.split("/").pop()!, { lastModified: e.lastModified });
    out.push({
      path: e.path,
      lastModified: file.lastModified,
      size: file.size,
      compress: e.compress,
      stream: () => file.stream() as ReadableStream<Uint8Array>,
    });
  }
  return out;
}

export async function formats(): Promise<Record<string, boolean>> {
  const out: Record<string, boolean> = {};
  for (const format of ["deflate-raw", "deflate", "gzip"]) {
    try {
      await bytesOf(
        new Blob([new Uint8Array(16)])
          .stream()
          .pipeThrough(new CompressionStream(format as "deflate-raw") as never),
      );
      out[format] = true;
    } catch {
      out[format] = false;
    }
  }
  return out;
}

export async function buildZip(
  sizes: Sizes,
  options: ZipOptions & { viaFiles?: boolean } = {},
): Promise<Uint8Array> {
  let entries = fixtureEntries({ sizes });
  if (options.viaFiles) entries = await asFiles(entries);
  return bytesOf(createZip(entries, options));
}
