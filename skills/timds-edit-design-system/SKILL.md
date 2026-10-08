---
name: timds-edit-design-system
description: Edit repository-owned TimDS design systems in either a standalone design-system repository or an embedded root design-system/ directory. Use for getting a client design system running locally; turning a freshly scaffolded starter into the client's system; changing tokens, documentation, components, navigation, imagery, fonts, or viewer source; adding externally stored full-resolution media; previewing the generated artifact; or preparing a guarded pull request for designer approval.
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
5. Install the pinned lockfile with `npm ci` from repository root. A fresh
   scaffold has no lockfile yet: run `npm install` once and include the
   lockfile it writes in the first commit.
6. Run `npm run timds -- doctor`, then `npm run timds -- check` and
   `npm run timds -- brand` to see what the system already provides and every
   brand-kit gap with its fix. Run `npm run timds -- dev` to open the
   repository-declared authoring server.
7. Treat the approved `@dtconcepts/timds` release line and resolved lockfile,
   `.timds/installation.json`, the managed skills under `.agents/skills/`,
   the TimDS workflows under `.github/workflows/`, the release automation
   scripts (`scripts/release.mjs`, `scripts/release.sh`,
   `scripts/check-versions.mjs`, `scripts/prepare-merge-release.mjs` and its
   test), and the `systemId`, `version`, `artifact`, `media`, `consumer`, and
   `workspace` entries of `timds.json` as protected tooling. Change them only
   when the user asks to update TimDS.

## Start from a fresh scaffold

A new contract ships a dependency-free starter viewer whose colors, fonts, and
copy are neutral placeholders. It passes `check` with two expected warnings:
no `brand/voice` page and no annotated logo. Turning it into the client's
system is ordinary design work:

1. Collect the approved inputs first: brand colors, licensed typefaces, logo
   files, and voice guidance. Ask for what is missing rather than inventing it.
2. Replace the values in `tokens.json`. The starter build emits each
   `group.name` token as the `--group-name` custom property in `tokens.css`;
   add a token before using a new value in `src/styles/`.
3. Read `src/site.json`. It declares every view and page; a page marked
   `"planned": true` has no source yet and is not built. Rewrite the authored
   fragments under `src/pages/` for the client, then author the planned ones:
   create `src/pages/<view>/<slug>.html` and remove the flag. Remove planned
   pages the system will not have and add the pages and views it needs.
   Every print sheet and screen canvas is sized from `src/formats.json`;
   add a format there, naming its page, before a template page previews it
   with `{{canvas:ID}}`.
4. Add the logo under `src/assets/` and write the `brand/logo`, `brand/voice`,
   and other guidance pages, shaped as described in the next section. A
   fragment holds only the content of `<main>`; `src/layout.html` supplies the
   shell and the navigation.
5. The starter `dev` server builds once and does not watch files. Rerun
   `npm run timds -- check` after an edit, then reload.

The scaffolded `AGENTS.md` carries the same starter map. Once the system moves
to another framework, follow `timds.json` `workspace` and that framework's
layout instead.

## Shape pages for the derived layer

`check` reads the built HTML and CSS, never authored source, and derives
`index.json`, `tokens.json`, `brand.json`, `llms.txt`, and a Markdown mirror of
every page. Video, product repositories, and consumer agents read only that
layer, so structure the pages for it whatever the framework:

- Give every page one `<h1>`; a page without one is skipped. When the `<h1>`
  is a direct child of `<main>`, the element before it becomes the eyebrow and
  the first `<p>` after it the page summary.
- Make each topic an outermost `<section>` inside `<main>` with a stable `id`.
  Block ids are citations such as `brand/voice#principles`; renaming one
  breaks every consumer that cites it.
- Put specifications and do/don't guidance in a `<table>` (one rule per row,
  named by its first cell), cautions in an `<aside>`, `<blockquote>`, or
  `.note`, and code in a `<pre>`. Other text is untyped prose, which the
  `check` summary counts. `timds.json` `machine` can name different selectors
  when the markup cannot change.
- Put a name on every asset with a `<figcaption>` or `alt`, and reference
  artifact files by site-absolute path such as `/assets/logo.svg`.
  Publication rewrites those to stable public URLs in the index and brand
  kit; a relative `src` is recorded as written, which no consumer can resolve.
- Local references must resolve inside the artifact; `check` fails on a
  broken one. The artifact is limited to 2,000 files, 12 MB per file, and
  80 MB in total, with no symbolic links.

## Design whole pages in the system

