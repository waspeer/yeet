function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatExpiry(expiresAt: string): string {
  const date = new Date(expiresAt);
  const now = new Date();
  const diffMs = date.getTime() - now.getTime();
  const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
  if (diffDays <= 0) return "expired";
  if (diffDays === 1) return "in 1 day";
  if (diffDays < 7) return `in ${diffDays} days`;
  return `on ${date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`;
}

const CSS = `
*{box-sizing:border-box;margin:0;padding:0}
body{background:#222;font-family:Geneva,"Lucida Grande",sans-serif;font-size:12px;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:16px}
#shader-bg{position:fixed;inset:0;z-index:0}
.win{background:#fff;border:2px solid #000;box-shadow:3px 3px 0 #000;width:380px;max-width:100%;position:relative;z-index:1}
.title-bar{background:repeating-linear-gradient(#fff 0px,#fff 1px,#000 1px,#000 2px);border-bottom:2px solid #000;display:flex;align-items:center;padding:3px 6px;gap:6px;height:22px}
.title-bar span{flex:1;text-align:center;font-weight:bold;font-size:12px;background:#fff;padding:0 8px;line-height:16px}
.close-box{width:14px;height:14px;border:1px solid #000;background:#fff;flex-shrink:0}
.body{padding:24px 20px}
.icon{text-align:center;font-size:40px;line-height:1;margin-bottom:12px}
.filename{font-size:13px;font-weight:bold;text-align:center;word-break:break-all;margin-bottom:6px}
.meta{text-align:center;color:#444;line-height:1.8;margin-bottom:16px}
hr{border:none;border-top:1px solid #000;margin:0 0 16px}
.center{text-align:center}
input[type=password],input[type=text],select{font-family:inherit;font-size:12px;border:1px solid #000;border-radius:0;background:#fff;color:#000;padding:4px 8px;width:100%;margin-bottom:8px;display:block}
label{display:block;margin-bottom:4px;font-weight:bold}
button{font-family:inherit;font-size:12px;border:2px solid #000;background:#fff;padding:5px 20px;cursor:pointer;box-shadow:2px 2px 0 #000}
button:active{box-shadow:none;transform:translate(2px,2px)}
button.primary{background:#000;color:#fff}
.error{background:#eee;border:1px solid #000;padding:6px 8px;margin-bottom:8px;font-size:11px}
select{-webkit-appearance:none;appearance:none;padding-right:24px;background:#fff url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='9' height='5'%3E%3Cpath d='M0 0h9L4.5 5z'/%3E%3C/svg%3E") no-repeat right 8px center}
progress{-webkit-appearance:none;appearance:none;border:1px solid #000;background:#fff;display:block}
progress::-webkit-progress-bar{background:#fff}
progress::-webkit-progress-value{background:#000}
progress::-moz-progress-bar{background:#000}
a.button{display:inline-flex;align-items:center;justify-content:center;font-size:12px;border:2px solid #000;background:#fff;color:#000;padding:5px 20px;box-shadow:2px 2px 0 #000;text-decoration:none}
a.button:active{box-shadow:none;transform:translate(2px,2px)}
a.button.primary{background:#000;color:#fff}
@media (max-width:480px),(pointer:coarse){
.body{padding:20px 16px}
button,a.button{min-height:44px;padding:10px 20px}
input[type=password],input[type=text],select{font-size:16px;min-height:44px}
}
`.trim();

function sentryScript(): string {
  // Read per render: on Workers, vars and secrets reach process.env via nodejs_compat.
  const SENTRY_DSN = process.env.SENTRY_DSN ?? "";
  if (!SENTRY_DSN) return "";
  return `
<script src="https://browser.sentry-cdn.com/9.41.0/bundle.tracing.replay.min.js" crossorigin="anonymous"></script>
<script>
  Sentry.init({
    dsn: ${JSON.stringify(SENTRY_DSN)},
    integrations: [
      Sentry.replayIntegration({
        maskAllText: false,
        blockAllMedia: false,
      }),
    ],
    // Capture 100% of transactions for user misery / performance
    tracesSampleRate: 1.0,
    // Capture replays only when an error occurs (saves your free quota)
    replaysSessionSampleRate: 0,
    replaysOnErrorSampleRate: 1.0,
    // Ignore known browser extension noise
    ignoreErrors: [
      'Internal JSON-RPC error',
      /Object Not Found Matching Id/,
    ],
    beforeSend(event) {
      const frames = event.exception?.values?.[0]?.stacktrace?.frames || [];
      if (frames.some(f => f.filename?.startsWith('chrome-extension://'))) {
        return null;
      }
      return event;
    },
  });
</script>`;
}

