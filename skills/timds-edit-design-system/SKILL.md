---
name: timds-edit-design-system
description: Edit repository-owned TimDS design systems in either a standalone design-system repository or an embedded root design-system/ directory. Use for getting a client design system running locally; changing tokens, documentation, components, navigation, imagery, fonts, or viewer source; adding externally stored full-resolution media; previewing the generated artifact; or preparing a guarded pull request for designer approval.
---

# Edit a TimDS Design System

Keep Git as the editable source of truth and TimDS as the reviewed publication
surface. Work only in the client repository supplied by the user.

## Resolve and start the workspace

1. Read the repository's root instructions completely.
2. Locate `timds.json`: it is at repository root for a standalone Design System
   and under root `design-system/` for an embedded system.
3. Read the applicable `AGENTS.md`, `README.md`, `timds.json`, and relevant
   authored source completely.
4. Run `git status --short` and preserve all pre-existing work.
5. Install the pinned lockfile with `npm ci` from repository root.
6. Run `npm run timds -- doctor`, then `npm run timds -- dev` to open the
   repository-declared authoring server.
7. Treat the approved `@dtconcepts/timds` release line and resolved lockfile,
   `.timds/installation.json`, `.agents/skills/timds-edit-design-system/`,
   `timds.json` workspace commands, and `.github/workflows/timds-design-system.yml`
   as protected tooling. Change them only when the user asks to update TimDS.

## Upgrade protected tooling only when requested

1. Use the bounded release line selected by the user or DT Concepts operator.
   For the current package use `0.1.x`; never select unbounded `latest`.
2. From repository root run:

```bash
npm install --save-dev @dtconcepts/timds@0.1.x
npm run timds -- upgrade --root .
```

3. Never use `--force` without explicit authorization to replace locally
   modified managed tooling.
4. Confirm the upgrade changed only the package manifest and lockfile, local AI
   skill, installation record, workflow when intentionally updated, and removal
   of any legacy `.timds/cli` tree.
5. Run `npm run timds -- doctor` and `npm run timds -- check`. Submit the
   tooling update separately from ordinary design work.

## Make the design change

1. Create or use a non-default `design-system/<change>` branch.
2. Edit authored tokens, source, documentation, components, navigation, and
   lightweight assets. Follow client-specific repository instructions.
3. In a standalone repository the tracked repository is the Design System
   scope. In an embedded repository stay under `design-system/**` unless the
   user explicitly expands the task.
4. Preserve the repository's framework and visual language unless the user asks
   for a migration or redesign.
5. Never hand-edit `dist/`; generate it using the commands in `timds.json`.
6. Keep `dist/` out of source pull requests when `artifact.publishRef` declares
   a separate CI publication branch.
7. Use genuine licensed assets. Never invent client marks or usage rights.

## Handle large media outside Git

Never commit full-resolution images, video masters, B-roll, source audio, or
other large originals to Git or `dist/`. Confirm actual rights, then upload:

```bash
TIMDS_ACCESS_TOKEN=... npm run timds -- assets add /path/to/file \
  --rights client-owned \
  --visibility private \
  --title "Descriptive title" \
  --tags b-roll,campaign
```

Use `private` for masters and production inputs. Use `public` only when known
rights allow intentional stable public delivery. Commit the resulting
`media.json` record. Never commit credentials, object keys, cache files, or
expiring signed URLs. Retrieve a private original into the ignored cache with:

```bash
TIMDS_ACCESS_TOKEN=... npm run timds -- assets pull ASSET_ID
```

## Verify locally

Run:

```bash
npm run timds -- check
npm run timds -- preview
npm run timds -- diff
```

Inspect both the framework authoring server and the exact generated artifact.
Check relevant desktop and mobile views, navigation, local assets, typography,
contrast, overflow, focus states, and the requested change.

## Submit only when requested

When asked to push or open a pull request, run:

```bash
npm run timds -- submit --message "Concise change summary"
```

The command validates and rebuilds, checks the standalone or embedded scope,
creates a review branch when needed, pushes it, and opens a draft pull request
against the default branch. Do not merge, publish, deploy, upgrade tooling, or
roll back without separate authorization.

## Report the result

Lead with what changed. Include the Design System version, validation and
preview coverage, branch or pull-request link, and any remaining publication or
consuming-site update.
