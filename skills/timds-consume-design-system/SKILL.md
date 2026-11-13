---
name: timds-consume-design-system
description: Make design changes to __CONSUMER_SUBJECT__, on behalf of a designer who reviews the result rather than the code. Use for changing a product's styles, components, page layout, copy placement, or imagery within its declared design surface; running the product locally to look at a change; and opening a draft pull request with local review details or an enabled cloud preview.
---

# Use the TimDS Design System in this product

<!-- timds:pinned -->
You are working in a product repository (a website or app) for a designer who
will judge the change by looking at it, not by reading code. The product's
brand lives in a TimDS Design System, `__SYSTEM_ID__`, pinned at
`__DESIGN_SYSTEM_PATH__/`. `timds.consumer.json` at repository root declares
each app, how to run it, the routes to review, and the paths a designer change
may touch. Work only in the repository the user supplied.
<!-- timds:workspace -->
You are working in a TimDS Design System repository that also holds the
system's own website, an EmDash site in `__SITE__/`, for a designer who will
judge the change by looking at it, not by reading code. The site has no pin:
it reads the Design System `__SYSTEM_ID__` (__SYSTEM_AT__) from its source
files at every build, so the system and the site are edited, reviewed, and
committed together. `__SITE__/timds.consumer.json` declares the site's app,
how to run it, the routes to review, and the paths a designer change may
touch, relative to `__SITE__/`. Run the commands below from the repository
root unless a step names another folder. Work only in the repository the
user supplied.
<!-- timds:end -->

## Start

<!-- timds:pinned -->
1. Read the repository's root `AGENTS.md`, `CLAUDE.md`, and any product
   skill or `DESIGN_SYSTEM.md` completely. Product rules add to these; where
   they are stricter, they win.
<!-- timds:workspace -->
1. Read __SYSTEM_GUIDANCE__, `__SITE__/AGENTS.md`, and
   `__SITE__/DESIGN_SYSTEM.md` completely. Where they are stricter than
   this skill, they win.
<!-- timds:end -->
2. Run `git status --short` and preserve all pre-existing work. Create or use
   a non-default branch named for the change, such as `design/hero-spacing`.
3. __PIN_SETUP__
4. Read the app's section under **This product** below before editing.
5. When the branch has a pull request, read the designer's notes (below).

## Designer notes

Take the designer's request and the pull-request comments as the request.
<!-- timds:pinned -->
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
<!-- timds:workspace -->

## Add to the system; never change what it has

- The Design System is __SYSTEM_AT__, and the site reads it directly: a
  change to a token, a stylesheet, or a design is a change to the site at
  its next build. There is no pin to move and nothing to sync; never add
  `designSystem.version` or `designSystem.path` to
  `__SITE__/timds.consumer.json`.
- Never copy the system's stylesheets, tokens, fonts, or images into the
  site, and never write a color or font literal there: use the system's
  classes and name its tokens with `var(--…)`.
- A style the site needs and the system lacks is added to the system in the
  same change, as a new token or a new class (see **Run the two-way
  check**). Never change the value of an existing token or the rules of an
  existing class: every page of the system and of the site uses them. The
  additions are in the diff and are reviewed with the rest of the change.

## Pages are the system's designs

- The site is built from the website design that
  `__SITE__/astro.config.mjs` names (`designSystem({ design: "<id>" })`).
  Every page of that design that is not an article, topic, or list route is
  served from `__SYSTEM_PREFIX__src/designs/<id>/pages/`, one copy: editing
  the design file is editing the page, and a page added to the design is a
  page of the site. Only a page's default state is served; its other states
  stay references.
- `__SITE__/sections.json` declaration version 2 names the article
  collections and literal address prefixes, including nested prefixes;
  `section-schema.json` owns their shared fields and features. Public design
  pages, Astro routes and public files cannot occupy collection namespaces.
  Mark additional sample pages with `site: "reference"` in `design.json`.
  Changing sections is a developer change: run `npm run sections:sync` in
  the site, then the consumer check and build, and arrange schema creation
  for an existing database. Those checks never silently sync source.
- The article, topic, and 404 routes render inside the design's
  `layout.html` (without one, its home page with the content of its `<main>`
  taken out) through `__SITE__/src/layouts/Base.astro`.
