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

## Find the two ends

1. The product. `AGENTS.md` or `README.md` names it (the repository, and
   usually a sibling checkout such as `../<product>`). If neither does, ask
   once and record the answer in `AGENTS.md` under the production section so
   the next handoff does not ask again.
2. What the product pins. In a sibling checkout read
   `designSystem.version` in `timds.consumer.json` (a published pin) or the
   commit the `design-system` submodule points at. Otherwise ask.
3. What this repository is at. `version` in `timds.json` is the latest
   release when the checkout is on the default branch with no unreleased
   notes; the top of `CHANGELOG.md` shows anything newer still unreleased.
   Releases are commits titled `Release <version>` on the default branch;
   find the pinned one with `git log --grep "^Release <version>$"`.

If the product already pins the current release and nothing is unreleased,
say so and stop.

## Collect what changed

Between the pinned release commit and the current release (or the working
tree, when the designer wants a preview of unreleased work), gather:

- The `CHANGELOG.md` sections for every version in between, which carry the
  designer's own description of each change.
- Website designs: `git diff --stat <pinned>..HEAD -- src/designs/` lists
  the routes and states that changed or were added, and `design.json` any
  renamed titles. A route is the file's path; a state is the `.state.html`
  file beside it. Open each in the built artifact
  (`npm run timds -- check`, then `dist/designs/<design>/<route>/`) when the
  diff alone does not say what a developer must match.
- Tokens: changed or added names in `tokens.json`, by name only; the
  developer takes values from the pin, never from the brief.
- Styles and components: changed files under `src/styles/` and the
  `web/components` page, and any new file that `timds.json`
  `bundle.include` now carries that the product must load.
- Media: new or replaced keys in `media.json`, with their public URLs.
- Guidance: changed pages under `src/pages/` that affect copy, voice, or
  compliance.

## Write the brief

Use this shape, in plain language, with nothing a developer must guess:

```markdown
# Design System <current version> for <product>

Pinned now: <pinned version>. Pin: <current version>.

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
