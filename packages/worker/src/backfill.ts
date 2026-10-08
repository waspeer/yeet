// One-time migration: give every sidecar without a summary (yeet < 0.2,
// rclone) its summary custom metadata in one go, instead of the cron's 21 per
// day. Not part of the Worker: run from a machine with
// `scripts/backfill-summaries.mjs`, which binds the bucket through wrangler
// (see there). This module holds the logic, on the same Bucket interface as
// the Worker, so it is tested on the in-memory buckets of e2e/.
//
// - Dry run unless `apply`: then it only counts.
// - Idempotent: it writes only sidecars without a (readable) summary, so a
//   second run finds nothing to do.
// - Safe next to a running Worker: each write is conditional on the etag
//   read (`onlyIf: { etagMatches }`), like the download count's. A sidecar
//   changed in between (a download counted, an upload deleted) is not
//   overwritten; whoever changed it wrote its summary too.
// - Touches nothing but `<prefix>/<id>/.meta.json` objects, rewriting the
//   same JSON body with the summary added (writeMeta()).

import { isValidId, Uploads, type Bucket, type UploadMeta } from "./uploads.js";

export interface BackfillReport {
  /** Sidecars found. */
  sidecars: number;
  /** Of those, without a readable summary. */
  missing: number;
  /** Summaries written (0 in a dry run). */
  written: number;
  /** Not written: the sidecar changed or went away between read and write. */
  changed: number;
  /** Not written: the sidecar is not valid JSON. */
  unreadable: number;
  /** IDs of the sidecars without a summary (all of them; also in a dry run). */
  ids: string[];
}

function hasSummary(custom: Record<string, string> | undefined): boolean {
  if (!custom?.summary) return false;
  try {
    return typeof JSON.parse(custom.summary) === "object";
  } catch {
    return false;
  }
}

export async function backfillSummaries(
  bucket: Bucket,
  prefix: string,
  opts: { apply: boolean; log?: (line: string) => void },
): Promise<BackfillReport> {
  const uploads = new Uploads(bucket, prefix);
  const base = `${prefix.replace(/^\/+|\/+$/g, "")}/`;
  const log = opts.log ?? (() => {});
  const report: BackfillReport = {
    sidecars: 0,
    missing: 0,
    written: 0,
    changed: 0,
    unreadable: 0,
    ids: [],
  };

  // Every key under the prefix, with custom metadata, page by page.
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix: base, cursor, include: ["customMetadata"] });
    for (const object of page.objects) {
      if (!uploads.isSidecarKey(object.key)) continue;
      const id = object.key.slice(base.length).split("/")[0]!;
      if (!isValidId(id)) continue;
      report.sidecars++;
      if (hasSummary(object.customMetadata)) continue;
      report.missing++;
      report.ids.push(id);
      if (!opts.apply) {
        log(`would add a summary: ${object.key}`);
        continue;
      }
      const read = await bucket.get(object.key);
      if (!read) {
        report.changed++;
        log(`gone meanwhile: ${object.key}`);
        continue;
      }
      const meta = await read.json<UploadMeta>().catch(() => null);
      if (!meta || typeof meta !== "object") {
        report.unreadable++;
        log(`not valid JSON, left alone: ${object.key}`);
        continue;
      }
      if (await uploads.writeMeta(id, meta, { etagMatches: read.etag })) {
        report.written++;
        log(`added a summary: ${object.key}`);
      } else {
        report.changed++;
        log(`changed meanwhile, left alone: ${object.key}`);
      }
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return report;
}
