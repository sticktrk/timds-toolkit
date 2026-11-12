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

The public `@dtconcepts/timds/release-metadata` export describes npm starter
resources and renders managed bytes without workspace, clock, or config input.
Keep its policies aligned with init/upgrade/starter sync; seed-only resources
never become overwrite permissions. See `docs/release-metadata.md`.

## Public toolkit boundary

This repository and its npm package are public: an open-source design-system
toolkit. TimDS Cloud, the hosted service, is a separate product. The rule for
what belongs here:

- The toolkit may call the host's public API. `src/hosted.mjs` is the public
  client contract (sessions, drafts, claims, publication, rollback), with the
  thin clients beside it for login (`src/auth.mjs`, `src/oauth.mjs`), media and
  artifact upload, consumer registration, receipts and notes.
- The toolkit may not contain server logic, server data models beyond that
  API, or Studio and operations documentation.

Server implementation, storage, Studio internals, deployment, maintenance
fleets, host conformance, runbooks and anything about running or
administering a host belong in the host repository (`sticktrk/timds-host`).
Hosted features stay documented here only as the clearly separated "TimDS
Cloud" layer: the last section of `README.md`, the "If you use TimDS Cloud"
asides in the skills and scaffold templates, and the
`timds-hosted-design-system` skill. Design-system authoring, the local and
Git paths, consumers, offshoots and video must work and read complete
without a host.

`src/merge.mjs` (the `./merge` export) is server logic: the host vendors its
own copy, so the export is deprecated and will be removed in a later
release. Do not add callers or features to it. `./release-metadata` stays a
supported export: hosts preparing toolkit upgrades load it from the selected
release to describe that package's own templates and skills.

Keep package releases cohesive. A version must carry compatible CLI behavior,
templates, workflows, and skill instructions together. Update or add tests
whenever managed-file behavior changes.

Npm client repositories select the bounded `0.1.x` package line, commit the exact
resolved lockfile, and execute `npm run timds --`. Binary clients instead select
an exact executable release in schema 2 `.timds/installation.json` with
`mode: "binary"` and execute `timds-cli`. Its runtime and dependencies live in a
verified per-user cache, never in the client repository. Binary adoption is an
explicit `installation adopt --binary --apply` migration: it may rewrite only
recognized stock `timds.json` workspace commands plus the managed boundary;
authored docs, package pins, custom commands and product source are retained.
`upgrade --version` selects the running verified binary release without replacing
the executable, and restores the previous selection/files when checking fails.
Binary-only consumers explicitly sync published bundles; existing npm hooks
retain their product toolchain. See `docs/binary-installation.md` for the contract. They do not vendor package
source. The always-managed repository-local boundary is
`.timds/installation.json`, `.agents/skills/timds-edit-design-system/`,
`.agents/skills/timds-create-video/`, the four designer skills
(`.agents/skills/design-start/`, `design-media/`, `design-ship/`,
`design-handoff/`, listed in `designSystemSkillNames` in `src/skill-names.mjs`),
and the legacy `.timds/cli/` tree only
while removing it during migration. `init` and `upgrade` also create the
`.claude/skills -> ../.agents/skills` link (`src/agent-skills.mjs`) when
nothing is at that path, so Claude Code sees the same skills as slash
commands; an existing path there is never touched. Standalone
initialization also owns the stock release workflows and preparation scripts
(`scripts/release.mjs`, `release.sh`, `check-versions.mjs`,
`prepare-merge-release.mjs` and its test). `CHANGELOG.md` is the client's;
the toolkit only reads it, renders it into the artifact, and refuses a
`submit` without an Unreleased note.
Existing standalone repos enter that expanded boundary only through the
explicit `upgrade --auto-release` migration; refuse customized files unless
replacement is forced. Package and lockfile changes select the resolved package
release.

In a consumer (product) repository, the consumer-managed boundary is
`.agents/skills/timds-consume-design-system/` (a designer's change inside
the design surface), `.agents/skills/timds-update-design-system/` (a
developer moving the pin to a release and porting the designs that
changed; both are rendered from the manifest by `renderConsumerSkillFile`),
the
`timds-consumer-preview.yml` and `timds-designer-change.yml` workflows, the
tracked `.claude/launch.json` and `.mcp.json` entries, and `consumer` in
`.timds/installation.json`; `upgrade` there refreshes only that boundary (and,
with `--version`, the root package and lockfile) and never touches
`timds.consumer.json`, other launch entries or MCP servers, or product source.

