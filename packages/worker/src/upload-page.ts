// The browser upload page for a logged-in user (GET /upload with a valid
// session). The page itself is static; public/upload.js drives it and runs the
// upload in a Web Worker (public/upload-worker.js), authenticated by the
// yeet_session cookie only. Nothing here may contain the UPLOAD_TOKEN.
// index.ts serves uploadPage() with `Cache-Control: no-store`.

import { layout } from "./template.js";

/** Default link lifetime for browser uploads: 30 days. */
export const DEFAULT_EXPIRES_IN_SECONDS = 30 * 24 * 60 * 60;

export interface UploadPageOptions {
  /** Lifetime of the share link in seconds. Default 30 days. */
  expiresInSeconds?: number;
}

// Only what the existing layout has no class for: the drop zone, the progress
// bar and the link field. Kept bare on purpose (styling is phase 2).
const PAGE_CSS = `
.drop{border:2px dashed #000;padding:24px 12px;text-align:center;line-height:2;margin-bottom:12px}
.drop.over{background:#eee}
.row{display:flex;gap:8px;justify-content:center;flex-wrap:wrap;margin-top:12px}
progress{width:100%;height:16px;margin-bottom:8px}
input[readonly]{font-family:inherit;font-size:12px;border:1px solid #000;padding:4px 8px;width:100%;display:block}
.note{text-align:center;color:#444;margin-top:8px;min-height:1em}
.logout{text-align:center;margin-top:20px}
.logout button{box-shadow:none;border-width:1px;padding:2px 10px;font-size:11px}
[hidden]{display:none!important}
`.trim();

export function uploadPage(opts: UploadPageOptions = {}): string {
  const expiresIn = opts.expiresInSeconds ?? DEFAULT_EXPIRES_IN_SECONDS;
  const days = Math.round(expiresIn / 86400);
  const body = `
    <style>${PAGE_CSS}</style>
    <div id="upload-app" data-expires-in="${expiresIn}">
      <section id="state-idle">
        <div id="drop" class="drop">
          Drag a file here<br>or<br>
          <button type="button" id="choose" class="primary" disabled>Choose file</button>
          <input type="file" id="file-input" hidden>
        </div>
        <div class="meta">The link works for ${days} days.</div>
        <div id="idle-note" class="note" role="status"></div>
      </section>

      <section id="state-uploading" hidden>
        <div id="up-name" class="filename"></div>
        <progress id="bar" max="100" value="0" aria-label="Upload progress"></progress>
        <div class="meta"><span id="percent">0%</span> · <span id="amount"></span> · <span id="speed"></span></div>
        <div id="up-note" class="note" role="status"></div>
        <div class="row"><button type="button" id="cancel">Cancel</button></div>
      </section>

      <section id="state-done" hidden>
        <div id="done-name" class="filename"></div>
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
          <a id="login-again" href="/upload" hidden>Log in again</a>
          <button type="button" id="retry" class="primary">Retry</button>
          <button type="button" id="error-another">Choose another file</button>
        </div>
      </section>

      <noscript><div class="error">This page needs JavaScript to upload files.</div></noscript>

      <form method="POST" action="/logout" class="logout"><button type="submit">Log out</button></form>
    </div>
    <script src="/upload.js" type="module"></script>`;
  return layout("yeet — Upload", body);
}
