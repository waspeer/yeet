// The upload page (see upload-page.ts for the markup). Takes what is picked or
// dropped (one file, several files, a folder), decides what to upload
// (selection.ts: the file as-is, or a zip), hands it to a dedicated Web
// Worker (worker.ts) and shows what the worker reports.

import type { FromWorker, Resume, ToWorker } from "./protocol.js";
import {
  formatBytes,
  MAX_UNSIZED_PARTS,
  PART_SIZE,
  planSelection,
  sameZip,
  SelectionError,
  zoneOffsets,
  type Picked,
  type Plan,
  type ZipPlan,
} from "./selection.js";

type State = "idle" | "confirm" | "uploading" | "done" | "error";

const MiB = 1024 * 1024;
/** Window for the speed shown while uploading. */
const SPEED_WINDOW_MS = 3000;
/**
 * How long a cancel may take to delete the upload before the worker is
 * dropped: the worker lets parts in flight of an upload of unknown size
 * finish for up to 6 s first, then deletes (5 s timeout per request).
 */
const CANCEL_GRACE_MS = 15_000;

function el<T extends HTMLElement = HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`#${id} is missing`);
  return element as T;
}

/**
 * Test hook (e2e only): a lower MAX_UNSIZED_PARTS, so the tests of what
 * happens near the server's limit for uploads of unknown size (150 parts,
 * 7.86 GB) need megabytes instead of gigabytes. A lower limit only makes the
 * page store sooner; it can never let it exceed the server's.
 */
function maxUnsizedParts(): number {
  const hook = (globalThis as { __yeetE2E?: { maxUnsizedParts?: unknown } }).__yeetE2E;
  const value = hook?.maxUnsizedParts;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1
    ? Math.min(value, MAX_UNSIZED_PARTS)
    : MAX_UNSIZED_PARTS;
}

/** Used if the expiry choice is somehow unusable: the guide's 30 days. */
const DEFAULT_EXPIRES_IN = 30 * 24 * 60 * 60;
const MAX_EXPIRES_IN = 365 * 24 * 60 * 60;
const sections: Record<State, HTMLElement> = {
  idle: el("state-idle"),
  confirm: el("state-confirm"),
  uploading: el("state-uploading"),
  done: el("state-done"),
  error: el("state-error"),
};
const expiresSelect = el<HTMLSelectElement>("expires");
const passwordInput = el<HTMLInputElement>("password");
const drop = el("drop");
const input = el<HTMLInputElement>("file-input");
const folderInput = el<HTMLInputElement>("folder-input");
const chooseFolder = el<HTMLButtonElement>("choose-folder");
const idleNote = el("idle-note");
const idleError = el("idle-error");
const bar = el<HTMLProgressElement>("bar");
const percent = el("percent");
const amount = el("amount");
const speed = el("speed");
const upNote = el("up-note");
const upFiles = el("up-files");
const upWarn = el("up-warn");
const link = el<HTMLInputElement>("link");
const copyNote = el("copy-note");
const errorMessage = el("error-message");
const loginAgain = el("login-again");
const retry = el<HTMLButtonElement>("retry");
const cancelButton = el<HTMLButtonElement>("cancel");
const errorAnother = el<HTMLButtonElement>("error-another");
const chooseAgain = el<HTMLButtonElement>("choose-again");
const discard = el<HTMLButtonElement>("discard");

let state: State = "idle";
let worker: Worker | null = null;
/** What the current (or last) upload uploads. */
let plan: Plan | null = null;
/** A large selection waiting for "Upload anyway". */
let pending: ZipPlan | null = null;
/** The options of the current upload, fixed when it starts. */
let options: { expiresIn: number; password: string } = {
  expiresIn: DEFAULT_EXPIRES_IN,
  password: "",
};
let uploadId: string | null = null;
/**
 * Set once the worker has sent `complete`: from then on the upload may be
 * finished on the server, so neither Cancel nor leaving the page deletes it.
 */
let completing = false;
/** When the link of the current upload stops working (from its start). */
let expiresAt = new Date();
/** The server's part size and the acknowledged parts of the current upload. */
let partSize = 0;
let parts = new Map<number, string>();
/** Which picker the current selection came from, to offer the same one again. */
let picker: "files" | "folder" = "files";

