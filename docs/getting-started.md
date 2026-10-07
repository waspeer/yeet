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

1. Open `https://yeet.<something>.workers.dev/upload` (your address from step 2,
   followed by `/upload`). Bookmark it.
2. Paste your upload token and click **Log in**. This browser stays logged in
   for 90 days.
3. Drag a file onto the page, or click **Choose file**.
4. Wait until the upload finishes, then click **Copy link**.
5. Send the link to whoever needs the file. It works for 30 days, then the
   file is deleted automatically.

## Changing your upload token

In the Cloudflare dashboard, go to your Worker, then **Settings → Variables and
secrets**, and edit `UPLOAD_TOKEN`. This immediately logs out every browser,
so you log in again with the new token. Links you already shared keep working.
People downloading a password-protected file just enter its password again.

<!--
Acceptance checks for the coordinator (remove when the guide is final):
- The token field on the Deploy page has no help text, so step 1 must come before step 2.
- The vars UPLOADS_PREFIX and DOWNLOAD_URL_TTL must no longer appear on the Deploy page (1A removes them).
- /upload must show a login form, accept the token, and then show the drop zone.
- The 90-day session and logout on token change are covered by e2e tests.
-->
