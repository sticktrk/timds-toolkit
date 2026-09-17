# Local media workspace

Drop full-resolution images, video, audio, and other large public assets here.
Everything in this directory except this README is ignored by Git.

Register a file with a stable logical key:

```bash
npm run timds -- assets add media-local/example.mp4 --key example-video
```

The local viewer uses this ignored file during development. `assets publish`
or `submit` uploads it to TimDS storage and writes only its public CDN record
to `media.json`.

Staging remembers the catalog checksum. If publication reports a conflict,
remove the stale entry from `.timds/local-media.json` to keep the published
record, or restore it with `npm run timds -- assets pull KEY --force`. Restage
with `assets add FILE --key KEY` only after reviewing an intentional replacement.
Do not replace an optimized derivative with an old original to clear a conflict.
An asset ID already registered under another key cannot silently rename or
remove that key.
