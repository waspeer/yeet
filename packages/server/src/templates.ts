/** Escape a string for safe insertion into HTML text content or attribute values. */
function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatExpiry(expiresAt: Date): string {
  return expiresAt.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

export interface DownloadPageProps {
  id: string;
  filename: string;
  expiresAt: Date;
  /** True when the upload has a password hash — show password form instead of direct download. */
  passwordProtected: boolean;
  /** Validation error to display (e.g. "Incorrect password"). */
  error?: string;
}

export function downloadPage(props: DownloadPageProps): string {
  const { id, filename, expiresAt, passwordProtected, error } = props;
  const actionUrl = `/${esc(id)}/download`;

  const formContent = passwordProtected
    ? `
      <label for="password">Password</label>
      <input
        id="password"
        type="password"
        name="password"
        required
        autofocus
        placeholder="Enter password"
      />
      ${error ? `<p class="error">${esc(error)}</p>` : ''}
      <button type="submit">Download</button>`
    : `
      <button type="submit">Download</button>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${esc(filename)} — yeet</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: monospace;
      background: #fff;
      color: #000;
      display: flex;
      justify-content: center;
      align-items: center;
      min-height: 100vh;
      padding: 1rem;
    }
    .card {
      border: 2px solid #000;
      padding: 2rem;
      max-width: 400px;
      width: 100%;
    }
    h1 { font-size: 1rem; margin-bottom: 1.5rem; word-break: break-all; }
    .meta { font-size: 0.875rem; margin-bottom: 1.5rem; }
    .meta dt { font-weight: bold; }
    .meta dd { margin-bottom: 0.5rem; }
    form { display: flex; flex-direction: column; gap: 0.75rem; }
    label { font-size: 0.875rem; font-weight: bold; }
    input[type="password"] {
      border: 1px solid #000;
      padding: 0.5rem;
      font-family: monospace;
      font-size: 1rem;
      width: 100%;
    }
    button[type="submit"] {
      border: 2px solid #000;
      background: #000;
      color: #fff;
      padding: 0.5rem 1rem;
      font-family: monospace;
      font-size: 1rem;
      cursor: pointer;
    }
    button[type="submit"]:hover { background: #fff; color: #000; }
    .error { color: #000; font-size: 0.875rem; border-left: 3px solid #000; padding-left: 0.5rem; }
  </style>
</head>
<body>
  <div class="card">
    <h1>${esc(filename)}</h1>
    <dl class="meta">
      <dt>Expires</dt>
      <dd>${esc(formatExpiry(expiresAt))}</dd>
      ${passwordProtected ? '<dt>Protected</dt><dd>Password required</dd>' : ''}
    </dl>
    <form method="post" action="${actionUrl}">
      ${formContent}
    </form>
  </div>
</body>
</html>`;
}