`consumer register` reads the product manifest and records a source-scoped
follower on the selected host (`--portal-url`, `TIMDS_PORTAL_URL`, then the
saved selected login). The manifest must be at the Git repository root. Its
stable retry input lives under the product's Git common directory in `timds-consumers/`, never in tracked
source; credentials stay in the existing external login store. `consumer
updates` reads the same run receipts as Studio and authenticated MCP. Hosted
pin adoption uses `consumer check --base REF --allow-pin-update LABEL`: only
the exact published version can change; every other manifest value remains
fixed, including app commands, routes, system identity and surface/protected
rules. Hosted skill rendering requires the exact `targetLabel` and
`delivery: "hosted"`, which leaves commits, pushes and PR delivery to the host.
Ordinary designer checks continue to reject pin moves. Keep registration, the shared host provider,
its CLI help and the developer update skill compatible in one release.

`consumer scaffold emdash` creates a new EmDash site repository that consumes
a Design System. It runs EmDash's own generator, never a vendored copy of
EmDash's template;
everything it writes beyond the consumer-managed boundary above (the theme,
the token module, public asset symlinks, `timds.consumer.json`,
`DESIGN_SYSTEM.md`) is product source from then on, so no upgrade may touch it.
`consumer scaffold emdash --existing` is withdrawn: `runConsumerScaffold`
refuses the flag with `EXISTING_WITHDRAWN` and writes nothing, since a
system's own site lives in its workspace. Its function
(`scaffoldExistingEmdashSite`), tests and templates stay until they are
removed, and the rest of this paragraph describes that function, which no
command reaches. It installs the toolkit's own article
templates (`templates/emdash/site*`, described by `templates/emdash/site.json`:
the seed's content model, the article routes, the serializer, the writer's
contract) into an Astro consumer that already has `timds.consumer.json`. Those
templates are TimDS's port of the starter's article designs, not EmDash's
template; keep their markup in step with
`templates/starter/src/designs/website/` and the brand kit's copy of the
article designs in `templates/brand-kit/src/designs/website/`, whose
`src/styles/system.css` must declare every class those templates use. The mode never overwrites a path or
edits an existing page, and it refuses a site page at a route a template page
takes by Astro's file routing (`articles.astro` beside `articles/index.astro`,
`[id]` beside `[slug]`), naming any dynamic or catch-all page the article
routes now outrank: it changes only `package.json` and
`timds.consumer.json`, prints every configuration change it cannot make
safely, and records the template version in `.timds/emdash.json`. What it
writes is product source too; a template fix reaches an installed site by
hand, and the recorded version says how far behind it is. The collection,
field and taxonomy slugs in the seed are a contract external writers target:
renaming one is a breaking change.
The site reads the pinned submodule at build time: never copy stylesheets,
tokens, or media out of it. The token module mirrors the starter build's
`--group-name` rule in
`src/viewer.mjs`; change the two together.
Public assets stay in the pin and are exposed through relative symlinks in
the site's `public/`; the links and their descendants are protected paths.
Refuse collisions with generated public files instead of replacing them.

