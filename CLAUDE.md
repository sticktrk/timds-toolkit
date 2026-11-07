# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Read `AGENTS.md` first. It holds the ownership boundaries (what this package
manages in client repos, what never enters this package, what `upgrade` may
touch) and those rules are binding. This file covers commands and architecture
only.

## Commands

```bash
npm test                      # tsc --noEmit, then node --test over .github/scripts/*.test.mjs, src/*.test.mjs and video/*.test.mjs, then tsx --test video/*.test.tsx
npm run typecheck             # tsc --noEmit (tsconfig only includes video/remotion.tsx)
npm run pack:check            # npm pack --dry-run; verifies the `files` allowlist in package.json
node --test src/core.test.mjs # one test file
node --test --test-name-pattern="upgrade" src/core.test.mjs   # one test by name
tsx --test video/remotion.test.tsx                            # the React component test
node bin/timds.mjs <command> --root /path/to/client-design-system   # run the CLI from source
node bin/timds.mjs starter sync --root /path/to/client-design-system  # adopt or re-sync a starter-based system (then every upgrade does it)
```

CI (`.github/workflows/ci.yml`) runs `npm ci && npm test && npm run pack:check`
and `node scripts/check-starter-history.mjs` on Node 24 for every pull
request and master push. The native executables (`binary.yml`, a matrix of
native macOS arm64 and Linux x64 runners) and the shared upgrade proof
(`npm run test:shared-upgrades` and `scripts/check-brand-kit-rendering.mjs`,
Remotion plus a browser) run only when the change matches the path filters
in `ci.yml`'s `changes` job (the `binaries` and `upgrades` regexes there are
the source; roughly the binary, executable and runtime modules, the package
files and the two workflows; and `video/`, `templates/`, `skills/`, the
video, starter, brand-kit and core modules and the proof scripts) or on a
manual run. A release rebuilds and verifies the executables in `release.yml`;
the upgrade proof never runs there. A newer push to a pull request cancels
its running checks. Run tests and the pack check before committing.

The starter-history check fails when a starter plumbing file or managed
fragment changes after a release without its shipped hash in
`legacyStarterFileHashes` (`src/starter.mjs`): after changing one, run
`node scripts/check-starter-history.mjs --print` and add the entries it lists.

Releases: `npm run release` (or `-- 0.2.0`, `-- --dry-run`; `release.sh`
also takes `--yes`) bumps, tags `v<version>`, pushes, and creates a GitHub
Release. `.github/workflows/release.yml` also cuts a release itself on
`workflow_dispatch` from master (`npm run release -- --yes`; its `dry_run`
input only probes npm trusted publishing), refuses to start without the six
Apple signing secrets, builds, signs and notarizes both executables through
`binary.yml`, publishes to npm via trusted publisher only when they built,
and attaches them with `SHA256SUMS` to the release. Never `npm publish` by
hand.

Tests use `node:test` with `mkdtemp` fixtures and real `git` subprocesses;
they assert against the version read from `package.json`, never a hardcoded
one. `src/video.fixture.mjs` builds a complete video workspace fixture; reuse
it rather than hand-writing contract JSON in new video tests.

## Architecture

The package is pure ESM (`.mjs`), no build step, with one TypeScript source
module (`video/remotion.tsx`, type-checked only, executed via `tsx`; its test
is `video/remotion.test.tsx`, and `templates/emdash/design-system.ts` is a
shipped template, not toolkit code). Hand-written `.d.mts` files ship type
declarations for the data-contract modules consumers import (brand, bundle,
changelog, derived, designs, formats, tokens, runtime, offshoot-contract,
brand-kit, and the video producer, transport, boards, footage and board
layouts); the CLI, MCP, consumer and hosted exports have none.
`package.json` `exports` and `files` are curated allowlists; a new public module
must be added to both.

### CLI entry and workspace model

