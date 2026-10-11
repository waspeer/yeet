# Getting started

> **Draft (phase 1).** This is the acceptance spec for the browser flow: every
> step below must work exactly as written. Screenshots, a troubleshooting
> section and the Mac Finder action are added in later phases.

With yeet you share files through a link that expires. It runs on your own free
Cloudflare account. Nobody else can see your files, and it costs nothing for
normal use (up to 10 GB stored).

You need:

- a computer with a web browser
- an email address, for a free Cloudflare account and a free GitHub account
- about 15 minutes

## Step 1: choose your upload password

yeet calls this the **upload token**. Anyone who knows it can upload files to
your yeet and delete them, so treat it like a password.

- Use **at least 16 characters**. A good choice is four or five random words,
  e.g. `velvet tractor ocean pickle`.
- Save it in your password manager, or write it down somewhere safe. You type
  it once in step 3 and once in every new browser you use.

## Step 2: deploy your yeet server

1. Click this button:

   [![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/waspeer/yeet/tree/main/packages/worker)

2. Sign up for, or log in to, Cloudflare. If asked, connect your GitHub account
   (sign up for free if you don't have one). Cloudflare makes a copy of yeet in
   your GitHub account. This copy is public unless you tick **Create private
   Git repository**. Either is fine, because your files and token are never
   stored in it.
3. Check the setup page:
   - **Project name:** keep `yeet` (or choose another name).
   - **Select R2 bucket:** this is where your files are stored. Keep the
     suggested new bucket. If you already have a bucket with the same name,
     pick a new name, because yeet would otherwise use your existing bucket.
   - **UPLOAD_TOKEN:** paste the upload token from step 1.
   - Leave everything else as it is.
4. Click **Deploy** and wait until it says the build is done (about a minute).
5. **Find your yeet address:** open your Worker in the Cloudflare dashboard and
   go to the **Domains** tab. Your address looks like
   `https://yeet.<something>.workers.dev`. Save it with your token.

> If Cloudflare asks you to enable R2 first, do that under **R2 Object
> Storage** in the dashboard. It is free, but Cloudflare may ask for a payment
> method.

## Step 3: upload your first file

1. Open your yeet address from step 2 (`https://yeet.<something>.workers.dev`)
   in your browser. You see a page that says **This is your yeet**, with
   your address on it (click **Copy address** to keep it somewhere).
   Click **Upload files**. This opens your upload page, `/upload`;
   bookmark it.
2. Paste your upload token and click **Log in**. This browser stays logged in
   for 90 days.
3. Choose how long the link works under **Link works for** (30 days unless
   you change it, at most 1 year). If you want, type a **Password**: people
   then need it to download the file, so send it to them too (best not in
   the same message as the link).
4. Drag a file, several files or a folder onto the page, or click
   **Choose files** or **Choose folder** (on an iPhone: tap **Choose
   files**; you can pick several files there). Several files or a folder
   become one zip file: a folder is called `<folder name>.zip`, loose
   files `yeet-<date>-<time>.zip`. If the selection is more than about
   5.2 GB, the page first says it will upload it without compressing it,
   and you choose **Upload anyway** or **Choose again**.
5. Wait until the upload finishes. Keep the page open meanwhile; on a
   phone, keep the screen on. If the page says the browser lost access to
   the file (this happens on an iPhone when the screen locks or you
   switch apps), click **Choose the file again** (for several files or a
   folder: **Choose the files again**, **Choose the folder again**; on an
   iPhone: tap it) and pick the same again. This works only while the
   page still shows that message; if the browser has reloaded the page
   in the meantime, start the upload again. A single file continues
   where it stopped. Several files or a folder continue where they
   stopped if they were uploaded uncompressed; a compressed zip starts
   over from the beginning (the page tells you which).
6. Click **Copy link**. The page shows how long the link works and whether
   it needs a password.
7. Send the link to whoever needs the file. When the time is up, the file
   is deleted automatically.

## Changing your upload token

In the Cloudflare dashboard, go to your Worker, then **Settings → Variables and
secrets**, and edit `UPLOAD_TOKEN`. This immediately logs out every browser,
so you log in again with the new token. Links you already shared keep working.
People downloading a password-protected file just enter its password again.

<!--
Acceptance checks for the coordinator (remove when the guide is final):
- The token field on the Deploy page has no help text, so step 1 must come before step 2.
- The vars UPLOADS_PREFIX and DOWNLOAD_URL_TTL must no longer appear on the Deploy page (1A removes them).
- / must show the welcome page with the address and an Upload files link to /upload.
- /upload must show a login form, accept the token, and then show the drop zone.
- The 90-day session and logout on token change are covered by e2e tests.
-->
