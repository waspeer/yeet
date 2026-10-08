// The daily cleanup (Cron Trigger): deletes expired uploads, uploads left
// pending for over a day, and the legacy `.downloads/` records of yeet 1D/1E,
// and adds the summary custom metadata to sidecars of yeet < 0.2, within a
// fixed number of R2 calls per run whatever the bucket holds.
//
// A run lists the bucket from where the previous one stopped (a key in
// `<prefix>/.cleanup-cursor`), in key order, as far as its listing budget
// goes; first gives the sidecars without a summary among them theirs, then
// handles the uploads in key order until its budget is spent; and saves the
// key after the last upload it finished as the next start. When it reaches
// the end of the bucket, the next run starts at the beginning again. So
// every upload is visited, in a stable order, at least once every
// ceil(uploads / uploads per run) runs.

import { isExpired, summarize, Uploads, type Bucket, type ListedUpload } from "./uploads.js";

/** R2 calls a cleanup run may make: the free plan allows 50 per invocation, minus a margin. */
export const CLEANUP_BUDGET = 45;

/** Of those, the list calls the listing may make. */
export const CLEANUP_LIST_BUDGET = 25;

/**
 * R2 calls of giving one sidecar its summary: a read and a conditional
 * write. The listing reserves them, so it lists no further than the run
 * can give summaries to.
 */
const SUMMARY_CALLS = 2;

/** Uploads still pending after this long are considered abandoned. */
export const ABANDONED_AFTER_MS = 24 * 60 * 60 * 1000;

export interface CleanupReport {
  /** Uploads deleted (expired, abandoned or stray records). */
  deleted: number;
  /** Uploads whose legacy download records were all deleted. */
  recordsCleared: number;
  /** Sidecars of yeet < 0.2 given their summary. */
  summarized: number;
  /** R2 calls made. */
  subrequests: number;
  /** Where the next run starts (after this key), or null for the beginning. */
  cursor: string | null;
}

function isStale({ meta, stray }: ListedUpload, now: number): boolean {
  if (stray) return true; // legacy download records without an upload
  if (!meta) return false; // no readable sidecar: leave it for a human
  const abandoned =
    !!meta.pending_upload_id && now - new Date(meta.uploaded_at).getTime() > ABANDONED_AFTER_MS;
  return isExpired(meta, now) || abandoned;
}

export async function runCleanup(
  bucket: Bucket,
  prefix: string,
  now = Date.now(),
): Promise<CleanupReport> {
  const uploads = new Uploads(bucket, prefix);
  let calls = 0;

  const saved = await bucket.get(uploads.cursorKey);
  calls++;
  // An unreadable cursor starts from the beginning rather than stopping every run.
  const parsed = await saved?.json<{ after?: unknown }>().catch(() => null);
  const start = typeof parsed?.after === "string" ? parsed.after : null;

  // Everything but the cursor's read and write; the summaries are written
  // below, in the calls the listing reserves for them.
  const listing = await uploads.listAll({
    budget: CLEANUP_BUDGET - 2,
    maxListCalls: CLEANUP_LIST_BUDGET,
    deferReads: SUMMARY_CALLS,
    after: start ?? undefined,
  });
  calls += listing.subrequests;
  // What is left, keeping one call to save the cursor.
  const budget = CLEANUP_BUDGET - calls - 1;

  let spent = 0;
  // Keys of finished work, deleted in batches of 1000 with the sidecars
  // last, in batches of their own (see deleteKeys()).
  let pending: string[] = [];
  let pendingSidecars = 0;
  const deleteCalls = (keys: number, sidecars: number) =>
    Math.ceil((keys - sidecars) / 1000) + Math.ceil(sidecars / 1000);
  const flushCost = () => deleteCalls(pending.length, pendingSidecars);
  const flush = async () => {
    const keys = pending;
    spent += flushCost();
    pending = [];
    pendingSidecars = 0;
    await uploads.deleteKeys(keys);
  };

  let deleted = 0;
  let recordsCleared = 0;
  let summarized = 0;
  let lastDone: string | undefined;
  let stopped = false;

  // First the summaries, as many as the budget allows: until a sidecar has
  // one, every listing costs a read for it (GET /api/uploads shows only 39
  // of a bucket of old sidecars). Stale ones get theirs too, so that the
  // next run knows them from the listing even if this one cannot delete
  // them. Uploads from the first one left without on wait for the next run.
  let known = listing.uploads.length;
  for (const [i, upload] of listing.uploads.entries()) {
    if (!upload.unsummarized) continue;
    if (spent + SUMMARY_CALLS > budget) {
      known = i;
      break;
    }
    const result = await uploads.addSummary(upload.id);
    spent += result.calls;
    upload.meta = result.meta && summarize(result.meta);
    if (result.written) summarized++;
  }

  // Then, in key order, the deletions.
  for (const upload of listing.uploads.slice(0, known)) {
    const stale = isStale(upload, now);
    if (!stale && !upload.legacyRecords) {
      lastDone = upload.id;
      continue;
    }
    const abort = stale && upload.meta?.pending_upload_id ? 1 : 0;
    const dir = `${prefix.replace(/^\/+|\/+$/g, "")}/${upload.id}/`;

    if (stale && upload.complete) {
      // Every key is known: delete them in batches with the others.
      const sidecars = upload.keys.filter((key) => uploads.isSidecarKey(key)).length;
      const cost = deleteCalls(pending.length + upload.keys.length, pendingSidecars + sidecars);
      if (spent + cost + abort > budget) {
        stopped = true;
        break;
      }
      if (abort) {
        await uploads.abortPending(
          upload.id,
          upload.meta!.filename,
          upload.meta!.pending_upload_id!,
        );
        spent++;
      }
      pending.push(...upload.keys);
      pendingSidecars += sidecars;
      deleted++;
      lastDone = upload.id;
      continue;
    }

    // Keys the listing jumped over, or legacy records of a current upload:
    // list and delete them (the whole upload if stale, else its records).
    if (spent + flushCost() + abort + 2 > budget) {
      stopped = true;
      break;
    }
    await flush();
    if (abort) {
      await uploads.abortPending(upload.id, upload.meta!.filename, upload.meta!.pending_upload_id!);
      spent++;
    }
    const result = await uploads.deleteUnder(stale ? dir : `${dir}.downloads/`, budget - spent);
    spent += result.calls;
    if (!result.done) {
      stopped = true; // the rest next run, starting with this upload
      break;
    }
    if (stale) deleted++;
    else recordsCleared++;
    lastDone = upload.id;
  }
  if (known < listing.uploads.length) stopped = true;
  await flush();
  calls += spent;

  // Resume after the last upload finished; at the end of the bucket, start over.
  const cursor = stopped
    ? lastDone
      ? uploads.keyAfter(lastDone)
      : start
    : listing.truncated
      ? (listing.resumeAfter ?? start)
      : null;
  if (cursor !== start) {
    await bucket.put(uploads.cursorKey, JSON.stringify({ after: cursor }), {
      httpMetadata: { contentType: "application/json" },
    });
    calls++;
  }
  return { deleted, recordsCleared, summarized, subrequests: calls, cursor };
}
