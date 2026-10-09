# Design System

__CONTRACT_DESCRIPTION__

`AGENTS.md` is the working contract for anyone, human or AI agent, who edits
this system: where things live, how pages reach the machine-readable layer,
and what is protected. Read it before the first change.

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
logo and no voice guidance until you add them. `dev` starts the
repository-declared authoring server. `preview` serves the exact generated
static artifact that TimDS will publish.

## Release publication

After committing and pushing source changes, an authorized operator runs
`__TIMDS_CLI__ publish` to build, push the declared artifact ref and request portal
publication. Sign in with `__TIMDS_CLI__ auth login`, or configure an unbound
operator `TIMDS_ACCESS_TOKEN` in CI. Designer/website and consumer tokens cannot
promote a release.

The portal's **Automatic updates** setting controls promotion. When on, the
command prints the root and pinned URLs and verifies the public release stamp.
When off, it reports a waiting candidate and a portal link for operator
publication. Repeating an already live identical release is a no-op.
`extract --publish` uploads CDN files separately. Managed release workflows
extract, push the exact artifact, then request promotion before updating a
linked consumer. A missing operator token fails the run before the version
advances.

## Starter viewer

New contracts include a dependency-free starter viewer under `src/` and
deterministic Node.js commands under `scripts/`. The starter exists so the
contract builds and validates immediately; replace its neutral tokens and
examples with approved client foundations rather than treating them as brand
guidance. It is organized as views (Brand, Web DS, Digital DS, Social DS,
Print DS), each a list of pages, all rendered into one shared shell. Some pages are authored from the starter
tokens; the rest are declared as planned and built once someone writes them.

| Path | Purpose |
| --- | --- |
| `tokens.json` | Authored tokens; the build emits each as a `--group-name` CSS custom property in `tokens.css` |
| `src/site.json` | The views and their pages, authored or planned; drives the navigation and the overview |
| `src/formats.json` | Every print sheet and screen canvas the system produces, each tied to its page; `{{formats:GROUP}}` tables and `{{canvas:ID}}` previews read it |
| `src/pages/` | One content fragment per authored page, such as `src/pages/brand/color.html` |
| `src/designs/` | Website designs: whole pages in HTML with JavaScript on the system's stylesheets, one directory per design, built to `/designs/` |
| `src/layout.html` | The shell every page shares |
| `src/styles/system.css`, `src/styles/canvas.css`, `src/styles/viewer.css` | The system's own styles, the format previews, and the documentation chrome |
| `src/assets/` | Small optimized assets such as logos, copied into the artifact |
| `scripts/build.mjs`, `dev.mjs`, `check.mjs`, `viewer.mjs` | The `workspace` commands declared in `timds.json` and the renderer they share |
| `CHANGELOG.md` | Change notes; add to `## Unreleased` |
| `media.json`, `media-local/` | Published media catalog and ignored originals |

The starter `dev` server builds once and serves on `http://127.0.0.1:4321`. It
does not watch files, so rerun `__TIMDS_CLI__ check` after an edit and reload.

## Website designs

The system is designer-owned down to the pages. A whole website, or any set
of screens, is designed under `src/designs/<design>/` in HTML with JavaScript on the
system's own stylesheets, one file per route and state
(`pages/contact.html`, `pages/contact.sent.html`), and an engineer ports it to
whatever runs production. `check` builds the designs to `/designs/` and
allows JavaScript interactions and refuses inline styles,
undeclared classes, relative references. The starter ships one sample design
to replace; a system scaffolded before designs existed adopts them with
`__TIMDS_CLI__ designs init`. `AGENTS.md` holds the rules.

The scaffold itself stays current: `.timds/starter.json` records the starter
scripts, viewer stylesheets, views, and asset formats TimDS wrote, and every
`__TIMDS_CLI__ upgrade` brings the stock scripts and viewer stylesheets to
the installed release (they are TimDS's in a fresh scaffold; a local change
to them is replaced and reported) and appends new views, planned pages, and
formats without touching what this system declares. A
system scaffolded before the record existed opts in once with
`__TIMDS_CLI__ starter sync`.

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

The commands execute only on a designer workstation or in isolated CI. TimDS never executes repository code during sync.

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
`media-local/` workspace and give each one a stable logical key:

```bash
__TIMDS_CLI__ assets add media-local/interview.mp4 \
  --key founder-interview \
  --title "Founder interview" \
  --tags interview,b-roll
```

The authoring viewer reads the ignored local file. Authenticate once and upload
the staged file to public TimDS object storage:

```bash
__TIMDS_CLI__ auth login
__TIMDS_CLI__ assets publish
```

`submit` performs the publish step automatically before building and preparing
the pull request. Git receives only the stable public record in `media.json`.
Staging remembers the catalog checksum. Publication refuses stale replacements,
including older staging entries without a baseline, and never removes another
logical key when storage reuses its asset ID. To keep the published asset,
remove its stale entry from `.timds/local-media.json` or run
`__TIMDS_CLI__ assets pull KEY --force`. Restage with `assets add FILE --key KEY`
only after reviewing an intentional replacement; keep optimized derivatives
under their existing keys.

TimDS uses `ffprobe` during `assets add` to record timed-media duration and video
dimensions. Backfill an older catalog from its stable public URLs without
re-uploading objects:

```bash
__TIMDS_CLI__ assets backfill-metadata
```

On a fresh workstation, restore a published original with:

```bash
__TIMDS_CLI__ assets pull founder-interview
```

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
operator's merge accepts the change for automatic patch publication; rollback
remains a separate operator decision.

## Linked consumer repository

When `timds.json` declares a `consumer`, every accepted change on `main`
becomes a patch release. CI synchronizes the version, publishes that exact
commit, then opens or refreshes a pull request that advances the consumer's
pinned `design-system` gitlink. Configure a `TIMDS_CONSUMER_TOKEN` repository
secret with contents and pull-request access to that consumer repository.

The consumer owns only its `.gitmodules` record and reviewed gitlink. Prefer a
same-host relative URL such as `../client-design-system.git`, so authenticated
HTTPS and SSH clones both resolve within the organization.

Day-to-day changes go under `## Unreleased` in `CHANGELOG.md`. Merging an
accepted change rolls those notes into the next patch automatically. Use
`./scripts/release.sh` only when intentionally preparing an explicit minor,
major, or selected version. Publication and the consumer update remain
separate, ordered CI work.

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
choices, even when a later default matches them. Review the diff and run `timds check`.

An older standalone repository adopts the managed automatic release flow with
`npm run timds -- upgrade --root . --auto-release`. The command refuses
customized release files unless replacement is explicitly forced.

The CLI runs from `node_modules`; do not commit that directory or a copied
`.timds/cli` tree. The upgrade does not rewrite this Design System's manifest,
tokens, media catalog, authored source, framework configuration, documentation,
or generated artifact. Review and commit the tooling diff separately.