`consumer scaffold emdash --workspace` writes a system's own site into `site/`
of its Design System workspace, with no pin: the shared template set with
`templates/emdash/site-workspace/` over it, a generated `package.json`, the
shipped lockfile, `site/timds.consumer.json` in the workspace form
(`designSystem: { "workspace": true, "systemId" }`) and
`site/.timds/emdash.json`. It runs no generator and asks nothing, so one
release writes the same bytes for the same workspace. Everything in `site/` is
product source that no upgrade touches. The site is its own package, never an
npm workspace of the root, and declares no toolkit. The two consumer skills it
installs in the repository root's `.agents/skills/` and the delimited
`<!-- timds:emdash-site -->` section it adds to the system's `AGENTS.md` sit
outside the Design System's managed set and release metadata on purpose: they
are rendered for the site's manifest, which `upgrade` at the root does not
read, so `upgrade` neither writes nor reports them; the record keeps their
hashes (`workspaceFiles`, `workspaceSections`) for a later template update
command. The site's integration compiles tokens by the same rule as
`compileTokens` in `src/viewer.mjs` (`--group-name`, `{group.name}` references
to `var()`), as does `compileTokenCss` in `src/consumer-scaffold.mjs`, and
names design pages by the catalog's default-state rule in `src/designs.mjs`;
`src/emdash-workspace-integration.test.mjs` holds them equal, so change them
together. A posting form in a design renders disabled until the site has a
handler under `src/forms/`; the template never ships one. Two builds share one
repository: any command that walks the Design System root (build, check,
extract, doctor, upgrade, the bundle walk, offshoots, the MCP guard) must
skip the workspace site (`src/workspace-site.mjs` locates it), and
`src/workspace-site.test.mjs`, which proves the system's results are the same
with and without `site/`, must keep passing. An embedded system's `submit`
carries the two root consumer skills only while the site's record lists them
in `workspaceFiles` and the repository root is not itself a consumer
(`workspaceSiteSkillFolders`); a product's own consumer skills never enter a
system submission. The two-way check and `--require-token` index only what
the site loads, from source: the stylesheets the selected website design
links (`designShellStylesheets`, shared with the scaffold's port report), the
compiled tokens when it links `/tokens.css`, and system sheets a site file
imports; never `bundle.include`, an unlinked sheet or anything under `dist/`.
A shoot that drops a workspace site also drops the unedited guidance its
scaffold wrote outside `site/`, by the hashes in the site's record. `package.json` `emdashTemplate`
publishes the template version beside `hostContract` and must equal
`templates/emdash/site.json` `version`: a template change an installed site
would need to receive raises `version` in both places and adds a `history`
entry saying what changed.

Template version 2 declares article sections in `site/sections.json` (section
contract 1) and their shared fields and features in `site/section-schema.json`.
Its pure `src/lib/articles/sections.mjs` helper validates that data and generates
the seed; consumer checks read the same JSON without executing site code.
`npm run sections:sync` is an
explicit site command; build, dev and consumer check validate without silently
changing source. The design integration injects routes per prefix from the
shared `src/routes/articles/` modules and exports the section contract beside
its pages. The consumer preview derives routes and design pairs from the
current declaration, preserving the authored consumer manifest. Keep package
`emdashWorkspaceContract: 2` and `emdashSectionsContract: 1` in step with these
exports. See `docs/emdash.md` for the existing-database boundary.

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
and `.timds/starter.json` in the client repository. A fresh `init` records it,
and every `upgrade` syncs it from then on. The toolkit supports only systems
at or above the starter floor: a starter-based system whose record is missing
or has no `level` (or one below the floor) predates starter levels, and
`upgrade`, `starter sync`, `starter migrate`, `feed` and `shoot` refuse it with
`below_floor` before writing anything, while `check` and `doctor` only warn.
It is regenerated from the current starter. Never add code that recognizes,
migrates or keeps building a shape from before the floor. Inside that boundary the
toolkit may touch exactly four kinds of things: the starter plumbing
(the stub `scripts/build.mjs`, `check.mjs` and `dev.mjs`, which call the
renderer in the package, `@dtconcepts/timds/viewer` in `src/viewer.mjs`, and
`src/scripts/compose.js`, `src/styles/canvas.css`, `src/styles/viewer.css`),
which a fresh `init`
records as the toolkit's outright (`plumbing: "toolkit"`: every sync brings
it to stock, replacing a local change and reporting it, never halting) and
the `"recorded"` mode keeps by hash (replaced only while the file
matches a hash the toolkit wrote); the structure catalogs `src/site.json`
and `src/formats.json`, merged three ways against the recorded stock baseline
so entries the client lacks are appended (pages as `planned`), fields still
equal to the baseline advance, and anything the client changed is kept (and
reported when the stock value moved, not on every sync), with nothing
removed, reordered, or retitled; and the authored overview
fragments the starter ships
(`starterManagedFragments`), written when the sync adds or authors their page
and refreshed only while unmodified. `src/layout.html` only gains a missing
stock stylesheet link; and the numbered starter steps (`starterSteps` in `src/starter.mjs`, applied by
`src/starter-steps.mjs` and published as `describeToolkitRelease().starterSteps`),
which change defaults a system never chose through a closed vocabulary
(`remove-file`, `set-site-field`, `set-page-field`) and record the level reached
in `.timds/starter.json` (`level`, `declined`). Every other fragment,
`tokens.json`, `system.css`, and the rest of authored source stay outside the
boundary. The site's `home`
selection, including its absence, is authored routing: the merge and parent
feeds preserve it so existing links and guidance routes remain stable; only a
declared visible step may set it, and only through an explicit
`timds starter migrate --accept`. Recorded plumbing
that was customized is asked about file by file when the sync or upgrade runs
in a terminal, and otherwise reported and replaced only by an explicit
`timds starter sync --force <path>` that names each file; `upgrade --force` covers the managed boundary
and never reaches starter files, and a customized overview fragment is the
system's own page, never replaced. The sync refuses to run over uncommitted
changes to the files it writes. A sync whose `check` fails is rolled back
whole, and `upgrade` runs
it before touching managed files so a failed sync aborts the upgrade with the
repository as it was. A structural change to `templates/starter` therefore
reaches existing systems through this sync; do not add another one-shot
migration for it. A change to a default a system may already hold (a moved
stock title, a field the merge cannot advance, a file to retire) is a new
starter step: raise `STARTER_LEVEL`, add the step to `starterSteps` as data
from the closed vocabulary (steps cover `STARTER_FLOOR + 1` through
`STARTER_LEVEL`), keep `starter-levels.test.mjs` proving the steps' JSON gives
what the commands write, and mark it `visible` when it changes what visitors
see (upgrade and sync never apply a visible step with something to change).
Raising the floor prunes the steps at or below it. A new operation or
requirement raises `hostContract` in `package.json`. The viewer, build,
check and dev logic live in `src/viewer.mjs`; the starter's scripts are stubs
that call it, and a system's extra build steps are `timds.json`
`workspace.after.build` commands, never a module the build imports. `feed`
carries no code: it never writes plumbing into an offshoot.

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