`bin/timds.mjs` calls `runCli` in `src/core.mjs`, which is a single flat
dispatcher over `command` + positional args. `helpText()` in the same file is
the public inventory (`timds --help`) and every usage line there has a
branch: `version`, `run`, `init`, the hosted session set (`start`, `pull`,
`update`, `status`, `history`, `sessions close`, `join`, `whoami`,
`systems`, `principals`, `claim`, `active-work`, `draft create|list|close`,
`rollback`), `upgrade`, `dependencies check`, `login` and `auth
login|status|logout`, `skills install`, `defaults`, `designs init`, `starter
sync`, `shoot`, `feed`, `sever`, `installation adopt`, `doctor`, `brand`,
`dev`, `check`, `extract`, `publish`, `preview`, `diff`, `assets` (alias
`media`) `list|add|backfill-metadata|publish|pull`, `video` (its own
`VIDEO_HELP` in `src/video.mjs`), `mcp [edit]` and `mcp read`, `submit`, and
`consumer …` (delegated to `runConsumerCli` in `src/consumer.mjs`). Keep the
help text and this list in step with the dispatcher.

The workspace commands (`doctor`, `brand`, `dev`, `check`, `extract`,
`publish`, `preview`, `diff`, `assets`, `submit`, `video`, `mcp`, `upgrade`,
`defaults`, `designs init`, `starter sync`, `feed`, `sever`) call
`loadWorkspace`; `version`, `run`, `init`, `auth`/`login`, `skills install`,
`installation adopt`, `shoot` (which loads only the new destination), the
hosted session set (`runHostedCommand`) and `consumer` do not.
`loadWorkspace`:

1. Finds the repo root (`findRepositoryRoot`): the nearest ancestor holding
   `.timds/session.json` (a hosted session workspace), else the git
   toplevel, else the nearest directory holding `timds.json` or
   `design-system/timds.json`.
2. Picks the layout: `timds.json` at root is **standalone**; otherwise the
   design system lives in `design-system/` (**embedded**). `scopePath` drives
   git pathspecs for `diff`/`submit`.
3. Validates `timds.json` (`validateManifest`, schema versions 1 and 2),
   requires `tokens.json`, and reads the media catalog (`media.json`).

Design-system build/dev/check are delegated to the commands declared in
`timds.json` `workspace.*`; TimDS never builds authored source itself.
`checkWorkspace` (`check`) validates the offshoot records, runs the workspace
`build`, renders the designs (`buildWorkspaceDesigns`) and the changelog
(`buildWorkspaceChangelog`), runs the workspace `check` command, checks the
designs, copies the consumer bundle (`buildWorkspaceBundle`), extracts the
derived layer, then `validateArtifact` walks `dist/` (size/depth/symlink
limits, internal link resolution), then the video check when video is
enabled, then `--require-clean-dist` compares the rebuilt artifact with the
committed one.

Human-readable progress goes through `output()` in core, which routes via
`setOutputStream` / `runWithOutputSink`. This matters because the stdio MCP
servers must keep stdout as a protocol stream.

### The derived layer (the consumer contract)

`designs.mjs` owns website designs: whole pages a designer authors under
`src/designs/<design>/pages/` in HTML with JavaScript on the system's stylesheets, one
file per route and state. It reads the catalog, renders the pages (layout
shell, route rewriting under `/designs/<id>/`, a directory page) into `dist/`,
enforces portability in `check` (no inline styles, undeclared
classes, or relative references), and serializes `designs.json`. A design's
`journeys` (the pages a visitor moves through in order, declared in
`design.json`) are validated, built as storyboards under the reserved
`/designs/<design>/journeys/<id>/` route, listed on `/designs/`, carried in
`designs.json`, and warned about (`journeyWarnings`) when a multi-page
design declares none. `check`
always builds designs itself after the workspace build; the starter build
calls the same function so `dev` shows them. `timds designs init` is the
migration for systems scaffolded without them; it replaces the stock build
and viewer scripts through the same hash check `starter sync` uses.

`changelog.mjs` owns the release history: it reads the client's
`CHANGELOG.md`, renders `dist/changelog/` (linked from the viewer's version
chip, outside the views) the way designs are rendered, writes
`changelog.json` into the derived layer, and holds the dated version rules
(`YYYY.MM.DD-N`: the UTC day and the release number that day; legacy
`MAJOR.MINOR.PATCH` orders below). The starter's `prepare-merge-release.mjs`
keeps its own copy of those rules so a client releases without importing the
toolkit; keep the two in step. `submit` refuses a change without an
Unreleased note.

