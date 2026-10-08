# TimDS Toolkit Agent Notes

This repository owns the public `@dtconcepts/timds` npm package: its CLI,
repository contracts, templates, artifact publisher, Design System editing
skills, and integrated video runtime. Do not split video into another package
or copy rendering, staging, composition registration, or producer runtime code
into client repositories. A generated client-owned snapshot of the visual
Remotion components is source, not copied runtime.

Before committing changes, run:

```bash
npm test
npm run pack:check
```

Keep package releases cohesive. A version must carry compatible CLI behavior,
templates, workflows, and skill instructions together. Update or add tests
whenever managed-file behavior changes.

Client repositories select the bounded `0.1.x` package line, commit the exact
resolved lockfile, and execute `npm run timds --`. They do not vendor package
source. The always-managed repository-local boundary is
`.timds/installation.json`, `.agents/skills/timds-edit-design-system/`,
`.agents/skills/timds-create-video/`, and the legacy `.timds/cli/` tree only
while removing it during migration. Standalone
initialization also owns the stock release workflows and preparation scripts.
Existing standalone repos enter that expanded boundary only through the
explicit `upgrade --auto-release` migration; refuse customized files unless
replacement is forced. Package and lockfile changes select the resolved package
release.

In a consumer (product) repository, the consumer-managed boundary is
`.agents/skills/timds-consume-design-system/`, the
`timds-consumer-preview.yml` and `timds-designer-change.yml` workflows, the
tracked `.claude/launch.json` and `.mcp.json` entries, and `consumer` in
`.timds/installation.json`; `upgrade` there refreshes only that boundary (and,
with `--version`, the root package and lockfile) and never touches
`timds.consumer.json`, other launch entries or MCP servers, or product source.

`consumer scaffold emdash` creates a new EmDash site repository that consumes
a Design System. It runs EmDash's own generator, never a vendored template;
everything it writes beyond the consumer-managed boundary above (the theme,
the token module, public asset symlinks, `timds.consumer.json`,
`DESIGN_SYSTEM.md`) is product source from then on, so no upgrade may touch it.
The site reads the pinned submodule at build time: never copy stylesheets,
tokens, or media out of it. The token module mirrors the starter build's
`--group-name` rule in
`templates/starter/scripts/viewer.mjs`; change the two together.
Public assets stay in the pin and are exposed through relative symlinks in
the site's `public/`; the links and their descendants are protected paths.
Refuse collisions with generated public files instead of replacing them.

`upgrade --version VERSION` selects one exact tested resolution, restores the
bounded requirement, runs `npm ci`, synchronizes adopted managed files with the
selected CLI, and validates the graph and workspace. Explicit `--own-runtime`
adoption lets it align existing React/Remotion declarations in package.json.
Adopted stock automation follows recorded template hashes; customized files
require explicit `--force`. `upgrade --dependency-prs` explicitly adds
`.github/workflows/timds-upgrade.yml` to that boundary. Repository registrations
and credentials stay in repository settings or an external fleet controller.

Never extend upgrades to authored source, `timds.json`, tokens, `media.json`,
framework configuration, documentation, or generated artifacts without an
explicit contract change and migration plan.

The starter scaffold has its own recorded boundary, kept by `src/starter.mjs`
and `.timds/starter.json` in the client repository. A fresh `init` records it;
an existing starter-based system opts in once with `timds starter sync`, and
every `upgrade` syncs an adopted system from then on. Inside that boundary the
toolkit may touch exactly three kinds of things: the starter plumbing
(`scripts/build.mjs`, `check.mjs`, `dev.mjs`, `viewer.mjs`,
`src/styles/canvas.css`, `src/styles/viewer.css`), which a fresh `init`
records as the toolkit's outright (`plumbing: "toolkit"`: every sync brings
it to stock, replacing a local change and reporting it, never halting) and an
adopted system records by hash (`"recorded"`: replaced only while the file
matches a hash the toolkit wrote); the structure catalogs `src/site.json`
and `src/formats.json`, merged three ways against the recorded stock baseline
so entries the client lacks are appended (pages as `planned`), fields still
equal to the baseline advance, and anything the client changed is kept (and
reported when the stock value moved, not on every sync), with nothing
removed, reordered, or retitled; and the overview
fragments the starter mirrors from the golden system
(`starterManagedFragments`), written when the sync adds or authors their page
and refreshed only while unmodified. `src/layout.html` only gains a missing
stock stylesheet link. Every other fragment, `tokens.json`, `system.css`, and
the rest of authored source stay outside the boundary. Recorded plumbing
that was customized is reported and replaced only by an explicit `timds
starter sync --force <path>` that names each file; `upgrade --force` covers the managed boundary
and never reaches starter files, and a customized overview fragment is the
system's own page, never replaced. The sync refuses to run over uncommitted
changes to the files it writes. A sync whose `check` fails is rolled back
whole, and `upgrade` runs
it before touching managed files so a failed sync aborts the upgrade with the
repository as it was. A structural change to `templates/starter` therefore
reaches existing systems through this sync; do not add another one-shot
migration for it.