## The starter scaffold is the canonical structure

`templates/starter/` is where a Design System's structure is designed. Its
views, sidebar groups, catalogs, page treatment and managed fragments are the
toolkit's own, and the starter-based client systems take every change through
`starter sync` on upgrade, which is what proves the scaffold against real
systems. A fleshed-out client system is a source of ideas when designing a new
view, catalog or template family, not an obligation: nothing here tracks one
or is kept in step with one.

When borrowing from any client system, take structure, never content. Client
names, domains and repository names never enter this public repository.

- Views live in `src/site.json`: ids, labels, blurbs, order, sidebar groups,
  and page lists. Keep a page title unless it is ambiguous outside its
  sidebar group (`LinkedIn specs`, not `Specs`). A page that needs the
  client's mark, photos, or copy stays `planned`. Author a view's overview
  when it carries what every system needs: principles, the catalog table,
  and how a preview is built.
- Single-owner catalogs are JSON the viewer validates: asset sizes in
  `src/formats.json`, with every entry naming its page. A page never
  restates a size or a token.
- Preview engines and shared atoms are script-free CSS under `src/styles/`,
  written against the starter tokens with no color literals.
- Platform facts (standard ad sizes, upload limits, print trims) may be
  carried over; say on the page that they need confirming before use.
- Leave out client copy, names and addresses, photos and focus points,
  campaign content, ink builds, field-specific compliance text, and
  product-specific sub-systems.

Some of the starter's shape is deliberate and worth keeping in mind when a
client system is organized differently. A product-specific utility theme,
such as an admin theme, is left for the client to add when it has one.
Typography and color are Brand pages rather than token pages under Web, and
the Web view lands on its first authored page. Illustration, modules,
sections and similar libraries go beyond the starter's component set and are
authored per client; page archetypes are website designs under
`src/designs/`. The Use view is toolkit guidance on every way to consume a
system, with no client counterpart.

When adding a view, a page, or a catalog:

1. Update `src/site.json`, `src/formats.json`, the stylesheets, and the
   fragments. A fresh scaffold must still pass `check` with exactly its two
   expected warnings (no voice page, no annotated logo) and no untyped prose.
2. Keep the scaffolded `templates/design-system-AGENTS.md`,
   `design-system-README.md`, the edit skill, and this repository's
   `CLAUDE.md` describing the new structure.
3. A changed plumbing file or managed fragment needs its hash bookkeeping:
   starter sync refreshes a file only while its bytes match a stock version
   the toolkit shipped, and a system's `.timds/starter.json` can sit behind
   its files, so `legacyStarterFileHashes` in `src/starter.mjs` must list
   every version a release at or above the floor shipped (it starts empty at
   the floor; the history check walks the releases from the first one that
   carries starter levels). After changing a template
   that a release already shipped, run
   `node scripts/check-starter-history.mjs --print` and add the entries it
   lists; CI runs the check and fails on a gap. A new authored page under a
   starter view goes in `starterManagedFragments`; a new stylesheet the
   layout must link goes in the plumbing table and the layout link list.
4. Update the starter assertions in `src/core.test.mjs` (page ids, page
   counts, rendered tables) and `src/mcp.test.mjs` (the stylesheet list),
   then run `npm test` and `npm run pack:check`.

## The brand kit mirrors its slot contract

