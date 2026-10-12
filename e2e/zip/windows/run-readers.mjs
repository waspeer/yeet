#!/usr/bin/env node
// Extract every archive of an archives.json (make-archives.ts, cli-upload.ts)
// with every reader, compare the result with the archive's manifest, and run
// check.py (the structural oracle) on each archive. Writes results.json and
// summary.md to --results and exits 1 if anything failed that is not listed
// in expected-failures.json, or if a listed failure did not happen.
//
//   node e2e/zip/windows/run-readers.mjs --archives <dir> --results <dir>
//        [--work <dir>] [--readers a,b] [--expected <file>] [--label <text>]
//
// Readers on Windows (the point of this script):
//   explorer             Explorer's zip handler via Shell.Application CopyHere (shell-extract.ps1)
//   expand-archive       Expand-Archive in PowerShell 7 (.NET System.IO.Compression)
//   expand-archive-ps51  Expand-Archive in Windows PowerShell 5.1 (.NET Framework)
//   tar                  %SystemRoot%\System32\tar.exe (bsdtar / libarchive)
// Elsewhere, to try this script itself: tar (bsdtar) and unzip.
//
// Per extraction it checks: the exact set of file and folder names (as the
// file system returns them, so a name that comes out NFD, mangled or
// sanitized differently is a missing plus an extra entry), empty folders,
// each file's size and SHA-256, and file mtimes (within 2 s). Each extraction
// is deleted before the next starts, so the >4 GiB archives need room for one
// archive and one extraction at a time. Plain Node >= 20, no dependencies.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { appendFile, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CHECK_PY = join(HERE, "..", "check.py");
const WIN = process.platform === "win32";
const MTIME_TOLERANCE_MS = 2000;
const MAX_PROBLEMS_SHOWN = 12;
/** Retries: on Windows a virus scanner may still hold a file that was just written. */
const RM = { recursive: true, force: true, maxRetries: 10, retryDelay: 500 };

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const powershell = WIN
  ? join(
      process.env.SystemRoot ?? "C:\\Windows",
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    )
  : "powershell";
const expandCommand =
  "$ProgressPreference = 'SilentlyContinue'; " +
  "Expand-Archive -LiteralPath $env:YEET_ZIP -DestinationPath $env:YEET_DEST -Force -ErrorAction Stop";

/** name -> { title, probe: [cmd, args], extract(zip, dest, archive) -> [cmd, args, env] } */
const READERS = {
  explorer: {
    title: "Explorer (Shell.Application CopyHere)",
    probe: [
      powershell,
      [
        "-NoProfile",
        "-NonInteractive",
        "-STA",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        join(HERE, "shell-extract.ps1"),
        "-Probe",
      ],
    ],
    extract: (zip, dest, a) => [
      powershell,
      [
        "-NoProfile",
        "-NonInteractive",
        "-STA",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        join(HERE, "shell-extract.ps1"),
        "-Zip",
        zip,
        "-Dest",
        dest,
        "-Files",
        String(a.expect.files.size),
        "-Bytes",
        String(a.expect.bytes),
        "-TimeoutSec",
        String(a.info.big ? 40 * 60 : 5 * 60),
        "-StallSec",
        a.info.big ? "0" : "60",
      ],
    ],
  },
  "expand-archive": {
    title: "Expand-Archive, PowerShell 7",
    probe: [
      "pwsh",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Write-Output ('PowerShell ' + $PSVersionTable.PSVersion + ', .NET ' + [System.Environment]::Version)",
      ],
    ],
    extract: (zip, dest) => [
      "pwsh",
      ["-NoProfile", "-NonInteractive", "-Command", expandCommand],
      { YEET_ZIP: zip, YEET_DEST: dest },
    ],
  },
  "expand-archive-ps51": {
    title: "Expand-Archive, Windows PowerShell 5.1",
    probe: [
      powershell,
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Write-Output ('Windows PowerShell ' + $PSVersionTable.PSVersion + ', CLR ' + [System.Environment]::Version)",
      ],
    ],
    extract: (zip, dest) => [
      powershell,
      ["-NoProfile", "-NonInteractive", "-Command", expandCommand],
      { YEET_ZIP: zip, YEET_DEST: dest },
    ],
  },
  tar: {
    title: WIN ? "tar.exe (bsdtar)" : "bsdtar",
    probe: [
      WIN ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "bsdtar",
      ["--version"],
    ],
    extract: (zip, dest) => [
      WIN ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "bsdtar",
      ["-xf", zip, "-C", dest],
    ],
  },
  unzip: {
    title: "Info-ZIP unzip",
    probe: ["unzip", ["-v"]],
    extract: (zip, dest) => ["unzip", ["-q", "-o", zip, "-d", dest]],
  },
};
const DEFAULT_READERS = WIN
  ? ["explorer", "expand-archive", "expand-archive-ps51", "tar"]
  : ["tar", "unzip"];

