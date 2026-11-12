---
name: timds-update-design-system
description: __UPDATE_DESCRIPTION__
---

<!-- timds:pinned -->
# Update this product to a Design System release

Designers do their work in the Design System repository and release it;
this product follows a pinned version and a developer carries each release
across. The Design System's website designs are the reference the product's
routes must match, never pages to copy in. You are doing the developer's
part. __UPDATE_WORKSPACE__

The product's brand lives in the system `__SYSTEM_ID__`, pinned at
`__DESIGN_SYSTEM_PATH__/`. `timds.consumer.json` declares each app, its
review routes, and the routes paired with a design.

## Start

1. Read the repository's root `AGENTS.md`, `CLAUDE.md`, and
   `DESIGN_SYSTEM.md` completely. Product rules add to these; where they
   are stricter, they win.
2. Run `git status --short` and preserve all pre-existing work.
3. Find the handoff brief when there is one: an issue titled
   `Design System <version>` in this repository, or a note from the
   designer. It lists the routes, states, tokens, and media to pick up.
   Without one, derive the list below.
4. Look for a pull request the release automation already opened: the
   Design System's release workflow opens `chore: update Design System to
   <version>` on the branch `automation/update-design-system`, and a hosted
   follower opens its own. When one exists, build the port on that branch
   instead of moving the pin a second time.

## Move the pin

__PIN_UPDATE__

When the pin is `current`, the product already follows every release:
`consumer update` changes nothing in the manifest and there is nothing to
commit for the pin, but the port below is still needed; read the changelog
from the last version the product was verified against (the version
`__DESIGN_SYSTEM_PATH__/.timds-bundle.json` recorded before syncing).

Moving the pin is the explicit developer decision this skill exists for;
never do it inside a design-only change.

## Read what changed

- Read the releases between the old pin and the new one: `changelog.json`
  at the published prefix (the `/changelog/` page on the Design System's own
  site shows the same) lists every release with its notes, newest first, and `describe_system` returns the
  recent ones; a sibling checkout has the same in `CHANGELOG.md`. It is the
  designers' own description of each change. A version is its UTC release
  day and number that day (`2026.10.12-1`); older releases may carry
  `MAJOR.MINOR.PATCH`.
- When the `timds-design-system-read` MCP tools are connected, run
  `describe_system`, then `list_designs` and `read_design` for each route
  the product pairs with a design in `timds.consumer.json` or the brief
  names. Otherwise read `designs.json` at the published prefix, or
  `__DESIGN_SYSTEM_PATH__/dist/designs/` after building a submodule pin.
  `list_designs` also returns each design's journeys: the screens (a route
  in a state) in the order a visitor meets them, step by step, with the
  branch screens met instead, and a storyboard url
  (`/designs/<design>/journeys/<id>/`, on the Design System's site) that
  shows them at phone width.
  When a changed route belongs to a journey, work through the journey in
  its order rather than route by route.
- Compare the new bundle with the old one (`consumer update` overwrites
  `__DESIGN_SYSTEM_PATH__/.timds-bundle.json`, so copy it before updating,
  or read the old file list at `v/<old version>/bundle.json` under the
  published prefix): new tokens by name, new or changed stylesheets and
  scripts under `__DESIGN_SYSTEM_PATH__/`, and new media keys. A new file the product must load is an import in the theme
  stylesheet or layout, taken from the pin, never copied.

## Port each design

For every route whose design changed or is new, in journey order when the
route belongs to one (`list_designs` gives the order; a screen's `state`
names the file to open):

1. Open the design (every state: default, and each `<state>.html` beside
   it) and the product route side by side.
2. Rebuild the route in this product's layouts and components so it matches
   the design: the same structure, composed from the system's classes and
   tokens (`var(--…)`), with the product's own routing, data, metadata, and
   accessibility wiring. Never paste the design's HTML file in as a page,
   and never restyle it.
3. Express every state the design shows as the product reaches it (a sent
   form, an empty list, an error), including every screen and branch a
   journey shows: a visitor must be able to move through the product in
   the journey's order and meet each branch where the journey places it.
   A state the product cannot express yet is a product change to make or
   to call out, not a design to simplify.
4. A token, component, or role the design needs and the system lacks is a
   gap: report it (`report_gap` when the user agrees) and fix it in the
   Design System, not with a literal here.
5. Stay inside the product's rules: no copied stylesheets or images from
   the pin, no new brand CSS, light and dark schemes and reduced motion
   kept working.

## Verify

1. Run the product's install and build commands from `timds.consumer.json`
   (`install`, `preview.build`), and its typecheck from `package.json`.
2. Run the app locally (its `.claude/launch.json` entry, named under **This
   product** below, or the serve command) and visit every review route at
   each declared width and scheme, paired routes against their design state
   by state. Fix what you find.
<!-- timds:workspace -->
# Keep this site in step with its Design System

The EmDash site in `__SITE__/` lives in the repository of the Design System
`__SYSTEM_ID__` (__SYSTEM_AT__) and reads it from its source files, so there
is no release to adopt and no pin to move: a change to the system reaches
the site at its next build. Two things still need a developer, and they are
this skill's work: the article routes that have no port to the system yet,
and the site's TimDS templates when a newer toolkit ships new ones. Work
only in the repository the user supplied, on a branch named for the change.
`__SITE__/timds.consumer.json` declares the site's app and review routes,
relative to `__SITE__/`. Run the commands below from the repository root
unless a step names another folder.

## Start

1. Read __SYSTEM_GUIDANCE__, `__SITE__/AGENTS.md`, and
   `__SITE__/DESIGN_SYSTEM.md` completely. Where they are stricter than
   this skill, they win.
2. Run `git status --short` and preserve all pre-existing work.
3. Run `npm ci` in `__SITE__/`.

## Find the routes with no port

Read `__SITE__/sections.json` for every collection and address prefix. Each
section's list and entry render through
`__SITE__/src/routes/articles/index.astro` and `entry.astro`; its optional
feed is `rss.xml.ts`. `/topics/[slug]` uses
`__SITE__/src/pages/topics/[slug].astro` and combines all sections. The
components are under `__SITE__/src/components/articles/`. They use the starter's
classes (`hero`, `section`, `article-list`, `article-card`, `article-meta`,
`topic-list`, `prose`, `table-scroll`, `button`, `button--secondary`) and
render inside the design's layout, so they are styled only by the
stylesheets that layout links: the `<link>`s in
`__SYSTEM_PREFIX__src/designs/<id>/layout.html` (or, in a design without
one, its home page), where `/styles/name.css` is
`__SYSTEM_PREFIX__src/styles/name.css`, with its `@import`s. A route that
uses a class none of those stylesheets declares has no port to this system
yet: it is installed and renders, unstyled where the class is missing.

The scaffold printed those routes and their missing classes under "No port
yet"; no command lists them again. To find them, compare the classes in each
route's file and its components with the rules in the linked stylesheets.
`npm run timds -- consumer check --root __SITE__` is not that list: it
accepts a class declared in any system stylesheet, linked or not.

## Port each route

For every route with missing classes, choose per class:

1. **Use a class the system has.** When a linked stylesheet already has a
   class for the job, change the route's markup to use it. The route files
   and components are the site's own templates; edit them in place.
2. **Add the class to the system.** Otherwise add a rule for it to a
   stylesheet the design links (the starter's is
   `__SYSTEM_PREFIX__src/styles/system.css`), written with the system's
   tokens (`var(--…)`). When the design has article pages
   at a section prefix (or the shared `articles/` samples), match them: they
   are samples of the route. A value the system has no token for is a new
   token, added the way **Run the two-way check** in the
   `timds-consume-design-system` skill describes.

Only add to the system: never change the value of an existing token or the
rules of an existing class, and never change the design's pages to suit a
route. Never copy a design's HTML into `__SITE__/src/pages/` or write a
color or font literal in the site.

## Bring the templates forward

`__SITE__/.timds/emdash.json` records the template version the site was
written from (`template`), the sha256 of every file the scaffold wrote from
its templates (`files`, relative to `__SITE__/`), and what it wrote outside
the site (`workspaceFiles`, relative to the repository root, and
`workspaceSections`, the delimited section it added to an `AGENTS.md`). The
toolkit's template version and what each version changed are
`emdashTemplate` in the toolkit's `package.json`
(`node_modules/@dtconcepts/timds/package.json` in an npm workspace;
`npm view @dtconcepts/timds emdashTemplate` for the latest release).

There is no template update command yet. When `emdashTemplate.version` is
above the recorded `template`, carry each later version's `changes` into the
site by hand. The templates are in the same package under
`templates/emdash/` (`site/` and `site-cloudflare/`, with `site-workspace/`
on top), with placeholders the scaffold filled in for this system. A file
whose sha256 still equals its `files` entry is as the scaffold wrote it; one
that differs was edited here, so keep the edit and add the change to it.
Then set `template` to the version reached and each changed file's hash to
its new sha256, so a later update can still tell a stock file from an
edited one.

## Verify

1. In `__SITE__/`, run `npm ci` and `npm run build`; when the change
   touches the Worker, also `npm run worker`, which writes the uploadable
   Worker to `__SITE__/dist/worker`.
2. Run `npm run timds -- dev` and visit every review route under `/site` at
   each declared width and scheme, each ported route against the design's
   article pages when it has them. Fix what you find.
<!-- timds:end -->
__PIN_VERIFY__

__UPDATE_DELIVERY__

## Report the result

__UPDATE_RESULT__

## This product

__APPS__
