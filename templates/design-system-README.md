# Design System

__CONTRACT_DESCRIPTION__

`AGENTS.md` is the working contract for anyone, human or AI agent, who edits
this system: where things live, how pages reach the machine-readable layer,
and what is protected. Read it before the first change.

## Installation mode

The selected toolkit is recorded in `.timds/installation.json`. Binary mode
(`schemaVersion: 2`, `mode: "binary"`) pins an exact `timds-cli` release and
needs no separately installed Node or npm for stock commands. Use
`timds-cli --version` and `timds-cli doctor` to compare running and selected
versions. Npm-specific installation and dependency-upgrade steps below apply
only to npm mode. For binary upgrades, install a checksum-verified executable,
then run `timds-cli upgrade --version EXACT_VERSION`; executable replacement
and workspace selection are separate. Existing npm systems preview migration
with `timds-cli installation adopt --binary`, then explicitly use `--apply`.
Authored documentation is not rewritten by adoption or upgrade.

## Designers design here, developers ship it

Designers do all of their work in this repository and never touch the
toolkit: the skills under `.agents/skills/` (and, for Claude Code, the
`.claude/skills` link to them) run it for them.

| Say | Skill | Result |
| --- | --- | --- |
| "Let's start" | `design-start` | Installed, built, local preview open, change branch ready |
| "Here is the new logo" | `design-media` | Staged, published, placed on the page, in the brand kit |
| "It's done" | `design-ship` | Validated, reviewed at both widths, changelog note written, draft pull request open |
| "Give it to the developers" | `design-handoff` | A brief naming the version to pin and the designs to port |

In a standalone repository, merging a pull request releases a dated version
(`2026.10.12-1`: the day and the release number that day) and publishes it.
An embedded system (`design-system/` inside a product repository) has no
release automation: its CI only validates, and the merge lands the rebuilt
`design-system/dist/` in the product itself. The production product
pins a release and a developer carries it across there, with its own
`timds-update-design-system` skill. `AGENTS.md` names the product under
"Handing a release to production".

## First local run

```bash
npm install
__TIMDS_CLI__ doctor
__TIMDS_CLI__ check
__TIMDS_CLI__ brand
__TIMDS_CLI__ dev
```

`npm install` creates the lockfile in a fresh scaffold; commit it and use
`npm ci` afterwards. `check` builds and validates the artifact. `brand` prints
the derived brand kit with a fix for every gap; a fresh scaffold reports no
logo and no voice guidance until you add them in the ordinary starter;
a brand kit has an authored Voice page and reports its assumed sample voice. `dev` starts the
repository-declared authoring server. `preview` serves the exact generated
static artifact that TimDS will publish.

## Starter viewer

New contracts include a dependency-free starter viewer under `src/` and
deterministic Node.js commands under `scripts/`. The starter exists so the
contract builds and validates immediately; replace its neutral tokens and
examples with approved client foundations rather than treating them as brand
guidance. It is organized as views (Brand, Web DS, Digital DS, Social DS,
Print DS, Use), each a list of pages, all rendered into one shared shell. Some pages are authored from the starter
tokens; the rest are declared as planned and built once someone writes them.

| Path | Purpose |
| --- | --- |
| `tokens/<group>.json`, `media/<group>.json` | Authored token and media key maps; the build emits each token as a `--group-name` CSS custom property in `tokens.css`. `tokens.json` and `media.json` are generated views of the groups, never edited |
| `src/site.json` | The views and their pages, authored or planned; drives the navigation and the overview |
| `src/formats.json` | Every print sheet and screen canvas the system produces, each tied to its page; `{{formats:GROUP}}` tables and `{{canvas:ID}}` previews read it |
| `src/pages/` | One content fragment per authored page, such as `src/pages/brand/color.html` |
| `src/designs/` | Website designs: whole pages in HTML with JavaScript on the system's stylesheets, one directory per design, built to `/designs/` |
| `src/layout.html` | The shell every page shares |
| `src/styles/system.css` | The system's own styles, the base styles and components a product adopts |
| `src/assets/` | Small optimized assets such as logos, copied into the artifact |
| `scripts/build.mjs`, `dev.mjs`, `check.mjs`, `src/scripts/compose.js`, `src/styles/canvas.css`, `src/styles/viewer.css` | The build, dev and check stubs that run the TimDS renderer from the package, composer plumbing, the format preview engine, and the documentation chrome, all managed by starter sync and replaced on upgrade (an extra build step goes in `timds.json` `workspace.after.build`) |
| `CHANGELOG.md` | Release notes, rendered at `/changelog/`; add to `## Unreleased`, leading with the area the change touches |
| `media-local/` | Ignored full-resolution originals, staged by `assets add` |

