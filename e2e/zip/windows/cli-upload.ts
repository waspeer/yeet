// The built CLI end to end against the stand-in server (e2e/lib/stand-in.ts,
// no wrangler, no Playwright): `yeet upload <folder>`, `yeet upload <a> <b>`
// and `yeet upload --store <folder>` with platform paths (on Windows: a drive
// letter, backslashes, forward slashes, a space and non-ASCII in the path).
// Each uploaded zip is reassembled from its parts and written to --out with a
// manifest computed from the source files, plus an archives.json, so
// run-readers.mjs checks it with the same readers as the generated archives.
//
//   node e2e/zip/windows/cli-upload.ts --work <dir> --out <dir> [--cli-node <node>]
//
// Node >= 22.18 (it imports stand-in.ts). --cli-node runs the CLI with another
// Node (the workflow tests the CLI on Node 20 that way); default: this one.
// Build the CLI first (cd packages/cli && npm run build).

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFile,
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { FILENAMES } from "../../lib/fixtures.ts";
import { standIn, type Recorded } from "../../lib/stand-in.ts";

const CLI = fileURLToPath(new URL("../../../packages/cli/dist/index.js", import.meta.url));
const WIN = process.platform === "win32";
const PART_SIZE = 64 * 1024;
/** Retries: on Windows a virus scanner may still hold a file that was just written. */
const RM = { recursive: true, force: true, maxRetries: 10, retryDelay: 500 };
/** Even seconds: DOS times have 2 s resolution, so readers can be checked exactly. */
const MTIME_S = Date.UTC(2026, 9, 8, 9, 30, 2) / 1000;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const workArg = arg("--work");
const outArg = arg("--out");
if (!workArg || !outArg) {
  console.error(
    "usage: node e2e/zip/windows/cli-upload.ts --work <dir> --out <dir> [--cli-node <node>]",
  );
  process.exit(2);
}
const work = resolve(workArg);
const out = resolve(outArg);
const cliNode = arg("--cli-node") ?? process.execPath;

function noise(size: number, seed: number): Uint8Array {
  const b = new Uint8Array(size);
  let x = seed;
  for (let i = 0; i < size; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    b[i] = x & 0xff;
  }
  return b;
}
const text = (name: string) =>
  `This is ${name}.\n` + "yeet zips files while streaming. ".repeat(300);

/** Write files (path ending in "/" = empty folder) under `root` and give everything MTIME_S. */
async function makeTree(root: string, files: Record<string, string | Uint8Array | null>) {
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, ...path.split("/"));
    if (content === null) await mkdir(full, { recursive: true });
    else {
      await mkdir(join(full, ".."), { recursive: true });
      await writeFile(full, content);
    }
  }
}

/** Set every mtime under `dir` (deepest first, so a folder's own date stays). */
async function touchAll(dir: string): Promise<void> {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) await touchAll(full);
    await utimes(full, MTIME_S, MTIME_S);
  }
  await utimes(dir, MTIME_S, MTIME_S);
}

type Manifest = Record<
  string,
  { sha256: string; size: number; sizeKnown: boolean; mtime: number } | { mtime: number }
>;

/**
 * What the zip must contain for `top` (a file or folder) at `prefix`,
 * computed here from the file system, independently of the CLI's own walk:
 * NFC names, .DS_Store skipped, empty folders as "dir/" entries.
 */
async function expected(top: string, prefix: string, manifest: Manifest): Promise<void> {
  const st = await stat(top);
  if (st.isFile()) {
    const data = await readFile(top);
    manifest[prefix] = {
      sha256: createHash("sha256").update(data).digest("hex"),
      size: data.length,
      sizeKnown: true,
      mtime: st.mtimeMs,
    };
    return;
  }
  const names = (await readdir(top)).filter((n) => n !== ".DS_Store");
  if (names.length === 0) manifest[`${prefix}/`] = { mtime: st.mtimeMs };
  for (const name of names)
    await expected(join(top, name), `${prefix}/${name.normalize("NFC")}`, manifest);
}

