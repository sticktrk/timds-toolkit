# Local media workspace

Drop full-resolution images, video, audio, and other large public assets here.
Everything in this directory except this README is ignored by Git.

Register a file with a stable logical key (the path is read from the
repository root):

```bash
__TIMDS_CLI__ assets add __MEDIA_LOCAL__example.mp4 --key example-video
```

Staging records the file in `.timds/local-media.json`. The starter viewer
does not read this directory: `{{media:KEY}}` resolves to a small optimized
copy under `src/assets/`, and only a framework viewer that serves staged
files with `localMediaResponse` shows the original locally. `assets publish`
or `submit` uploads it to TimDS storage and writes only its public CDN record
to the media catalog.

Staging remembers the catalog checksum. If publication reports a conflict,
remove the stale entry from `.timds/local-media.json` to keep the published
record, or restore it with `__TIMDS_CLI__ assets pull KEY --force`. Restage
with `assets add FILE --key KEY` only after reviewing an intentional replacement.
Do not replace an optimized derivative with an old original to clear a conflict.
An asset ID already registered under another key cannot silently rename or
remove that key.
