# Design System Agent Contract

__CONTRACT_DESCRIPTION__ Read `timds.json`, this file, and the relevant source before editing.

## Source and artifact boundary

- Edit authored tokens, source, documentation, components, and lightweight viewer assets.
- Preserve the existing framework unless the task explicitly requests a migration.
- Generate `dist/` with the `workspace.build` command declared in `timds.json`.
- Never hand-edit `dist/`; TimDS serves it as the exact static viewer artifact.
- Keep `dist/` out of source pull requests when CI publishes the artifact separately.
- Keep builds deterministic. Do not inject build timestamps, machine paths, or random identifiers into `dist/`.
- Do not add symbolic links inside `dist/`.

## Media boundary

- Never commit full-resolution images, video masters, B-roll, source audio, or other large originals to Git or `dist/`.
- This phase supports public assets only. Put originals under ignored `media-local/` and register them with `npm run timds -- assets add FILE --key LOGICAL_KEY`.
- Use logical keys in viewer source. Local development resolves them from `.timds/local-media.json`; production builds resolve them from committed `media.json` public URLs.
- Run `npm run timds -- auth login` once, then `npm run timds -- assets publish`. `submit` also publishes changed staged files before validation.
- TimDS measures video and audio metadata with `ffprobe` during `assets add`; use `npm run timds -- assets backfill-metadata` to repair older records from stable public URLs without re-uploading them.
- Keep only the returned stable record in `media.json`. Never place access tokens, R2 credentials, object keys, expiring signed URLs, `.timds/local-media.json`, or raw `media-local/` files in Git.
- Use `npm run timds -- assets pull KEY` to restore a published original into the ignored local workspace.
- Small optimized images, icons, and fonts required to render the viewer may remain in `dist/` within the artifact limits.

## Local workflow

Run commands from the repository root:

```bash
__TIMDS_CLI__ doctor
__TIMDS_CLI__ dev
__TIMDS_CLI__ check
__TIMDS_CLI__ preview
__TIMDS_CLI__ diff
```

Use `dev` for the authoring server and `preview` to inspect the exact built artifact. Check relevant views at desktop and mobile sizes before submission.

## Optional video contract

When `timds.json` declares `video`, this Design System also owns the client's
video contract, logical video asset catalog, and five JSON records for each
production. Read those declared files and use the managed
`timds-create-video` skill. TimDS supplies the complete default Remotion
component set. `npm run timds -- video components init` may copy those exact
installed defaults into one reviewed module at `video.components`. The copy is
authored client source and may diverge; toolkit upgrades must never overwrite
it. A Design System may also declare a hand-authored partial override module.
Either form may replace client-facing visual compositions but not engine or
rendering behavior. Do not add a Remotion
engine, rendering scripts, client-specific agent skill, producer/compiler
implementation, or per-topic TSX entry here; those are provided by the
selected `@dtconcepts/timds` release. If the client enables programmatic
production, keep its role labels, CTA templates, and asset-key vocabulary in
the contract's `producer` block.

Keep generated audio, prepared media, generated entries, renders, thumbnails,
and review packages under ignored `video-local/`. Validate committed records
with `npm run timds -- video check` and use `video studio` or `video render`
only for an explicitly selected production.

Regenerating components with `video components init --force` discards client
changes and requires explicit authorization. A normal `timds upgrade` does not
touch the declared component module.

## Git and publication

- Use a `design-system/<change>` branch and a pull request.
- Keep unrelated repository files out of the design-system commit.
- Record day-to-day changes under `## Unreleased`; standalone CI rolls them
  into a synchronized patch version after merge.
- `npm run timds -- submit` may create a branch, commit, push, and draft pull request only when the user asks.
- In a standalone repository with managed automatic releases, merging is the
  publication decision: every accepted `main` change becomes a patch release.
- Only a DT Concepts operator may approve that merge or roll back a TimDS
  version.
- When `timds.json.consumer` is present, publish the exact synchronized Design
  System commit before advancing the consumer's submodule. The automation opens
  a consumer pull request; it never merges or deploys the consumer.

## Protected tooling

Treat the approved `@dtconcepts/timds` release line and resolved lockfile,
`.timds/installation.json`, the repository-local AI skills, `timds.json`
workspace commands, and `.github/workflows/timds-design-system.yml` as
execution policy. Do not change them during ordinary design work.

When a DT Concepts operator selects a toolkit release line, keep the package
requirement at `0.1.x`, update the resolved lockfile, and then synchronize the
managed skill and installation record:

```bash
npm update @dtconcepts/timds
npm run timds -- upgrade --root .
```

Do not choose an unbounded `latest` or use `--force` without explicit
authorization. The upgrade removes a legacy `.timds/cli` copy when present;
the CLI itself comes from `node_modules`. Review and commit the tooling diff
separately from ordinary design changes.
