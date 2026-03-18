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
input[type=password]{font-family:inherit;font-size:12px;border:1px solid #000;padding:4px 8px;width:100%;margin-bottom:8px;display:block}
label{display:block;margin-bottom:4px;font-weight:bold}
button{font-family:inherit;font-size:12px;border:2px solid #000;background:#fff;padding:5px 20px;cursor:pointer;box-shadow:2px 2px 0 #000}
button:active{box-shadow:none;transform:translate(2px,2px)}
button.primary{background:#000;color:#fff}
.error{background:#eee;border:1px solid #000;padding:6px 8px;margin-bottom:8px;font-size:11px}
`.trim();

const SENTRY_DSN = process.env.SENTRY_DSN ?? "";

function sentryScript(): string {
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
  });
</script>`;
}

function layout(title: string, body: string): string {
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
  filename: string;
  fileSize: number;
  expiresAt: string;
  hasPassword: boolean;
  passwordError?: boolean;
}): string {
  const { filename, fileSize, expiresAt, hasPassword, passwordError } = opts;
  const meta = `${formatBytes(fileSize)}<br>Expires ${formatExpiry(expiresAt)}`;

  const actionBlock = hasPassword
    ? `<form method="POST" action="download">
        ${passwordError ? '<div class="error">Incorrect password. Please try again.</div>' : ""}
        <label for="pw">Password required</label>
        <input type="password" id="pw" name="password" autofocus placeholder="Enter password">
        <div class="center"><button type="submit" class="primary">Download</button></div>
      </form>`
    : `<div class="center">
        <form method="POST" action="download">
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

export function landingPage(): string {
  const body = `
    <div class="icon">&#129418;</div>`;
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

function escHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