The starter `dev` server builds once and serves on `http://127.0.0.1:4321`. It
does not watch files, so rerun `__TIMDS_CLI__ check` after an edit and reload.

Fresh scaffolds select `home: "use"` in `src/site.json`, serving Use at
`/` and the overview at `/overview/`. With `home` unset, the overview stays at
`/` and Use stays at `/use/`. Starter sync, upgrade and parent feeds preserve
this routing choice, including its absence, so existing authored links keep
working.

## Brand-kit systems

When the starter record says `brand-kit`, a fresh kit opens on Landing and
organizes Brand, Web, Social, Ads, Email, Print, Events, Decks and Use separately.
Its stock pages read tokens, copy and media slots in Minimal, Accent, Bold and
Photo treatments. The designer's agent fills the data and records evidence;
the owner reviews what is observed, assumed or unresolved. Copy stays in
`src/copy.json`, small approved local media stays in `src/assets/` with its
catalog record, and the Evidence page keeps captured facts and decisions.
Use has Landing (at `/` by default), Compose at `/use/compose/`, and Install.
The overview is preserved at `/overview/` with the default home choice.
The promoted “Start making” action opens Compose, whose presets include every
kit format, including Print, Events and Decks. Landing cards select a format
for the composer. Foundation and channel pages show previews before the Spec
drawers with slot evidence and technical tables. Whole-page Designs
begin empty and are authored for this system before a developer ports a release
into the product. An upgrade keeps shared plumbing current and preserves these
authored values and pages.

## Website designs

The system is designer-owned down to the pages. A whole website, or any set
of screens, is designed under `src/designs/<design>/` in HTML with JavaScript on the
system's own stylesheets, one file per route and state
(`pages/contact.html`, `pages/contact.sent.html`), and an engineer ports it to
whatever runs production. `check` builds the designs to `/designs/` and
allows JavaScript interactions and refuses inline styles,
undeclared classes, relative references. The ordinary starter ships one sample design
to replace; a brand kit begins with an empty Designs directory; a system scaffolded before designs existed adopts them with
`__TIMDS_CLI__ designs init`. `AGENTS.md` holds the rules.

The scaffold itself stays current: `.timds/starter.json` records the starter kind and its
scripts, viewer stylesheets, views, and asset formats TimDS wrote, and every
`__TIMDS_CLI__ upgrade` brings the stock scripts and viewer stylesheets to
the installed release (they are TimDS's in a fresh scaffold; a local change
to them is replaced and reported) and appends new views, planned pages, and
formats without touching what this system declares. A
system scaffolded before the record existed opts in once with
`__TIMDS_CLI__ starter sync`. `__TIMDS_CLI__ starter status` reports the
starter level; a step that changes what visitors see waits for
`__TIMDS_CLI__ starter migrate --accept ID` or `--decline ID`.

## Offshoots

Local `shoot` currently runs through the npm distribution; do not substitute
`timds-cli` for that creation step. After reviewing and committing the new npm
offshoot, binary users explicitly adopt it with
`timds-cli installation adopt --binary --apply`. Feed and sever retain the
selected execution mode.

An offshoot starts from a parent's immutable published source and keeps a
parent link for later updates. The designer's agent runs the toolkit on the
designer's behalf. To create a new local system:

```bash
__TIMDS_CLI__ shoot example/core --system-id example/child --root ../child --mode structure --version RELEASE
```

The destination must be new or empty. An absolute or `./` / `../` local Git
checkout can replace the system ID; pass its `--source-id UUID` and optionally
`--ref REF` to select a committed tree. New child IDs are lowercase. Custom
dependencies install with lifecycle scripts disabled; `--install` explicitly
permits a reviewed custom installer or npm lifecycle scripts. Creation still
runs the declared build/check. Full mode carries every source layer. Structure
mode carries
verified toolkit plumbing, navigation, whole format catalogs, token names
and role mappings. Missing page bodies become planned pages; values become
CSS `initial`, which `check` reports as unresolved warnings. Media and website
designs are omitted and neutral shell files fill missing stock. These warnings
describe foundations still to author before the system is a finished brand.