`timds defaults --apply` is the explicit migration for shared publishing defaults.
It updates only `publishing.targets` and `publishing.targetDefaults` and records
the supplied values and persistent override paths in `.timds/defaults.json`.
Compare against that baseline to advance unchanged defaults; never clear an
override merely because a later default matches it. Preserve inherited client
publishing policy on adoption. Ordinary `upgrade`
reports pending defaults without applying them. New video scaffolds use the same
source and baseline. Reusable wording and budgets refined in a client system may
be promoted to these defaults; firm names, URLs, and client-only requirements stay
in the client repository. Keep this migration covered by first-adoption,
subsequent-update, override-preservation, and idempotence tests.

The generic video engine may know only the executable schema and deterministic
tooling. Client brand, copy, source authorization, compliance, asset selection,
production records, and output policy belong under that client's Design System
and must never enter this package.

TimDS owns the complete default Remotion component set, the typed partial
override contract, the one-time component snapshot generator, the shared
production rules in `video/footage.mjs` (footage families, natural-speed
chains, headline copy) that the components, the producer, and `video check`
all import, and the `video lab` command that previews a producer compile
request the way an automated Video Lab renders it. A generated snapshot
imports the rules module rather than copying it. Client
Design Systems may generate a complete editable snapshot or implement partial
visual overrides against that contract. Never overwrite a generated snapshot
during `upgrade`; only `video components init --force` intentionally resets it.
Keep component discovery, rendering, composition registration, media
preparation, and other engine behavior here.

New scaffolds use video contract schema 2, select shared board layout presets,
and declare runtime schema,
component API, minimum release, and feature requirements. Snapshot creation
records exact tested runtime versions. `video components migrate` explicitly
inventories recognized declarations, retains supported visual overrides, flags
custom engine logic, and applies only on request. Rollback copies live under
`.timds/component-migration/`; ordinary upgrades never touch them. Unchanged
snapshots become shared re-exports, preserving registration and named exports.
Custom overrides require reviewed exact runtime versions. Shared geometry and
fit limits live in `video/board-layouts.mjs`. Keep packed-release checks with
two brands and before/after visual comparisons in CI.

## The starter scaffold mirrors the golden system

One private client Design System is the golden reference for
`templates/starter/`. Its name never enters this public repository; the
maintainer supplies it. When it gains a view, a sidebar group, a template
family, or shared plumbing, rework the starter to match, so a fresh scaffold
is organized the way a fleshed-out system ends up.

Mirror structure, never content:

- Views, in `src/site.json`: ids, labels, blurbs, order, sidebar groups, and
  page lists. Keep the golden view labels (`Web DS`, `Digital DS`); the golden
  `marketing` view is the starter's `web` view. Keep a page title unless it
  is ambiguous outside its sidebar group (`LinkedIn specs`, not `Specs`).
  A page that needs the client's mark, photos, or copy stays `planned`.
  Author a view's overview when it carries what every system needs:
  principles, the catalog table, and how a preview is built.
- Single-owner catalogs become JSON the viewer validates: asset sizes in
  `src/formats.json`, the counterpart of the golden format modules, with
  every entry naming its page. A page never restates a size or a token.
- Preview engines and shared atoms become script-free CSS under
  `src/styles/`, written against the starter tokens with no color literals.
- Platform facts (standard ad sizes, upload limits, print trims) may be
  mirrored; say on the page that they need confirming before use.
- Leave out client copy, names and addresses, photos and focus points,
  campaign content, ink builds, field-specific compliance text, and
  product-specific sub-systems such as an admin theme.

When mirroring a golden change:

1. Run `npm run golden-drift -- --golden PATH` against a checkout of the
   change: it lists the views, groups, pages, and formats the starter lacks
   or declares differently. Then read the navigation model, catalogs,
   stylesheet imports, and overview pages before the template pages; the
   templates follow from those.
2. Update `src/site.json`, `src/formats.json`, the stylesheets, and the
   fragments. A fresh scaffold must still pass `check` with exactly its two
   expected warnings (no voice page, no annotated logo) and no untyped prose.
3. Keep the scaffolded `templates/design-system-AGENTS.md`,
   `design-system-README.md`, the edit skill, and this repository's
   `CLAUDE.md` describing the new structure.
4. A changed plumbing file or managed fragment needs no hash bookkeeping:
   an adopted system's `.timds/starter.json` records what the toolkit last
   wrote, and `starter sync` advances it. `legacyStarterFileHashes` in
   `src/starter.mjs` only recognizes systems scaffolded before the record
   existed and stays as it is. A new authored page under a mirrored view goes
   in `starterManagedFragments`; a new stylesheet the layout must link goes
   in the plumbing table and the layout link list.
5. Update the starter assertions in `src/core.test.mjs` (page ids, page
   counts, rendered tables) and `src/mcp.test.mjs` (the stylesheet list),
   then run `npm test` and `npm run pack:check`. Rerun the drift script
   until it reports none; a deliberate omission is recorded with its reason
   in `MAPPING` in `scripts/golden-drift.mjs`, never left as noise.
6. Cite the golden pull request by number in the commit message, never by
   repository name.

The golden repository's own workflow opens a `golden-mirror` issue here
when a merged pull request touched its structure-bearing files (navigation
model, catalogs and content modules, shared stylesheets, layout). Work the
issue with the steps above and close it from the mirror pull request.

Never add client-specific content, credentials, private URLs, access tokens,
media, or portal-internal implementation to this public repository or npm
package.

Release tags must exactly match `package.json` as `v<version>`. Keep
`publishConfig.access` public and use the tracked GitHub Actions trusted
publisher workflow rather than a long-lived npm token.
