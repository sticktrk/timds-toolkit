---
name: timds-update-design-system
description: Bring a new release of the TimDS Design System pinned at design-system/ into this product as a developer: move the version pin, read what changed in the system, port changed or new website designs and their states onto the product's stack, and verify the review routes. Use when a developer asks to update, bump, or adopt a Design System release, or to port a design the designers finished.
---

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

## Move the pin

__PIN_UPDATE__

Moving the pin is the explicit developer decision this skill exists for;
never do it inside a design-only change.

## Read what changed

- Read the releases between the old pin and the new one: `changelog.json`
  at the published prefix (or the `/changelog/` page there) lists every
  release with its notes, newest first, and `describe_system` returns the
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
  (`/designs/<design>/journeys/<id>/`) that shows them at phone width.
  When a changed route belongs to a journey, work through the journey in
  its order rather than route by route.
- Compare the new bundle with the old one: new tokens by name, new or
  changed stylesheets and scripts under `__DESIGN_SYSTEM_PATH__/`, and new
  media keys. A new file the product must load is an import in the theme
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

1. Run the product's install, typecheck, and build commands from
   `timds.consumer.json` and `package.json`.
2. Run the app locally (its `.claude/launch.json` entry or the serve command)
   and visit every review route at each declared width and scheme, paired
   routes against their design state by state. Fix what you find.
3. For a published version pin, run from repository root:

```bash
npm run timds -- consumer check --base origin/__DEFAULT_BRANCH__ --allow-pin-update __PIN_CHECK_TARGET__
```

   __PIN_CHECK_EXPLANATION__
   The opt-in permits only that published version change. All other manifest
   metadata, including the system identity, paths, app commands and scope,
   must remain unchanged. The base manifest still controls the
   design surface and protected paths. If the pinned CLI does not recognize
   the flag, upgrade it through the product’s normal reviewed dependency path
   before using hosted updates. Never weaken or bypass this check.

   For a git submodule pin, keep its explicit gitlink review and run:

```bash
npm run timds -- consumer check --base origin/__DEFAULT_BRANCH__
```

   That check still reports the deliberate gitlink pin move; inspect the exact
   commit selected and report that diagnostic in the pull request. Resolve
   every other check failure, including protected paths and design-surface
   violations. Do not describe that run as green. The published-pin opt-in
   does not apply to submodules; hosted followers require a published pin.

__UPDATE_DELIVERY__

## Report the result

__UPDATE_RESULT__
