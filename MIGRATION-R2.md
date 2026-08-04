# Migrating yeet from Hetzner Storage Box to Cloudflare R2

Storage layout is unchanged: `uploads/<id>/<filename>` and `uploads/<id>/.meta.json`.
The CLI needs **no code changes** — only environment variables (see step 2).

---

## 1. Cloudflare (dashboard, manual)

1. **R2 → Create bucket**, name it `yeet`. Location hint: automatic (or EU).
2. Note the **account-scoped S3 endpoint**, shown on the bucket's settings page:

   ```
   https://<accountid>.r2.cloudflarestorage.com
   ```

   Use this account-scoped form (no bucket in the hostname) — rclone appends the bucket as a path segment.
3. **R2 → API → Manage API Tokens → Create API Token**
   - Permission: **Object Read & Write**
   - Scope: **specific bucket → `yeet`**
   - TTL: no expiry (or set a reminder to rotate)
4. Capture the **Access Key ID** and **Secret Access Key** shown once on creation. Store them in your password manager now — the secret is not retrievable later.

Do not enable a public r2.dev domain. All access goes through the server's presigned URLs.

---

## 2. Local machine (rclone + env)

### Create the rclone remote

```sh
rclone config create r2 s3 \
  provider=Cloudflare \
  endpoint=https://<accountid>.r2.cloudflarestorage.com \
  access_key_id=<ACCESS_KEY_ID> \
  secret_access_key=<SECRET_ACCESS_KEY> \
  region=auto \
  --non-interactive
```

`region=auto` is what R2 expects; no real region is needed. Verify by listing *inside* the bucket:

```sh
rclone ls r2:yeet
```

On a bucket that is still empty this prints nothing and exits 0 — that silence is the success
signal, since the request reached R2 and was authorised. Any credential or endpoint problem
surfaces here as an error instead.

Do **not** verify with `rclone lsd r2:` (no bucket). That calls `ListBuckets`, an account-level
operation which a bucket-scoped token cannot perform by design, so it returns
`403 AccessDenied` even when everything is configured correctly.

### Update environment variables

S3 remotes are **bucket-rooted**, so the bucket name becomes part of the path. The old SFTP
remote was rooted at the Storage Box home, so `hetzner:uploads` worked with the default
`YEET_UPLOADS_PATH`. On R2 you must set `YEET_UPLOADS_PATH` explicitly, otherwise the CLI
would look for a bucket literally named `uploads`.

In **`~/.zshrc`** (around line 107) replace:

```sh
export YEET_RCLONE_REMOTE=hetzner
```

with:

```sh
export YEET_RCLONE_REMOTE=r2
export YEET_UPLOADS_PATH=yeet/uploads
```

Leave `YEET_DOMAIN=https://dl.wannessalome.nl` as-is.

**Also update the Finder Quick Action helper** at `~/.config/yeet/finder-upload.zsh`. It does
not source `~/.zshrc` — it exports its own `YEET_*` vars (lines 8–10) and will keep writing to
Hetzner until you change it. Apply the same two-line change there.

Then `source ~/.zshrc` (or open a new shell).

---

## 3. One-time data migration

```sh
rclone copy hetzner:uploads r2:yeet/uploads --progress
```

No filtering needed — the server's cron job cleans up expired entries after the cutover.
Sanity check the counts match:

```sh
rclone lsjson hetzner:uploads --dirs-only | grep -c '"Path"'
rclone lsjson r2:yeet/uploads  --dirs-only | grep -c '"Path"'
```

---

## 4. Server deployment (Coolify)

**Remove** all `WEBDAV_*` environment variables.

**Add:**

| Variable | Value / notes |
| --- | --- |
| `R2_ENDPOINT` | `https://<accountid>.r2.cloudflarestorage.com` — account-scoped S3 endpoint, no bucket |
| `R2_ACCESS_KEY_ID` | From the R2 API token |
| `R2_SECRET_ACCESS_KEY` | From the R2 API token (mark as secret) |
| `R2_BUCKET` | `yeet` |
| `R2_UPLOADS_PREFIX` | `uploads` (default; key prefix inside the bucket) |
| `R2_PRESIGN_EXPIRY_SECONDS` | `3600` (default; lifetime of generated download URLs) |

Note `R2_BUCKET` and `R2_UPLOADS_PREFIX` are separate on the server, whereas the CLI joins them
into one path (`YEET_UPLOADS_PATH=yeet/uploads`). They must describe the same location.

Redeploy, then check the logs for startup errors. Missing env vars fail fast at boot, but
*invalid credentials do not* — nothing contacts R2 until the first request, so a pasted-wrong
secret still boots green. The download check in the verification list below is what actually
proves the credentials work.

---

## 5. Verification checklist

- [ ] `yeet upload ~/some-test-file.pdf --expires 1d` prints a `https://dl.wannessalome.nl/<id>/...` URL
- [ ] `rclone lsf r2:yeet/uploads/<id>` shows both the file and `.meta.json`
- [ ] Opening the link in a browser shows the download page
- [ ] Clicking download **redirects to `<accountid>.r2.cloudflarestorage.com`** (check devtools Network → 303), transfers at full speed, and supports range requests / resume
- [ ] `yeet list` shows the new upload alongside the migrated ones, with correct sizes and dates
- [ ] `yeet upload ~/some-test-file.pdf --password hunter2` — link prompts for the password, wrong password rejected, correct password downloads
- [ ] Finder Quick Action upload works (confirms `finder-upload.zsh` was updated)
- [ ] Clean up the test uploads:

  ```sh
  rclone purge r2:yeet/uploads/<id>
  ```

---

## 6. Rollback

Low-risk: nothing is destructive until you choose to make it so.

- **Server:** redeploy the previous build and restore the `WEBDAV_*` variables. The old
  WebDAV config still points at an intact Storage Box.
- **CLI:** revert the two lines in `~/.zshrc` and `~/.config/yeet/finder-upload.zsh`
  (`YEET_RCLONE_REMOTE=hetzner`, and remove `YEET_UPLOADS_PATH`).
- **Data:** the Hetzner Storage Box is never written to or deleted from by this migration —
  step 3 is a copy, not a move. Keep it until R2 has run clean for a few weeks, then delete
  it deliberately.

Caveat: uploads created *after* the cutover live only in R2. If you roll back after real use,
re-sync the delta with `rclone copy r2:yeet/uploads hetzner:uploads`.
