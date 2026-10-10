// A throwaway Worker for zip-runtime.spec.ts: streams fixture zips built in
// workerd by the Worker copy of zip.ts. Run with `wrangler dev -c
// e2e/zip/runtime/wrangler.jsonc` (deliberately without nodejs_compat).
//
//   GET /info                       runtime and CompressionStream formats
//   GET /zip?sizes=known|unknown|mixed&compress=0|1&tz=<minutes east of UTC>

import { formats, buildZip, type Sizes } from "./harness.ts";

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/info") {
      return Response.json({
        userAgent: navigator.userAgent,
        formats: await formats(),
      });
    }
    if (url.pathname === "/zip") {
      const tz = url.searchParams.get("tz");
      const bytes = await buildZip((url.searchParams.get("sizes") ?? "known") as Sizes, {
        compress: url.searchParams.get("compress") !== "0",
        timeZoneOffset: tz === null ? undefined : Number(tz),
      });
      return new Response(bytes as Uint8Array<ArrayBuffer>, {
        headers: { "content-type": "application/zip" },
      });
    }
    return new Response("not found", { status: 404 });
  },
};