/**
 * An upload that stopped because a file could no longer be read (see
 * FailureKind "file"). It stays open on the server until something is
 * chosen again:
 * - one file: the same file (name, size and lastModified) continues it
 *   from its first unacknowledged part;
 * - a stored zip (size known): the same files (paths, sizes, dates)
 *   continue it too; the zip is made again from the start, and the parts
 *   the server has are not sent again;
 * - a compressed zip cannot continue (deflate cannot restart halfway): it
 *   starts over.
 * Anything else starts afresh and deletes it.
 */
interface Resumable {
  id: string;
  partSize: number;
  parts: Map<number, string>;
  plan: Plan;
  /** One file: its name, size and date as they were when it was chosen. */
  identity: { name: string; size: number; lastModified: number };
  /** A zip: the time zone offsets of its entries' dates when it started (zoneOffsets()). */
  zone: string;
  options: { expiresIn: number; password: string };
  expiresAt: Date;
}
let resumable: Resumable | null = null;
/** zoneOffsets() of the current zip, taken when it started. */
let zone = "";
/**
 * Name, size and date of the current file, taken when it was chosen: once
 * the file is gone, WebKit's File.lastModified no longer gives the date
 * it had (it reads the missing file again).
 */
let identity = { name: "", size: 0, lastModified: 0 };

let samples: { at: number; sent: number }[] = [];
let wakeLock: WakeLockSentinel | null = null;

function show(next: State): void {
  state = next;
  for (const [name, section] of Object.entries(sections)) section.hidden = name !== next;
}

