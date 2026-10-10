// What the upload page uploads (round 2C+2): one file as-is, or a zip of
// several files and/or a folder, decided from what was picked or dropped.
// The rules follow the CLI's packages/cli/src/selection.ts (see
// docs/design/zip.md, "Filename policy" and "Callers"), plus the choice of
// how the zip's size is handled (docs/design/browser-upload.md, "Round 2C+2").
// No DOM access here: main.ts gathers the files, worker.ts zips them.

import { isCompressedPath, sanitizeForWindows, storedZipSize, type ZipEntry } from "../zip.js";

/** A picked or dropped file and its "/"-separated path from the top of the selection. */
export interface PickedFile {
  file: File;
  /** "Stems/drums/kick.wav" for a file in a picked or dropped folder, "kick.wav" for a loose one. */
  path: string;
}

/** What the person chose, as main.ts finds it. */
export interface Picked {
  /** The top-level items: files, and folders (whose contents are in `files` and `dirs`). */
  tops: { name: string; isDir: boolean }[];
  files: PickedFile[];
  /** Folders seen while walking a dropped folder, empty ones included; their date if known. */
  dirs: { path: string; lastModified?: number }[];
}

/** A file in the zip. */
export interface ZipFile {
  file: File;
  /** Its path inside the zip: NFC, made safe for Windows. */
  path: string;
  /** Size and date as they were when chosen (WebKit forgets the date once the file is gone). */
  size: number;
  lastModified: number;
  compress: boolean;
}

export interface ZipPlan {
  kind: "zip";
  /** The upload's filename: `<folder>.zip` or `yeet-<timestamp>.zip`. */
  name: string;
  files: ZipFile[];
  /** Empty folders, kept as directory entries ("Stems/empty/"). */
  dirs: { path: string; lastModified: number }[];
  /** Sum of the files' sizes: what progress counts. */
  totalSize: number;
  /** The zip's exact size when every file is stored: sent at create (no part limit). */
  size?: number;
  /**
   * Without `size`: an upper bound of the zip's size (deflate's worst case),
   * at most `maxUnsizedParts` parts, so the upload can never hit the
   * server's limit for uploads of unknown size halfway.
   */
  worstCase?: number;
  /** Everything stored although some files would compress: the selection is too large otherwise. */
  forcedStore: boolean;
  /** Some file would be deflated (by its extension, and not empty). */
  compressible: boolean;
  /** One folder: the zip holds that folder. */
  folder: boolean;
  /** Renamed or very long paths, for the person to know. */
  warnings: string[];
}

export type Plan = { kind: "file"; file: File } | ZipPlan;

/** A problem with the selection, worded for the person. */
export class SelectionError extends Error {}

export interface PlanOptions {
  /** The server's part size (52,428,800 bytes, `part_size` of POST /api/uploads). */
  partSize: number;
  /** The most parts the server completes for an upload of unknown size (MAX_UNSIZED_PARTS). */
  maxUnsizedParts: number;
  now?: Date;
}

/** The server's part size, which the page plans with before it creates the upload. */
export const PART_SIZE = 50 * 1024 * 1024;
/** MAX_UNSIZED_PARTS in packages/worker/src/uploads.ts (an e2e test keeps them equal). */
export const MAX_UNSIZED_PARTS = 150;
/** R2's own limit of parts per upload. */
export const MAX_PARTS = 10_000;

/** Never zipped: Finder's folder view settings. */
const SKIPPED_NAMES = new Set([".DS_Store"]);
/** Windows Explorer cannot extract longer paths (MAX_PATH) without help. */
const LONG_PATH = 260;

const pad = (n: number) => String(n).padStart(2, "0");

/** `yeet-20261010-153012.zip`, in local time (as the CLI names it). */
export function timestampName(now: Date): string {
  return (
    `yeet-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.zip`
  );
}

/**
 * The most a raw deflate stream of `size` bytes can grow to. zlib (behind
 * CompressionStream in every engine) emits incompressible data as stored
 * blocks of at most 64 KiB with 5 bytes of header each, about 0.03 %
 * (docs/design/zip.md measured +0.03 % on random data); this allows four
 * times that, plus a kilobyte.
 */
export function deflateBound(size: number): number {
  return size + Math.ceil(size / 4096) * 5 + 1024;
}

const basename = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/** Compare paths folder by folder, so a folder's contents stay together and sorted. */
function byPath(a: string, b: string): number {
  const x = a.split("/");
  const y = b.split("/");
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    if (x[i] !== y[i]) return x[i]! < y[i]! ? -1 : 1;
  }
  return x.length - y.length;
}