/** Run a command; resolves with its exit code and (tails of) its output. Never rejects. */
function run(cmd, args, { env, timeoutMs = 60 * 60 * 1000 } = {}) {
  return new Promise((done) => {
    const started = Date.now();
    let out = "";
    let child;
    try {
      child = spawn(cmd, args, {
        env: { ...process.env, ...env },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (err) {
      return done({ code: -1, output: String(err), ms: 0 });
    }
    const keep = (chunk) => {
      out += chunk;
      if (out.length > 20_000) out = out.slice(-20_000);
    };
    child.stdout.setEncoding("utf-8").on("data", keep);
    child.stderr.setEncoding("utf-8").on("data", keep);
    const timer = setTimeout(() => {
      keep(`\n[run-readers] killed after ${timeoutMs / 1000} s`);
      child.kill("SIGKILL");
    }, timeoutMs);
    child.on("error", (err) => keep(`\n[run-readers] ${err.message}`));
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      done({ code: code ?? (signal ? -1 : 0), output: out.trim(), ms: Date.now() - started });
    });
  });
}

/** What an archive must extract to: files (path -> {size, sha256, mtime}), folders, total bytes. */
function expectation(manifest) {
  const files = new Map();
  const dirs = new Set();
  let bytes = 0;
  const addParents = (path) => {
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
  };
  for (const [path, e] of Object.entries(manifest)) {
    if (path.endsWith("/")) {
      dirs.add(path.slice(0, -1));
      addParents(path.slice(0, -1));
    } else {
      files.set(path, e);
      bytes += e.size;
      addParents(path);
    }
  }
  return { files, dirs, bytes };
}

/** Everything under `root`: files (path -> full path) and folders, "/"-separated. */
async function listTree(root) {
  const files = new Map();
  const dirs = new Set();
  const walk = async (dir, prefix) => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        dirs.add(rel);
        await walk(full, rel);
      } else {
        files.set(rel, full);
      }
    }
  };
  await walk(root, "");
  return { files, dirs };
}

async function sha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path, { highWaterMark: 4 << 20 })) hash.update(chunk);
  return hash.digest("hex");
}

