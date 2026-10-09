# Design System Agent Contract

__CONTRACT_DESCRIPTION__ Read `timds.json`, this file, and the relevant source before editing.

Paths in this file are relative to the Design System root, the directory that
holds `timds.json`. Run `__TIMDS_CLI__` commands from the repository root.

## Start here

1. Install the toolkit: `npm ci` when a lockfile is committed. A fresh scaffold
   has none yet, so run `npm install` once and commit the lockfile it writes.
2. Run `__TIMDS_CLI__ doctor` to confirm the contract, layout, and toolkit
   version.
3. Run `__TIMDS_CLI__ check`, then `__TIMDS_CLI__ brand`. `check` builds
   `dist/` and validates it; `brand` lists what the brand kit still lacks,
   with the fix for each gap. A fresh scaffold passes with two expected
   warnings: no `brand/voice` page and no annotated logo.
4. Read `.agents/skills/timds-edit-design-system/SKILL.md` at the repository
   root before design work, and `.agents/skills/timds-create-video/SKILL.md`
   before video work. They hold the full procedures; this file holds the
   rules.
5. Work on a `design-system/<change>` branch. Finish every change with
   `__TIMDS_CLI__ check` and a look at `__TIMDS_CLI__ preview`.

## What is in this directory

| Path | Role | During design work |
| --- | --- | --- |
| `tokens.json` | Authored design tokens | Edit |
| `src/site.json` | The views and every page in them; the one place that declares which pages exist | Edit |
| `src/pages/` | One content fragment per authored page | Edit |
| `src/designs/` | Website designs: whole pages in plain HTML on the system's stylesheets, one directory per design | Edit |
| `src/layout.html` | The shell every page shares: app bar, page navigation, content slot | Edit |
| `src/styles/`, `src/assets/` | The system's styles, the viewer chrome, and small optimized assets | Edit |
| `scripts/build.mjs`, `dev.mjs`, `check.mjs`, `viewer.mjs` | The `workspace` commands that `timds.json` runs and the renderer they share | Edit only when the viewer needs it |
| `CHANGELOG.md` | Designer-facing change notes | Add to `## Unreleased` |
| `README.md`, `AGENTS.md` | This system's own documentation | Keep accurate as the system changes |
| `timds.json` | Manifest: identity, version, artifact entry, workspace commands, the `bundle` globs naming what a website loads | Only `brand` and `machine` mappings; the rest is protected |
| `media.json` | Published media catalog | Written by `assets` commands, never by hand |
| `media-local/` | Ignored full-resolution originals | Stage files here |
| `dist/` | Generated artifact and derived layer | Never edit |
| `.timds/`, release scripts, and the repository root's `.agents/skills/` and `.github/workflows/` | Managed tooling | Protected; see the last section |

## Starter viewer

A new contract ships a dependency-free viewer so it builds and validates
immediately. Its colors, fonts, and copy are neutral placeholders, not brand
guidance. Its structure is the part to keep: views, a shared shell, and pages
built from the same few blocks.

- `src/site.json` lists the views (Brand, Web) and the pages in each, in
  navigation order. A page is `{ "slug", "title", "summary" }` plus an
  optional `group` heading for the sidebar. The page `<view>/<slug>` is
  authored in `src/pages/<view>/<slug>.html` and built to
  `dist/<view>/<slug>/index.html`; an empty slug is the view's own page,
  `src/pages/<view>/index.html`. `src/pages/index.html` is the overview.
- A page marked `"planned": true` is declared but not authored. It shows in
  the navigation and the overview as planned, and nothing is built for it, so
  the derived layer never carries placeholder guidance. To author it, create
  the fragment and remove the flag. The build fails when the two disagree, and
  when a fragment exists that `site.json` does not declare.