- So a page's copy, structure, header, footer, or head is changed in the
  design file, never by copying the design into `__SITE__/src/pages/`.
  After editing a design, `npm run timds -- check` checks that it stays
  portable (no inline styles, no undeclared classes, no relative references).
- The article routes (`__SITE__/src/routes/articles/`,
  `__SITE__/src/pages/topics/`) and their components are the site's own
  templates, written on the system's classes. A route whose classes the
  system does not declare has no port yet; porting it is the
  `timds-update-design-system` skill's work.

## Content goes through EmDash

Articles, topics, bylines, and media live in the EmDash database, never in a
commit: change them in the admin (`/_emdash/admin`), through the REST API,
or through the MCP server (`/_emdash/api/mcp`), as
`__SITE__/docs/content-api.md` describes. A request to write or edit an
article is content work, not a design change. The collection, field, and
taxonomy slugs in `__SITE__/seed/seed.json` are the contract writers target;
never rename one.
<!-- timds:end -->

## Read the system, never invent it

Take every color, font, spacing value, logo, and image from the system:

<!-- timds:pinned -->
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
- **Pull-request previews.** Automatic previews require the repository
  variable `TIMDS_PREVIEWS_ENABLED=true` and the `TIMDS_ACCESS_TOKEN` secret.
  They are off by default; without a token the workflow skips all preview
  work. When enabled, `timds-consumer-preview` comments a preview link for
  each app whose design surface the pull request changes (every app when it
  moves the pin or changes the manifest) and updates it on each push; a pull
  request that touches no surface gets no preview. Give the designer that
  link when available.
- **Shared imagery.** The Design System publishes registered media with
  `assets publish`.
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
   Shared imagery belongs to the Design System and is registered there with
   `assets add` using that repository's selected toolkit; reference its
   stable URL or media key here. Small optimized images may
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
4. For the designer, provide the local review URL and
   screenshots; do not wait for or promise a cloud preview (see **If you use
   TimDS Cloud**).
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
<!-- timds:workspace -->
- The system's source is in this repository: its tokens in
  `__SYSTEM_PREFIX__tokens/<group>.json` (see **Run the two-way check** for
  the older single-file layout), its stylesheets in
  `__SYSTEM_PREFIX__src/styles/`, its guidance pages in
  `__SYSTEM_PREFIX__src/pages/`, and its media catalog
  (`npm run timds -- assets list`).
- `npm run timds -- brand` prints the brand kit in plain language (colors,
  fonts, logos, formats) with every gap. After `npm run timds -- check`, the
  derived layer sits beside the built entry page under
  `__SYSTEM_PREFIX__dist/`: `brand.json`, `tokens.json`, `formats.json`,
  `llms.txt`, `llms-full.txt`, and a Markdown mirror of every guidance page.
  It is build output: read it, never edit it.
- Prefer brand roles over guessing from token names. In site CSS use the
  token's `name` (`var(--…)`), never its resolved literal.
- Compliance guidance is binding. When requested copy conflicts with it, say
  so instead of complying silently.

## If you use TimDS Cloud

Pull-request previews, designer notes on a preview, drafts integrated with
`consumer update --draft`, and hosted followers serve a product that pins a
Design System. A site in its system's own repository has none of them
(`consumer update --draft` and `consumer register` refuse here); a hosted
session on this Design System follows the system's own guidance.

## Make the change

1. Compose the classes, components, and tokens the system already provides.
   Do not invent class names, write one-off inline colors or fonts, or add a
   site stylesheet for what the system should own.
