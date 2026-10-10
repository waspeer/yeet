# @waspeer/yeet

Command-line client for [yeet](https://github.com/waspeer/yeet): share files
from your terminal with expiring, optionally password-protected download links,
served by your own Cloudflare Worker.

```sh
npm install -g @waspeer/yeet
yeet login https://yeet.<you>.workers.dev
yeet upload song.wav --expires 7d
yeet upload stems/                # a folder (or several files) as one zip, zipped while it uploads
```

Run `yeet --help` for every command and option.

You need your own yeet server first; deploying one is a single click. See the
[main README](https://github.com/waspeer/yeet#readme).