- A fragment holds only what goes inside `<main>`: an eyebrow, one
  `<h1 class="page-title">`, a `<p class="lede">`, then one
  `<section class="block" id="...">` per topic. `src/layout.html` supplies the
  app bar, the sidebar, and the previous/next links from `site.json`.
- Write a block from the shared pieces in `src/styles/viewer.css`: a
  `.block__head` with the `<h2 class="h2">` and an intro, a
  `<table class="spec">` for rules, a `.note` for guidance that is not a row,
  a `<pre>` for markup to copy, and a `<figure class="demo">` for a live
  preview. A preview is a figure so its sample text stays out of the derived
  rules.
- `tokens.json` groups tokens as `group.name` with a string `value` and an
  optional `description`. The build writes each one to `tokens.css` as the CSS
  custom property `--group-name` on `:root`. Add a token before using a new
  value; `check` fails on a color literal in `src/styles/`.
- A fragment never restates a token. `{{tokens:GROUP}}` becomes the table of
  that group, written from `tokens.json`; `{{sitemap}}` becomes the table of
  every page; `{{name}}`, `{{description}}`, and `{{version}}` come from
  `timds.json`. An unknown placeholder fails the build.
- `src/styles/system.css` is the system itself, the base styles and
  components a product adopts. `src/styles/viewer.css` is documentation
  chrome. Keep them apart. `src/styles/` and `src/assets/` are copied into the
  artifact unchanged.
- Link pages and files by site-absolute path, such as `/brand/color/` and
  `/assets/logo.svg`. `check` fails on a local reference that does not resolve
  inside the artifact.
- `dev` builds once and serves the artifact at `http://127.0.0.1:4321` (set
  `PORT` to change it). It does not watch files: rerun `__TIMDS_CLI__ check`
  after editing, then reload.
- `preview` serves the exact built artifact on port 4400.

If this system has moved to another framework, `timds.json` `workspace` names
the real commands and this section no longer applies. Replace it with that
framework's layout.

## Website designs

The system is designer-owned down to the pages themselves. A whole website,
or any set of screens, is designed here in plain HTML on the system's own
stylesheets, and a backend engineer ports it to whatever runs production:
EmDash, WordPress, a static host, anything. The design is the reference the
port must match. It is never the production site itself, however simple the
stack, so the ownership line between this repository and a product stays
clean.

- One design per directory under `src/designs/<design>/`: `design.json`
  (`title`, `summary`, and optionally `pages` with a `title` per route for a
  page whose heading is a headline rather than a name), an optional
  `layout.html` shell with `{{content}}` (plus `{{title}}`, `{{name}}`,
  `{{description}}`, `{{version}}`), and `pages/`.
- The file name is the route. `pages/index.html` is `/`, `pages/about.html`
  is `/about`, `pages/contact/index.html` is `/contact`; directories are
  route segments. Link between pages by their eventual site route
  (`href="/contact"`); the build points those links at the design's place
  in the artifact and leaves every other reference as written.
- A state is a file beside its page, never a script. `contact.sent.html` is
  `/contact` after the form is sent; `index.signed-in.html`,
  `orders.empty.html`, and `checkout.error.html` work the same way. Every
  state a port must handle is a file a port can see.
- A design uses only what the system defines. `check` refuses `<script>`,
  inline event handlers, `<style>`, `style` attributes, a class no linked
  stylesheet declares, and a relative reference. When a page needs a style
  the system lacks, add it to `src/styles/system.css` and document it on
  `web/components`; never add it to the page.
- Link the system's stylesheets by site-absolute path (`/tokens.css`,
  `/styles/system.css`) and never `viewer.css`, which is documentation
  chrome a product does not have. Reference imagery by site-absolute path
  or a published media URL.
- Design the pages, not the content. A blog is its archive page and one
  sample post, not forty posts.