const show = (s) => JSON.stringify(s);
const codepoints = (s) =>
  [...s].map((c) => "U+" + c.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")).join(" ");

/** Problems of an extraction against the expectation, as {kind, entry, detail}. */
async function compare(expect, root) {
  const problems = [];
  const got = await listTree(root);
  const extraFiles = [...got.files.keys()].filter((p) => !expect.files.has(p));
  for (const [path, e] of expect.files) {
    const full = got.files.get(path);
    if (!full) {
      const near = extraFiles.find(
        (x) => x.normalize("NFC") === path || x.toLowerCase() === path.toLowerCase(),
      );
      problems.push({
        kind: "missing",
        entry: path,
        detail: near
          ? `missing; found ${show(near)} instead (${codepoints(near.split("/").pop())})`
          : "missing",
      });
      continue;
    }
    const st = await stat(full);
    if (st.size !== e.size) {
      problems.push({ kind: "size", entry: path, detail: `size ${st.size}, expected ${e.size}` });
      continue;
    }
    const digest = await sha256(full);
    if (digest !== e.sha256)
      problems.push({
        kind: "sha256",
        entry: path,
        detail: `SHA-256 ${digest.slice(0, 16)}…, expected ${e.sha256.slice(0, 16)}…`,
      });
    if (Math.abs(st.mtimeMs - e.mtime) > MTIME_TOLERANCE_MS) {
      problems.push({
        kind: "mtime",
        entry: path,
        detail: `mtime ${new Date(st.mtimeMs).toISOString()}, expected ${new Date(e.mtime).toISOString()} (${((st.mtimeMs - e.mtime) / 1000).toFixed(0)} s off)`,
      });
    }
  }
  for (const path of extraFiles)
    problems.push({
      kind: "extra",
      entry: path,
      detail: `unexpected file (${codepoints(path.split("/").pop())})`,
    });
  for (const dir of expect.dirs)
    if (!got.dirs.has(dir))
      problems.push({ kind: "dir-missing", entry: `${dir}/`, detail: "folder missing" });
  for (const dir of got.dirs)
    if (!expect.dirs.has(dir))
      problems.push({ kind: "dir-extra", entry: `${dir}/`, detail: "unexpected folder" });
  for (const p of [...got.files.keys(), ...got.dirs]) {
    if (p !== p.normalize("NFC"))
      problems.push({
        kind: "not-nfc",
        entry: p,
        detail: `name is not NFC (${codepoints(p.split("/").pop())})`,
      });
  }
  return problems;
}

const glob = (pattern) =>
  new RegExp(
    "^" +
      pattern
        .split("*")
        .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
        .join(".*") +
      "$",
  );

async function main() {
  const archivesDir = resolve(arg("--archives", "") || ".");
  const resultsDir = resolve(arg("--results", "") || join(archivesDir, "results"));
  const work = resolve(arg("--work", "") || join(tmpdir(), "yeet-readers"));
  const readers = (arg("--readers") ?? DEFAULT_READERS.join(",")).split(",").filter(Boolean);
  const expectedFile = resolve(arg("--expected", "") || join(HERE, "expected-failures.json"));
  const label = arg("--label", "") || "zip readers";
  const python = process.env.PYTHON || (WIN ? "python" : "python3");
  for (const r of readers)
    if (!READERS[r])
      throw new Error(`unknown reader ${r}; known: ${Object.keys(READERS).join(", ")}`);

  const index = JSON.parse(await readFile(join(archivesDir, "archives.json"), "utf-8"));
  const expectedList = JSON.parse(await readFile(expectedFile, "utf-8"));
  for (const x of expectedList) {
    if (!x.reader || !x.archive || !x.kind || !x.reason)
      throw new Error(
        `${expectedFile}: every entry needs reader, archive, kind and reason: ${show(x)}`,
      );
    x.used = 0;
    x.re = { reader: glob(x.reader), archive: glob(x.archive), kind: glob(x.kind) };
  }
  await mkdir(resultsDir, { recursive: true });
  await rm(work, RM);
  await mkdir(work, { recursive: true });

  const versions = {};
  for (const r of readers) {
    const [cmd, args] = READERS[r].probe;
    const p = await run(cmd, args, { timeoutMs: 60_000 });
    versions[r] = {
      ok: p.code === 0,
      text: p.output.split(/\r?\n/).slice(0, 2).join(" ").slice(0, 200),
    };
    console.log(`${r}: ${versions[r].ok ? "" : "UNAVAILABLE "}${versions[r].text}`);
  }
  const py = await run(python, ["--version"]);
  versions["check.py"] = { ok: py.code === 0, text: py.output };

  const results = [];
  for (const info of index) {
    const zip = join(archivesDir, info.file);
    const manifest = JSON.parse(await readFile(join(archivesDir, info.manifest), "utf-8"));
    const a = { info, expect: expectation(manifest) };
    console.log(
      `\n== ${info.file} (${info.entries} entries, ${info.bytes.toLocaleString("en")} bytes): ${info.title}`,
    );
    for (const r of readers) {
      const dest = join(work, `${info.name}--${r}`);
      await rm(dest, RM);
      await mkdir(dest, { recursive: true });
      let problems;
      let ms = 0;
      let output = "";
      if (!versions[r].ok) {
        problems = [
          { kind: "unavailable", entry: "", detail: `reader not available: ${versions[r].text}` },
        ];
      } else {
        const [cmd, args, env] = READERS[r].extract(zip, dest, a);
        const p = await run(cmd, args, { env, timeoutMs: (info.big ? 45 : 6) * 60 * 1000 });
        ms = p.ms;
        output = p.output;
        problems = [];
        if (p.code !== 0)
          problems.push({
            kind: "exit",
            entry: "",
            detail: `exit code ${p.code}: ${p.output.split(/\r?\n/).slice(-3).join(" | ").slice(0, 400)}`,
          });
        problems.push(...(await compare(a.expect, dest)));
      }
      results.push(judge({ archive: info.name, reader: r, ms, problems, output }, expectedList));
      await rm(dest, RM);
      const last = results.at(-1);
      console.log(
        `  ${last.status.padEnd(5)} ${r} (${(ms / 1000).toFixed(1)} s)${problems.length ? `: ${problems.length} problem(s)` : ""}`,
      );
      for (const p of problems.slice(0, MAX_PROBLEMS_SHOWN))
        console.log(`        ${p.kind}${p.entry ? ` ${show(p.entry)}` : ""}: ${p.detail}`);
      if (last.status !== "PASS" && output)
        console.log(
          output
            .split(/\r?\n/)
            .slice(-8)
            .map((l) => `        | ${l}`)
            .join("\n"),
        );
    }
    // The structural oracle, on the archive itself.
    const c = await run(
      python,
      ["-I", "-X", "utf8", CHECK_PY, zip, join(archivesDir, info.manifest)],
      { timeoutMs: 30 * 60 * 1000 },
    );
    const problems =
      c.code === 0
        ? []
        : [
            {
              kind: "structure",
              entry: "",
              detail: c.output.split(/\r?\n/).slice(0, 6).join(" | ").slice(0, 600),
            },
          ];
    results.push(
      judge(
        { archive: info.name, reader: "check.py", ms: c.ms, problems, output: c.output },
        expectedList,
      ),
    );
    console.log(
      `  ${results.at(-1).status.padEnd(5)} check.py (${(c.ms / 1000).toFixed(1)} s): ${c.output.split(/\r?\n/).find((l) => / entries, zip64eocd=/.test(l)) ?? c.output.split(/\r?\n/)[0]}`,
    );
  }

  const unused = expectedList.filter(
    (x) =>
      x.used === 0 &&
      results.some((r) => x.re.reader.test(r.reader) && x.re.archive.test(r.archive)),
  );
  const failed = results.filter((r) => r.status === "FAIL");
  const md = summary(label, index, readers, versions, results, unused);
  await writeFile(join(resultsDir, "summary.md"), md);
  await writeFile(
    join(resultsDir, "results.json"),
    JSON.stringify(
      {
        label,
        versions,
        archives: index,
        results,
        unusedExpectedFailures: unused.map((x) => ({
          reader: x.reader,
          archive: x.archive,
          kind: x.kind,
          reason: x.reason,
        })),
      },
      null,
      2,
    ) + "\n",
  );
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, md);
  await rm(work, RM);

  console.log(
    `\n${results.length} checks: ${results.filter((r) => r.status === "PASS").length} pass, ${results.filter((r) => r.status === "XFAIL").length} expected failures, ${failed.length} fail`,
  );
  for (const x of unused)
    console.log(
      `expected failure did not happen (remove it from ${expectedFile}): ${show({ reader: x.reader, archive: x.archive, kind: x.kind })}`,
    );
  // exitCode, not process.exit(): Node 24.16 was seen to hang in exit()
  // (joining a V8 worker thread) with stdout on a pipe.
  if (failed.length || unused.length) process.exitCode = 1;
}

