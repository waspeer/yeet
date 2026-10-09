// One-time migration: give every sidecar without a summary (yeet < 0.2,
// rclone) its summary custom metadata in one go, instead of the cron's 10 per
// hourly run. Not part of the Worker: run from a machine with
// `scripts/backfill-summaries.mjs`, which binds the bucket through wrangler
// (see there). This module holds the logic, on the same Bucket interface as
// the Worker, so it is tested on the in-memory buckets of e2e/.
//
// - Dry run unless `apply`: then it reads every sidecar without a summary
//   (to classify it exactly as `apply` would) but writes nothing.
// - Idempotent: it writes only sidecars without a usable summary (the same
//   check as the listing's, summaryFromCustomMetadata()), so a second run
//   finds nothing to do.
// - Safe next to a running Worker: each write is conditional on the etag
//   read (`onlyIf: { etagMatches }`), like the download count's. A sidecar
//   changed in between (a download counted, an upload deleted) is not
//   overwritten; whoever changed it wrote its summary too.
// - Touches nothing but `<prefix>/<id>/.meta.json` objects, rewriting the
//   same JSON body with the summary added (writeMeta()). Sidecars that are
//   not valid JSON or not shaped like one (parseUploadMeta()), and ones whose
//   summary would not fit (canStoreSummary()), are left alone.

import {
  canStoreSummary,
  isValidId,
  summaryFromCustomMetadata,
  Uploads,
  type Bucket,
} from "./uploads.js";

export interface BackfillReport {
  /** Sidecars found. */
  sidecars: number;
  /** Of those, without a readable summary. */
  missing: number;
  /**
   * Of those, the ones whose summary can be written: what `apply` would
   * write in a dry run; with `apply`, the written ones plus those changed
   * between read and write.
   */
  writable: number;
  /** Summaries written (0 in a dry run). */
  written: number;
  /** Not written: the sidecar changed or went away between read and write. */
  changed: number;
  /**
   * Not written: the sidecar is not valid JSON, or not shaped like a sidecar
   * (parseUploadMeta(): `{}`, `[]`, `"downloads": 5`, …).
   */
  unreadable: number;
  /** Not written: its summary would exceed MAX_SUMMARY_BYTES (see toCustomMetadata()). */
  tooLarge: number;
  /** IDs of the sidecars without a summary (all of them; also in a dry run). */
  ids: string[];
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
    writable: 0,
    written: 0,
    changed: 0,
    unreadable: 0,
    tooLarge: 0,
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
      if (summaryFromCustomMetadata(object.customMetadata)) continue;
      report.missing++;
      report.ids.push(id);
      const { etag, meta } = await uploads.readSidecar(id);
      if (!etag) {
        report.changed++;
        log(`gone meanwhile: ${object.key}`);
        continue;
      }
      if (!meta) {
        report.unreadable++;
        log(`not valid JSON or not a sidecar, left alone: ${object.key}`);
        continue;
      }
      if (!canStoreSummary(meta)) {
        report.tooLarge++;
        log(`summary too large for custom metadata, left alone: ${object.key}`);
        continue;
      }
      report.writable++;
      if (!opts.apply) {
        log(`would add a summary: ${object.key}`);
        continue;
      }
      if (await uploads.writeMeta(id, meta, { etagMatches: etag })) {
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

/**
 * What the script tells the user after a run (stderr), or null: how many
 * summaries `--apply` would write, and how many sidecars can never get one.
 */
export function backfillAdvice(report: BackfillReport, apply: boolean): string | null {
  const lines: string[] = [];
  if (!apply && report.writable > 0) {
    lines.push(`Run again with --apply to write ${report.writable} summaries.`);
  }
  const never = report.unreadable + report.tooLarge;
  if (never > 0) {
    lines.push(
      `${never} sidecar${never === 1 ? "" : "s"} cannot get a summary ` +
        `(${report.unreadable} not valid or not shaped like a sidecar, ${report.tooLarge} too large); ` +
        "run with --verbose to name them, and see docs/design/api.md.",
    );
  }
  return lines.length > 0 ? lines.join("\n") : null;
}