function formatMB(bytes: number): string {
  if (bytes < MiB) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / MiB).toFixed(1)} MB`;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const nameOf = (p: Plan) => (p.kind === "file" ? p.file.name : p.name);
const totalOf = (p: Plan) => (p.kind === "file" ? p.file.size : p.totalSize);

// ---------------------------------------------------------------------------
// Choosing files
// ---------------------------------------------------------------------------

/** Several loose files (the file picker, or a drop without folders). */
function looseFiles(files: File[]): Picked {
  return {
    tops: files.map((file) => ({ name: file.name, isDir: false })),
    files: files.map((file) => ({ file, path: file.name })),
    dirs: [],
  };
}

/** A picked folder: every file in it, with its path from the folder's parent. */
function pickedFolder(files: File[]): Picked {
  if (files.length > 0 && files.every((f) => f.webkitRelativePath.includes("/"))) {
    const top = files[0]!.webkitRelativePath.split("/")[0]!;
    return {
      tops: [{ name: top, isDir: true }],
      files: files.map((file) => ({ file, path: file.webkitRelativePath })),
      dirs: [],
    };
  }
  // The browser reports no folder: an empty folder (no files at all), or
  // no folder support.
  return files.length
    ? looseFiles(files)
    : { tops: [{ name: "", isDir: true }], files: [], dirs: [] };
}

el("choose").addEventListener("click", () => openPicker("files"));
chooseFolder.addEventListener("click", () => openPicker("folder"));
chooseFolder.hidden = !("webkitdirectory" in HTMLInputElement.prototype);

function openPicker(kind: "files" | "folder"): void {
  (kind === "folder" && !chooseFolder.hidden ? folderInput : input).click();
}

input.addEventListener("change", () => {
  const files = [...(input.files ?? [])];
  input.value = ""; // so choosing the same file again fires change
  if (files.length) chosen(looseFiles(files), "files");
});
folderInput.addEventListener("change", () => {
  const files = [...(folderInput.files ?? [])];
  folderInput.value = "";
  chosen(pickedFolder(files), "folder");
});

// Dropping anywhere on the page works, not only on the box; and a file
// dropped next to it must not make the browser navigate away to it.
let dragDepth = 0;
const canChoose = () => state !== "uploading";
window.addEventListener("dragenter", (event) => {
  event.preventDefault();
  if (canChoose() && ++dragDepth === 1) drop.classList.add("over");
});
window.addEventListener("dragleave", () => {
  if (dragDepth > 0 && --dragDepth === 0) drop.classList.remove("over");
});
window.addEventListener("dragover", (event) => {
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = canChoose() ? "copy" : "none";
});
window.addEventListener("drop", (event) => {
  event.preventDefault();
  dragDepth = 0;
  drop.classList.remove("over");
  if (!canChoose()) return;
  const data = event.dataTransfer;
  if (!data) return;
  const gathered = readDrop(data);
  if (state === "idle") idleNote.textContent = "Reading what you dropped…";
  void gathered.then(
    (picked) => {
      if (idleNote.textContent === "Reading what you dropped…") idleNote.textContent = "";
      chosen(picked, picked.tops.length === 1 && picked.tops[0]!.isDir ? "folder" : "files");
    },
    (err: unknown) =>
      selectionProblem(
        `The dropped items could not be read. Try Choose files instead. (${(err as Error)?.name ?? "Error"})`,
      ),
  );
});

/**
 * What was dropped: the entries of folders are read (recursively) with
 * webkitGetAsEntry(), which every engine has; otherwise the dropped files.
 * Both must be taken from the DataTransfer before the event ends.
 */
function readDrop(data: DataTransfer): Promise<Picked> {
  const files = [...data.files];
  const entries = [...(data.items ?? [])]
    .filter((item) => item.kind === "file")
    .map((item) => item.webkitGetAsEntry?.() ?? null);
  if (entries.length === 0 || entries.some((entry) => entry === null)) {
    return Promise.resolve(looseFiles(files));
  }
  const walked = walkEntries(entries as FileSystemEntry[]);
  // A drop of files only falls back to the dropped files if their entries
  // cannot be read.
  if (entries.every((entry) => entry!.isFile)) return walked.catch(() => looseFiles(files));
  return walked;
}

async function walkEntries(tops: FileSystemEntry[]): Promise<Picked> {
  const picked: Picked = { tops: [], files: [], dirs: [] };
  const visit = async (entry: FileSystemEntry, path: string): Promise<void> => {
    if (entry.isFile) {
      const file = await new Promise<File>((resolve, reject) =>
        (entry as FileSystemFileEntry).file(resolve, reject),
      );
      picked.files.push({ file, path });
    } else if (entry.isDirectory) {
      const dir = entry as FileSystemDirectoryEntry;
      picked.dirs.push({ path, lastModified: await folderDate(dir) });
      const reader = dir.createReader();
      // readEntries() hands out a batch at a time (Chromium: 100) until it
      // returns none.
      for (;;) {
        const batch = await new Promise<FileSystemEntry[]>((resolve, reject) =>
          reader.readEntries(resolve, reject),
        );
        if (batch.length === 0) break;
        for (const child of batch) await visit(child, `${path}/${child.name}`);
      }
    }
  };
  for (const entry of tops) {
    picked.tops.push({ name: entry.name, isDir: entry.isDirectory });
    await visit(entry, entry.name);
  }
  return picked;
}

/** A folder's date where the engine tells (Chromium's getMetadata()); else undefined (now). */
function folderDate(dir: FileSystemDirectoryEntry): Promise<number | undefined> {
  const getMetadata = (
    dir as unknown as {
      getMetadata?: (ok: (m: { modificationTime?: Date }) => void, fail: () => void) => void;
    }
  ).getMetadata;
  if (typeof getMetadata !== "function") return Promise.resolve(undefined);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), 2000);
    try {
      getMetadata.call(
        dir,
        (metadata) => {
          clearTimeout(timer);
          const time = metadata?.modificationTime?.getTime();
          resolve(typeof time === "number" && Number.isFinite(time) ? time : undefined);
        },
        () => {
          clearTimeout(timer);
          resolve(undefined);
        },
      );
    } catch {
      clearTimeout(timer);
      resolve(undefined);
    }
  });
}

/** Something was picked or dropped: plan it, warn if it must be stored, start. */
function chosen(picked: Picked, from: "files" | "folder"): void {
  if (state === "uploading") return;
  let next: Plan;
  try {
    next = planSelection(picked, { partSize: PART_SIZE, maxUnsizedParts: maxUnsizedParts() });
  } catch (err) {
    if (err instanceof SelectionError) return selectionProblem(err.message);
    throw err;
  }
  picker = from;
  if (resumable && canContinue(next, resumable)) return start(next);
  if (next.kind === "zip" && next.forcedStore && next.compressible) return confirmLarge(next);
  start(next);
}

/** A selection that cannot be uploaded: say why, and let the person choose again. */
function selectionProblem(text: string): void {
  if (state === "error" && resumable) {
    // Still waiting for the lost files: keep that state, with the reason.
    errorMessage.textContent = `${text} ${errorMessage.dataset["lost"] ?? ""}`.trim();
    return;
  }
  show("idle");
  idleNote.textContent = "";
  idleError.textContent = text;
  idleError.hidden = false;
}

function idleMessage(text: string): void {
  show("idle");
  idleError.hidden = true;
  idleNote.textContent = text;
}

/**
 * A selection over the limit for uploads of unknown size (about 7.8 GB)
 * with files that would compress: stored instead, so its size is known.
 * Say so before anything is uploaded; the person may upload it anyway or
 * zip it first themselves.
 */
function confirmLarge(next: ZipPlan): void {
  pending = next;
  const limit = formatBytes(maxUnsizedParts() * PART_SIZE);
  el("confirm-name").textContent = next.name;
  el("confirm-size").textContent =
    `${plural(next.files.length, "file")}, ${formatBytes(next.totalSize)}`;
  el("confirm-message").textContent =
    `This is more than about ${limit}, so yeet uploads it without compressing it: ` +
    `the upload takes longer and the download is bigger. For a smaller download, zip it ` +
    `yourself first (on a Mac: right-click the folder and choose Compress) and upload ` +
    `that zip file instead.`;
  show("confirm");
}

el("confirm-upload").addEventListener("click", () => {
  const next = pending;
  pending = null;
  if (next) start(next);
});
el("confirm-back").addEventListener("click", () => {
  pending = null;
  idleMessage("");
});

// ---------------------------------------------------------------------------
// Uploading
// ---------------------------------------------------------------------------

/** The options as chosen on the page right now. */
function chosenOptions(): { expiresIn: number; password: string } {
  const seconds = Number(expiresSelect.value);
  const expiresIn =
    Number.isSafeInteger(seconds) && seconds >= 1 && seconds <= MAX_EXPIRES_IN
      ? seconds
      : DEFAULT_EXPIRES_IN;
  return { expiresIn, password: passwordInput.value };
}

/** Whether `next` may continue the upload that stopped (see Resumable). */
function canContinue(next: Plan, previous: Resumable): boolean {
  const old = previous.plan;
  if (next.kind === "file" && old.kind === "file") {
    return (
      next.file.name === previous.identity.name &&
      next.file.size === previous.identity.size &&
      next.file.lastModified === previous.identity.lastModified
    );
  }
  return (
    next.kind === "zip" &&
    old.kind === "zip" &&
    old.size !== undefined &&
    sameZip(next, old) &&
    !zoneChanged(previous)
  );
}

/**
 * Whether the time zone changed since a zip started: made again, its
 * entries' dates would differ from the parts already uploaded (round 2D).
 */
function zoneChanged(previous: Resumable): boolean {
  return previous.plan.kind === "zip" && zoneOffsets(previous.plan) !== previous.zone;
}

/**
 * Delete an upload this page left open (best effort; the cleanup gets it
 * after 24 h). An upload of unknown size has a record per part and the
 * server deletes 100 objects per request, so ask while it answers 202.
 */
function deleteOnServer(id: string): void {
  void (async () => {
    for (let round = 0; round < 5; round++) {
      const res = await fetch(`/api/uploads/${encodeURIComponent(id)}`, { method: "DELETE" });
      if (res.status !== 202) return;
    }
  })().catch(() => {});
}

function start(chosenPlan: Plan, opts = chosenOptions()): void {
  if (state === "uploading") return;
  let next = chosenPlan;
  let resume: Resume | undefined;
  let note = "";
  if (resumable) {
    const previous = resumable;
    resumable = null;
    if (canContinue(next, previous)) {
      resume = {
        id: previous.id,
        partSize: previous.partSize,
        parts: [...previous.parts].map(([n, etag]) => ({ part_number: n, etag })),
      };
      opts = previous.options;
      expiresAt = previous.expiresAt;
      parts = new Map(previous.parts);
      if (next.kind === "zip" && previous.plan.kind === "zip") {
        // The zip as it was planned (its name, its folders' dates), with
        // the files just chosen: it must come out byte for byte the same.
        const files = next.files;
        next = {
          ...previous.plan,
          files: previous.plan.files.map((f, i) => ({ ...f, file: files[i]!.file })),
        };
      }
    } else {
      if (
        next.kind === "zip" &&
        previous.plan.kind === "zip" &&
        previous.plan.size !== undefined &&
        sameZip(next, previous.plan) &&
        zoneChanged(previous)
      ) {
        note = "The time zone changed since the upload started, so it starts over.";
      }
      deleteOnServer(previous.id);
    }
  }
  if (!resume) {
    parts = new Map();
    // Counted from now: the server counts from its create, moments later.
    expiresAt = new Date(Date.now() + opts.expiresIn * 1000);
  }
  plan = next;
  identity =
    next.kind === "file"
      ? { name: next.file.name, size: next.file.size, lastModified: next.file.lastModified }
      : { name: next.name, size: next.totalSize, lastModified: 0 };
  // When resuming, `next` is the zip as planned, so this is its zone again.
  zone = next.kind === "zip" ? zoneOffsets(next) : "";
  options = opts;
  uploadId = null;
  completing = false;
  cancelButton.hidden = false;
  samples = [{ at: performance.now(), sent: 0 }];
  idleNote.textContent = "";
  idleError.hidden = true;
  upNote.textContent = resume ? "Continuing where it stopped…" : note;
  el("up-name").textContent = nameOf(next);
  upFiles.hidden = next.kind === "file";
  upFiles.textContent =
    next.kind === "zip" ? `${plural(next.files.length, "file")}, zipped while uploading` : "";
  upWarn.hidden = next.kind === "file" || next.warnings.length === 0;
  upWarn.textContent = next.kind === "zip" ? next.warnings.join(" ") : "";
  renderProgress(0, totalOf(next));
  show("uploading");

  const w = new Worker("/upload-worker.js");
  worker = w;
  w.onmessage = (event: MessageEvent<FromWorker>) => {
    if (worker === w) onMessage(event.data);
    else if (event.data.type === "cancelled") w.terminate(); // a cancelled upload's worker
  };
  w.onerror = (event) => {
    event.preventDefault();
    if (worker !== w) return;
    finish();
    fail(
      `Something went wrong in this page. Reload it and try again. ${details(undefined, event.message ?? "")}`,
      true,
    );
  };
  w.postMessage({
    type: "start",
    job: next.kind === "file" ? { kind: "file", file: next.file } : { kind: "zip", plan: next },
    expiresIn: opts.expiresIn,
    ...(opts.password ? { password: opts.password } : {}),
    ...(resume ? { resume } : {}),
    maxUnsizedParts: maxUnsizedParts(),
  } satisfies ToWorker);
  void keepAwake();
}

function onMessage(message: FromWorker): void {
  switch (message.type) {
    case "started":
      uploadId = message.id;
      partSize = message.partSize;
      break;
    case "part":
      parts.set(message.part.part_number, message.part.etag);
      break;
    case "progress":
      renderProgress(message.sent, message.total);
      break;
    case "entry": {
      const name = message.path.replace(/\/$/, "").split("/").pop() ?? "";
      upFiles.textContent = `File ${message.index} of ${message.count}: ${name}`;
      break;
    }
    case "retrying":
      upNote.textContent = "The connection hiccupped. Trying again…";
      break;
    case "finishing": {
      completing = true;
      cancelButton.hidden = true;
      const total = plan ? totalOf(plan) : 0;
      renderProgress(total, total);
      upNote.textContent = "Finishing…";
      break;
    }
    case "done":
      finish();
      el("done-name").textContent = plan ? nameOf(plan) : "";
      el("done-files").hidden = plan?.kind !== "zip";
      el("done-files").textContent =
        plan?.kind === "zip" ? `${plural(plan.files.length, "file")} in one zip file.` : "";
      el("done-expiry").textContent = expiryText(options.expiresIn, expiresAt);
      el("done-password").textContent = options.password
        ? "Password protected: people need the password to download."
        : "No password: anyone with the link can download.";
      link.value = message.url;
      copyNote.textContent = "";
      show("done");
      break;
    case "failed":
      if (message.kind === "file" && uploadId && plan) {
        resumable = {
          id: uploadId,
          partSize,
          parts: new Map(parts),
          plan,
          identity,
          zone,
          options,
          expiresAt,
        };
      }
      finish();
      if (message.kind === "file") {
        fileLost();
      } else if (message.kind === "session") {
        fail(
          `Your login has expired. Log in again, then upload the ${plan?.kind === "zip" ? "files" : "file"} again.`,
          false,
        );
        loginAgain.hidden = false;
      } else if (message.kind === "network") {
        fail(
          "The connection to the server was lost, so the upload stopped. Check your internet connection and try again.",
          true,
        );
      } else if (message.kind === "zip") {
        fail(
          `A file could not be added to the zip, so the upload stopped. Maybe it changed while it was ` +
            `being uploaded. Choose the files again. ${details(undefined, message.message)}`,
          false,
        );
      } else if (message.kind === "rejected") {
        fail(rejectedMessage(message.status, message.message), true);
      } else {
        fail(
          `Something went wrong on the server. Please try again in a moment. ${details(message.status, message.message)}`,
          true,
        );
      }
      break;
    case "cancelled":
      break;
  }
}

/** "Works for 30 days, until Nov 9, 2026." */
function expiryText(seconds: number, until: Date): string {
  const days = Math.round(seconds / 86400);
  const span = days >= 365 ? "1 year" : days === 1 ? "1 day" : `${days} days`;
  const date = until.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  return `Works for ${span}, until ${date}.`;
}

function rejectedMessage(status: number | undefined, detail: string): string {
  const suffix = details(status, detail);
  if (/filename/i.test(detail)) {
    return plan?.kind === "zip"
      ? `This name can't be used for the zip. Rename the folder and try again. ${suffix}`
      : `This file's name can't be used. Rename the file and try again. ${suffix}`;
  }
  if (status === 403) {
    return `The server refused the upload from this page. Reload the page and try again. ${suffix}`;
  }
  return `The server refused this ${plan?.kind === "zip" ? "upload" : "file"}. ${suffix}`;
}