The optional parent-authored `.timds/stock.json` explicitly declares reusable
structure: `{"schemaVersion":1,"paths":["src/styles/system.css"]}`. Publish
the declaration before shooting off. Paths name exact existing regular HTML
files under `src/pages/`, CSS files under `src/styles/`, `src/layout.html`, or `src/copy.json`.
Globs, links, media, designs and configuration are refused.

`.timds/parent.json` records schema version 1, the parent system ID and source
UUID, version, source commit, mode, `baseline: {site, formats}` and `files`,
the hash of each declared stock file the parent last wrote. It is
protected ancestry, preserved by starter sync and upgrade. For an offshoot,
those commands update toolkit plumbing while leaving catalogs and declared
stock to the parent feed and every other page to this system. Layout maintenance remains limited
to missing stock stylesheet links and the changelog version-chip link.

`__TIMDS_CLI__ feed [--version RELEASE]` advances unchanged catalog fields,
appends missing entries with pages planned, and keeps local edits as grafts.
Use `--from ../parent` for a local committed parent tree with the saved source
UUID. A reported graft shading a parent change can be kept or edited to let
the parent through. Plumbing follows its ownership record; `--force PATH`
reaches only named plumbing. A declared stock file is refreshed while this
system's copy is unmodified; a changed or removed copy is a graft and stays,
and tokens, media, designs and undeclared files are never replaced. Feed
requires clean files where it writes, checks the
workspace and rolls its writes back on failure. The baseline advances only
on success.

`__TIMDS_CLI__ sever` permanently removes the local parent baseline after
confirmation; `--yes` records explicit confirmation. Source remains and the
system becomes independent.

Declare framework-specific local commands as argument arrays in `timds.json`:

```json
{
  "workspace": {
    "install": ["npm", "ci"],
    "dev": ["npm", "run", "dev"],
    "build": ["npm", "run", "build"],
    "check": ["npm", "run", "check"]
  }
}
```

The commands execute only on a designer workstation or in isolated CI (`check`, `upgrade` and `starter sync` run them there).

The design system should use the client repository's existing framework. For example, an Astro client site can declare commands that target the site package from this directory:

```json
{
  "workspace": {
    "install": ["npm", "--prefix", "../client-site", "ci"],
    "dev": ["npm", "--prefix", "../client-site", "run", "dev"],
    "build": ["npm", "--prefix", "../client-site", "run", "build:timds"]
  }
}
```

TimDS consumes only the resulting `__DIST_PATH__`; Astro or another framework remains a repository-owned authoring detail.

## Full-resolution public media and B-roll

Do not add large originals to Git or `dist/`. Put them under the ignored
`media-local/` workspace and give each one a stable logical key (the file
path is read from the repository root):

```bash
__TIMDS_CLI__ assets add __MEDIA_LOCAL__interview.mp4 \
  --key founder-interview \
  --title "Founder interview" \
  --tags interview,b-roll
```

The starter viewer does not read the ignored original: `{{media:KEY}}`
resolves to a small optimized copy under `src/assets/`, and only a framework
viewer that serves staged files with `localMediaResponse` shows it locally.
Publishing the staged file to public object storage needs a TimDS host; see
"If you use TimDS Cloud" below.

TimDS uses `ffprobe` during `assets add` to record timed-media duration and video
dimensions.

## Optional video production

Video is optional and off in a new contract. `__TIMDS_CLI__ video init` adds
the `video` block to `timds.json` and scaffolds the contract, board catalog,
asset map, and a lab sample under `video/`.

When `timds.json` enables `video`, this repository owns the client-specific
contract, asset choices, scripts, publishing data, captions, and production
records. The installed `@dtconcepts/timds` package supplies the video engine and
commands directly. An optional contract-owned `producer` block can supply
client role labels, structure, CTA copy, and asset vocabulary to TimDS's
programmatic producer/compiler without adding client runtime code:

```bash
__TIMDS_CLI__ video doctor
__TIMDS_CLI__ video check TOPIC
__TIMDS_CLI__ video lab NAME --plan
__TIMDS_CLI__ video lab NAME
__TIMDS_CLI__ video studio TOPIC
__TIMDS_CLI__ video render TOPIC
```

`video lab` previews a `video/lab/` compile request the way an automated Video
Lab ships it: compiled through the `producer` block, timed silently, footage
and cover chosen from the registered catalog, and opened in Remotion Studio
with this repository's components. `video check` compiles every lab input.

