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
- Register large media with `timds assets add FILE --rights STATUS --visibility private|public`.
- Keep only the returned stable record in `media.json`. Never place access tokens, R2 credentials, object keys, or expiring signed URLs in repository files.
- Use `timds assets pull ASSET_ID` when a private original is needed locally. The default destination is `.timds/cache/media/`, which is ignored by Git.
- Record real rights, attribution, and expiration information. Never guess usage rights. Public media requires known rights.
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

## Git and publication

- Use a `design-system/<change>` branch and a pull request.
- Keep unrelated repository files out of the design-system commit.
- Update `CHANGELOG.md` and `timds.json.version` when preparing a published version.
- `timds submit` may create a branch, commit, push, and draft pull request only when the user asks.
- Merging a pull request does not itself authorize live publication.
- Only a DT Concepts operator may promote or roll back a TimDS version.

## Protected tooling

Treat `.timds/`, `timds.json` workspace commands, and `.github/workflows/timds-design-system.yml` as execution policy. Do not change them during ordinary design work.

When a DT Concepts operator selects a toolkit release, upgrade only the managed
CLI and skill from the repository root:

```bash
npx --yes @dtconcepts/timds@VERSION upgrade --root .
```

Do not choose `latest` automatically or use `--force` without explicit
authorization. Review and commit the managed-tooling diff separately from
ordinary design changes.