`extract.mjs` harvests the built HTML in `dist/` (using the tolerant parser in
`html.mjs`, which exists so the package needs no HTML dependency) and writes
`index.json`, `tokens.json` (`tokens.mjs`, CSS custom properties resolved by
scope plus brand roles; it also parses `@font-face` and the external
stylesheets pages link), `brand.json` (`brand.mjs`, from `data-timds-role`
annotations, each font role with the files or font service that provide its
family), `formats.json` (`formats.mjs`, from the optional `src/formats.json`
catalog), `llms.txt` (opens with the brand essentials: colors, fonts, logos,
formats), `llms-full.txt`, per-page `index.md`, `designs.json` (the
designs output directory is skipped by the page walk), `changelog.json`,
and, only when the entry page is at the artifact root, `robots.txt` at the
site root naming `llms.txt` (kept when the build wrote its own).
`agent-pointers.mjs` holds that robots text and the head/body pointers to
`llms.txt` the changelog page and designs directory carry; the starter viewer
writes its own copy on every page it renders, with the page's Markdown
mirror. `bundle.mjs` builds
the consumer bundle: the files `timds.json` `bundle.include` globs name,
copied into `<entry>/bundle/` under their source paths with a `bundle.json`
of digests, published under the current prefix and an immutable
`v/<version>/` prefix a website pins. On the product side,
`consumer-sync.mjs` is `timds consumer sync|update`: a published pin
(`designSystem.version` in `timds.consumer.json`) fetches that version's
bundle into the gitignored `design-system/` directory from `postinstall`,
verifying digests and leaving a symlink alone, and `consumer update --draft
NAME` (`updateConsumerDraft`) replaces only that ignored bundle with a hosted
draft's, never the tracked pin; `consumer-migrate.mjs` is
`timds consumer migrate`, which removes the submodule and pins the version
the checkout declared. It checks both working trees, preflights init's
installation plan and the full bundle, then keeps the checkout, module store,
Git state, and touched files for rollback until the writes succeed. Migration
uses the supplied manifest with the shared installation planner in
`consumer-init.mjs`, so `--force` replaces managed files without regenerating
app settings. `consumer-install.mjs` preflights missing or older toolkit locks
to the running release without lifecycle scripts, restores the bounded root
requirement, and includes the lock in the installation's writes and rollback.
Published-mode init runs `npm ci` so the postinstall uses that resolution;
`--skip-install` refuses older locks before writing. `consumer.mjs` reports a
lock that predates published-pin support and resolves either pin mode (published
record or submodule gitlink) for `check`. `derived.mjs` is the
read side: `readDerivedLayer` (local) and `fetchDerivedLayer` (published URL)
return the same shape. `artifact.mjs` publishes that layer to the portal CDN
via `extract --publish`. Everything downstream (MCP read server, video brand
resolution, render hosts) reads this layer, never authored source.

### MCP surfaces

`mcp.mjs` (edit tools, `timds mcp`) and `mcp-read.mjs` (consumer read tools,
`timds mcp read`) expose `registerDesignSystemTools(server, { resolveWorkspace,
hooks })` and `registerDesignSystemReadTools(server, { resolveSystem,
listSystems, hooks })` so a remote host can mount the same tools with its own
transport and identity; `mcp.mjs` also exports `registerHostedSessionTools(server,
{ root })`, the `timds_*` session tools (start, join, pull, update, submit,
claim, active-work, drafts, status, history, publish) over the hosted CLI.
The stdio runner is a thin wrapper around those. Tool definitions, the
authored-surface write guard, and the check belong here; transport and draft
lifecycle belong to the host.

### Video

- `src/video.mjs` is the orchestrator: contract/asset normalization, `video
  init`, `components init` (one-time snapshot of `video/remotion.tsx`) and
  `components migrate` (`src/video-migration.mjs`), `doctor`, `check`,
  prepare/stage, voiceover (`video/generate_voiceover.py`), `studio`,
  `render`, `publishing` export, and `video lab`; `VIDEO_HELP` there is the
  `timds video --help` inventory.
- `src/video-producer.mjs`: `createVideoProducer()` returns
  `{ PRODUCER_CONTRACT_VERSION, compileProduction, finalizeProduction }`,
  which turn a model-authored request into a production;
  `createVideoAuthoringContract()` builds the prompt + JSON Schema a Video
  Lab hands the model. The compiler rejects over-limit copy rather than
  truncating.