TimDS supplies the default Remotion component set. To begin with an identical
client-owned copy that can evolve independently, generate one snapshot:

```bash
__TIMDS_CLI__ video components init
```

The command writes and declares one complete visual component module in the
Design System. TimDS upgrades never overwrite it. The command refuses to run
again unless `--force` is explicitly used to discard client changes and reset
to the currently installed defaults. A client may instead declare one reviewed
partial override module at `video.components`. Do not create a second package,
copied Remotion engine, rendering script, or per-topic TSX file. Generated
working files and review packages stay under ignored `video-local/`.

## Before review

```bash
__TIMDS_CLI__ check
__TIMDS_CLI__ brand
__TIMDS_CLI__ preview
__TIMDS_CLI__ diff
```

When asked to submit the reviewed local change:

```bash
__TIMDS_CLI__ submit --message "Describe the design-system change"
```

Submission creates a draft pull request. In a standalone repository, an
operator's merge accepts the change for automatic publication; rollback
remains a separate operator decision.

## Linked consumer repository (standalone repositories)

In a standalone repository every accepted change on `main` becomes a
release: CI synchronizes the version and publishes that exact commit. When
`timds.json` also declares a `consumer`, the same run then opens or
refreshes a pull request in that product that moves its pin to the release.
Configure a `TIMDS_CONSUMER_TOKEN` repository secret with contents and
pull-request access to that consumer repository.

The pin takes one of two forms. A product with a **published pin**
(`designSystem.version` in its `timds.consumer.json`) is moved to the
release through its own toolkit, which fetches and verifies the published
bundle into its gitignored `design-system/` directory; no Design System
bytes enter the product's repository. A product that still carries this
system as a **git submodule** gets its `design-system` gitlink advanced to
the exact commit; it owns only its `.gitmodules` record and the reviewed
gitlink, and a same-host relative URL such as `../client-design-system.git`
lets authenticated HTTPS and SSH clones both resolve within the
organization. `timds consumer migrate` in the product moves it from the
submodule to a published pin.

Day-to-day changes go under `## Unreleased` in `CHANGELOG.md`, each note
led by the area it touches (`Brand · Color: ...`, `Print DS: ...`). Merging
an accepted change rolls those notes into the next version automatically:
the UTC day of the release and its number that day (`2026.10.12-1`, then
`2026.10.12-2`). The built system shows the history at `/changelog/`,
linked from the version in the app bar, and publishes it as
`changelog.json` for products moving their pin. Use `./scripts/release.sh`
only when intentionally releasing at a chosen moment or under a chosen
later version. Publication and the consumer update remain separate,
ordered CI work.

## Toolkit upgrades

The repository selects the bounded TimDS `0.1.x` package line and commits its
resolved lockfile. It keeps only the repository-local AI skills and installation
record in Git. When a DT Concepts operator selects a new release line, keep the
package requirement at `0.1.x` and update the resolved lockfile before syncing
those managed files:

```bash
npm run timds -- upgrade --version 0.1.x
npm run timds -- defaults
npm run timds -- defaults --apply
```

The selection command resolves one exact patch, restores the bounded requirement,
installs with `npm ci`, synchronizes adopted managed files, and checks the runtime
graph and workspace. Bootstrap an older CLI once with `npm update @dtconcepts/timds`
and ordinary `upgrade`. Adopt `--own-runtime` once to align existing direct
React/Remotion declarations. Define `check:timds-upgrade` for project producer,
render, and visual checks. Review and commit the exact tested lockfile; ordinary
PR checks and publication use it unchanged.

Shared video components are the default. To consolidate copied components,
preview `video components migrate`, then apply with `--apply` on a feature branch.
Review the inventory, retained overrides, and horizontal/vertical images full
frame and over footage. Rollback bytes live in `.timds/component-migration/`;
revert the migration commit to restore the original contract and components.
Custom overrides require reviewed exact `runtime.testedVersions`. Deploy the
same compatible locked TimDS release on producer and renderer hosts.

Opt into draft dependency PRs with `upgrade --dependency-prs` and configure
`TIMDS_UPGRADE_TOKEN` in repository settings. This workflow does not merge or
deploy. Fleet registrations and credentials belong outside the public package.

Run defaults application on a feature branch. It migrates shared publishing
wording and budgets, retaining inherited client policy and recording supplied
values and persistent override paths in `.timds/defaults.json`. Commit that
baseline with the contract so updates advance unchanged defaults and keep client
choices, even when a later default matches them. Review the diff and run `__TIMDS_CLI__ check`.

