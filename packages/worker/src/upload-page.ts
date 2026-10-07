// The upload page, served by GET /upload to a browser with a valid session.
//
// PLACEHOLDER: the real upload UI is built separately and replaces this
// module. The contract with the rest of the Worker is only this function's
// signature: it returns the full HTML document, and index.ts serves it with
// `Cache-Control: no-store`. The page talks to /api/* with the session cookie
// (same origin, so the browser sends Origin and Sec-Fetch-Site itself) and
// must never see the upload token. Logging out is a same-origin form POST to
// /logout.

import { layout } from "./template.js";

export function uploadPage(): string {
  const body = `
    <div class="icon">&#128228;</div>
    <div class="filename">You are logged in</div>
    <div class="meta">The upload form is coming soon.</div>
    <hr>
    <form method="POST" action="/logout" class="center">
      <button type="submit">Log out</button>
    </form>`;
  return layout("yeet — Upload", body);
}
