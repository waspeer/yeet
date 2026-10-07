// The upload page (see upload-page.ts for the markup). Picks one file, hands it
// to a dedicated Web Worker (worker.ts) and shows what the worker reports.

import type { FromWorker, ToWorker } from "./protocol.js";

type State = "idle" | "uploading" | "done" | "error";

const MiB = 1024 * 1024;
/** Window for the speed shown while uploading. */
const SPEED_WINDOW_MS = 3000;
/** How long a cancel may take to delete the upload before the worker is dropped. */
const CANCEL_GRACE_MS = 10_000;

function el<T extends HTMLElement = HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`#${id} is missing`);
  return element as T;
}

const app = el("upload-app");
const expiresIn = Number(app.dataset["expiresIn"]) || 30 * 24 * 60 * 60;
const sections: Record<State, HTMLElement> = {
  idle: el("state-idle"),
  uploading: el("state-uploading"),
  done: el("state-done"),
  error: el("state-error"),
};
const drop = el("drop");
const input = el<HTMLInputElement>("file-input");
const idleNote = el("idle-note");
const bar = el<HTMLProgressElement>("bar");
const percent = el("percent");
const amount = el("amount");
const speed = el("speed");
const upNote = el("up-note");
const link = el<HTMLInputElement>("link");
const copyNote = el("copy-note");
const errorMessage = el("error-message");
const loginAgain = el("login-again");
const retry = el<HTMLButtonElement>("retry");

let state: State = "idle";
let worker: Worker | null = null;
let file: File | null = null;
let uploadId: string | null = null;
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

// ---------------------------------------------------------------------------
// Choosing a file
// ---------------------------------------------------------------------------

el("choose").addEventListener("click", () => input.click());
input.addEventListener("change", () => {
  const chosen = input.files?.[0];
  input.value = ""; // so choosing the same file again fires change
  if (chosen) start(chosen);
});

// Dropping a file anywhere on the page works, not only on the box; and a
// file dropped next to it must not make the browser navigate away to it.
let dragDepth = 0;
window.addEventListener("dragenter", (event) => {
  event.preventDefault();
  if (state === "idle" && ++dragDepth === 1) drop.classList.add("over");
});
window.addEventListener("dragleave", () => {
  if (dragDepth > 0 && --dragDepth === 0) drop.classList.remove("over");
});
window.addEventListener("dragover", (event) => {
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = state === "idle" ? "copy" : "none";
});
window.addEventListener("drop", (event) => {
  event.preventDefault();
  dragDepth = 0;
  drop.classList.remove("over");
  if (state !== "idle" && state !== "done" && state !== "error") return;
  const data = event.dataTransfer;
  if (!data) return;
  const entry = data.items?.[0]?.webkitGetAsEntry?.();
  if (entry?.isDirectory) {
    return idleMessage("Folders can't be uploaded yet. Zip the folder first, or choose one file.");
  }
  if (data.files.length > 1) return idleMessage("Please drop one file at a time.");
  const dropped = data.files[0];
  if (dropped) start(dropped);
});

function idleMessage(text: string): void {
  show("idle");
  idleNote.textContent = text;
}

// ---------------------------------------------------------------------------
// Uploading
// ---------------------------------------------------------------------------

function start(chosen: File): void {
  if (state === "uploading") return;
  file = chosen;
  uploadId = null;
  samples = [{ at: performance.now(), sent: 0 }];
  idleNote.textContent = "";
  upNote.textContent = "";
  el("up-name").textContent = chosen.name;
  renderProgress(0, chosen.size);
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
  w.postMessage({ type: "start", file: chosen, expiresIn } satisfies ToWorker);
  void keepAwake();
}

function onMessage(message: FromWorker): void {
  switch (message.type) {
    case "started":
      uploadId = message.id;
      break;
    case "progress":
      renderProgress(message.sent, message.total);
      break;
    case "retrying":
      upNote.textContent = "The connection hiccupped. Trying again…";
      break;
    case "finishing":
      renderProgress(file?.size ?? 0, file?.size ?? 0);
      upNote.textContent = "Finishing…";
      break;
    case "done":
      finish();
      el("done-name").textContent = file?.name ?? "";
      link.value = message.url;
      copyNote.textContent = "";
      show("done");
      break;
    case "failed":
      finish();
      if (message.kind === "session") {
        fail("Your login has expired. Log in again, then upload the file again.", false);
        loginAgain.hidden = false;
      } else if (message.kind === "network") {
        fail(
          "The connection to the server was lost, so the upload stopped. Check your internet connection and try again.",
          true,
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

function rejectedMessage(status: number | undefined, detail: string): string {
  const suffix = details(status, detail);
  if (/filename/i.test(detail)) {
    return `This file's name can't be used. Rename the file and try again. ${suffix}`;
  }
  if (status === 403) {
    return `The server refused the upload from this page. Reload the page and try again. ${suffix}`;
  }
  return `The server refused this file. ${suffix}`;
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
  loginAgain.hidden = true;
  retry.hidden = !canRetry;
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

el("cancel").addEventListener("click", () => {
  const w = worker;
  if (!w) return;
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
  if (file) start(file);
});
el("error-another").addEventListener("click", () => {
  show("idle");
  input.click();
});
el("another").addEventListener("click", () => {
  file = null;
  show("idle");
  idleNote.textContent = "";
});

// Leaving the page mid-upload: warn first, and if the user leaves anyway,
// delete the unfinished upload (best effort; keepalive outlives the page).
window.addEventListener("beforeunload", (event) => {
  if (state === "uploading") event.preventDefault();
});
window.addEventListener("pagehide", () => {
  if (state !== "uploading" || !worker) return;
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