2. Change the site only inside the app's design surface, and the system only
   with the additions **Run the two-way check** asks for and the design
   files a page's content needs. Protected paths always win. Anything else
   (the site's `src/lib/`, `src/integrations/`, `src/worker.ts`, `seed/`,
   configuration, dependencies, and lockfile; the system's build and CI) is
   a developer change: stop and say what would need a developer.
3. Never add dependencies or change the site's framework configuration.
4. Never commit media masters, video, audio, or full-resolution photography.
   Shared imagery belongs to the system: register it with
   `npm run timds -- assets add FILE` (the `design-media` skill walks
   through it) and reference its stable URL or media key.
5. Keep light and dark schemes, desktop and phone widths, focus states, and
   contrast working.

## Run the two-way check

From the repository root:

```bash
npm run timds -- consumer check --root __SITE__
```

It checks the site against its manifest and against the system, both ways:
every site file in the design surface (stylesheets whole; in `.astro`,
`.html`, `.jsx`, `.tsx`, `.vue`, and `.svelte` files the `<style>` blocks,
static `style="..."` attributes, and static class names) is compared with
the source styles the site actually loads: the selected design's linked
stylesheets, their imports, compiled tokens when it links `/tokens.css`, and
system sheets imported by site source. Unlinked sheets, `bundle.include` and
`dist/` do not make a token or class available. Colors, font families, custom
properties, and classes are checked; lengths and other values are not, so take those from
the system's tokens yourself. With `--json` the results are
`workspaceCheck.rewrites` and `workspaceCheck.findings`, each with `file`,
`line`, and `column` relative to `__SITE__/`.

- **A rewrite.** A color or font literal that exactly one system token holds
  is rewritten in place to `var(--that-token)` and listed. Keep it; nothing
  is added to the system. (With `--no-fix` the check reports it without
  writing it, and fails.)
- **`literal`.** No system token holds the value. Add a token with that
  value to the system, named for its role and beside the tokens of its kind,
  then use it in the site as `var(--…)`. The finding's `suggestion` names
  the group and the variable it compiles to. In a protected file, a value
  one token holds is also a `literal` finding, naming that token: a
  developer changes that line.
- **`ambiguous-literal`.** Several tokens hold the value (`candidates`). Use
  the one whose role fits; add a new token only when none does.
- **`token-override`.** The site redeclares a system token. Remove the
  declaration; when the site needs a different value, add a new token and
  use it.
- **`class`.** The site uses or declares a class no system stylesheet
  declares. Add a rule for it to the stylesheet the `suggestion` names
  (usually `__SYSTEM_PREFIX__src/styles/system.css`), written with the
  system's tokens, and move any declarations the site had for it there.
  When the system already has a class for the job, use that class instead.

Tokens are authored in `__SYSTEM_PREFIX__tokens/<group>.json` when
`__SYSTEM_PREFIX__.timds/contract-layout.json` exists; `tokens.json` is then
generated from them and never edited, whatever a `suggestion` says. Without
that file, `__SYSTEM_PREFIX__tokens.json` is the authored file. A token
`accent` in the group `color` compiles to `--color-accent`.

Every fix only adds: never change an existing token's value or an existing
class's rules, even when that would be shorter. Then run
`npm run timds -- check` (it regenerates `tokens.json`, rebuilds the
system, and checks its designs) and the site check again, until both pass.

## Look at it

Run `npm ci` in `__SITE__/` once. Then `npm run timds -- dev` builds the
system, serves its pages, and starts the site behind them under `/site/` on
the same port (the app's section below gives the address). The site reads
the system's files on every request; the system's own pages are built once
per start. Visit each review route under `/site` at each width and scheme
the app's section declares, and check the requested change, overflow,
navigation, and images. A route listed under **Designs to match** is served
from that design (an article route's design is a sample of it): where the
site differs on a design page, the design file is what to change. Fix what
you find before opening the pull request.

## Open the pull request only when asked

1. Run, from the repository root:

```bash
npm run timds -- consumer check --root __SITE__ --base origin/__DEFAULT_BRANCH__
npm run timds -- check
```

   The first fails on a changed path in `__SITE__/` outside the design
   surface; a change outside `__SITE__/` is the system's and is judged by
   the second. Fix the change rather than the manifest; editing
   `__SITE__/timds.consumer.json` widens a boundary and needs a developer.
2. Ship the site change and the system's additions in one pull request, the
   way this repository ships every change: the `design-ship` skill writes
   the note under `## Unreleased` in `__SYSTEM_PREFIX__CHANGELOG.md`
   (`submit` refuses without one) and opens the draft pull request with
   `npm run timds -- submit`.
3. Write the description for the designer: what changed and why in plain
   language, which pages and routes to look at, every token and class added
   to the system, and anything left undecided. No code walkthrough.
4. For the designer, provide the local review URL and screenshots.
5. Never merge, mark ready for review, deploy, or publish, and never change
   managed TimDS files (`.agents/skills/`, `.timds/`, `__SITE__/.timds/`,
   the `.claude/skills` link) without separate authorization.

## Report the result

Lead with what changed, in the designer's words. Include the pull-request
link, the local review link, the routes and widths you checked, the system
roles and tokens used, every token and class added to the system, and
anything that needs a developer.
<!-- timds:end -->

## This product

__APPS__