The system is designer-owned down to the pages. A website, or any set of
screens, is designed under `src/designs/<design>/` in plain HTML on the
system's own stylesheets; an engineer ports it to production. The design is
the reference the port must match, never the production site itself.

- `design.json` names the design (`title`, `summary`, optional `pages` titles
  by route). An optional `layout.html` with `{{content}}` is the shell;
  `pages/` holds one file per route and state: `index.html` is `/`,
  `about.html` is `/about`, `contact/index.html` is `/contact`, and
  `contact.sent.html` is `/contact` in its sent state. A state is always a
  file, never a script.
- Link pages by their eventual site route (`href="/contact"`); the build
  points those links at the design's place in the artifact. Link the
  system's stylesheets by site-absolute path and never the viewer's
  documentation chrome.
- Use only what the system defines. `check` refuses `<script>`, inline event
  handlers, `<style>`, `style` attributes, a class no linked stylesheet
  declares, and a relative reference, and names the file and the class. When
  a page needs a style the system lacks, add it to the system's stylesheet
  and document it on the components page, then use it.
- Design the pages, not the content: an archive page and one sample post,
  not forty posts.
- The built pages sit under `/designs/<design>/` with a directory at
  `/designs/`; review them in `preview` at desktop and phone widths like any
  page. Consumers read them through `list_designs` and `read_design`.
- A system scaffolded before designs existed adopts them with
  `npm run timds -- designs init`, which writes the sample, updates stock
  starter scripts, and appends the starter's layout pieces to the system
  stylesheet when the system still uses the starter's token names; otherwise
  it names the classes the sample needs.

## Upgrade protected tooling only when requested

1. Use the bounded release line selected by the user or DT Concepts operator.
   For the current package use `0.1.x`; never select unbounded `latest`.
2. Confirm `devDependencies["@dtconcepts/timds"]` remains `"0.1.x"`, then run
   from repository root:

```bash
npm run timds -- upgrade --version 0.1.x
npm run timds -- defaults
```

   Bootstrap an older CLI with `npm update @dtconcepts/timds` and ordinary
   `upgrade` once. Dependency selection installs one exact lockfile, validates
   the React/Remotion graph, synchronizes adopted managed files, and runs the
   workspace and configured `check:timds-upgrade` checks. Adopt `--own-runtime`
   only when authorized to align existing direct React/Remotion declarations.
   PR validation and publication use `npm ci`; never probe releases in ordinary
   checks. Enable `upgrade --dependency-prs` only when the user opts into draft
   dependency PRs; keep credentials and fleet registrations outside the package.

3. Never use `--force` without explicit authorization to replace locally
   modified managed tooling.
4. For an older standalone repository, use `--auto-release` only when the user
   asks to migrate it to the managed merge-to-patch flow. TimDS preserves
   customized release automation unless `--force` is also authorized.
5. Confirm the upgrade changed only the package manifest and lockfile, local AI
   skill, installation record, workflow when intentionally updated, and removal
   of any legacy `.timds/cli` tree.
6. Run `npm run timds -- doctor` and `npm run timds -- check`. Submit the
   tooling update separately from ordinary design work.

Component consolidation is a separate explicit `video components migrate`
preview and `--apply` migration. Review supported overrides and before/after
horizontal and vertical renders, including boards over footage. Preserve tokens,
publishing defaults and sticky overrides, media, and production records. Runtime
requirements and exact custom-component `testedVersions` need reviewed checks
before adoption; deploy the selected lockfile on producer and renderer hosts.

When the task includes adopting shared publishing improvements, run
`npm run timds -- defaults --apply` on the feature branch. Review the contract
diff and reported local overrides. Commit `.timds/defaults.json` with the
authored contract: it records the supplied default values, so later runs update
unchanged defaults and preserve client edits. The baseline's override paths are
persistent: a later matching default does not surrender client ownership.
Keep inherited client CTAs, disclosures, and article-link policy on adoption.
Promote reusable wording improvements into TimDS's publishing defaults so the
same upgrade procedure carries them to other systems. Never regenerate client
components or production records to adopt publishing defaults.

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
   `check` derives `tokens.json` from the built stylesheets and fills the
   brand roles (`color.accent`, `font.display`, …) by convention; when it
   warns that a role is unfilled, map the role to the system's token name in
   `timds.json` `brand.roles` rather than copying a value anywhere. It also
   derives `brand.json` from assets annotated `data-timds-role` (`logo`,
   `photo`, `illustration`, …); annotate the logo and hero imagery on the
   pages that present them instead of listing them elsewhere. Voice and
   compliance guidance reach the kit from `brand/voice` and `*/compliance`
   pages by convention, or from `timds.json` `brand.guidance` references.
