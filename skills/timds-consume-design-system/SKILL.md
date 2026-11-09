---
name: timds-consume-design-system
description: Make design changes to a product that consumes a TimDS Design System pinned at __DESIGN_SYSTEM_PATH__/ (a published bundle fetched by npm install, or a git submodule), on behalf of a designer who reviews the result rather than the code. Use for changing a product's styles, components, page layout, copy placement, or imagery within its declared design surface; running the product locally to look at a change; and opening a draft pull request with local review details or an enabled cloud preview.
---

# Use the TimDS Design System in this product

You are working in a product repository (a website or app) for a designer who
will judge the change by looking at it, not by reading code. The product's
brand lives in a TimDS Design System, `__SYSTEM_ID__`, pinned at
`__DESIGN_SYSTEM_PATH__/`. `timds.consumer.json` at repository root declares
each app, how to run it, the routes to review, and the paths a designer change
may touch. Work only in the repository the user supplied.

## Start

1. Read the repository's root `AGENTS.md`, `CLAUDE.md`, and any product
   skill or `DESIGN_SYSTEM.md` completely. Product rules add to these; where
   they are stricter, they win.
2. Run `git status --short` and preserve all pre-existing work. Create or use
   a non-default branch named for the change, such as `design/hero-spacing`.
3. __PIN_SETUP__
4. Read the app's section under **This product** below before editing.
5. When the branch has a pull request, read the designer's notes (below).

## Designer notes

Take the designer's request and the pull-request comments as the request.
When the designer reviewed a published preview, their notes live on the TimDS
host (see "If you use TimDS Cloud" below).

## The Design System is pinned, not edited here

__PIN_RULES__
- When `__DESIGN_SYSTEM_PATH__/` is a symbolic link, a developer has pointed
  it at a Design System checkout to work on both together; sync leaves it
  alone and check reads it as a working copy. It is still never edited from
  here.
- When the system lacks what the change needs (a token, a component, a role,
  guidance), say so. The fix belongs in the Design System repository through
  its own pull request, not in a product-side workaround.

## Read the system, never invent it

Take every color, font, spacing value, logo, and image from the system:

__DERIVED_LAYER__
- The published prefix serves the current release, which may be newer than
  the pin; the bundle the product uses is the immutable copy under
  `v/<version>/`. Beside `llms.txt`, `brand.json` and `tokens.json` the
  prefix carries `index.json`, `formats.json`, `designs.json`,
  `changelog.json`, `bundle.json` and `llms-full.txt`.
- When the `timds-design-system-read` MCP tools are connected, prefer them:
  `get_consumer_guide` first, then
  `describe_system` (or `list_design_systems` when several are shared), then
  `resolve_role` for "what is the accent color" or "what font are headings"
  (`color.accent`, `color.text`, `font.display`, `font.body`, …),
  `get_tokens` for token names, `get_brand` and `list_media` for marks and
  imagery, `list_formats` for the asset formats, `list_pages`,
  `search_guidance` and `read_page` for voice and compliance. Note the
  version the tools serve; the product is built against its pin, which may
  trail it.
- Prefer brand roles over guessing from token names. In product CSS use the
  token's `name` (`var(--…)`), never its resolved literal.
- When the system holds a website design for the route you are changing
  (`list_designs` and `read_design`, or `designs.json` at the published
  prefix; a published bundle carries no designs, while a submodule checkout
  also has `dist/designs/` once its pin is built), the design is the reference the product route must match:
  port its markup and every state it shows onto the product's stack with the
  system's stylesheets. When the route belongs to a journey (`list_designs`
  lists each design's journeys: the screens in the order a visitor meets
  them, with the branches met instead), port the screens in that order and
  express each one. Never copy the design's HTML file into the product
  as a page, and never restyle it. A state the product cannot express is a
  developer change; say so.
- An unfilled role or missing token is a gap, not something to invent. Report
  it, and file it with `report_gap` when the user agrees.
- Validate newly consumed CSS tokens with `npm run timds -- consumer check
  --require-token=--focus-ring` (repeat the flag for each required token).
  It checks the local bundle for definitions and resolvable aliases. A fix
  that shipped as a release reaches the product only when a developer moves
  the pin with the `timds-update-design-system` skill, never inside a design
  change. Still
  verify imports, cascade, keyboard focus, and contrast in the product's
  browser preview.

- Compliance guidance is binding. When requested copy conflicts with it, say
  so instead of complying silently.

## If you use TimDS Cloud

- **Designer notes.** When a preview is published, the designer can review it
  in the TimDS portal and leave notes. Run `npm run timds -- consumer notes`
  at the start and again after each push (it needs `TIMDS_ACCESS_TOKEN` or
  `npm run timds -- auth login`). Each note names the page, the element, and
  usually the source file and line; the designer's words are the request and
  the element is where it applies. After pushing the fix, run
  `npm run timds -- consumer notes resolve <id>` for each note you addressed
  (in the designer-change workflow the workflow resolves them; see below).
  Never mark a note addressed that you did not address; say why instead, or
  `consumer notes resolve <id> --dismiss` when the designer agreed to drop
  it. Without portal access, use the request and pull-request comments.