/**
 * The technical detail, for whoever helps: "(Error 500: Internal server error)".
 * Only the status and the server's own message, never a stack trace (WebKit's
 * stacks do not even contain the message).
 */
function details(status: number | undefined, detail: string): string {
  const parts = [status ? `Error ${status}` : "", detail.trim()].filter(Boolean);
  return parts.length ? `(${parts.join(": ")})` : "";
}

function renderProgress(sent: number, total: number): void {
  const ratio = total > 0 ? Math.min(1, sent / total) : 1;
  const pct = Math.floor(ratio * 100);
  bar.value = ratio * 100;
  percent.textContent = `${pct}%`;
  amount.textContent = `${formatMB(sent)} of ${formatMB(total)}`;

  const now = performance.now();
  samples.push({ at: now, sent });
  while (samples.length > 2 && now - samples[1]!.at > SPEED_WINDOW_MS) samples.shift();
  const first = samples[0]!;
  const seconds = (now - first.at) / 1000;
  speed.textContent =
    seconds > 0.2 ? `${((sent - first.sent) / MiB / seconds).toFixed(1)} MB/s` : "";
}

function fail(text: string, canRetry: boolean): void {
  errorMessage.textContent = text;
  delete errorMessage.dataset["lost"];
  loginAgain.hidden = true;
  retry.hidden = !canRetry;
  errorAnother.hidden = false;
  chooseAgain.hidden = true;
  discard.hidden = true;
  show("error");
}

