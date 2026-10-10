// What `yeet upload <path...>` uploads: one file as-is, or a zip of several
// files and/or folders. This module only looks at the file system (stat,
// readdir); nothing is read or uploaded here. See docs/design/zip.md.

import { lstat, readdir, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { sanitizeForWindows } from "./zip.js";

/** A file to put into the zip. */
export interface ZipFile {
  /** Where it is on disk. */
  source: string;
  /** Its path inside the zip: "/"-separated, NFC, made safe for Windows. */
  path: string;
  size: number;
  mtimeMs: number;
}

export type Plan =
  | { kind: "file"; source: string; name: string; size: number }
  | {
      kind: "zip";
      /** The upload's filename: `<folder>.zip` or `yeet-<timestamp>.zip`. */
      name: string;
      files: ZipFile[];
      /** Empty folders, kept as directory entries ("a/empty/"). */
      dirs: { path: string; mtimeMs: number }[];
      /** Sum of the files' sizes. */
      totalSize: number;
      /** Things the user should know (skipped entries, renamed or very long paths). */
      warnings: string[];
    };

/** A problem with the selection, worded for the user. */
export class SelectionError extends Error {}

/** Never zipped: Finder's folder view settings. */
const SKIPPED_NAMES = new Set([".DS_Store"]);

/** The error code of a failed file-system call ("ENOENT", "ELOOP", …), if any. */
const codeOf = (err: unknown) => (err as NodeJS.ErrnoException | undefined)?.code;

/** Windows Explorer cannot extract longer paths (MAX_PATH) without help. */
const LONG_PATH = 260;

const pad = (n: number) => String(n).padStart(2, "0");

/** `yeet-20261010-153012.zip`, in local time. */
export function timestampName(now: Date): string {
  return (
    `yeet-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.zip`
  );
}

/**
 * Decide what to upload for the given paths:
 *
 * - one regular file: that file, as-is (no zip);
 * - one folder: `<folder>.zip`, with the folder as the single top-level entry;
 * - several paths: `yeet-<timestamp>.zip`, files at the top level and folders
 *   as top-level entries.
 *
 * Folders are walked completely (sorted, so the order is stable). `.DS_Store`
 * is skipped; so are symbolic links to folders (no cycles) and anything that
 * is neither a file nor a folder, with a warning. Zip paths are
 * NFC-normalized and made safe for Windows (sanitizeForWindows); two paths
 * that end up equal, ignoring case, are an error naming both, rather than one
 * file silently replacing the other when the zip is extracted. A selection
 * without any file is an error too (an empty zip is useless, and readers
 * reject it).
 */
export async function planUpload(paths: string[], now = new Date()): Promise<Plan> {
  if (paths.length === 0) throw new SelectionError("Nothing to upload.");
  const tops: { abs: string; arg: string; isDir: boolean; size: number; mtimeMs: number }[] = [];
  for (const arg of paths) {
    const abs = resolve(arg);
    let st;
    try {
      st = await stat(abs);
    } catch (err) {
      if (codeOf(err) === "ELOOP") {
        throw new SelectionError(
          `Cannot upload ${arg}: ${arg} is a symbolic link loop (following it leads back to itself).`,
        );
      }
      if (codeOf(err) === "ENOENT" || codeOf(err) === "ENOTDIR") {
        throw new SelectionError(`File not found: ${arg}`);
      }
      throw new SelectionError(`Cannot read ${arg}: ${(err as Error).message}`);
    }
    if (!st.isFile() && !st.isDirectory()) {
      throw new SelectionError(`Not a file or folder: ${arg}`);
    }
    tops.push({ abs, arg, isDir: st.isDirectory(), size: st.size, mtimeMs: st.mtimeMs });
  }

  const only = tops[0]!;
  if (tops.length === 1 && !only.isDir) {
    return { kind: "file", source: only.abs, name: basename(only.abs), size: only.size };
  }

  const files: ZipFile[] = [];
  const dirs: { path: string; mtimeMs: number }[] = [];
  const warnings: string[] = [];
  const renamed: string[] = [];
  /** Zip path (lower case) -> where it came from, to report collisions. */
  const taken = new Map<string, string>();

  const claim = (raw: string, source: string, isDir: boolean): string => {
    const nfc = raw.normalize("NFC");
    const path = sanitizeForWindows(nfc) + (isDir ? "/" : "");
    if (path.replace(/\/$/, "") !== nfc) renamed.push(`${nfc} → ${path.replace(/\/$/, "")}`);
    // A file and a folder of the same name collide too: compare without the "/".
    const key = path.replace(/\/$/, "").toLowerCase();
    const other = taken.get(key);
    if (other !== undefined) {
      throw new SelectionError(
        `${JSON.stringify(other)} and ${JSON.stringify(source)} would both be ` +
          `${JSON.stringify(path.replace(/\/$/, ""))} in the zip (names are compared ignoring ` +
          `case, after making them safe for Windows), and one would replace the other when it ` +
          `is unzipped. Rename one of them.`,
      );
    }
    taken.set(key, source);
    if (path.length >= LONG_PATH) {
      warnings.push(
        `${path} is ${path.length} characters long; Windows Explorer may not extract it.`,
      );
    }
    return path;
  };

  /** A file-system error for something readdir() listed a moment ago, as a selection error. */
  const vanished = (shown: string, err: unknown) =>
    new SelectionError(
      codeOf(err) === "ENOENT"
        ? `Cannot read ${shown}: it was removed or renamed while yeet read the folder. Try again.`
        : `Cannot read ${shown}: ${(err as Error).message}`,
    );

  const walk = async (dir: string, zipDir: string, label: string): Promise<void> => {
    let names: string[];
    try {
      names = (await readdir(dir)).sort();
    } catch (err) {
      throw new SelectionError(`Cannot read folder ${label}: ${(err as Error).message}`);
    }
    let kept = 0;
    for (const name of names) {
      if (SKIPPED_NAMES.has(name)) continue;
      const source = join(dir, name);
      const shown = `${label}/${name}`;
      let link;
      try {
        link = await lstat(source);
      } catch (err) {
        throw vanished(shown, err);
      }
      let st = link;
      if (link.isSymbolicLink()) {
        try {
          st = await stat(source);
        } catch (err) {
          warnings.push(
            codeOf(err) === "ELOOP"
              ? `Skipped ${shown}: a symbolic link loop.`
              : codeOf(err) === "ENOENT" || codeOf(err) === "ENOTDIR"
                ? `Skipped ${shown}: a symbolic link to nothing.`
                : `Skipped ${shown}: a symbolic link that cannot be followed (${codeOf(err) ?? (err as Error).message}).`,
          );
          continue;
        }
        if (st.isDirectory()) {
          warnings.push(`Skipped ${shown}: a symbolic link to a folder.`);
          continue;
        }
      }
      if (st.isDirectory()) {
        const path = claim(`${zipDir}/${name}`, shown, true);
        kept++;
        await walk(source, path.replace(/\/$/, ""), shown);
      } else if (st.isFile()) {
        files.push({
          source,
          path: claim(`${zipDir}/${name}`, shown, false),
          size: st.size,
          mtimeMs: st.mtimeMs,
        });
        kept++;
      } else {
        warnings.push(`Skipped ${shown}: not a file or folder.`);
      }
    }
    if (kept === 0) {
      let mtimeMs;
      try {
        mtimeMs = (await stat(dir)).mtimeMs;
      } catch (err) {
        throw vanished(label, err);
      }
      dirs.push({ path: `${zipDir}/`, mtimeMs });
    }
  };

  for (const top of tops) {
    const name = basename(top.abs);
    if (name === "") throw new SelectionError(`Cannot zip ${top.arg}: give a folder inside it.`);
    if (SKIPPED_NAMES.has(name)) continue;
    if (top.isDir) {
      const path = claim(name, top.arg, true);
      await walk(top.abs, path.replace(/\/$/, ""), top.arg.replace(/\/+$/, "") || top.arg);
    } else {
      files.push({
        source: top.abs,
        path: claim(name, top.arg, false),
        size: top.size,
        mtimeMs: top.mtimeMs,
      });
    }
  }

  if (files.length === 0) {
    throw new SelectionError(
      `Nothing to upload: ${paths.join(", ")} ${paths.length === 1 ? "contains" : "contain"} no files ` +
        `(${[...SKIPPED_NAMES].join(", ")} is skipped).`,
    );
  }
  if (renamed.length) {
    warnings.unshift(
      `Renamed ${renamed.length} name${renamed.length === 1 ? "" : "s"} so Windows can unzip ` +
        `${renamed.length === 1 ? "it" : "them"}: ${renamed.slice(0, 3).join(", ")}${renamed.length > 3 ? ", …" : ""}`,
    );
  }
  const name =
    tops.length === 1 ? `${basename(only.abs).normalize("NFC")}.zip` : timestampName(now);
  return {
    kind: "zip",
    name,
    files,
    dirs,
    totalSize: files.reduce((sum, f) => sum + f.size, 0),
    warnings,
  };
}