- `video/footage.mjs` holds the production rules (footage families, natural-
  speed chains, headline completeness) shared by the Remotion components, the
  producer, and `video check`. Client snapshots import it, so changes here
  reach client frames without a snapshot reset.
- `src/video-boards.mjs` validates a client's `video/boards.json` board
  catalog (kind schemas, budgets, cadence, motifs, cues) and feeds the
  authoring contract, compile/finalize, `video check`, the machine index, and
  MCP `describe_system`. `video/boards.mjs` holds the shared board rules
  (cue-word normalization, reveal frames, chapter derivation) that the
  default components, the producer, and `video check` import.
- `video/remotion.tsx` is the default component set and the
  `VideoProjectComponentOverrides` contract; `resolveVideoProjectComponents`
  merges a client's partial override onto the defaults.
- `src/video-lab-server.mjs` + `video/lab-ui.html` are the local web Video Lab
  (`video lab --serve`), which drafts with the Anthropic SDK against the
  client's authoring contract and renders headlessly.
- `src/defaults.mjs` implements `timds defaults --apply`: merge against the
  `.timds/defaults.json` baseline with sticky overrides. See `AGENTS.md` for
  the test matrix this migration must keep.
- `src/starter.mjs` implements `timds starter sync`, the recurring starter
  migration `upgrade` runs on every adopted system: stock plumbing replaced
  by recorded hash, `src/site.json` and `src/formats.json` merged against the
  baseline in `.timds/starter.json` (the catalogs are serialized in the
  starter's one-entry-per-line style so diffs stay reviewable), managed
  overview fragments written for added or planned pages, a missing stylesheet
  link inserted into the layout, then `check` with full rollback on failure.
  The existing `home` selection, including absence, stays authored routing;
  sync and parent feeds never move the front page.
  `init` records a fresh scaffold as adopted. `src/fixtures/starter-before-
  formats/` is the pre-format-catalog scaffold the tests adopt from, and
  `templates/starter-history/<kind>/` holds the stock `site.json` versions
  the bootstrap compares against (the root-level `site-1.json` and
  `site-2.json` there are the ordinary starter's copies that
  `src/starter.test.mjs` reads). The `starter` field selects the stock
  catalogs and managed fragments; absent means the ordinary `starter`.
  `legacyStarterFileHashes` in `src/starter.mjs` lists every stock version a
  release shipped of each plumbing file and managed fragment, so a system at
  an older release's bytes is still refreshed; `scripts/check-starter-history.mjs`
  (run in CI) fails when a shipped version is missing from it. See `AGENTS.md` for the boundary.

### Templates and managed files

`src/offshoot-contract.mjs` validates `.timds/parent.json` and the designer's
exact-file `.timds/stock.json` declarations. `src/offshoots.mjs` implements
local `shoot` from immutable hosted or Git source and confirmed `sever`;
`src/feed.mjs` reuses the starter's catalog merges with parent stock, verified
plumbing, dirty-file guards and rollback. While a parent record exists,
ordinary starter sync updates plumbing only and preserves its structural
baselines, while maintaining the narrow layout link/version-chip boundary.
Public lineage appears in derived readers and publication stamps;
session edits cannot change the parent record. See `docs/offshoots.md`.

`templates/` is copied verbatim (with `__PLACEHOLDER__` substitution) by `init`
and `video init`. `templates/starter/` is the standalone repo scaffold including
its release scripts; `templates/*.yml` are the stock workflows.
`templates/brand-kit/` overlays only the second starter's catalogs, token and
copy samples, stock declaration, styles, layout, pages and empty Designs
structure. `init --starter brand-kit` records that kind; it never copies the
ordinary starter's authored page tree or sample design into the overlay.
`src/brand-kit.mjs` is the public pure-data slot contract, exported as
`@dtconcepts/timds/brand-kit` with `.d.mts` declarations. Init and starter sync
copy it to managed `scripts/brand-kit.mjs`; the viewer imports that copy, so
stock samples and guidance work before dependencies are installed. Slot
rules, samples, page ids and stock paths have one source. The starter
is client-owned once copied, except the plumbing and catalogs `starter sync`
keeps current (see above): `scripts/viewer.mjs` renders
`src/site.json` (views and pages, authored or `planned`), `src/layout.html`,
and the fragments under `src/pages/` into `dist/`, filling `{{tokens:GROUP}}`
tables from `tokens.json` and `{{formats:GROUP}}` tables and `{{canvas:ID}}`
preview variables from `src/formats.json` (the catalog of print sheets and
screen canvases, each tied to its page; `src/styles/canvas.css` is the
script-free preview engine). `{{copy:KEY}}` renders escaped strings from
`src/copy.json`, with optional numeric bank indexes; `{{media:KEY}}` emits a
bounded local catalog asset path; `{{slots:GROUP_OR_KEY}}` renders the exported
slot guidance and labels. Missing values use the contract's samples and are
reported. The viewer lists designs in the app bar even when the directory is
empty. The ordinary starter opens on the Use view: its own page is the portal
landing (`"layout": "landing"`, rendered without the side navigation: a hero,
rails of asset cards from the catalog that deep-link the composer with
`?format=ID`, the kit, three steps, every other way in), and `use/compose` is
the composer, whose presets are every catalog format through
`{{presets:GROUP}}`; shared `src/scripts/compose.js` powers it against the
host's relative compose route. `{{count:formats|views|pages|designs}}` states
a count, `{{page:ID}}` is a page's address (refusing a planned page),
`{{nearest:ID}}` is the same with a fallback to its view's first authored
page (then the overview) while it is planned, so a managed fragment can link
client pages before they exist, and `{{sitemap}}` is the table of every
page. The kit keeps its overview at `/`, with Landing at `/use/`, the
promoted Compose at `/use/compose/`, and Install at `/use/install/`. Its
landing uses its own copy slots and format catalog, and its composer offers
every catalog group, including print event formats. Kit foundations and
channel overviews lead with previews and fold slot evidence and technical
tables into Spec drawers. Starter sync advances unchanged page `layout` and
`promote` fields against the recorded baseline and preserves authored choices.
The starter's views (Brand, Web DS,
Digital DS, Social DS, Print DS, and Use, the toolkit's own guidance on
consuming a system) are the canonical structure; client systems are a source
of ideas, not a mirror. Planned pages are never built, so a fresh scaffold
keeps its two expected brand warnings. The kit instead authors its Voice page,
reports the assumed sample voice, and reports no logo until its media is filled.
Its template formats render in Minimal, Accent, Bold and Photo treatments.
The ordinary starter's sample design uses the site layout
block in `src/styles/system.css` (between its marker comments), which
`designs init` appends to a migrating system that kept the starter tokens.
`templates/design-system-AGENTS.md`, `design-system-CLAUDE.md`, and
`design-system-README.md` are the scaffolded agent and human entry points;
they are written once and then client-owned, so keep them accurate for a fresh
scaffold. `skills/` holds the managed agent skills installed under
`.agents/skills/`: for Design System repos the editing and video
procedures plus the four designer skills (`design-start`, `design-media`,
`design-ship`, `design-handoff`; names in `designSystemSkillNames`, declared in
`src/skill-names.mjs` and re-exported from `src/core.mjs`), and for consumer
repos `timds-consume-design-system` and `timds-update-design-system` (names
in `CONSUMER_SKILL_NAMES`, declared in `src/consumer.mjs` beside the
always-allowed paths derived from them and re-exported from
`src/consumer-init.mjs`, rendered per manifest). `src/agent-skills.mjs`
links `.claude/skills` to `.agents/skills` in both repository kinds.
`src/skills-install.mjs` is `timds skills install`, for the folder a
designer's agent works from (never a Design System, consumer, or session
workspace): the designer skills plus `skills/timds-hosted-design-system`
rendered per system (`hostedSkillPlaceholders` must match the host's fill),
into `.agents/`, `.claude/` and `.cursor/skills/`, tracked by digest in
`.timds/skills.json`. `upgrade` compares managed files by hash against
`.timds/installation.json` and refuses locally modified files without
`--force`; `legacyStandaloneAutomationHashes` in core lists every stock
version of the release automation files a release shipped, consulted by the
`--auto-release` migration and by every later upgrade of adopted automation
(including the dated-version migration of `release.sh` and
`check-versions.mjs`). When a template or skill
changes, update the tests in `src/core.test.mjs` that assert managed-file
behavior.

### Hosted sessions, publication, upgrade and consumer review

- `src/hosted.mjs` implements session API version 1 (`createHostProvider`,
  `materializeHostedSnapshot`): `start`, `join`, `pull`, `update`, `submit`,
  `claim`, `active-work`, drafts, `rollback`, and the human verbs; the CLI
  branches and `registerHostedSessionTools` share it. `src/auth.mjs` is the
  external credential store (device flow, saved portal selection, the
  locked refresh) and `src/oauth.mjs` the PKCE authorization-code flow it
  uses against a host that advertises OAuth.
- `src/publish.mjs` is `timds publish` (build, push `artifact.publishRef`,
  request portal promotion); `src/publication-snapshot.mjs` stamps a
  workspace-free publication, `src/artifact-files.mjs` holds the artifact
  limits and file walk, and `src/git-blobs.mjs` reads committed trees.
- `src/upgrade.mjs` is `upgrade --version` and `dependencies check` (one
  exact tested resolution); `src/clean-tree.mjs` is the dirty-file guard the
  starter sync, feed and selection share.
- `src/contract-groups.mjs` splits `tokens.json`/`media.json` into authored
  `tokens/` and `media/` key maps and regenerates the views; `src/merge.mjs`
  is the three-way file-tree merge (`mergeFileTrees`) hosted updates use.
- `src/consumer.mjs` is `runConsumerCli` and `consumer check`;
  `consumer-register.mjs` (`register`, `updates`), `consumer-notes.mjs`
  (`notes`), `consumer-preview.mjs` with `consumer-browser.mjs` and
  `consumer-png.mjs` (`preview`), `consumer-scaffold.mjs` (`scaffold
  emdash`), and `consumer-draft-preview.mjs` with `draft-source.mjs` (the
  browser module and local draft source of `init --draft-preview`).
- Video runtime: `src/video-transport.mjs` (Zod 3 wire schemas),
  `video-runtime.mjs` and `video-component-loader.mjs` (loading a client's
  components), `video-migration.mjs` (`components migrate`),
  `video-crops.mjs` (vertical crop metadata), `video/board-layouts.mjs`
  (shared geometry), `video/text.mjs` and `video/runtime-compat.mjs`.
- `src/executable.mjs`, `executable-register.mjs` and `executable-loader.mjs`
  are the SEA re-entry and module-resolution hooks (see "Standalone
  executable distribution").

## Conventions worth knowing

- Module-top comments in `src/*.mjs` explain each module's purpose and
  boundary; read them before editing and keep them accurate.
- Client-facing errors are thrown as plain `Error`s with actionable messages;
  `bin/timds.mjs` prints them as `TimDS: <message>` and exits 1.
- Zod is imported as `zod/v4`, except in `src/video-transport.mjs` (and its
  `.d.mts`), which deliberately uses `zod/v3` so the wire schemas work for
  Zod 3 render hosts.
- Local `.env` files hold portal and R2 credentials and are ignored; tests must
  not depend on them.

### Standalone executable distribution

`npm run binary:build` packages the same npm allowlist and exact production
lockfile with Node 24.22.0 as a native `timds-cli` SEA. `src/executable.mjs`
distinguishes CLI re-entry from JavaScript execution and owns resource/runtime
paths. The SEA materializes a validated external per-user cache; it never copies
engine code into a client repository. `src/binary-installation.mjs` owns exact
binary selections (`schemaVersion: 2`, `mode: "binary"`). Explicit
`installation adopt --binary --apply` migrates stock workspace commands and
managed skills/automation, retaining npm pins and authored docs; ordinary
`upgrade --version EXACT_VERSION` selects the already installed executable.
Npm installations retain the bounded requirement and resolved lockfile.

Run `npm run binary:smoke` and `npm run binary:smoke:video` after a binary build.
Native macOS arm64 and Linux x64 CI runs the complete suite and these clean-PATH
checks before either release path publishes. See `docs/binary-installation.md`
and `docs/binary-packaging.md` for installation, migration, cache integrity,
platform floors, external prerequisites and actual signing status.