/** Run the CLI isolated from the real user: own config home, only the stand-in's YEET_* variables. */
function yeet(args: string[], env: Record<string, string>, cwd: string) {
  const childEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env))
    if (v !== undefined && !k.startsWith("YEET_")) childEnv[k] = v;
  Object.assign(
    childEnv,
    {
      HOME: join(work, "home"),
      USERPROFILE: join(work, "home"),
      XDG_CONFIG_HOME: join(work, "home"),
      NO_COLOR: "1",
    },
    env,
  );
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((done, fail) => {
    const child = spawn(cliNode, [CLI, ...args], {
      cwd,
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf-8").on("data", (c: string) => (stdout += c));
    child.stderr.setEncoding("utf-8").on("data", (c: string) => (stderr += c));
    const timer = setTimeout(() => child.kill(), 120_000);
    child.on("error", fail);
    child.on("close", (code) => {
      clearTimeout(timer);
      done({ code, stdout, stderr });
    });
  });
}

await rm(work, RM);
await mkdir(join(work, "home"), { recursive: true });
await mkdir(out, { recursive: true });

// A source folder whose own path has a space and non-ASCII characters.
const src = join(work, "source dir ü – 名前");
const folderName = "Folder Ü – 名前 🎵";
const folder = join(src, folderName);
await makeTree(folder, {
  [FILENAMES.spaces]: noise(300 * 1024 + 1, 1), // several 64 KiB parts
  [FILENAMES.unicode]: text("unicode"),
  [FILENAMES.punctuation]: text("punctuation"),
  "Café NFD.txt": text("an NFD name on disk"), // NFC in the zip
  "photo.JPG": noise(70 * 1024, 2), // stored by extension
  "sub folder/日本語 — ñ.txt": text("japanese"),
  "sub folder/deeper/emoji 🎉.txt": text("emoji"),
  "empty folder/": null,
  ".DS_Store": "skipped by the CLI",
});
const second = join(src, "Second Ö");
await makeTree(src, {
  "loose file – ü.txt": text("a loose file"),
  "Second Ö/inner.txt": text("inner"),
  "Second Ö/empty inside/": null,
});
await touchAll(src);

const tmp = join(work, "tmp dir ü");
await mkdir(tmp, { recursive: true });

const runs: {
  name: string;
  title: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  filename: (name: string) => boolean;
  tops: [string, string][];
  sizedAtCreate: boolean;
  temporaryFile?: boolean;
}[] = [
  {
    name: "cli-folder",
    title: `CLI: yeet upload ${folder} (absolute${WIN ? ", drive letter, backslashes" : ""}), streamed`,
    args: ["upload", folder],
    cwd: work,
    filename: (n) => n === `${folderName.normalize("NFC")}.zip`,
    tops: [[folder, folderName.normalize("NFC")]],
    sizedAtCreate: false,
  },
  {
    name: "cli-two",
    title:
      "CLI: yeet upload <relative file> <absolute folder with trailing separator>, through the temporary file",
    args: ["upload", `.${sep}loose file – ü.txt`, second + sep],
    cwd: src,
    // Lowers the 100-part limit so even this small zip takes the
    // temporary-file path (in TEMP/TMP/TMPDIR, a folder with a space and ü).
    env: { YEET_TEST_MAX_UNSIZED_PARTS: "1", TEMP: tmp, TMP: tmp, TMPDIR: tmp },
    filename: (n) => /^yeet-\d{8}-\d{6}\.zip$/.test(n),
    tops: [
      [join(src, "loose file – ü.txt"), "loose file – ü.txt"],
      [second, "Second Ö"],
    ],
    sizedAtCreate: true,
    temporaryFile: true,
  },
  {
    name: "cli-store",
    title: `CLI: yeet upload --store ${WIN ? "<folder with forward slashes>" : "<folder>"}, size known at create`,
    args: ["upload", "--store", WIN ? folder.replaceAll("\\", "/") : folder],
    cwd: work,
    filename: (n) => n === `${folderName.normalize("NFC")}.zip`,
    tops: [[folder, folderName.normalize("NFC")]],
    sizedAtCreate: true,
  },
];

const cliVersion = await new Promise<string>((done) => {
  let v = "";
  const child = spawn(cliNode, ["--version"], { stdio: ["ignore", "pipe", "inherit"] });
  child.stdout.setEncoding("utf-8").on("data", (c: string) => (v += c));
  child.on("close", () => done(v.trim()));
});
console.log(`CLI runs with ${cliNode}, Node ${cliVersion}`);

const failures: string[] = [];
const index: object[] = [];
const report: string[] = [
  "## CLI on Windows against a stand-in server",
  "",
  `CLI run with Node ${cliVersion} (${cliNode}), part size ${PART_SIZE} bytes. The zips then go through the readers (next section).`,
  "",
  "| run | result |",
  "| --- | --- |",
];

for (const r of runs) {
  const server = await standIn(PART_SIZE);
  const problems: string[] = [];
  try {
    const res = await yeet(r.args, { ...server.env, ...r.env }, r.cwd);
    const lines = res.stdout.split(/\r?\n/).filter(Boolean);
    if (res.code !== 0) problems.push(`exit code ${res.code}`);
    if (lines.length !== 1 || !/^https?:\/\/\S+$/.test(lines[0]!))
      problems.push(`stdout is not one link: ${JSON.stringify(res.stdout)}`);
    const completes = server.completes();
    if (completes.length !== 1) problems.push(`${completes.length} completes, expected 1`);
    const id = completes[0]?.path.split("/")[3];
    // The stand-in names uploads up1, up2, … in the order they are created.
    const create = id ? server.creates()[Number(id.slice(2)) - 1] : undefined;
    const filename = String(create?.json?.filename ?? "");
    if (!r.filename(filename))
      problems.push(`unexpected upload filename ${JSON.stringify(filename)}`);
    const parts = server
      .puts()
      .filter((p: Recorded) => p.path.startsWith(`/api/uploads/${id}/parts/`))
      .sort(
        (a: Recorded, b: Recorded) =>
          Number(a.path.split("/").pop()) - Number(b.path.split("/").pop()),
      );
    parts.forEach((p: Recorded, i: number) => {
      if (Number(p.path.split("/").pop()) !== i + 1) problems.push(`part ${i + 1} is ${p.path}`);
      if (i < parts.length - 1 && p.body.length !== PART_SIZE)
        problems.push(`part ${i + 1} has ${p.body.length} bytes`);
    });
    const zip = Buffer.concat(parts.map((p: Recorded) => p.body));
    const createSize = create?.json?.size;
    if (r.sizedAtCreate ? createSize !== zip.length : createSize !== undefined)
      problems.push(
        `size at create ${createSize}, zip has ${zip.length} bytes (expected ${r.sizedAtCreate ? "the size" : "none"})`,
      );
    const completeSize = completes[0]?.json?.size;
    if (completeSize !== undefined && completeSize !== zip.length)
      problems.push(`size at complete ${completeSize}, zip has ${zip.length}`);
    const deletes = server.deletes().map((d: Recorded) => d.path);
    const otherDeletes = deletes.filter((d) => d !== `/api/uploads/${id}`);
    if (deletes.length !== otherDeletes.length)
      problems.push(`the completed upload was deleted too: ${deletes.join(", ")}`);
    if (r.temporaryFile) {
      if (server.creates().length !== 2 || otherDeletes.length !== 1)
        problems.push(
          `temporary-file path: ${server.creates().length} creates and deletes ${otherDeletes.join(", ") || "none"}, expected 2 and the unused first upload`,
        );
      if (!res.stderr.includes("temporary file"))
        problems.push("stderr does not mention the temporary file");
      const left = await readdir(tmp);
      if (left.length)
        problems.push(`temporary folder not cleaned up: ${left.join(", ")} in ${tmp}`);
    } else if (otherDeletes.length) problems.push(`unexpected deletes: ${otherDeletes.join(", ")}`);

    const manifest: Manifest = {};
    for (const [top, prefix] of r.tops) await expected(top, prefix, manifest);
    await writeFile(join(out, `${r.name}.zip`), zip);
    await writeFile(join(out, `${r.name}.manifest.json`), JSON.stringify(manifest, null, 2) + "\n");
    index.push({
      name: r.name,
      file: `${r.name}.zip`,
      manifest: `${r.name}.manifest.json`,
      title: r.title,
      big: false,
      bytes: zip.length,
      entries: Object.keys(manifest).length,
    });
    console.log(
      `${r.name}: yeet ${r.args.map((a) => JSON.stringify(a)).join(" ")} (cwd ${relative(work, r.cwd) || "."})`,
    );
    console.log(
      `  exit ${res.code}, ${parts.length} parts, ${zip.length} bytes, upload filename ${JSON.stringify(filename)}`,
    );
    if (res.stderr.trim())
      console.log(
        res.stderr
          .trim()
          .split(/\r?\n/)
          .map((l) => `  | ${l}`)
          .join("\n"),
      );
  } catch (err) {
    problems.push(`harness error: ${(err as Error).stack ?? err}`);
  } finally {
    await server.close();
  }
  for (const p of problems) console.log(`  FAIL ${p}`);
  failures.push(...problems.map((p) => `${r.name}: ${p}`));
  report.push(
    `| ${r.title.replace(/\|/g, "\\|")} | ${problems.length ? `❌ ${problems.join("; ").replace(/\|/g, "\\|")}` : "✅ pass"} |`,
  );
}

await writeFile(join(out, "archives.json"), JSON.stringify(index, null, 2) + "\n");
if (process.env.GITHUB_STEP_SUMMARY)
  await appendFile(process.env.GITHUB_STEP_SUMMARY, report.join("\n") + "\n\n");
await rm(work, RM);
// exitCode, not process.exit() (see run-readers.mjs).
if (failures.length) {
  console.log(`\n${failures.length} problem(s)`);
  process.exitCode = 1;
} else console.log(`\nall ${runs.length} CLI runs pass; their zips and manifests are in ${out}`);