An older standalone repository adopts the managed automatic release flow with
`npm run timds -- upgrade --root . --auto-release`. The command refuses
customized release files unless replacement is explicitly forced.

The CLI runs from `node_modules`; do not commit that directory or a copied
`.timds/cli` tree. Besides the package pin, the managed skills and the
installation record, an upgrade writes only what the starter sync above
owns: the stock scripts and viewer stylesheets, entries appended to
`src/site.json` and `src/formats.json`, the managed overview and Use
fragments while they are unmodified, a missing stylesheet or changelog link
in `src/layout.html`, the `.timds/starter.json` record, and the generated
`tokens.json` and `media.json` views when it migrates the aggregates into
groups. It never rewrites `timds.json`, the authored token and media groups,
other pages, `system.css`, framework configuration, this documentation, or
the generated artifact. Review and commit the tooling diff separately.


## Multiplayer source contract

Agents author key maps in `tokens/<group>.json` and `media/<group>.json`.
`tokens.json` and `media.json` are generated compatibility views when
`.timds/contract-layout.json` exists. `upgrade` migrates the earlier aggregates;
`check` enforces group layout and reference integrity. Do not edit generated
views. Token values may reference another key with `{color.brand.600}`.

Product repositories remain pinned to their published version until the
developer changes that pin.

## If you use TimDS Cloud

Everything above works with a local or Git checkout and no host. The rest of
this section applies when the system publishes media or releases through a
TimDS host, or works in hosted sessions. `media.portalUrl` in `timds.json`
names the host used for media upload, `extract --publish`, and release
publication.

### Release publication (standalone repositories)

Publication needs the `artifact.publishRef` a standalone `timds.json`
declares; an embedded manifest has none, so `publish` refuses there and the
product consumes the committed `design-system/dist/` directly.

After committing and pushing source changes, an authorized operator runs
`__TIMDS_CLI__ publish` to build, push the declared artifact ref and request portal
publication. Sign in with `__TIMDS_CLI__ login`, or configure an unbound
operator `TIMDS_ACCESS_TOKEN` in CI. Designer/website and consumer tokens cannot
promote a release.
The artifact ref must be separate from the remote default branch. Publication
refuses to push if it cannot resolve that branch name.

The portal's **Automatic updates** setting controls promotion. When on, the
command prints the root and pinned URLs and verifies the public release stamp.
When off, it reports a waiting candidate and a portal link for operator
publication. Repeating an already live identical release is a no-op.
`extract --publish` uploads CDN files separately. Managed release workflows
extract, push the exact artifact, then request promotion before updating a
linked consumer. A missing operator token fails the run before the version
advances.

### Publishing media

Authenticate once and upload the staged file to public TimDS object storage:

```bash
__TIMDS_CLI__ login
__TIMDS_CLI__ assets publish
```

`submit` performs the publish step automatically before building and preparing
the pull request. Git receives only the stable public record in the media
catalog (`media/<group>.json`, with `media.json` regenerated from it).
Staging remembers the catalog checksum. Publication refuses stale replacements,
including older staging entries without a baseline, and never removes another
logical key when storage reuses its asset ID. To keep the published asset,
remove its stale entry from `.timds/local-media.json` or run
`__TIMDS_CLI__ assets pull KEY --force`. Restage with `assets add FILE --key KEY`
only after reviewing an intentional replacement; keep optimized derivatives
under their existing keys.

Backfill an older catalog from its stable public URLs without
re-uploading objects:

```bash
__TIMDS_CLI__ assets backfill-metadata
```

On a fresh workstation, restore a published original with:

```bash
__TIMDS_CLI__ assets pull founder-interview
```

### Offshoots and hosted sessions

Feed and sever run outside hosted sessions. A severed hosted system
additionally needs its host catalog lineage updated before publication;
`sever` does not change the host catalog.

Humans direct work, inspect status/history, publish and roll back. In hosted
systems the agent uses `timds_*` MCP tools to claim paths, start or join a
session, update and submit with the human intent in `note`. Claims are advisory.
A named draft has members and no expiry; `start --draft NAME` targets it.
Read active work before editing. Resolve exactly the returned conflict key
with `PATH#KEY=mine|theirs`; never replace unrelated changes. Return the live
URL and frozen submission preview to the human.
