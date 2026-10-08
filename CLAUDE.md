# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Read `AGENTS.md` first. It holds the ownership boundaries (what this package
manages in client repos, what never enters this package, what `upgrade` may
touch) and those rules are binding. This file covers commands and architecture
only.

## Commands

```bash
npm test                      # tsc --noEmit, then node --test over all *.test.mjs, then tsx --test video/*.test.tsx
npm run typecheck             # tsc --noEmit (tsconfig only includes video/remotion.tsx)
npm run pack:check            # npm pack --dry-run; verifies the `files` allowlist in package.json
node --test src/core.test.mjs # one test file
node --test --test-name-pattern="upgrade" src/core.test.mjs   # one test by name
tsx --test video/remotion.test.tsx                            # the React component test
node bin/timds.mjs <command> --root /path/to/client-design-system   # run the CLI from source
node bin/timds.mjs starter sync --root /path/to/client-design-system  # adopt or re-sync a starter-based system (then every upgrade does it)
npm run golden-drift -- --golden /path/to/golden-checkout            # where templates/starter has drifted from the golden system (exit 1 on drift)
```

CI (`.github/workflows/ci.yml`) runs `npm ci && npm test && npm run pack:check`
on Node 24. Run both before committing.

Releases: `npm run release` (or `-- 0.2.0`, `-- --dry-run`) bumps, tags
`v<version>`, pushes, and creates a GitHub Release. npm publish happens only in
`.github/workflows/release.yml` via trusted publisher. Never `npm publish` by
hand.

Tests use `node:test` with `mkdtemp` fixtures and real `git` subprocesses;
they assert against the version read from `package.json`, never a hardcoded
one. `src/video.fixture.mjs` builds a complete video workspace fixture; reuse
it rather than hand-writing contract JSON in new video tests.

## Architecture

The package is pure ESM (`.mjs`), no build step, with one TypeScript file
(`video/remotion.tsx`, type-checked only, executed via `tsx`). Hand-written
`.d.mts` files ship type declarations for the JS modules consumers import.
`package.json` `exports` and `files` are curated allowlists; a new public module
must be added to both.

### CLI entry and workspace model

`bin/timds.mjs` calls `runCli` in `src/core.mjs`, which is a single flat
dispatcher over `command` + positional args (`video`, `mcp`, `auth`, `init`,
`defaults`, `upgrade`, `doctor`, `brand`, `check`, `extract`, `preview`, `dev`,
`diff`, `assets|media`, `submit`). Every command first calls `loadWorkspace`,
which:

1. Finds the repo root (git toplevel, else nearest `timds.json`).
2. Picks the layout: `timds.json` at root is **standalone**; otherwise the
   design system lives in `design-system/` (**embedded**). `scopePath` drives
   git pathspecs for `diff`/`submit`.
3. Validates `timds.json` (`validateManifest`, schema versions 1 and 2),
   requires `tokens.json`, and reads the media catalog (`media.json`).

Design-system build/dev/check are delegated to the commands declared in
`timds.json` `workspace.*`; TimDS never builds authored source itself. `check`
runs that build, then `validateArtifact` walks `dist/` (size/depth/symlink
limits, internal link resolution), then extracts the derived layer, then runs
the video check when video is enabled.

Human-readable progress goes through `output()` in core, which routes via
`setOutputStream` / `runWithOutputSink`. This matters because the stdio MCP
servers must keep stdout as a protocol stream.

### The derived layer (the consumer contract)

`designs.mjs` owns website designs: whole pages a designer authors under
`src/designs/<design>/pages/` in plain HTML on the system's stylesheets, one
file per route and state. It reads the catalog, renders the pages (layout
shell, route rewriting under `/designs/<id>/`, a directory page) into `dist/`,
enforces portability in `check` (no scripts, inline styles, undeclared
classes, or relative references), and serializes `designs.json`. `check`
always builds designs itself after the workspace build; the starter build
calls the same function so `dev` shows them. `timds designs init` is the
migration for systems scaffolded without them; it replaces the stock build
and viewer scripts through the same hash check `starter sync` uses.