6. Keep `dist/` out of source pull requests when `artifact.publishRef` declares
   a separate CI publication branch.
7. Use genuine licensed assets. Never invent client marks or usage rights.

## Route imagery through the Design System

Shared brand imagery, photography, campaign art, character art, and page heroes
belong to the client's Design System, including imagery used by a linked
website. Follow the client contract for website-only exceptions. Work in the
owning Design System repository and let consumers use its reviewed asset URLs
or media keys; do not copy the assets into the consumer repository or bypass
its release pin.

Use TimDS media publication for image originals and their web derivatives.
Small optimized logos, icons, fonts, and other lightweight public assets may
live in the Design System's tracked asset directory when the client contract
allows it. Respect that repository's file-size limits; being under a Git size
limit does not make a full-resolution original suitable for a web page.

## Keep originals and display images separate

Before generating, downloading, or copying an image, stage it outside tracked
source in the Design System's ignored `media-local/` workspace. Keep the
original for future edits and make an optimized derivative for the actual
display dimensions, preserving needed transparency and visual quality. Publish
both through the media workflow below under distinct logical keys, such as
`campaign-hero-original` and `campaign-hero`.

Before replacing an existing media key, inspect its consumers, dimensions,
format, and byte size. Preserve the key's purpose: a thumbnail or page-display
key must resolve to the optimized derivative, never a newly uploaded large
original. CSS sizing does not reduce the downloaded image bytes; do not assume
a `publicUrl` automatically resizes the source. Check the published derivative's
dimensions, size, and rendering in the consuming page before submitting.

## Publish media outside Git

This release supports public media only. Never commit full-resolution images,
video masters, B-roll, source audio, or other large originals to Git or `dist/`.
Copy the file into the ignored `media-local/` workspace and register a stable
logical key:

```bash
npm run timds -- assets add media-local/file.mp4 \
  --key descriptive-key \
  --title "Descriptive title" \
  --tags b-roll,campaign
```

Use that logical key in viewer source. The local authoring server resolves it
from `.timds/local-media.json`; a production build resolves it from the stable
public URL in `media.json`. Authenticate through the operator portal and upload:

```bash
npm run timds -- auth login
npm run timds -- assets publish
```

`submit` publishes changed staged files automatically before validation. Commit
the resulting `media.json` record, never the raw file or local manifest.
`assets add` records the catalog checksum when staging. `assets publish` and
`submit` stop before uploading if a staged replacement conflicts with the
current catalog, including older staging entries without that baseline. Keep
reviewed published derivatives: remove stale entries from
`.timds/local-media.json` or run `assets pull KEY --force` to restore the
published asset. Restage with `assets add FILE --key KEY` only after reviewing
an intentional replacement; never restage originals over optimized keys merely
to bypass a conflict. Reusing an asset ID belonging to another key is rejected
without deleting that key; reference the existing logical key instead.

TimDS
uses `ffprobe` while staging video and audio so the record and published machine
index include measured duration and video dimensions. For an older catalog,
run `npm run timds -- assets backfill-metadata` once to measure its stable public
URLs without uploading the blobs again. Never
commit credentials, storage keys, or expiring signed URLs. Use
`npm run timds -- assets pull LOGICAL_KEY` to restore a published asset on a new
workstation. `TIMDS_ACCESS_TOKEN` is the non-interactive alternative for an AI
agent or CI job.

When creating or registering B-roll for a video-enabled system, also follow
the [vertical crop authoring contract](../timds-create-video/references/vertical-crops.md).
Include the configured `vertical-meta.json` records with the video asset map
and run `npm run timds -- video check`; wide subject-side labels do not replace
reviewed vertical framing. Preserve the client's approved derivatives.

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

## Keep linked consumers release-pinned

When a standalone `timds.json` declares a `consumer`, treat the Design System
release as the source of the consumer's submodule update. Every accepted change
on `main` becomes a patch release: CI synchronizes the version, publishes the
exact commit, and only then opens or refreshes a gitlink-only pull request in
the consumer. Tags are not required. `scripts/release.sh` remains available for
an intentional explicit version advance.

The consumer owns its `.gitmodules` record and reviewed gitlink. Prefer a
same-host relative submodule URL, and never merge the consumer pull request or
deploy the consumer without separate authorization. If
`TIMDS_CONSUMER_TOKEN` is not configured with contents and pull-request access
to the declared consumer repository, report that setup requirement rather than
copying a workstation credential into GitHub Actions.

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
