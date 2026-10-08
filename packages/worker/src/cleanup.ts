// The daily cleanup (Cron Trigger): deletes expired uploads, uploads left
// pending for over a day, and the legacy `.downloads/` records of yeet 1D/1E,
// and adds the summary custom metadata to sidecars of yeet < 0.2, within a
// fixed number of R2 calls per run whatever the bucket holds.
//
// A run lists the bucket from where the previous one stopped (a key in
// `<prefix>/.cleanup-cursor`), in key order, as far as its listing budget
// goes; handles the uploads listed in that order until its budget is spent;
// and saves the key after the last upload it finished as the next start. When it
// reaches the end of the bucket, the next run starts at the beginning again.
// So every upload is visited, in a stable order, at least once every
// ceil(uploads / uploads per run) runs.

import { isExpired, Uploads, type Bucket, type ListedUpload } from "./uploads.js";

/** R2 calls a cleanup run may make: the free plan allows 50 per invocation, minus a margin. */
export const CLEANUP_BUDGET = 45;

/** Of those, what the listing may use (sidecar reads of old uploads included). */
export const CLEANUP_LIST_BUDGET = 25;

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

  const listing = await uploads.listAll({ budget: CLEANUP_LIST_BUDGET, after: start ?? undefined });
  calls += listing.subrequests;
  // What is left, keeping one call to save the cursor.
  const budget = CLEANUP_BUDGET - calls - 1;

  let spent = 0;
  let pending: string[] = []; // keys of finished work, deleted in batches of 1000
  const batches = (n: number) => Math.ceil(n / 1000);
  const flush = async () => {
    await uploads.deleteKeys(pending);
    spent += batches(pending.length);
    pending = [];
  };

  let deleted = 0;
  let recordsCleared = 0;
  let summarized = 0;
  let lastDone: string | undefined;
  let stopped = false;
  for (const upload of listing.uploads) {
    const stale = isStale(upload, now);
    if (!stale && upload.unsummarized) {
      // A get and a conditional put; the listings after it save a read.
      if (spent + batches(pending.length) + 2 > budget) {
        stopped = true;
        break;
      }
      spent += 2;
      if (await uploads.addSummary(upload.id)) summarized++;
    }
    if (!stale && !upload.legacyRecords) {
      lastDone = upload.id;
      continue;
    }
    const abort = stale && upload.meta?.pending_upload_id ? 1 : 0;
    const dir = `${prefix.replace(/^\/+|\/+$/g, "")}/${upload.id}/`;

    if (stale && upload.complete) {
      // Every key is known: delete them with the others in one batch.
      const extra = batches(pending.length + upload.keys.length) - batches(pending.length);
      if (spent + batches(pending.length) + abort + extra > budget) {
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
      deleted++;
      lastDone = upload.id;
      continue;
    }

    // Keys the listing jumped over, or legacy records of a current upload:
    // list and delete them (the whole upload if stale, else its records).
    if (spent + batches(pending.length) + abort + 2 > budget) {
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