`extract.mjs` harvests the built HTML in `dist/` (using the tolerant parser in
`html.mjs`, which exists so the package needs no HTML dependency) and writes
`index.json`, `tokens.json` (`tokens.mjs`, CSS custom properties resolved by
scope plus brand roles), `brand.json` (`brand.mjs`, from `data-timds-role`
annotations), `llms.txt`, per-page `index.md`, and `designs.json` (the
designs output directory is skipped by the page walk). `derived.mjs` is the
read side: `readDerivedLayer` (local) and `fetchDerivedLayer` (published URL)
return the same shape. `artifact.mjs` publishes that layer to the portal CDN
via `extract --publish`. Everything downstream (MCP read server, video brand
resolution, render hosts) reads this layer, never authored source.

### MCP surfaces

`mcp.mjs` (edit tools, `timds mcp`) and `mcp-read.mjs` (consumer read tools,
`timds mcp read`) each expose a `register*Tools(server, resolve)` function so a
remote host can mount the same tools with its own transport and identity. The
stdio runner is a thin wrapper around that. Tool definitions, the
authored-surface write guard, and the check belong here; transport and draft
lifecycle belong to the host.

### Video

- `src/video.mjs` is the orchestrator: contract/asset normalization, `video
  init`, `components init` (one-time snapshot of `video/remotion.tsx`), check,
  prepare/stage, voiceover (`video/generate_voiceover.py`), render, publishing
  export, and `video lab`.
- `src/video-producer.mjs`: `createVideoProducer()` returns
  `{ compileProduction, finalizeProduction }`, which turn a model-authored
  request into a production; `createVideoAuthoringContract()` builds the
  prompt + JSON Schema a Video Lab hands the model. The compiler rejects
  over-limit copy rather than truncating.
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
  `init` records a fresh scaffold as adopted. `src/fixtures/starter-before-
  formats/` is the pre-format-catalog scaffold the tests adopt from, and
  `templates/starter-history/` holds the stock `site.json` versions the
  bootstrap compares against. See `AGENTS.md` for the boundary.

### Templates and managed files

`templates/` is copied verbatim (with `__PLACEHOLDER__` substitution) by `init`
and `video init`. `templates/starter/` is the standalone repo scaffold including
its release scripts; `templates/*.yml` are the stock workflows. The starter
is client-owned once copied, except the plumbing and catalogs `starter sync`
keeps current (see above): `scripts/viewer.mjs` renders
`src/site.json` (views and pages, authored or `planned`), `src/layout.html`,
and the fragments under `src/pages/` into `dist/`, filling `{{tokens:GROUP}}`
tables from `tokens.json` and `{{formats:GROUP}}` tables and `{{canvas:ID}}`
preview variables from `src/formats.json` (the catalog of print sheets and
screen canvases, each tied to its page; `src/styles/canvas.css` is the
script-free preview engine), and lists the designs under `src/designs/` in the
app bar and sitemap. The starter's views mirror the golden client system
(Brand, Web DS, Digital DS, Social DS, Print DS); keep them in step with it. Planned pages are never built, so a fresh scaffold
keeps its two expected brand warnings. The sample design uses the site layout
block in `src/styles/system.css` (between its marker comments), which
`designs init` appends to a migrating system that kept the starter tokens.
`templates/design-system-AGENTS.md`, `design-system-CLAUDE.md`, and
`design-system-README.md` are the scaffolded agent and human entry points;
they are written once and then client-owned, so keep them accurate for a fresh
scaffold. `skills/` holds the managed agent skills installed under
`.agents/skills/`: two for Design System repos and
`timds-consume-design-system` for consumer repos. `upgrade` compares managed files by hash against
`.timds/installation.json` and refuses locally modified files without
`--force`; `legacyStandaloneAutomationHashes` in core pins the recognized stock
release files for the `--auto-release` migration. When a template or skill
changes, update the tests in `src/core.test.mjs` that assert managed-file
behavior.

## Conventions worth knowing

- Module-top comments in `src/*.mjs` explain each module's purpose and
  boundary; read them before editing and keep them accurate.
- Client-facing errors are thrown as plain `Error`s with actionable messages;
  `bin/timds.mjs` prints them as `TimDS: <message>` and exits 1.
- Zod is imported as `zod/v4`.
- Local `.env` files hold portal and R2 credentials and are ignored; tests must
  not depend on them.