/** PASS, XFAIL (every problem is an expected failure) or FAIL. */
function judge(result, expectedList) {
  const covered = (p) => {
    const x = expectedList.find(
      (x) =>
        x.re.reader.test(result.reader) &&
        x.re.archive.test(result.archive) &&
        x.re.kind.test(p.kind),
    );
    if (x) x.used++;
    return x;
  };
  const reasons = new Set();
  let uncovered = 0;
  for (const p of result.problems) {
    const x = covered(p);
    if (x) {
      p.expected = x.reason;
      reasons.add(x.reason);
    } else uncovered++;
  }
  const status = result.problems.length === 0 ? "PASS" : uncovered ? "FAIL" : "XFAIL";
  return {
    ...result,
    status,
    output: status === "PASS" ? undefined : result.output,
    reasons: [...reasons],
  };
}

const ICON = { PASS: "✅ pass", XFAIL: "⚠️ expected", FAIL: "❌ FAIL" };
const cell = (s) => String(s).replace(/\|/g, "\\|").replace(/\r?\n/g, " ");

function summary(label, index, readers, versions, results, unused) {
  const cols = [...readers, "check.py"];
  const lines = [`## ${label}`, ""];
  const failed = results.filter((r) => r.status === "FAIL").length;
  lines.push(
    failed || unused.length
      ? `**${failed} failing check(s)${unused.length ? `, ${unused.length} expected failure(s) that did not happen` : ""}.**`
      : "**Every reader extracted every archive correctly** (expected failures, if any, are marked ⚠️ and listed below).",
    "",
    `| archive | ${cols
      .map((c) => READERS[c]?.title ?? c)
      .map(cell)
      .join(" | ")} |`,
    `| --- | ${cols.map(() => "---").join(" | ")} |`,
  );
  for (const info of index) {
    const row = cols.map((c) => {
      const r = results.find((x) => x.archive === info.name && x.reader === c);
      return r ? `${ICON[r.status]} (${(r.ms / 1000).toFixed(1)} s)` : "—";
    });
    lines.push(`| \`${info.file}\` — ${cell(info.title)} | ${row.join(" | ")} |`);
  }
  lines.push("", "Readers:", "");
  for (const c of cols)
    lines.push(
      `- **${c}**: ${cell(versions[c]?.ok ? versions[c].text : `not available (${versions[c]?.text ?? "?"})`)}`,
    );
  const sanitized = index.filter((i) => i.renames);
  for (const i of sanitized) {
    lines.push(
      "",
      `Names in \`${i.file}\` (raw → what \`sanitizeForWindows\` made of it, which every reader must extract):`,
      "",
    );
    for (const [raw, to] of Object.entries(i.renames))
      lines.push(`- \`${cell(JSON.stringify(raw))}\` → \`${cell(JSON.stringify(to))}\``);
  }
  const bad = results.filter((r) => r.status !== "PASS");
  if (bad.length) lines.push("", "### Details", "");
  for (const r of bad) {
    lines.push(
      `**${r.reader} × \`${r.archive}\`: ${r.status}**${r.reasons.length ? ` — expected: ${r.reasons.map(cell).join("; ")}` : ""}`,
      "",
    );
    for (const p of r.problems.slice(0, MAX_PROBLEMS_SHOWN)) {
      lines.push(
        `- ${p.expected ? "(expected) " : ""}${p.kind}${p.entry ? ` \`${cell(p.entry)}\`` : ""}: ${cell(p.detail)}`,
      );
    }
    if (r.problems.length > MAX_PROBLEMS_SHOWN)
      lines.push(`- … and ${r.problems.length - MAX_PROBLEMS_SHOWN} more (results.json)`);
    lines.push("");
  }
  if (unused.length) {
    lines.push(
      "### Expected failures that did not happen",
      "",
      "Remove them from `e2e/zip/windows/expected-failures.json`:",
      "",
    );
    for (const x of unused)
      lines.push(
        `- ${cell(JSON.stringify({ reader: x.reader, archive: x.archive, kind: x.kind }))}: ${cell(x.reason)}`,
      );
  }
  return lines.join("\n") + "\n\n";
}

await main();