- TimDS builds the designs to `dist/designs/<design>/<route>/index.html`
  with states as `<state>.html` beside the default, lists them at
  `/designs/`, and the viewer's app bar links there. `designs.json` beside
  `index.json` carries every page's HTML for consumers, who read it with
  the `list_designs` and `read_design` tools. A product pairs a route with
  its design in its `timds.consumer.json` (`"/": "website:/"`), and its
  pull-request preview then shows the design beside the route.
- The starter ships one sample design, `website`, composed from the site
  layout pieces on `web/components`. Replace it with the client's pages, or
  remove `src/designs/` entirely; `check` ignores a system without it. A
  system scaffolded before designs existed adopts them with
  `__TIMDS_CLI__ designs init`.

## Write pages the derived layer can read

`check` reads the built HTML and CSS, never authored source, and writes
`index.json`, `tokens.json`, `brand.json`, `formats.json`, `llms.txt`,
`llms-full.txt`, and a Markdown mirror of every page beside them. Video,
product repositories, other agents, and anyone given the system's public link
consume only that layer, so page structure decides what they receive.
`llms.txt` opens with the brand essentials (colors, fonts and where to get
them, logos, asset formats), so what reaches the kit reaches every tool.

- A font role is usable outside the browser only when its family can be
  obtained: declare an `@font-face` for it in a stylesheet the pages load, or
  link the font service's stylesheet from the layout. `check` warns about a
  font role with neither.
- Keep `src/formats.json` current: it is the catalog of every print sheet and
  screen canvas, and `formats.json` is derived from it so a consumer gets the
  business card's exact size rather than a page to scrape.
- `timds.json` `bundle.include` names the files a website loads from this
  system (the built `tokens.css` and the system stylesheet in a fresh
  scaffold). `check` copies them into `bundle/` under their source paths and
  publishes them under an immutable per-version prefix a website pins. A new
  stylesheet or script a website should load is a `bundle.include` entry; a
  pattern that matches nothing fails `check`.
- A page needs one `<h1>`; a page without one is skipped. When the `<h1>` is
  a direct child of `<main>`, the element before it becomes the page eyebrow
  and the first `<p>` after it the page summary.
- Inside `<main>`, each outermost `<section>` is one block. Give it a stable
  `id`; without one the heading text becomes the id. Ids are citations such as
  `brand/voice#principles`, so do not rename them casually.
- Inside a block, a `<table>` becomes rules (one record per row, named by its
  first cell), an `<aside>`, `<blockquote>`, or `.note` becomes a note, a
  `<pre>` becomes code, and a `<figure>`, `<img>`, or `<video>` becomes an
  asset named by its `<figcaption>` or `alt`. Everything else is untyped
  prose, which the `check` summary counts. Put specifications and do/don't
  guidance in tables so consumers can cite them.
- Every CSS custom property in a stylesheet the pages load becomes a token.
  The brand roles fill by convention from `:root` names: `color.background`
  (`--color-background`, `--color-canvas`), `color.panel` (`--color-panel`,
  `--color-surface`), `color.accent` (`--color-accent`, `--color-primary`),
  `color.text` (`--color-text`, `--color-ink`), `color.muted`
  (`--color-muted`), `font.display` (`--font-display`, `--font-heading`,
  `--font-serif`), `font.body` (`--font-body`, `--font-sans`), and `font.ui`
  (`--font-ui`, `--font-sans`). When a token is named differently, map the
  role to the token name in `timds.json` `brand.roles`; never copy the value.
- Annotate each logo on the page that presents it with
  `data-timds-role="logo"`, and `"logo primary"` on the default variant.
  `data-timds-variant`, `data-timds-lockup`, `data-timds-on` (the background
  it is for), and `data-timds-tags` qualify it. Reusable imagery takes
  `photo`, `illustration`, `graphic`, `icon`, or `pattern` the same way. The
  attribute may sit on the image, its figure, or any wrapper in the block.
- Reference images and other artifact files by site-absolute path from the
  artifact root, such as `/assets/logo.svg`. Publication rewrites those to
  stable public URLs in the index and brand kit; a relative `src` is recorded
  as written, which no consumer can resolve.
