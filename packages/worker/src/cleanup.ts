// The hourly cleanup (Cron Trigger): deletes expired uploads, uploads left
// pending for over a day, and the legacy `.downloads/` records of yeet 1D/1E,
// and adds the summary custom metadata to sidecars of yeet < 0.2. Each run
// does a small, fixed amount of work whatever the bucket holds: CPU (10 ms
// per invocation on the Free plan) is what limits it, so a run is bounded by
// the objects it examines, with a cap on R2 calls as a second guard.
//
// A run lists one slice of the bucket from where the previous one stopped (a
// key in `<prefix>/.cleanup-cursor`), in key order; first gives a few
// sidecars without a summary among them theirs, then handles the uploads in
// key order while its bounds allow; and saves the key after the last upload
// it finished as the next start. When it reaches the end of the bucket, the
// next run starts at the beginning again. So every upload is visited, in a
// stable order, at least once every ceil(uploads / uploads per run) runs.

import { isExpired, summarize, Uploads, type Bucket, type ListedUpload } from "./uploads.js";

/**
 * R2 calls a cleanup run may make at most. Not the binding limit any more
 * (Workers allow 1,000 R2 calls per invocation; CPU binds long before), but
 * a second guard on top of the bounds below: a run's own work needs at most
 * 31 calls (the cursor's read and write, two lists, 2 × CLEANUP_SUMMARIES,
 * DELETE_UNDER_CALLS and up to 4 batch deletes) besides aborting abandoned
 * multipart uploads (1 call each), which this caps.
 */
export const CLEANUP_BUDGET = 45;

/**
 * Objects one list call of a run returns at most (its `limit`): the run's
 * slice of the bucket (with metadata), the jump over a `.downloads/` or
 * `.parts/` run it may make (CLEANUP_JUMPS), and the one round of
 * deleteUnder() it may make (without metadata). So a run examines at most
 * 3 × 200 = 600 objects, usually 200: about 100 finished uploads. Lower than
 * a page of GET /api/uploads (PAGE_LIMIT) because a run may list three
 * times; inferred from the phase 1H cron runs (141 to 179 ms for 25 list
 * calls): about 14.8 to 17.3 µs CPU per object listed, so 600 objects ≈
 * 8.9 to 10.4 ms, and at least 0.7 to 1.3 ms per summary written. Not
 * measured: to be measured on a real deploy, and lowered here (or
 * CLEANUP_SUMMARIES) if need be; tests derive what they expect from it.
 */
export const CLEANUP_LIST_LIMIT = 200;

/**
 * List calls a run may add to jump over the rest of a `.downloads/` or
 * `.parts/` run its list call ended in (see listAll()), so that one upload
 * with many such keys does not take the run's whole slice.
 */
export const CLEANUP_JUMPS = 1;

/**
 * Sidecars without a summary a run gives theirs (a read and a conditional
 * write each). Hourly, that is 240 a day; a bucket of many more is migrated
 * faster with the one-time script (scripts/backfill-summaries.mjs).
 */
export const CLEANUP_SUMMARIES = 10;

/**
 * R2 calls of the one deleteUnder() a run may make, for an upload whose
 * keys its listing did not all see, or the legacy records of a current
 * upload: one round (a list of at most CLEANUP_LIST_LIMIT keys and a delete)
 * and the sidecar's own delete. Such an upload with more keys takes several
 * runs.
 */
const DELETE_UNDER_CALLS = 3;

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

  // One list call, and one more to jump over a `.downloads/` or `.parts/`
  // run (an upload whose keys it did not all see is handled with
  // deleteUnder() below). Everything but the cursor's read and write; the
  // summaries are written below, in the calls the listing reserves for them.
  const listing = await uploads.listAll({
    budget: CLEANUP_BUDGET - 2,
    maxListCalls: 1,
    jumpCalls: CLEANUP_JUMPS,
    limit: CLEANUP_LIST_LIMIT,
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
  let deletedUnder = false;

  // First the summaries, up to CLEANUP_SUMMARIES: until a sidecar has one,
  // every listing costs a read for it. Stale ones get theirs too, so that
  // the next run knows them from the listing even if this one cannot delete
  // them. Uploads from the first one left without on wait for the next run.
  let known = listing.uploads.length;
  let attempts = 0;
  for (const [i, upload] of listing.uploads.entries()) {
    if (!upload.unsummarized) continue;
    if (attempts >= CLEANUP_SUMMARIES || spent + SUMMARY_CALLS > budget) {
      known = i;
      break;
    }
    attempts++;
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

    // Keys the listing did not see, or legacy records of a current upload:
    // list and delete them (the whole upload if stale, else its records),
    // one such upload per run.
    if (deletedUnder || spent + flushCost() + abort + 2 > budget) {
      stopped = true;
      break;
    }
    deletedUnder = true;
    await flush();
    if (abort) {
      await uploads.abortPending(upload.id, upload.meta!.filename, upload.meta!.pending_upload_id!);
      spent++;
    }
    const result = await uploads.deleteUnder(
      stale ? dir : `${dir}.downloads/`,
      Math.min(budget - spent, DELETE_UNDER_CALLS),
      { limit: CLEANUP_LIST_LIMIT, maxLists: 1 },
    );
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