- **Hosted read tools.** The `.mcp.json` entry for `timds-design-system-read`
  reaches the portal over HTTP and needs `TIMDS_ACCESS_TOKEN` in the
  environment.
- **A designer's draft.** `npm run timds -- consumer update --draft NAME`
  replaces the ignored bundle under `__DESIGN_SYSTEM_PATH__/` with the
  draft's build and leaves the tracked pin alone (`consumer check` then warns
  that the draft overrides the pin, and `--require-token` checks the draft);
  `npm run timds -- consumer sync` restores the production bundle. After the
  designer fixes a reported gap in a draft, integrate the draft again and
  rerun the check. A product initialized with `consumer init --draft-preview`
  also answers `?timds_draft=NAME` in the browser, and the read MCP tools
  take a `draft` argument. Never commit while a draft is integrated.

## Make the change

1. Compose the classes, components, and tokens the product and system already
   provide. Do not invent class names, write one-off inline colors or fonts,
   or add a new stylesheet when an existing one owns the surface.
2. Stay inside the app's design surface. Protected paths always win, and
   anything outside the surface (server code, data, build and deploy
   configuration, dependencies, lockfiles, CI) is a developer change: stop
   and say what would need a developer.
3. Never add dependencies or change the product's framework configuration.
4. Never commit media masters, video, audio, or full-resolution photography.
   Shared imagery belongs to the Design System and is published with
   `assets add` and `assets publish` using that repository's selected toolkit;
   reference its stable URL or media key here. Small optimized images may
   live in the product only where its rules allow them.
5. Keep light and dark schemes, desktop and phone widths, focus states, and
   contrast working.

## Look at it

Start the app with its `.claude/launch.json` entry (named below) in the
browser pane, or run its serve command from the app folder. Visit each review
route at each width and scheme the app's section declares, and check the
requested change, overflow, navigation, and images. A route listed under
**Designs to match** below has a design in the system; compare the route with
it, state by state, reading the design through `read_design` or the
system's `/designs/` pages. Fix what you find before opening the pull
request. The pull-request preview, when enabled, captures each paired design
beside its route only when the pin is a Design System checkout (a submodule
or a symbolic link); with a published pin the preview shows the routes alone
and the designer compares against the system's own pages.

## Open the pull request only when asked

1. Run, from repository root:

```bash
npm run timds -- consumer check --base origin/__DEFAULT_BRANCH__
```

   It validates the manifest and the pin and fails on any changed path outside
   the design surface. Fix the change rather than the manifest; editing
   `timds.consumer.json` widens a boundary and needs a developer.
2. Commit only the files the change needs, push the branch, and open the pull
   request as a **draft** against `__DEFAULT_BRANCH__`.
3. Write the description for the designer: what changed and why in plain
   language, which pages and routes to look at, and anything left undecided.
   No code walkthrough.
4. Automatic previews require the repository variable
   `TIMDS_PREVIEWS_ENABLED=true` and the `TIMDS_ACCESS_TOKEN` secret. They are
   off by default; without a token the workflow skips all preview work. When
   enabled, `timds-consumer-preview` comments a preview link for each app
   whose design surface the pull request changes (every app when it moves
   the pin or changes the manifest) and updates it on each push; a pull
   request that touches no surface gets no preview. Give the designer that
   link when available. Otherwise provide the local review URL and
   screenshots; do not wait for or promise a cloud preview.
5. Never merge, mark ready for review, deploy, move the Design System pin, or
   change managed TimDS files (everything under
   `.agents/skills/timds-consume-design-system/`,
   `.agents/skills/timds-update-design-system/` and `.timds/`, the
   `.claude/skills` link, `.github/workflows/timds-consumer-preview.yml`,
   `.github/workflows/timds-designer-change.yml`, and the TimDS entries in
   `.mcp.json` and `.claude/launch.json`) without separate authorization.

## In the designer-change workflow

When this skill runs inside `.github/workflows/timds-designer-change.yml`, the
run is non-interactive: do not ask questions; make reasonable assumptions and
state them in the pull request description. There is no local browser pane;
skip **Look at it**. The preview workflow publishes a review page only when
previews are enabled; otherwise describe the review routes and state that
visual checks were not performed. The run edits the working tree only: never
commit, push, open a pull request or use GitHub credentials. Run
`consumer check` until it passes, then return a JSON object with `summary`
(what changed, which pages to review, and the assumptions made) and
`addressedNoteIds`; the workflow commits, pushes, opens or refreshes the
draft pull request, and resolves those notes only after a successful push.
Do not run `consumer notes resolve` yourself. Without `TIMDS_ACCESS_TOKEN`
the designer's notes arrive as a `json` block in the request; list the ones
you addressed in the summary instead. The rest of **Open the pull request
only when asked** (never merge, never move the pin, never edit managed
files) still holds.

## Report the result

Lead with what changed, in the designer's words. Include the pull-request link,
the available cloud or local review link, the routes and widths you checked,
the Design System roles and tokens used, and anything that needs a developer
or a Design System change.

## This product

__APPS__
