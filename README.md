# yeet

Share files from your terminal with a link that expires.

```console
$ yeet upload mixdown-v3.wav
https://yeet.example.workers.dev/aB3x_Q/mixdown-v3.wav
```

The recipient opens the link, sees the file name, size and expiry date, and
clicks **Download**. Links expire after 30 days by default, can be protected
with a password, and expired files are deleted automatically.

yeet is self-hosted on your own Cloudflare account. It runs on the free plan:
Workers and R2 storage are free up to 10 GB stored and 100,000 requests a day,
and downloads cost nothing at any volume.

## Setup

You need a free [Cloudflare account](https://dash.cloudflare.com/sign-up) and
[Node.js](https://nodejs.org) 20 or newer. It takes about five minutes.

### 1. Deploy your server

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/waspeer/yeet/tree/main/packages/worker)

Click the button and follow the steps. Cloudflare creates the Worker and an R2
bucket for your files. When it asks for **`UPLOAD_TOKEN`**, enter a long random
secret. This is the password the CLI uses to upload, so keep it somewhere safe.
To generate one:

```sh
openssl rand -base64 32
```

When it is done, note your Worker's URL, e.g. `https://yeet.<you>.workers.dev`.

> If Cloudflare asks you to enable R2 first, do that in the dashboard
> (**R2 Object Storage**). The free tier may still ask for a payment method.

### 2. Install the CLI

```sh
npm install -g @waspeer/yeet
```

### 3. Log in

```sh
yeet login https://yeet.<you>.workers.dev
```

Paste your upload token when asked. That's it:

```sh
yeet upload song.wav
```

## Usage

```sh
yeet upload song.wav                         # link valid for 30 days
yeet upload stems.zip --expires 7d           # or 24h, 90m
yeet upload demo.mp3 --password hunter2      # recipient needs the password
yeet upload *.wav                            # one link per file
yeet list                                    # all uploads, newest first
yeet list --downloads                        # include recent download times
yeet delete <link or id>                     # remove before it expires
```

`yeet upload` prints only the links on stdout (progress goes to stderr), so it
pipes cleanly, e.g. `yeet upload song.wav | pbcopy` on macOS.

Large files are uploaded in 50 MB parts, three at a time, and failed parts are
retried. Files can be up to about 500 GB.

## Configuration

`yeet login` saves the server URL and token in `~/.config/yeet/config.json`
(readable only by you). Environment variables override it, which is handy for
scripts:

| Variable               | Description                                                       |
| ---------------------- | ----------------------------------------------------------------- |
| `YEET_URL`             | Server URL                                                        |
| `YEET_TOKEN`           | Upload token                                                      |
| `YEET_DEFAULT_EXPIRES` | Default link lifetime as `<n>d`, `<n>h` or `<n>m` (default `30d`) |

The default lifetime can also be set as `"defaultExpires": "7d"` in the config
file.

### Server settings

Set these in the Cloudflare dashboard under **Workers → yeet → Settings →
Variables and secrets**. Only `UPLOAD_TOKEN` is required; the others have
defaults in the code, so `wrangler.jsonc` lists no vars (vars listed there would
overwrite your dashboard values on every deploy).

| Name               | Type   | Description                                                                                                                                |
| ------------------ | ------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `UPLOAD_TOKEN`     | secret | At least 16 characters. Used by the CLI and to log in at `/upload`. Changing it logs out every browser and invalidates open download links |
| `UPLOADS_PREFIX`   | var    | Key prefix inside the bucket (default `uploads`)                                                                                           |
| `DOWNLOAD_URL_TTL` | var    | Lifetime of a download link after the password check, in seconds (default `3600`)                                                          |
| `SENTRY_DSN`       | secret | Optional. Enables Sentry error reporting, including session replay on errors. Without it, no Sentry code runs                              |

### Your own domain

To share links like `https://dl.example.com/...`, add a custom domain in the
dashboard under **Workers → yeet → Settings → Domains & Routes**. The domain
must be managed by Cloudflare. Then run `yeet login https://dl.example.com`.

## How it works

| Part                           | What it does                                                                                                                                                     |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **CLI** (`packages/cli`)       | Sends the file to your Worker in parts and prints the share link. No dependencies.                                                                               |
| **Worker** (`packages/worker`) | Stores files in R2, serves the download page, checks passwords, and streams the file with support for resuming. A daily job (03:00 UTC) deletes expired uploads. |

Files live in the bucket as `uploads/<id>/<filename>`, next to a small
`uploads/<id>/.meta.json` with the name, size, expiry and password hash.

## Security notes

- Uploading, listing and deleting require the upload token. Anyone with a
  share link can download, unless it has a password.
- In the browser, `/upload` asks for the token once and keeps you logged in
  with a signed, HttpOnly cookie for 90 days. The token itself never reaches
  the page. Changing `UPLOAD_TOKEN` logs out every browser.
- Wrong tokens and wrong download passwords are rate limited per client
  (5 per minute for logins and per file for passwords, 20 per minute for the
  CLI's token), counted in a Durable Object.
- After a correct password, the browser gets a cookie for that file for up to
  24 hours, so it is not asked again.
- Passwords are hashed with PBKDF2-SHA256 (20,000 iterations), which fits the
  free plan's CPU budget. The hash is stored in your private bucket.
- After the password check, the browser gets a signed download link that works
  without the password until it expires (at most `DOWNLOAD_URL_TTL`).
- Anyone with the share link can see the file name and size, even for
  password-protected uploads.
- Upload IDs are 6 random characters, which makes links hard to guess but not
  impossible. Use a password for anything sensitive.

## Development

```sh
# Worker, with a local simulated R2 bucket
cd packages/worker
npm install
cp .dev.vars.example .dev.vars    # set UPLOAD_TOKEN
npm run dev                        # http://localhost:8787

# CLI, against the local Worker
cd packages/cli
npm install
npm run build
node dist/index.js login http://localhost:8787
```

Deploy manually with `npm run deploy` in `packages/worker` (after
`npx wrangler login`). Lint and format from the repository root with
`npm install && npm run lint && npm run fmt:check`.

## License

[MIT](LICENSE)
