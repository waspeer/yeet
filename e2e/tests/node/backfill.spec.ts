import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { backfillSummaries } from "../../../packages/worker/src/backfill.js";
import { summarize, Uploads, type UploadMeta } from "../../../packages/worker/src/uploads.js";
import { FakeBucket } from "../../lib/fake-r2.js";
import {
  expect,
  getObject,
  headObject,
  putObject,
  server,
  startServer,
  test,
} from "../../lib/index.js";

// The one-time migration that gives old sidecars their summary
// (packages/worker/scripts/backfill-summaries.mjs, logic in src/backfill.ts):
// on the in-memory bucket, then the script itself on a `wrangler dev` bucket.
// Never on a real bucket.

const PREFIX = "uploads";
const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 8, 3);

function metaOf(i: number, extra: Partial<UploadMeta> = {}): UploadMeta {
  return {
    filename: `f${i}.bin`,
    file_size: 10 + i,
    uploaded_at: new Date(NOW - DAY).toISOString(),
    expires_at: new Date(NOW + 30 * DAY).toISOString(),
    ...extra,
  };
}

/** u000…u00(n-1): even ones without a summary (old), odd ones with. */
function seedBucket(n: number): FakeBucket {
  const bucket = new FakeBucket({ maxCalls: Infinity });
  for (let i = 0; i < n; i++) {
    const dir = `${PREFIX}/u${String(i).padStart(3, "0")}/`;
    const meta = metaOf(i, i % 4 === 0 ? { downloads: [{ at: "2026-01-01T00:00:00.000Z" }] } : {});
    bucket.seed(dir + meta.filename, "x".repeat(meta.file_size!));
    bucket.seed(
      dir + ".meta.json",
      JSON.stringify(meta),
      i % 2 ? { summary: JSON.stringify(summarize(meta)) } : {},
    );
  }
  return bucket;
}

const snapshot = (bucket: FakeBucket) =>
  JSON.stringify([...bucket.objects.entries()].sort(([a], [b]) => (a < b ? -1 : 1)));

test.describe("backfilling summaries (in memory)", () => {
  test("a dry run writes nothing and reports what it would write", async () => {
    const bucket = seedBucket(300);
    const before = snapshot(bucket);
    const report = await backfillSummaries(bucket, PREFIX, { apply: false });
    expect(report).toMatchObject({ sidecars: 300, missing: 150, written: 0, changed: 0 });
    expect(report.ids).toHaveLength(150);
    expect(bucket.calls["put"] ?? 0).toBe(0);
    expect(bucket.calls["get"] ?? 0).toBe(0);
    expect(snapshot(bucket)).toBe(before);
  });

  test("--apply: every sidecar gets its summary, nothing else changes; a second run does nothing", async () => {
    const bucket = seedBucket(300);
    const others = [...bucket.objects.entries()].filter(([key]) => !key.endsWith("/.meta.json"));
    const bodies = new Map(
      [...bucket.objects.entries()]
        .filter(([key]) => key.endsWith("/.meta.json"))
        .map(([key, object]) => [key, JSON.parse(object.body) as UploadMeta]),
    );
    const summarizedBefore = new Map(
      [...bucket.objects.entries()].filter(([, o]) => o.customMetadata["summary"]),
    );

    const report = await backfillSummaries(bucket, PREFIX, { apply: true });
    expect(report).toMatchObject({ sidecars: 300, missing: 150, written: 150, changed: 0 });
    expect(bucket.calls["put"]).toBe(150);

    for (const [key, meta] of bodies) {
      const object = bucket.objects.get(key)!;
      expect(JSON.parse(object.body), key).toEqual(meta); // same content
      expect(JSON.parse(object.customMetadata["summary"]!), key).toEqual(summarize(meta));
    }
    // A legacy downloads array's count carries over into the summary.
    expect(JSON.parse(bucket.objects.get(`${PREFIX}/u000/.meta.json`)!.customMetadata["summary"]!))
      .toMatchObject({ download_count: 1 });
    for (const [key, object] of others) expect(bucket.objects.get(key), key).toEqual(object);
    for (const [key, object] of summarizedBefore) expect(bucket.objects.get(key), key).toEqual(object);

    bucket.resetCalls();
    const again = await backfillSummaries(bucket, PREFIX, { apply: true });
    expect(again).toMatchObject({ sidecars: 300, missing: 0, written: 0 });
    expect(bucket.calls["put"] ?? 0).toBe(0);
  });

  test("a download counted between its read and write is never overwritten", async () => {
    const bucket = seedBucket(4);
    const uploads = new Uploads(bucket, PREFIX);
    const key = `${PREFIX}/u002/.meta.json`;
    // The Worker counts a download of u002 right after the script read it.
    const get = bucket.get.bind(bucket);
    let raced = false;
    bucket.get = async (k: string) => {
      const object = await get(k);
      if (k === key && !raced) {
        raced = true;
        bucket.maxCalls = Infinity;
        expect(await uploads.recordDownload("u002", new Date(NOW).toISOString())).toBe(true);
      }
      return object;
    };
    const report = await backfillSummaries(bucket, PREFIX, { apply: true });
    expect(report).toMatchObject({ missing: 2, written: 1, changed: 1 });
    const stored = bucket.objects.get(key)!;
    expect((JSON.parse(stored.body) as UploadMeta).download_count).toBe(1);
    expect(JSON.parse(stored.customMetadata["summary"]!)).toEqual(summarize(JSON.parse(stored.body)));
  });

  test("only upload sidecars are touched; unreadable ones are left alone", async () => {
    const bucket = new FakeBucket({ maxCalls: Infinity });
    bucket.seed(`${PREFIX}/bad/.meta.json`, "not JSON");
    bucket.seed(`${PREFIX}/a.b/.meta.json`, JSON.stringify(metaOf(1))); // not an upload ID
    bucket.seed(`${PREFIX}/ok/sub/.meta.json`, JSON.stringify(metaOf(2))); // not a sidecar
    bucket.seed(`${PREFIX}/.meta.json`, JSON.stringify(metaOf(3)));
    bucket.seed(`other/x/.meta.json`, JSON.stringify(metaOf(4))); // outside the prefix
    const before = snapshot(bucket);
    const report = await backfillSummaries(bucket, PREFIX, { apply: true });
    expect(report).toMatchObject({ sidecars: 1, missing: 1, written: 0, unreadable: 1 });
    expect(snapshot(bucket)).toBe(before);
  });
});

