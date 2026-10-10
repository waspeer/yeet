// Browser harness for tests/browser/zip-runtime.spec.ts, bundled into an IIFE
// that exposes `window.zipHarness`.

import { buildZip, formats, type Sizes } from "./harness.ts";

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

const harness = {
  formats,
  async zip(sizes: Sizes, viaFiles: boolean, compress = true) {
    const t0 = performance.now();
    const bytes = await buildZip(sizes, { viaFiles, compress });
    return { base64: toBase64(bytes), ms: performance.now() - t0 };
  },
};

(globalThis as unknown as { zipHarness: typeof harness }).zipHarness = harness;
