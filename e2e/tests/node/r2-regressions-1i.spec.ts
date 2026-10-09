import { summarize, Uploads, type UploadMeta } from "../../../packages/worker/src/uploads.js";
import { expect, test } from "../../lib/index.js";
import { StrictBucket } from "../../lib/strict-r2.js";

// Regressions found in round 1I, on listAll() with its default options, so
// that each runs against the listing before the fix too.

const P = "uploads";
const NOW = Date.UTC(2026, 9, 8, 3);
const DAY = 86_400_000;

test("an upload followed by thousands of keys that are no upload is listed, with its sidecar read", async () => {
  // Before: such an upload was always the "last, maybe partly listed" one of
  // a listing that ran out on the keys after it, so it was left for the
  // next listing, which listed it alone and returned it unread: a sidecar
  // without a summary (yeet < 0.2) was never read, and the upload never
  // shown. A key after it that belongs to no upload shows it was complete.
  const b = new StrictBucket({ maxCalls: Infinity });
  const meta: UploadMeta = {
    filename: "old.bin",
    file_size: 3,
    uploaded_at: new Date(NOW - DAY).toISOString(),
    expires_at: new Date(NOW + DAY).toISOString(),
  };
  b.seed(`${P}/a/old.bin`, "abc");
  b.seed(`${P}/a/.meta.json`, JSON.stringify(meta)); // no summary
  for (let i = 0; i < 5000; i++) b.seed(`${P}/a~junk${String(i).padStart(5, "0")}`);
  b.seed(`${P}/b/new.bin`, "abc");
  b.seed(`${P}/b/.meta.json`, JSON.stringify(meta), { summary: JSON.stringify(summarize(meta)) });

  const uploads = new Uploads(b, P);
  const listed: { id: string; filename: string | undefined; complete: boolean }[] = [];
  let after: string | undefined;
  for (let round = 0; round < 20; round++) {
    const listing = await uploads.listAll(after === undefined ? {} : { after });
    listed.push(
      ...listing.uploads.map((u) => ({
        id: u.id,
        filename: u.meta?.filename,
        complete: u.complete,
      })),
    );
    if (!listing.truncated) break;
    after = listing.resumeAfter;
  }
  expect(listed).toEqual([
    { id: "a", filename: "old.bin", complete: true },
    { id: "b", filename: "old.bin", complete: true },
  ]);
});