/** A file can no longer be read (iOS: the screen locked). Nothing is deleted. */
function fileLost(): void {
  const lost = resumable?.plan ?? plan;
  const why = "On an iPhone this happens when the screen locks or you switch apps.";
  let text: string;
  if (lost?.kind === "zip") {
    const what = lost.folder ? "folder" : "files";
    text =
      lost.size !== undefined
        ? `The browser lost access to the ${what}. ${why} Choose the same ${what} again to ` +
          `continue where it stopped.`
        : `The browser lost access to the ${what}. ${why} Choose the same ${what} again to ` +
          `upload ${lost.folder ? "it" : "them"}: the upload starts over from the beginning, ` +
          `because a compressed zip can't continue where it stopped.`;
    chooseAgain.textContent = `Choose the ${what} again`;
  } else {
    text = resumable
      ? `The browser lost access to the file. ${why} Choose the same file again to continue ` +
        `where it stopped.`
      : `The browser lost access to the file. ${why} Choose the file again to upload it.`;
    chooseAgain.textContent = "Choose the file again";
  }
  errorMessage.textContent = text;
  errorMessage.dataset["lost"] = text;
  loginAgain.hidden = true;
  retry.hidden = true;
  errorAnother.hidden = true;
  chooseAgain.hidden = false;
  discard.hidden = !resumable;
  show("error");
}

