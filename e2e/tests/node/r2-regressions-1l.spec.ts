import {
  PAGE_LIMIT,
  summarize,
  Uploads,
  type UploadMeta,
} from "../../../packages/worker/src/uploads.js";
import { expect, test } from "../../lib/index.js";
import { StrictBucket } from "../../lib/strict-r2.js";

// Regressions found in round 1L.

const P = "uploads";
const NOW = Date.UTC(2026, 9, 8, 3);
const DAY = 86_400_000;

const meta = (filename: string): UploadMeta => ({
  filename,
  file_size: 3,
  uploaded_at: new Date(NOW - DAY).toISOString(),
  expires_at: new Date(NOW + DAY).toISOString(),
});

/** Every page of GET /api/uploads from the start: the IDs shown, in page order. */
async function walk(b: StrictBucket): Promise<string[]> {
  const uploads = new Uploads(b, P);
  const seen: string[] = [];
  let after: string | undefined;
  for (let page = 0; page < 100; page++) {
    const result = await uploads.listPage(after);
    seen.push(...result.uploads.map((u) => u.id));
    if (result.next === null) return seen;
    after = result.next;
  }
  throw new Error("more than 100 pages");
}

test("a page whose jump R2 answers with only the sidecar still shows an upload of yeet < 0.2", async () => {
  // Found by the random short pages of r2-work-bounds.spec.ts (seed 2) once
  // the jump got its own, smaller limit: the first upload of a page has
  // more legacy records than the page lists, the jump over them returns
  // only its sidecar (a short page, as R2 may return), and that sidecar has
  // no summary. The page returned the upload "unread" so that the next
  // page would get past it, and so left it out: skipped for the whole walk.
  // Its sidecar was listed and its read fits in the page's reads.
  const b = new StrictBucket({ maxCalls: Infinity, metadataCap: 415 });
  b.seed(`${P}/a/a.bin`, "abc");
  b.seed(`${P}/a/.meta.json`, JSON.stringify(meta("a.bin"))); // no summary
  for (let i = 0; i < PAGE_LIMIT + 20; i++) {
    b.seed(`${P}/a/.downloads/2026-06-01T00:00:00.${String(i).padStart(6, "0")}Z_x`);
  }
  const later = meta("b.bin");
  b.seed(`${P}/b/b.bin`, "abc");
  b.seed(`${P}/b/.meta.json`, JSON.stringify(later), { summary: JSON.stringify(summarize(later)) });
  // The jump (startAfter …/~) returns one object, truncated.
  const list = b.list.bind(b);
  b.list = async (options) => {
    if (options.startAfter?.endsWith("/~")) return list({ ...options, limit: 1 });
    return list(options);
  };
  expect(await walk(b)).toEqual(["a", "b"]);
});
