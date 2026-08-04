---
name: timds-edit-design-system
description: Edit repository-owned TimDS design systems in either a standalone design-system repository or an embedded root design-system/ directory. Use for changing design tokens, documentation, components, navigation, imagery, fonts, static viewer source, or externally stored full-resolution media; previewing and validating the exact generated artifact locally; or preparing and submitting a guarded GitHub pull request for a designer-authored change.
---

# Edit a TimDS Design System

Keep Git as the editable source of truth and TimDS as the reviewed publication surface. Work only in the client repository supplied by the user.

## Resolve the contract

1. Read the repository's root instructions completely.
2. Locate the contract:
   - Standalone: `timds.json` is at repository root and the CLI is `node .timds/cli/bin/timds.mjs`.
   - Embedded: `timds.json` is under root `design-system/` and the CLI is `node design-system/.timds/cli/bin/timds.mjs`.
3. Read the applicable `AGENTS.md`, `timds.json`, and relevant source files completely.
4. Run `git status --short` and preserve all pre-existing work.
5. Run `<cli> doctor` from repository root.
6. Treat `.timds/`, `.agents/skills/timds-edit-design-system/`, `.github/workflows/timds-design-system.yml`, and workspace commands in `timds.json` as protected tooling. Change them only when the user asks to update TimDS itself.

## Upgrade protected tooling only when requested

1. Use the exact toolkit version selected by the user or DT Concepts operator; do not silently choose `latest`.
2. Run `npx --yes @dtconcepts/timds@VERSION upgrade --root .` from the repository root.
3. Do not use `--force` unless the user explicitly authorizes replacing locally modified managed tooling.
4. Review the resulting `.timds/` and `.agents/skills/timds-edit-design-system/` diff. The upgrade must not change authored Design System files.
5. Run the vendored `<cli> doctor` and `<cli> check`, then submit the tooling update through normal review when requested.

## Make the change

1. Create or use a non-default `design-system/<change>` branch.
2. Edit authored tokens, source, documentation, components, navigation, and lightweight assets.
3. In a standalone repository, the entire tracked repository is the Design System scope. In an embedded repository, remain under `design-system/**` unless the user explicitly expands the task.
4. Preserve the repository's framework and visual language unless the user explicitly requests a migration or redesign.
5. Never hand-edit `dist/`. Generate it with the manifest's `workspace.build` command.
6. Keep generated `dist/` out of source pull requests when `artifact.publishRef` declares a CI publication branch.
7. Use genuine licensed assets. Never invent client logos, customer marks, or usage rights.

## Handle large media outside Git

1. Keep only optimized viewer files within static artifact limits. Never commit full-resolution images, video masters, B-roll, or source audio to Git or `dist/`.
2. Confirm actual rights from the user or supplied metadata. Do not infer rights.
3. Upload an original with:

```bash
TIMDS_ACCESS_TOKEN=... <cli> assets add /path/to/file \
  --rights client-owned \
  --visibility private \
  --title "Descriptive title" \
  --tags b-roll,campaign
```

4. Use `private` for masters and production inputs. Use `public` only when the original is intentionally public and has known usage rights.
5. Commit the resulting `media.json` record. Never commit credentials, storage keys, cache files, or expiring signed URLs.
6. Retrieve a private original with `<cli> assets pull ASSET_ID`; the default cache is ignored by Git.

## Verify locally

Run:

```bash
<cli> check
<cli> preview
<cli> diff
```

Inspect the exact generated artifact and the framework development server. Check relevant views at desktop and mobile sizes, including navigation, local assets, typography, contrast, overflow, focus states, and the requested change.

## Submit only when requested

When the user asks to push, submit, or open a pull request, run:

```bash
<cli> submit --message "Concise change summary"
```

The command validates and rebuilds, checks the appropriate standalone or embedded scope, creates a review branch when needed, pushes it, and opens a draft pull request.

Do not merge, publish, deploy, upgrade protected tooling, or roll back unless the user explicitly authorizes that separate action. In a repository with `artifact.publishRef`, merging to the default branch may automatically publish the viewer artifact, but it does not update a consuming website's pinned submodule commit.

## Report the result

Lead with what changed. Include the affected Design System version, validation result, preview coverage, branch or pull-request link, and any remaining publication or consuming-site update.