- The `brand/voice` page fills the voice guidance group, and any page named
  `compliance` fills compliance. `timds.json` `brand.guidance` can point at
  other pages or blocks.
- The artifact holds at most 2,000 files, 12 MB per file, and 80 MB in total,
  with no symbolic links.

## First design pass on a fresh scaffold

1. Collect the approved inputs before designing: brand colors, licensed
   typefaces, logo files, and voice guidance. Ask for what is missing. Never
   invent a client mark, a usage right, or a compliance rule.
2. Replace the starter values in `tokens.json`. Keep role-friendly token names
   or map the roles in `timds.json`.
3. Rewrite the authored pages (`brand/color`, `brand/typography`,
   `web/spacing`, `web/components`) for the client: their copy, their rules,
   and the components in `src/styles/system.css`.
4. Author the planned pages, starting with the Brand view. Add small
   optimized logo files under `src/assets/`, then write `brand/logo` showing
   each one by site-absolute path with its annotation. Write `brand/voice`
   and `brand/foundation`.
5. Shape the rest of `src/site.json` to the client: remove a planned page the
   system will not have, and add pages or whole views (email, social, print,
   video) it needs.
6. Replace the sample website design under `src/designs/website/` with the
   client's pages, each state as its own file, using only the system's
   classes. Add a layout piece or component to `src/styles/system.css` and
   `web/components` when a page needs one.
7. Run `__TIMDS_CLI__ check` until it passes without warnings and
   `__TIMDS_CLI__ brand` lists the logo and the voice guidance.
8. Inspect `__TIMDS_CLI__ preview` at desktop and mobile widths, the designs
   under `/designs/` included.
9. Record the change under `## Unreleased` in `CHANGELOG.md`.

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
- This phase supports public assets only. Put originals under ignored `media-local/` and register them with `__TIMDS_CLI__ assets add FILE --key LOGICAL_KEY`.
- Run `__TIMDS_CLI__ auth login` once, then `__TIMDS_CLI__ assets publish`. `submit` also publishes changed staged files before validation.
- The starter viewer does not resolve logical keys. Reference a published asset by the `publicUrl` in its `media.json` record; the derived layer joins the asset back to that record by URL. A framework viewer can resolve keys with `resolveMediaSource` and serve staged local files with `localMediaResponse` from `@dtconcepts/timds/media`.
- Staging records the current catalog checksum. Publication refuses conflicting replacements and asset-ID reuse across logical keys. Keep reviewed derivatives: remove stale entries from `.timds/local-media.json` or restore them with `assets pull KEY --force`. Restage with `assets add` only for a reviewed, intentional replacement, never to push an old original over an optimized key.
- TimDS measures video and audio metadata with `ffprobe` during `assets add`; use `__TIMDS_CLI__ assets backfill-metadata` to repair older records from stable public URLs without re-uploading them.
- Keep only the returned stable record in `media.json`. Never place access tokens, R2 credentials, object keys, expiring signed URLs, `.timds/local-media.json`, or raw `media-local/` files in Git.
- Use `__TIMDS_CLI__ assets pull KEY` to restore a published original into the ignored local workspace.
- Small optimized images, icons, and fonts required to render the viewer may remain in `dist/` within the artifact limits.

## Command reference

```bash
__TIMDS_CLI__ doctor    # contract, layout, toolkit version, brand kit summary
__TIMDS_CLI__ dev       # the authoring server declared in timds.json
__TIMDS_CLI__ check     # build, validate the artifact, derive the machine layer
__TIMDS_CLI__ brand     # the derived brand kit and a fix for every gap
__TIMDS_CLI__ preview   # serve the exact built artifact; designs under /designs/
__TIMDS_CLI__ designs init   # adopt website designs in a system scaffolded without them
__TIMDS_CLI__ diff      # design-system changes against the default branch (--base REF)
```