/** Run the migration script; resolves with its exit code and output. */
function runScript(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [join(server.workerDir, "scripts", "backfill-summaries.mjs"), ...args],
      { cwd: server.workerDir, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("the migration script on a local wrangler dev bucket: dry run, apply, idempotent", async () => {
  test.setTimeout(180_000);
  const token = randomBytes(24).toString("base64url");
  const prefix = server.uploadsPrefix;
  const ids = ["mig001", "mig002", "mig003"];
  const metas = ids.map((_, i) => metaOf(i));

  // Seed old uploads (and one with a summary) on a bucket of its own.
  let srv = await startServer({ token });
  const persistDir = srv.persistDir;
  try {
    for (const [i, id] of ids.entries()) {
      await putObject(`${prefix}/${id}/${metas[i]!.filename}`, "x".repeat(metas[i]!.file_size!), {
        baseURL: srv.baseURL,
      });
      await putObject(`${prefix}/${id}/.meta.json`, JSON.stringify(metas[i]), {
        contentType: "application/json",
        baseURL: srv.baseURL,
      });
    }
    const current = metaOf(9);
    await putObject(`${prefix}/cur001/.meta.json`, JSON.stringify(current), {
      customMetadata: { summary: JSON.stringify(summarize(current)) },
      baseURL: srv.baseURL,
    });
  } finally {
    await srv.stop(); // the script must not share the bucket files with a running server
  }

  const target = ["--local", "--persist-to", persistDir, "--bucket", server.bucketName];
  const counts = (run: { stdout: string }) => JSON.parse(run.stdout.trim()) as Record<string, unknown>;

  const dry = await runScript(target);
  expect(dry.code, dry.stderr).toBe(0);
  expect(counts(dry)).toEqual({ apply: false, sidecars: 4, missing: 3, written: 0, changed: 0, unreadable: 0, tooLarge: 0 });

  // The dry run wrote nothing: --apply still finds all three.
  const apply = await runScript([...target, "--apply"]);
  expect(apply.code, apply.stderr).toBe(0);
  expect(counts(apply)).toEqual({ apply: true, sidecars: 4, missing: 3, written: 3, changed: 0, unreadable: 0, tooLarge: 0 });

  const again = await runScript([...target, "--apply"]);
  expect(again.code, again.stderr).toBe(0);
  expect(counts(again)).toMatchObject({ missing: 0, written: 0 });

  // Refuses to run without an explicit target.
  const bare = await runScript(["--bucket", server.bucketName]);
  expect(bare.code).toBe(2);

  // What the Worker's bucket now holds.
  srv = await startServer({ token, persistDir });
  try {
    for (const [i, id] of ids.entries()) {
      const sidecar = await headObject(`${prefix}/${id}/.meta.json`, { baseURL: srv.baseURL });
      expect(JSON.parse(sidecar!.custom_metadata["summary"]!), id).toEqual(summarize(metas[i]!));
      const body = await getObject(`${prefix}/${id}/.meta.json`, { baseURL: srv.baseURL });
      expect(JSON.parse(body!.toString("utf-8")), id).toEqual(metas[i]);
      const file = await getObject(`${prefix}/${id}/${metas[i]!.filename}`, { baseURL: srv.baseURL });
      expect(file!.toString("utf-8")).toBe("x".repeat(metas[i]!.file_size!));
    }
  } finally {
    await srv.stop();
  }
});