/** The upload ended (done, failed): drop the worker and the wake lock. */
function finish(): void {
  worker?.terminate();
  worker = null;
  uploadId = null;
  void wakeLock?.release().catch(() => {});
  wakeLock = null;
}

cancelButton.addEventListener("click", () => {
  const w = worker;
  if (!w || completing) return;
  // The worker aborts its requests, deletes the upload and then reports
  // "cancelled", whereupon it is terminated (see start()).
  w.postMessage({ type: "cancel" } satisfies ToWorker);
  setTimeout(() => w.terminate(), CANCEL_GRACE_MS);
  worker = null;
  uploadId = null;
  void wakeLock?.release().catch(() => {});
  wakeLock = null;
  idleMessage("Upload cancelled.");
});

retry.addEventListener("click", () => {
  if (plan) start(plan, options);
});
errorAnother.addEventListener("click", () => {
  idleMessage("");
  openPicker("files");
});
// Opens the picker right away (a user gesture), staying in the error state
// until something is chosen: choosing continues or restarts (start()).
chooseAgain.addEventListener("click", () => {
  const lost = resumable?.plan ?? plan;
  openPicker(lost?.kind === "zip" && lost.folder && picker === "folder" ? "folder" : "files");
});
discard.addEventListener("click", () => {
  if (resumable) deleteOnServer(resumable.id);
  resumable = null;
  idleMessage("Upload cancelled.");
});
el("another").addEventListener("click", () => {
  plan = null;
  idleMessage("");
});

