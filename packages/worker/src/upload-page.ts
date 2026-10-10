// The browser upload page for a logged-in user (GET /upload with a valid
// session). The page itself is static; public/upload.js drives it and runs the
// upload in a Web Worker (public/upload-worker.js), authenticated by the
// yeet_session cookie only. Nothing here may contain the UPLOAD_TOKEN.
// index.ts serves uploadPage() with `Cache-Control: no-store`.

import { layout } from "./template.js";

const DAY = 24 * 60 * 60;

/** Default link lifetime for browser uploads: 30 days. */
export const DEFAULT_EXPIRES_IN_SECONDS = 30 * DAY;

/**
 * The link lifetimes the page offers, in seconds. The longest is the API's
 * limit, 365 days (`expires_in`, see docs/design/api.md).
 */
export const EXPIRY_CHOICES: readonly { seconds: number; label: string }[] = [
  { seconds: DAY, label: "1 day" },
  { seconds: 7 * DAY, label: "7 days" },
  { seconds: 30 * DAY, label: "30 days" },
  { seconds: 90 * DAY, label: "90 days" },
  { seconds: 365 * DAY, label: "1 year" },
];

// Only what the shared layout has no class for: the options, the drop zone,
// the progress bar and the link field, in the layout's style.
const PAGE_CSS = `
.field{margin-bottom:12px}
.field input{margin-bottom:0}
.hint{color:#444;font-weight:normal;font-size:11px;margin-top:4px}
.drop{border:2px dashed #000;padding:24px 12px;text-align:center;line-height:2;margin-bottom:12px}
.drop.over{background:#eee}
.pickers{display:inline-flex;gap:8px;flex-wrap:wrap;justify-content:center}
.warning{border:2px solid #000;box-shadow:2px 2px 0 #000;padding:8px 10px;line-height:1.5;margin-bottom:4px}
.hint.center{text-align:center;margin:0 0 8px}
.row{display:flex;gap:8px;justify-content:center;flex-wrap:wrap;margin-top:12px}
progress{width:100%;height:16px;margin-bottom:8px}
input[readonly]{background:#fff}
.note{text-align:center;color:#444;margin-top:8px;min-height:1em}
.summary{text-align:center;line-height:1.8;margin-bottom:12px}
.logout{text-align:center;margin-top:20px}
.logout button{box-shadow:none;border-width:1px;padding:2px 10px;font-size:11px}
a.button{display:inline-flex;align-items:center;border:2px solid #000;background:#fff;color:#000;padding:5px 20px;box-shadow:2px 2px 0 #000;text-decoration:none}
@media (max-width:480px),(pointer:coarse){a.button{min-height:44px}}
@media (pointer:coarse){.drag-hint,#choose-folder{display:none}}
[hidden]{display:none!important}
`.trim();

export function uploadPage(): string {
  const options = EXPIRY_CHOICES.map(
    ({ seconds, label }) =>
      `<option value="${seconds}"${seconds === DEFAULT_EXPIRES_IN_SECONDS ? " selected" : ""}>${label}</option>`,
  ).join("");
  const body = `
    <style>${PAGE_CSS}</style>
    <div id="upload-app">
      <section id="state-idle">
        <div class="field">
          <label for="expires">Link works for</label>
          <select id="expires">${options}</select>
        </div>
        <div class="field">
          <label for="password">Password <span class="hint">(optional)</span></label>
          <input type="text" id="password" autocomplete="off" autocapitalize="off"
            autocorrect="off" spellcheck="false" placeholder="No password">
          <div class="hint">If you set one, people need it to download the file.</div>
        </div>
        <div id="drop" class="drop">
          <span class="drag-hint">Drag files or a folder here<br>or<br></span>
          <span class="pickers">
            <button type="button" id="choose" class="primary" disabled>Choose files</button>
            <button type="button" id="choose-folder" hidden>Choose folder</button>
          </span>
          <input type="file" id="file-input" multiple hidden>
          <input type="file" id="folder-input" webkitdirectory hidden>
        </div>
        <div id="idle-note" class="note" role="status"></div>
        <div id="idle-error" class="error" role="alert" hidden></div>
      </section>

      <section id="state-confirm" hidden>
        <div id="confirm-name" class="filename"></div>
        <div id="confirm-size" class="meta"></div>
        <div id="confirm-message" class="warning" role="alert"></div>
        <div class="row">
          <button type="button" id="confirm-upload" class="primary">Upload anyway</button>
          <button type="button" id="confirm-back">Choose again</button>
        </div>
      </section>

      <section id="state-uploading" hidden>
        <div id="up-name" class="filename"></div>
        <div id="up-files" class="hint center" hidden></div>
        <progress id="bar" max="100" value="0" aria-label="Upload progress"></progress>
        <div class="meta"><span id="percent">0%</span> · <span id="amount"></span> · <span id="speed"></span></div>
        <div id="up-note" class="note" role="status"></div>
        <div id="up-warn" class="hint center" hidden></div>
        <div class="row"><button type="button" id="cancel">Cancel</button></div>
      </section>

      <section id="state-done" hidden>
        <div id="done-name" class="filename"></div>
        <div class="summary">
          <div id="done-files" hidden></div>
          <div id="done-expiry"></div>
          <div id="done-password"></div>
        </div>
        <label for="link">Share this link</label>
        <input type="text" id="link" readonly>
        <div class="row">
          <button type="button" id="copy" class="primary">Copy link</button>
          <button type="button" id="another">Upload another</button>
        </div>
        <div id="copy-note" class="note" role="status"></div>
      </section>

      <section id="state-error" hidden>
        <div id="error-message" class="error" role="alert"></div>
        <div class="row">
          <a id="login-again" class="button" href="/upload" hidden>Log in again</a>
          <button type="button" id="retry" class="primary">Retry</button>
          <button type="button" id="error-another">Choose another file</button>
          <button type="button" id="choose-again" class="primary" hidden>Choose the file again</button>
          <button type="button" id="discard" hidden>Cancel upload</button>
        </div>
      </section>

      <noscript><div class="error">This page needs JavaScript to upload files.</div></noscript>

      <form method="POST" action="/logout" class="logout"><button type="submit">Log out</button></form>
    </div>
    <script src="/upload.js" type="module"></script>`;
  return layout("yeet — Upload", body);
}
