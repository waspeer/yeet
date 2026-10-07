# yeet

Share files from your terminal with a link that expires.

```console
$ yeet upload mixdown-v3.wav
https://dl.example.com/aB3x_Q/mixdown-v3.wav
```

The recipient opens the link, sees the file name, size and expiry date, and
clicks **Download**. Links expire after 30 days by default, can be protected
with a password, and expired files are deleted automatically.

yeet is self-hosted: files go to **your own** S3-compatible bucket (Cloudflare
R2 recommended) and are served through **your own** small download server. There
is no shared yeet service.

## How it works

yeet has two parts:

| Part                           | What it does                                                                                                                                                                                                                   |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **CLI** (`packages/cli`)       | Uploads the file plus a small `.meta.json` (name, size, expiry, optional password hash) to your bucket with [rclone](https://rclone.org), and prints the share link.                                                           |
| **Server** (`packages/server`) | Hosts the download page at your domain. On download it checks the password, then redirects the browser to a short-lived presigned URL so the bytes come straight from the bucket. A daily job (03:00) deletes expired uploads. |

Both read and write the same bucket, laid out as `<prefix>/<id>/<filename>` and
`<prefix>/<id>/.meta.json`.

## Requirements

- **Node.js 20+** for the CLI
- **[rclone](https://rclone.org/install/)** on the machine you upload from
- **An S3-compatible bucket.** Cloudflare R2 is what yeet is built and tested
  on; its egress is free, so downloads cost nothing. Other S3 providers (AWS,
  Hetzner Object Storage, MinIO, …) should work but are untested.
- **Somewhere to run the server** (a Docker container) behind HTTPS on a
  domain you control, e.g. `dl.example.com`

## Setup

### 1. Create a bucket and an API token

On Cloudflare R2:

1. **R2 → Create bucket**, e.g. `yeet`. Do not enable public access; all
   downloads go through the server's presigned URLs.
2. Note the account-scoped S3 endpoint: `https://<accountid>.r2.cloudflarestorage.com`.
3. **R2 → Manage API tokens → Create API token** with **Object Read & Write**,
   scoped to that one bucket. Save the access key ID and secret.

A bucket-scoped token cannot list buckets, so `rclone lsd r2:` returns
`403 AccessDenied` even when everything is fine. Always address the bucket
explicitly, as below.

### 2. Run the server

```sh
cp packages/server/.env.example packages/server/.env   # then fill it in
docker build -t yeet-server packages/server
docker run -d --name yeet --env-file packages/server/.env -p 3000:3000 yeet-server
```

Put it behind a reverse proxy with HTTPS (Caddy, Traefik, Coolify, …) and point
your domain at it. `GET /health` returns `{"status":"ok"}` for health checks.

| Variable                    | Required | Description                                                                               |
| --------------------------- | -------- | ----------------------------------------------------------------------------------------- |
| `R2_ENDPOINT`               | yes      | S3 endpoint without the bucket, e.g. `https://<accountid>.r2.cloudflarestorage.com`       |
| `R2_ACCESS_KEY_ID`          | yes      | Access key of the API token                                                               |
| `R2_SECRET_ACCESS_KEY`      | yes      | Secret of the API token                                                                   |
| `R2_BUCKET`                 | yes      | Bucket name, e.g. `yeet`                                                                  |
| `R2_UPLOADS_PREFIX`         | no       | Key prefix inside the bucket (default `uploads`)                                          |
| `R2_PRESIGN_EXPIRY_SECONDS` | no       | Lifetime of a generated download URL (default `3600`, never beyond the file's own expiry) |
| `R2_REGION`                 | no       | Signing region (default `auto`, correct for R2; set it for other providers)               |
| `PORT`                      | no       | Port to listen on (default `3000`)                                                        |
| `SENTRY_DSN`                | no       | Enables Sentry error reporting, including session replay on errors                        |

Missing variables stop the server at boot, but wrong credentials only show up
on the first download, so test one after deploying.

### 3. Install the CLI

```sh
npm install -g @waspeer/yeet
```

Or from source:

```sh
git clone https://github.com/waspeer/yeet.git
cd yeet
npm install
npm install -g ./packages/cli
```

### 4. Configure rclone and the CLI

Create an rclone remote for the bucket (here called `r2`):

```sh
rclone config create r2 s3 \
  provider=Cloudflare \
  endpoint=https://<accountid>.r2.cloudflarestorage.com \
  access_key_id=<ACCESS_KEY_ID> \
  secret_access_key=<SECRET_ACCESS_KEY> \
  region=auto \
  --non-interactive

rclone ls r2:yeet   # prints nothing on an empty bucket, and exits 0
```

## Configuration

The CLI is configured with environment variables, e.g. in `~/.zshrc` or `~/.bashrc`:

```sh
export YEET_RCLONE_REMOTE=r2                    # the rclone remote from step 4
export YEET_UPLOADS_PATH=yeet/uploads           # <bucket>/<R2_UPLOADS_PREFIX>
export YEET_DOMAIN=https://dl.example.com       # where your server runs
# export YEET_DEFAULT_EXPIRES=30d               # optional, default 30d
```

| Variable               | Required | Description                                                                                     |
| ---------------------- | -------- | ----------------------------------------------------------------------------------------------- |
| `YEET_RCLONE_REMOTE`   | yes      | Name of the rclone remote (see `rclone listremotes`)                                            |
| `YEET_UPLOADS_PATH`    | yes      | Bucket plus prefix on that remote. Must match the server's `R2_BUCKET` and `R2_UPLOADS_PREFIX`. |
| `YEET_DOMAIN`          | yes      | Public base URL of your server, used to build the share links                                   |
| `YEET_DEFAULT_EXPIRES` | no       | Default link lifetime as `<n>d`, `<n>h` or `<n>m` (default `30d`)                               |

There are deliberately no defaults for the first three: a wrong guess would
upload to the wrong place or print links that don't work. If anything is
missing, yeet tells you which variable and what it should look like.

## Usage

```sh
yeet upload song.wav                         # link valid for 30 days
yeet upload stems.zip --expires 7d           # or 24h, 90m
yeet upload demo.mp3 --password hunter2      # recipient needs the password
yeet list                                    # all uploads, newest first
yeet list --downloads                        # include recent download times
```

`yeet upload` prints only the link on stdout (progress goes to stderr), so it
pipes cleanly, e.g. `yeet upload song.wav | pbcopy` on macOS.

To delete an upload before it expires:

```sh
rclone purge r2:yeet/uploads/<id>
```

## Security notes

- Passwords are hashed with Argon2id; only the hash is stored in the bucket.
- A presigned download URL is a bearer token: until it expires (at most
  `R2_PRESIGN_EXPIRY_SECONDS`), anyone who has it can download without the
  password.
- Anyone with the share link can see the file name and size, even for
  password-protected uploads.
- Upload IDs are 6 random base64url characters, which makes links hard to
  guess but not impossible. Use a password for anything sensitive.

## Development

```sh
npm install
npm run build -w packages/cli
npm run build -w packages/server
npm run lint && npm run fmt:check
```

## License

[MIT](LICENSE)