/** The page shell (styles, window chrome, client.js). `body` is trusted HTML. */
export function layout(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>${CSS}</style>
</head>
<body>
<div id="shader-bg"></div>
<div class="win">
  <div class="title-bar">
    <div class="close-box"></div>
    <span>yeet</span>
  </div>
  <div class="body">${body}</div>
</div>
<script src="/client.js" type="module"></script>${sentryScript()}
</body>
</html>`;
}

export function downloadPage(opts: {
  /** The upload ID; the form posts to /<id>/download whether the page is at /<id> or /<id>/<filename>. */
  id: string;
  filename: string;
  fileSize: number;
  expiresAt: string;
  hasPassword: boolean;
  passwordError?: boolean;
  /** Shown instead of the wrong-password message, e.g. when rate-limited. */
  errorMessage?: string;
}): string {
  const { id, filename, fileSize, expiresAt, hasPassword, passwordError, errorMessage } = opts;
  const action = `/${encodeURIComponent(id)}/download`;
  const error = errorMessage ?? (passwordError ? "Incorrect password. Please try again." : null);
  const meta = `${formatBytes(fileSize)}<br>Expires ${formatExpiry(expiresAt)}`;

  const actionBlock = hasPassword
    ? `<form method="POST" action="${action}">
        ${error ? `<div class="error">${escHtml(error)}</div>` : ""}
        <label for="pw">Password required</label>
        <input type="password" id="pw" name="password" autofocus placeholder="Enter password">
        <div class="center"><button type="submit" class="primary">Download</button></div>
      </form>`
    : `<div class="center">
        <form method="POST" action="${action}">
          <button type="submit" class="primary">Download</button>
        </form>
      </div>`;

  const body = `
    <div class="icon">&#128196;</div>
    <div class="filename">${escHtml(filename)}</div>
    <div class="meta">${meta}</div>
    <hr>
    ${actionBlock}`;

  return layout(`yeet \u2014 ${escHtml(filename)}`, body);
}

/**
 * The command-line tool's first step, as the welcome page shows it with this
 * yeet's address. (CLI 0.3.0 has `login <url>`; there is no `setup` yet.)
 */
export function cliCommand(origin: string): string {
  return `npx @waspeer/yeet login ${origin}`;
}

// Only what the shared layout has no class for: the address field, its
// note, and the line about the command-line tool.
const WELCOME_CSS = `
.address{margin-bottom:8px}
.address input{margin-bottom:8px;font-family:Monaco,Menlo,monospace}
.note{text-align:center;color:#444;min-height:1em;margin-bottom:12px}
.cli{color:#444;font-size:11px;line-height:1.6;text-align:center;margin-top:20px}
.cli code{font-family:Monaco,Menlo,monospace;overflow-wrap:anywhere;background:#eee;padding:0 2px}
`.trim();

/**
 * GET /: what yeet is, this yeet's address (`origin`, from the request) to
 * keep, and the way to /upload. Public and the same for everyone: no
 * secret, no session, nothing from the bucket.
 */
export function landingPage(origin: string): string {
  const address = escHtml(origin);
  const body = `
    <style>${WELCOME_CSS}</style>
    <div class="icon">&#129418;</div>
    <div class="filename">This is your yeet</div>
    <div class="meta">yeet shares your files through links that expire.</div>
    <hr>
    <div class="address">
      <label for="address">Your yeet address</label>
      <input type="text" id="address" value="${address}" readonly
        autocapitalize="off" autocorrect="off" spellcheck="false">
      <div class="center"><button type="button" id="copy-address">Copy address</button></div>
    </div>
    <div id="copy-note" class="note" role="status"></div>
    <div class="center"><a class="button primary" href="/upload">Upload files</a></div>
    <div class="cli">On a Mac you can also upload from Terminal:<br><code>${escHtml(cliCommand(origin))}</code></div>
    <script type="module">
      const field = document.getElementById("address");
      const note = document.getElementById("copy-note");
      document.getElementById("copy-address").addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(field.value);
          note.textContent = "Address copied.";
          return;
        } catch {
          // no Clipboard API, no permission, or not a secure context
        }
        field.focus();
        field.select();
        let copied = false;
        try {
          copied = document.execCommand("copy");
        } catch {
          // not supported
        }
        note.textContent = copied ? "Address copied." : "Select the address and copy it.";
      });
    </script>`;
  return layout("yeet", body);
}

export function notFoundPage(): string {
  const body = `
    <div class="icon">&#9888;</div>
    <div class="filename">File not found</div>
    <div class="meta">This file has expired or does not exist.</div>`;
  return layout("yeet \u2014 Not Found", body);
}

export function errorPage(message = "Something went wrong."): string {
  const body = `
    <div class="icon">&#9888;</div>
    <div class="filename">Error</div>
    <div class="meta">${escHtml(message)}</div>`;
  return layout("yeet \u2014 Error", body);
}

/** The login form of /upload. Never contains the token, not even a wrong one. */
export function loginPage(opts: { error?: string } = {}): string {
  const body = `
    <div class="icon">&#128274;</div>
    <div class="filename">Log in to upload</div>
    <div class="meta">Paste the upload token you set when deploying yeet.</div>
    <hr>
    <form method="POST" action="/login">
      ${opts.error ? `<div class="error">${escHtml(opts.error)}</div>` : ""}
      <label for="token">Upload token</label>
      <input type="password" id="token" name="token" required autofocus
        autocapitalize="off" autocorrect="off" spellcheck="false" autocomplete="current-password">
      <div class="center"><button type="submit" class="primary">Log in</button></div>
    </form>`;
  return layout("yeet \u2014 Log in", body);
}

/** Readable message for a 429, as shown on pages. */
export function tooManyAttempts(retryAfter: number): string {
  return `Too many attempts. Try again in ${retryAfter} seconds.`;
}

export function escHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
