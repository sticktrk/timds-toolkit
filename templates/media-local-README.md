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