Use `dev` for the authoring server and `preview` to inspect the exact built artifact. Check relevant views at desktop and mobile sizes before submission.

## Optional video contract

Video is off until `__TIMDS_CLI__ video init` adds the `video` block to
`timds.json`; run it only when the user asks for video.

When `timds.json` declares `video`, this Design System also owns the client's
video contract, logical video asset catalog, and five JSON records for each
production. Read those declared files and use the managed
`timds-create-video` skill. TimDS supplies the complete default Remotion
component set. `__TIMDS_CLI__ video components init` may copy those exact
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

`video/lab/` holds compile requests for the contract's `producer` block; they
are preview fixtures, not productions. `__TIMDS_CLI__ video lab` runs one
through the producer the way an automated Video Lab does and opens Remotion
Studio on the result with this system's components, so visual changes are
reviewed on the frames the lab will ship. Footage-chain and headline-copy
rules come from `@dtconcepts/timds/video/footage`; do not copy them here.

Keep generated audio, prepared media, generated entries, renders, thumbnails,
and review packages under ignored `video-local/`. Validate committed records
and lab inputs with `__TIMDS_CLI__ video check` and use `video studio` or
`video render` only for an explicitly selected production.

Regenerating components with `video components init --force` discards client
changes and requires explicit authorization. A normal `timds upgrade` does not
touch the declared component module.

## Git and publication

- Use a `design-system/<change>` branch and a pull request.
- Keep unrelated repository files out of the design-system commit.
- Record day-to-day changes under `## Unreleased`; standalone CI rolls them
  into a synchronized patch version after merge. Do not edit `version` by
  hand.
- `__TIMDS_CLI__ submit` may create a branch, commit, push, and draft pull request only when the user asks.
- In a standalone repository with managed automatic releases, merging is the
  publication decision: every accepted `main` change becomes a patch release.
- Only a DT Concepts operator may approve that merge or roll back a TimDS
  version.
- When `timds.json.consumer` is present, publish the exact synchronized Design
  System commit before advancing the consumer's submodule. The automation opens
  a consumer pull request; it never merges or deploys the consumer.

## Protected tooling

Treat the approved `@dtconcepts/timds` release line and resolved lockfile,
`.timds/installation.json`, the repository-local AI skills under
`.agents/skills/`, the TimDS workflows under `.github/workflows/`, the release
automation scripts (`scripts/release.mjs`, `scripts/release.sh`,
`scripts/check-versions.mjs`, `scripts/prepare-merge-release.mjs` and its
test), and the `systemId`, `version`, `artifact`, `media`, `consumer`, and
`workspace` entries of `timds.json` as execution policy. Do not change them
during ordinary design work.

When a DT Concepts operator selects a toolkit release line, keep the package
requirement at `0.1.x`, update the resolved lockfile, and then synchronize the
managed skill and installation record:

```bash
__TIMDS_CLI__ upgrade --version 0.1.x
```

Bootstrap an older CLI once with `npm update @dtconcepts/timds` and ordinary
`upgrade`. Dependency selection resolves one exact lockfile, installs it with
`npm ci`, validates the runtime graph, and runs the workspace plus configured
`check:timds-upgrade` checks. Explicit `--own-runtime` adoption aligns existing
React/Remotion declarations; explicit `upgrade --dependency-prs` adopts draft
dependency PR automation. Credentials and repository registrations stay in
repository settings or a private controller. Ordinary checks and publication
use the committed lockfile. Shared components are the normal path; consolidation
of snapshots uses the separate reviewed `video components migrate --apply`
migration, with rollback copies and before/after visuals in both formats.

Do not choose an unbounded `latest` or use `--force` without explicit
authorization. The upgrade removes a legacy `.timds/cli` copy when present;
the CLI itself comes from `node_modules`. Review and commit the tooling diff
separately from ordinary design changes.