// Leaving the page mid-upload: warn first, and if the user leaves anyway,
// delete the unfinished upload (best effort; keepalive outlives the page).
// One request: an upload of unknown size with more than 100 objects is
// then gone for users (marked as being deleted), and the server's cleanup
// deletes the rest.
window.addEventListener("beforeunload", (event) => {
  if (state === "uploading") event.preventDefault();
});
window.addEventListener("pagehide", (event) => {
  // An upload kept to continue after a lost file: only this page can
  // continue it, and only if it comes back from the back-forward cache
  // (`persisted`). Leaving for good, it is deleted. (WebKit aborts the
  // upload and the file's reads as the page goes, so a page left mid-upload
  // may already be in this state.)
  if (resumable && !event.persisted) {
    const id = resumable.id;
    resumable = null;
    void fetch(`/api/uploads/${encodeURIComponent(id)}`, {
      method: "DELETE",
      keepalive: true,
    }).catch(() => {});
    return;
  }
  if (state !== "uploading" || !worker || completing) return;
  const id = uploadId;
  worker.terminate();
  worker = null;
  if (id) {
    void fetch(`/api/uploads/${encodeURIComponent(id)}`, {
      method: "DELETE",
      keepalive: true,
    }).catch(() => {});
  }
  show("idle");
});

// ---------------------------------------------------------------------------
// Copying the link
// ---------------------------------------------------------------------------

el("copy").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(link.value);
    copyNote.textContent = "Link copied.";
    return;
  } catch {
    // no Clipboard API, no permission, or not a secure context
  }
  link.focus();
  link.select();
  let copied = false;
  try {
    copied = document.execCommand("copy");
  } catch {
    // unsupported
  }
  copyNote.textContent = copied
    ? "Link copied."
    : "Press Ctrl+C (⌘C on a Mac) to copy the selected link.";
});
link.addEventListener("focus", () => link.select());

// ---------------------------------------------------------------------------
// Keep the screen on while uploading, where the browser allows it
// ---------------------------------------------------------------------------

async function keepAwake(): Promise<void> {
  if (!("wakeLock" in navigator) || state !== "uploading" || wakeLock) return;
  try {
    const lock = await navigator.wakeLock.request("screen");
    if (state !== "uploading" || wakeLock) {
      await lock.release();
      return;
    }
    wakeLock = lock;
    lock.addEventListener("release", () => {
      if (wakeLock === lock) wakeLock = null;
    });
  } catch {
    // denied (e.g. hidden tab, low battery): upload anyway
  }
}
// The browser drops the lock when the tab is hidden; take it again on return.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") void keepAwake();
});

// Everything is wired up: the button is disabled in the HTML until now.
el<HTMLButtonElement>("choose").disabled = false;
