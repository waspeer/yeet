# @waspeer/yeet

Command-line client for [yeet](https://github.com/waspeer/yeet): share files
from your terminal with expiring, optionally password-protected download links,
served by your own Cloudflare Worker.

```sh
npm install -g @waspeer/yeet
yeet login https://yeet.<you>.workers.dev
yeet upload song.wav --expires 7d
yeet upload stems/                # a folder as one zip: one link
yeet upload a.wav b.wav           # several files as one zip: one link (since 0.3.0)
yeet upload footage/ --store      # zip without compressing (faster for media)
```

One file is uploaded as it is. Several files, or a folder, become one zip
with one link, made while it uploads. A compressed zip that could come out
larger than about 7.8 GB is written to a temporary file first (in `$TMPDIR`,
so it needs that much free disk space; it is always deleted afterwards).
`--store` never needs one. Ctrl-C during a zip upload deletes what was
uploaded; a second Ctrl-C quits at once.

Run `yeet --help` for every command and option, and see the
[changelog](CHANGELOG.md) for what changed between versions.

You need your own yeet server first; deploying one is a single click. See the
[main README](https://github.com/waspeer/yeet#readme).