/**
 * Decide what to upload:
 *
 * - one file (not in a folder): that file, as-is;
 * - one folder: `<folder>.zip`, the folder as the single top-level entry;
 * - several items: `yeet-<timestamp>.zip`, files at the top level and
 *   folders as top-level entries.
 *
 * `.DS_Store` is skipped. Empty folders are kept as directory entries.
 * Paths are NFC-normalized and made safe for Windows (sanitizeForWindows);
 * two that end up equal ignoring case (a file and a folder too) are an
 * error naming both, rather than one silently replacing the other when the
 * zip is extracted. A selection without any file is an error.
 *
 * The zip's size: when no file would be deflated (only already-compressed
 * or empty files) every file is stored and the exact size is known (sent
 * at create, no part limit). Otherwise compressible files are deflated and
 * the size is sent at `complete`, which the server allows for at most
 * `maxUnsizedParts` parts; if deflate's worst case could exceed that,
 * everything is stored instead (`forcedStore`), so the size is known again.
 */
export function planSelection(picked: Picked, options: PlanOptions): Plan {
  const now = options.now ?? new Date();
  if (picked.tops.length === 0) throw new SelectionError("Nothing was chosen.");
  const only = picked.tops[0]!;
  if (picked.tops.length === 1 && !only.isDir && picked.files.length === 1) {
    return { kind: "file", file: picked.files[0]!.file };
  }

  // Every folder: those walked, and those the files' paths go through.
  const folders = new Map<string, number | undefined>();
  for (const dir of picked.dirs) folders.set(dir.path, dir.lastModified ?? folders.get(dir.path));
  for (const { path } of picked.files) {
    for (let i = path.indexOf("/"); i > 0; i = path.indexOf("/", i + 1)) {
      const dir = path.slice(0, i);
      if (!folders.has(dir)) folders.set(dir, undefined);
    }
  }
  const kept = picked.files.filter(({ path }) => !SKIPPED_NAMES.has(basename(path)));

  const warnings: string[] = [];
  const renamed: string[] = [];
  /** Zip path (lower case, without a trailing "/") -> where it came from. */
  const taken = new Map<string, string>();
  const claim = (raw: string, isDir: boolean): string => {
    const nfc = raw.normalize("NFC");
    const safe = sanitizeForWindows(nfc);
    if (safe !== nfc) renamed.push(`${nfc} → ${safe}`);
    // A file and a folder of the same name collide too: compare without the "/".
    const key = safe.toLowerCase();
    const other = taken.get(key);
    if (other !== undefined) {
      throw new SelectionError(
        `“${other}” and “${raw}” would have the same name in the zip (“${safe}”; upper and ` +
          `lower case count as the same, and characters Windows does not allow are replaced), ` +
          `so one would replace the other when the zip is opened. Rename one of them and try again.`,
      );
    }
    taken.set(key, raw);
    const path = safe + (isDir ? "/" : "");
    if (path.length >= LONG_PATH) {
      warnings.push(`${path} is ${path.length} characters long; Windows may not unzip it.`);
    }
    return path;
  };

  // Claim folders and files in path order, so a clash names neighbours.
  const items = [
    ...[...folders.keys()].map((path) => ({ path, isDir: true as const })),
    ...kept.map((picked) => ({ path: picked.path, isDir: false as const, picked })),
  ].sort((a, b) => byPath(a.path, b.path));
  const zipPaths = new Map<string, string>();
  for (const item of items)
    zipPaths.set(`${item.isDir ? "d" : "f"}:${item.path}`, claim(item.path, item.isDir));

  if (kept.length === 0) {
    throw new SelectionError(
      "There is nothing to upload: no files were chosen, only empty folders " +
        "(.DS_Store files are left out).",
    );
  }

  // A folder is kept as an entry of its own only if nothing else is in it
  // (the CLI does the same).
  const nonEmpty = new Set<string>();
  for (const path of [...folders.keys(), ...kept.map((f) => f.path)]) {
    for (let i = path.indexOf("/"); i > 0; i = path.indexOf("/", i + 1)) {
      nonEmpty.add(path.slice(0, i));
    }
  }
  const dirs = [...folders]
    .filter(([path]) => !nonEmpty.has(path))
    .sort(([a], [b]) => byPath(a, b))
    .map(([path, lastModified]) => ({
      path: zipPaths.get(`d:${path}`)!,
      lastModified: lastModified ?? now.getTime(),
    }));

  const files = kept
    .sort((a, b) => byPath(a.path, b.path))
    .map(({ file, path }): ZipFile => {
      const zipPath = zipPaths.get(`f:${path}`)!;
      return {
        file,
        path: zipPath,
        size: file.size,
        lastModified: file.lastModified,
        compress: file.size > 0 && !isCompressedPath(zipPath),
      };
    });

  if (renamed.length) {
    warnings.unshift(
      `Renamed ${renamed.length} name${renamed.length === 1 ? "" : "s"} so Windows can unzip ` +
        `${renamed.length === 1 ? "it" : "them"}: ${renamed.slice(0, 3).join(", ")}` +
        `${renamed.length > 3 ? ", …" : ""}`,
    );
  }

  const folder = picked.tops.length === 1 && only.isDir;
  const plan: ZipPlan = {
    kind: "zip",
    name: folder ? `${only.name.normalize("NFC")}.zip` : timestampName(now),
    files,
    dirs,
    totalSize: files.reduce((sum, f) => sum + f.size, 0),
    forcedStore: false,
    compressible: files.some((f) => f.compress),
    folder,
    warnings,
  };
  return sizePlan(plan, options);
}

