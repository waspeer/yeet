# Changelog

All notable changes to the `@waspeer/yeet` command-line client.

## 0.3.0 (unreleased)

### Behaviour change: several files give one link

`yeet upload a.wav b.wav` now uploads **one zip** (`yeet-<YYYYMMDD-HHMMSS>.zip`)
and prints **one link**. Before 0.3.0 it uploaded each file on its own and
printed one link per file.

- Scripts that read one URL per file from stdout get a single URL now. To
  keep one link per file, call `yeet upload` once per file, e.g.
  `for f in *.wav; do yeet upload "$f"; done`.
- A macOS Finder Quick Action (or any other wrapper) that passes all selected
  files to a single `yeet upload` now gets one zip link for the selection.
  Run it once per file to keep the old behaviour.
- One file is still uploaded as it is, without a zip.

### New: zips of several files or a folder

- `yeet upload <folder>` uploads `<folder>.zip`, with the folder as its single
  top-level folder; `yeet upload <file1> <file2> …` uploads
  `yeet-<YYYYMMDD-HHMMSS>.zip`.
- The zip is made while it uploads. Already-compressed files (audio, video,
  photos, archives) are stored, the rest is compressed; `--store` compresses
  nothing (faster for media).
- `.DS_Store` is left out, empty folders are kept, symbolic links to folders,
  links to nothing and link loops are skipped with a note, and names are made
  safe for Windows (`:` becomes `_`, with a note). Two names that would clash
  in the zip (ignoring case) are an error naming both.
- No size cap: a compressed zip that could come out larger than about 7.8 GB
  (the most the server accepts without knowing the size up front) is written
  to a temporary file in `$TMPDIR` first, then uploaded. It needs free disk
  space for about the size of the files plus 256 MB (checked first; the message suggests `--store` when it is
  short), and the file is always deleted: on success, on an error, on Ctrl-C,
  SIGTERM or SIGHUP. `--store` never needs a temporary file.
- If anything goes wrong part-way (a file that cannot be read or changes while
  it is read, a network failure, Ctrl-C), the upload is deleted and never
  completed: a link never points to half a zip.
- Ctrl-C cancels and deletes the upload (exit 130); a second Ctrl-C, or a
  Ctrl-C after any other failure, quits at once. SIGTERM (exit 143) and SIGHUP
  (exit 129) cancel the same way.

### Other changes since 0.2.0

- `yeet list` fetches every page of a large listing, keeps what it fetched
  when a later page fails, and says when only part of the uploads is shown.
- `yeet delete` finishes deleting an upload the server deletes in several
  requests.
- Retries honour the server's Retry-After, and messages say when to try again.
- `yeet login` words a wrong token and rate limiting for login.
- `--expires` is at most 365 days.

## 0.2.0 and earlier

See the git history.
