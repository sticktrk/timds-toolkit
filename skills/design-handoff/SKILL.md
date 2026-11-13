---
name: design-handoff
description: Write the developer handoff for a TimDS Design System release: what changed since the version the product pins, which website designs, routes, and states to port, which tokens, styles, media, and guidance moved, and the version to pin. Use when a designer says a release is ready for the developers, asks what the site still needs to pick up, or wants to brief engineering; or when a developer asks what changed since the product's pin.
---

# Hand a release to the developers

Designers finish their work in this repository. Developers carry it into
the production product, which pins a released version of this system and
ports its website designs onto the product's own stack. This skill writes
the brief that makes the port a checklist instead of a diff archaeology.

Never edit the product repository, move its pin, or deploy. The brief is the
deliverable.

## Installation mode

Read `.timds/installation.json` under the Design System root (the folder
holding `timds.json`) before installing tools. With `mode: "binary"`,
use `timds-cli` at its exact `version` in place of `npm run timds --`; skip npm
installation and npm dependency-upgrade steps for the stock system. Check
`timds-cli --version` and `timds-cli doctor`. Select another executable release
only through `timds-cli upgrade --version EXACT_VERSION`. Existing npm mode
keeps its bounded requirement and committed lockfile. Custom product tools
retain their declared prerequisites. The agent runs these steps for the designer.

A site inside this Design System's workspace (`site/timds.consumer.json`
with `designSystem.workspace: true`) has no release pin or bundle to adopt.
For that site, report the changed source routes, article templates, section
schema or form handlers that need developer work, and the checks and deployment
still needed. Follow its installed `timds-update-design-system` skill for
that work; the pinned-product comparison below applies to separate consumers.

## Find the two ends

Paths below are relative to the Design System root: the repository in a
standalone system, `design-system/` in an embedded one.

1. The product. `AGENTS.md` or `README.md` names it (the repository, and
   usually a sibling checkout such as `../<product>`). If neither does, ask
   once and record the answer in `AGENTS.md` under the production section so
   the next handoff does not ask again.
2. What the product pins. In a sibling checkout read
   `designSystem.version` in `timds.consumer.json` (a published pin) or the
   commit the `design-system` submodule points at. Otherwise ask. A pin of
   `current` follows every release on its own: the product already moves,
   so take the version its synced `design-system/.timds-bundle.json`
   records (or the last version the developer says they verified against)
   as "pinned now", and write the brief as the porting guide it still needs.
   In an embedded system the product is this repository and there is no
   pin: the two ends are the last handoff (a tag, a commit, or the issue the
   last brief was filed in) and the current tree.
3. What this repository is at. `version` in `timds.json` is the latest
   release when the checkout is on the default branch with no unreleased
   notes; the top of `CHANGELOG.md` shows anything newer still unreleased.
   Where the managed standalone release workflow or `scripts/release.mjs`
   runs, releases are commits titled `Release <version>` on the default
   branch; resolve each endpoint with
   `git log --all --format='%H %s' --fixed-strings --grep='Release VERSION'`
   and verify the candidate's `timds.json` version. Replace `VERSION` with
   the literal release label; do not assume the checkout's `HEAD` is the
   requested release.
   If you use TimDS Cloud: a hosted system has no Git history in the
   session; `timds history` and the published `changelog.json` are its
   record.

If the product already pins the current release and nothing is unreleased,
say so and stop.

## Collect what changed

Between the pinned release commit and the current release (or the working
tree, when the designer wants a preview of unreleased work), gather:

- The `CHANGELOG.md` sections for every version in between, which carry the
  designer's own description of each change. The published system carries
  the same history as `changelog.json` beside `index.json` and as the
  `/changelog/` page, so a developer without this checkout reads it there.
  A version is its UTC release day and number that day (`2026.10.12-1`);
  older releases may carry `MAJOR.MINOR.PATCH`.
- Website designs: from the Design System root,
  `git diff --stat PINNED_COMMIT RELEASE_COMMIT -- src/designs/` lists
  the routes and states that changed or were added; use the verified commit
  hashes from above. For an explicitly requested preview of unreleased work,
  `git diff --stat PINNED_COMMIT -- src/designs/` also includes tracked working
  changes; inspect untracked designs with `git status --short`. `design.json` lists any
  renamed titles and the journeys that changed or were added (a journey is
  the pages a visitor moves through in order, with its steps, screens, and
  branches; its storyboard is `/designs/<design>/journeys/<id>/`). A route
  is the file's path; a state is authored as `<route>.<state>.html` beside
  it and built as `<state>.html` beside the route's `index.html`. Open
  each in the built artifact (`npm run timds -- check`, then
  `dist/designs/<design>/<route>/`) when the diff alone does not say what a
  developer must match. A changed funnel whose `design.json` declares no
  journey is a gap in the system to fix before the brief, not a brief to
  write around.
- Tokens: changed or added tokens, named by the CSS custom property the
  developer uses (`--color-accent`) as the derived `dist/tokens.json` lists
  them, by name only; the developer takes values from the pin, never from
  the brief.
- Styles and components: changed files under `src/styles/` and the
  `web/components` page, and any new file that `timds.json`
  `bundle.include` now carries that the product must load.
- Media: new or replaced keys in the media catalog (`media/*.json`, or
  `media.json` in the older layout), with their public URLs.
- Guidance: changed pages under `src/pages/` that affect copy, voice, or
  compliance.

## Write the brief

Use this shape, in plain language, with nothing a developer must guess:

```markdown
# Design System <current version> for <product>

Pinned now: <pinned version>. Pin: <current version>.

## Journeys that changed
- <journey title> (`<design>/<id>`): the steps and screens in visitor order,
  and which changed. Port the screens in this order and express every state.
  Storyboard: https://<published host>/designs/<design>/journeys/<id>/

## Designs to port
- `/route` (states: default, sent): what changed and what to match.
  Reference: https://<published host>/designs/<design>/<route>/

## Tokens and styles
- New or changed tokens by name; new stylesheets or scripts in the bundle.

## Media
- key: public URL, where it is used.

## Guidance
- Pages whose copy or rules changed, with the block to read.

## Review
- Routes, widths, and schemes to check after the port.
- New routes to pair with their design in `timds.consumer.json`
  `preview.designs` (`"/contact": "website:/contact"`), so the product's
  review shows the design beside the route at desktop, tablet and phone.
```

Leave out sections with nothing in them. Link designs by their published
URL when the system is published, and by artifact path otherwise.

## Deliver it

Put the brief in your reply. When the designer wants it filed, and `gh` can
reach the product repository, open an issue there titled
`Design System <version>` with the brief as its body, or add it as a
comment on the product's open update pull request when one exists. Do not
open a pull request in the product, change its manifest, or run its
commands.