`templates/brand-kit/` is a second starter overlay, selected by
`init --starter brand-kit`; it does not copy the ordinary starter's authored
content. It mirrors the slots, samples, views, page ids and exact stock paths
exported by `src/brand-kit.mjs`. Change the overlay, export, declarations,
rendering tests, docs and skills together in one release. Shared plumbing
stays in the ordinary starter; the package viewer (`src/viewer.mjs`) imports
that pure source module, so the viewer and integrations use one contract.

`.timds/starter.json` records `starter` (`starter` when absent). Starter sync
selects catalogs, managed fragments and stock template paths from it. The kit manages no fragment: its
pages are seed-only, written once by `init --starter brand-kit` and authored
from then on on the published kit parent (the toolkit keeps code, the parent
keeps design), so no sync or upgrade writes, refreshes, records or reports
them, and pages its catalog gains are appended as planned without a fragment.
Kit children follow the parent's pages through `feed`. A brand-kit structure
offshoot retains the kind. No upgrade changes kinds or replaces authored token
maps, copy, media, evidence, system styles, or customized fragments. The kit's
`src/copy.json` is designer-owned data that may be explicitly declared stock;
its existence does not add it to the upgrade write boundary. Keep the
ordinary starter's compatibility and the kit's stock and inverted-palette
rendering checks covered. See `docs/brand-kit.md`.

## Designers design in the system, developers ship it in the product

The scaffolded `AGENTS.md`, `README.md`, and skills all describe one
division of labor, and every change here keeps it: designers do all of
their work in the Design System repository and never run the toolkit
themselves (the designer skills run it for them); an operator's merge is
the release; a developer carries each release into the product by moving
its pin and porting the website designs onto the product's stack. A design
is the reference a port must match, never the production page. When the
toolkit gains a command a designer or a developer meets on that path, the
matching skill and template section change in the same release.

Never add client-specific content, credentials, private URLs, access tokens,
media, or portal-internal implementation to this public repository or npm
package.

Release tags must exactly match `package.json` as `v<version>`. Keep
`publishConfig.access` public and use the tracked GitHub Actions trusted
publisher workflow rather than a long-lived npm token.

Hosted source initialization (`init --standalone --provider hosted`) owns
Wrangler preview configuration and `_headers` instead of GitHub workflows.
Local/git initialization keeps its existing release automation. Session API
version 1 is implemented in `src/hosted.mjs`; CLI and MCP commands must share
that implementation and keep files/token boundaries covered by tests.

Offshoots record their immediate parent release, structural feed baseline
and the hash of every declared stock file it last wrote (`files`, omitted
while the child's selected toolkit predates the running release, which feed
refuses until it is upgraded) in `.timds/parent.json`. Check validates it without mutation; sessions cannot
create, edit or delete it. `.timds/stock.json` is a designer-authored exception
under `.timds`: exact existing regular `src/pages/**/*.html`,
`src/styles/**/*.css`, `src/layout.html` and `src/copy.json` paths only, never
globs or links. Declared files stay outside every ordinary upgrade.
Structure creation includes those declarations, verified recorded plumbing,
whole formats, planned pages and token `initial` placeholders reported as
unresolved warnings. `shoot` creates a local independent repository without
registering or publishing; `feed` reuses starter merges against the parent's
baseline and refreshes declared stock only while the child's file still equals
its recorded hash; a changed or removed stock file is a graft and is kept, and
force never reaches stock or other authored source. A record without `files`
is adopted from the release it names. Parent baselines and hashes advance only
after a successful check, with rollback on failure. Ordinary
starter sync/upgrade keeps offshoot plumbing current and preserves its parent
record and catalog baselines; it still maintains missing stock stylesheet links
within the narrow layout boundary.
`sever` requires confirmation and removes only
the local parent record; hosted catalog severing remains a host operation.
Public derived readers and provenance expose lineage or null, never baselines
or stock hashes.
See `docs/offshoots.md` for the contract and command details.


The multiplayer contract migration is an explicit exception to the authored
aggregate boundary above: fresh init and upgrade split tokens/media into
key maps, recording `.timds/contract-layout.json`, and keep generated root
`tokens.json`/`media.json` compatibility views. Group files are authored;
upgrades never replace them. Reference validation and aggregate generation
live in `src/contract-groups.mjs`. Consumer `init --draft-preview` explicitly
adds its browser module and, when available, the root HTML hook; ordinary
upgrade never edits either product-owned file. Draft consumer updates replace
only the ignored bundle and never the tracked published pin.
