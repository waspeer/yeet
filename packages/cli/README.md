# @waspeer/yeet

Command-line client for [yeet](https://github.com/waspeer/yeet): share files
with expiring, optionally password-protected download links, stored in your own
S3-compatible bucket and served by your own yeet server.

```sh
npm install -g @waspeer/yeet
yeet upload song.wav --expires 7d
```

yeet needs [rclone](https://rclone.org), a bucket, and a running yeet server.
See the [main README](https://github.com/waspeer/yeet#readme) for setup and
configuration.