/** The entries createZip() gets for a plan (sizes declared; files first, then empty folders). */
export function zipEntries(
  plan: Pick<ZipPlan, "files" | "dirs">,
  stream?: (file: ZipFile, index: number) => ReadableStream<Uint8Array>,
): ZipEntry[] {
  return [
    ...plan.files.map((f, index) => ({
      path: f.path,
      size: f.size,
      lastModified: f.lastModified,
      compress: f.compress,
      ...(stream ? { stream: () => stream(f, index) } : {}),
    })),
    ...plan.dirs.map((d) => ({ path: d.path, lastModified: d.lastModified })),
  ];
}

/**
 * An upper bound of the zip's size with the files deflated as planned:
 * the stored layout with each deflated file at deflateBound(), plus 64 KiB.
 */
export function worstCaseZipSize(plan: Pick<ZipPlan, "files" | "dirs">): number {
  const entries = zipEntries(plan).map((e) => ({
    ...e,
    ...(e.compress ? { size: deflateBound(e.size!) } : {}),
    compress: false,
  }));
  return storedZipSize(entries)! + 64 * 1024;
}

function sizePlan(plan: ZipPlan, { partSize, maxUnsizedParts }: PlanOptions): ZipPlan {
  if (plan.compressible) {
    const worstCase = worstCaseZipSize(plan);
    if (worstCase <= maxUnsizedParts * partSize) return { ...plan, worstCase };
    // Too large for an upload of unknown size: store everything.
    plan = {
      ...plan,
      forcedStore: true,
      files: plan.files.map((f) => ({ ...f, compress: false })),
    };
  }
  const size = storedZipSize(zipEntries(plan))!;
  if (Math.ceil(size / partSize) > MAX_PARTS) {
    throw new SelectionError(
      `This selection is too large to upload: ${formatBytes(size)}, and at most ` +
        `${formatBytes(MAX_PARTS * partSize)} fits in one upload.`,
    );
  }
  return { ...plan, size };
}

/** "7.8 GB", "52 MB", "300 KB": rounded down, in powers of 1000 (as macOS shows sizes). */
export function formatBytes(bytes: number): string {
  if (bytes >= 1e9) return `${Math.floor(bytes / 1e8) / 10} GB`;
  if (bytes >= 1e6) return `${Math.floor(bytes / 1e6)} MB`;
  return `${Math.floor(bytes / 1e3)} KB`;
}

/**
 * Whether a zip chosen again is the very same as one whose upload stopped:
 * the same files (paths, sizes and dates as they were chosen), the same
 * empty folders and the same choice of stored or deflated per file. Only
 * then can a stored zip, whose bytes are fully determined, continue.
 */
export function sameZip(a: ZipPlan, b: ZipPlan): boolean {
  return (
    a.size === b.size &&
    a.files.length === b.files.length &&
    a.dirs.length === b.dirs.length &&
    a.files.every((f, i) => {
      const g = b.files[i]!;
      return (
        f.path === g.path &&
        f.size === g.size &&
        f.lastModified === g.lastModified &&
        f.compress === g.compress
      );
    }) &&
    a.dirs.every((d, i) => d.path === b.dirs[i]!.path)
  );
}
