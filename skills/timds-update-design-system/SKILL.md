---
name: timds-update-design-system
description: Bring a new release of the TimDS Design System pinned at design-system/ into this product as a developer: move the version pin, read what changed in the system, port changed or new website designs and their states onto the product's stack, and verify the review routes. Use when a developer asks to update, bump, or adopt a Design System release, or to port a design the designers finished.
---

# Update this product to a Design System release

Designers do their work in the Design System repository and release it;
this product follows a pinned version and a developer carries each release
across. The Design System's website designs are the reference the product's
routes must match, never pages to copy in. You are doing the developer's
part. Work only in the repository the user supplied, on a branch named for
the release, such as `design-system/update-1.4.0`.

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

- Read the Design System's `CHANGELOG.md` for every version between the old
  pin and the new one (in a sibling checkout of the system, or on its
  repository). It is the designers' own description of each change.
- When the `timds-design-system-read` MCP tools are connected, run
  `describe_system`, then `list_designs` and `read_design` for each route
  the product pairs with a design in `timds.consumer.json` or the brief
  names. Otherwise read `designs.json` at the published prefix, or
  `__DESIGN_SYSTEM_PATH__/dist/designs/` after building a submodule pin.
- Compare the new bundle with the old one: new tokens by name, new or
  changed stylesheets and scripts under `__DESIGN_SYSTEM_PATH__/`, and new
  media keys. A new file the product must load is an import in the theme
  stylesheet or layout, taken from the pin, never copied.

## Port each design

For every route whose design changed or is new:

1. Open the design (every state: default, and each `<state>.html` beside
   it) and the product route side by side.
2. Rebuild the route in this product's layouts and components so it matches
   the design: the same structure, composed from the system's classes and
   tokens (`var(--…)`), with the product's own routing, data, metadata, and
   accessibility wiring. Never paste the design's HTML file in as a page,
   and never restyle it.
3. Express every state the design shows as the product reaches it (a sent
   form, an empty list, an error). A state the product cannot express yet
   is a product change to make or to call out, not a design to simplify.
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
3. Do not rely on `npm run timds -- consumer check` here: it guards
   design-only changes and refuses a moved pin by design. The product's
   typecheck, build, and the review routes are the verification for a
   release. Anything outside the design surface beyond the manifest and
   the port needs a reason in the pull request.

## Open the pull request

Commit the pin and the port together, push, and open a pull request against
`__DEFAULT_BRANCH__` titled for the release (`Adopt Design System 1.4.0`).
Describe what was ported route by route, what was left out and why, and
the review routes. Never merge, deploy, or publish without separate
authorization; production publication is a decision this skill does not
make.

## Report the result

Lead with the version moved to and the routes ported. Include the
pull-request link, the routes and widths you checked, any design state not
yet expressed, and every gap reported to the Design System.
