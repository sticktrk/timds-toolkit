---
name: design-ship
description: Finish a design change in a TimDS Design System and send it for review without the designer touching git or the toolkit. Validates the build, reviews the changed pages at desktop and phone widths, writes the changelog note, and opens the draft pull request. Use when the designer says the change is done, ready, or should be submitted, shipped, or sent for review.
---

# Ship a design change

The designer says "done". You make it reviewable: a clean check, a look at
the result, a changelog note in their words, and a draft pull request. You
never merge, release, publish to the portal, or move a product's pin; those
are other people's decisions, and you say so when asked.

## Installation mode

Read `.timds/installation.json` before installing tools. With `mode: "binary"`,
use `timds-cli` at its exact `version` in place of `npm run timds --`; skip npm
installation and npm dependency-upgrade steps for the stock system. Check
`timds-cli --version` and `timds-cli doctor`. Select another executable release
only through `timds-cli upgrade --version EXACT_VERSION`. Existing npm mode
keeps its bounded requirement and committed lockfile. Custom product tools
retain their declared prerequisites. The agent runs these steps for the designer.

## Validate

1. Run `npm run timds -- check` until it passes. Fix the cause, never the
   symptom: a color literal in a stylesheet becomes a token in `tokens.json`
   first; a broken link gets the site-absolute artifact path; a class a
   website design uses that no stylesheet declares is added to the system
   stylesheet and documented on the components page. Warnings about a
   missing voice page or logo are gaps to name in the report, not to paper
   over. A warning that a design's pages have no journey is fixed before
   shipping when the change added them: pages a visitor moves through in
   order (a funnel, a checkout, a form with its states) are declared as a
   journey in that design's `design.json` (`journeys: [{ id, title,
   steps: [{ title, screens: [{ page, state? }], branches? }] }]`), so the
   storyboard at `/designs/<design>/journeys/<id>/` shows them in order.
2. Run `npm run timds -- brand` and note any gap the change was meant to
   close that is still open.
3. Run `npm run timds -- diff` to see exactly what will ship, and confirm it
   is only this change. Unrelated files, protected tooling, `dist/`, media
   originals, and credentials never go in.

## Look at it

Serve the exact artifact with `npm run timds -- preview` and open every
changed page, every website design route and state the change touched, and
the storyboard of every journey those pages belong to,
at desktop and phone widths and in each color scheme the system offers.
Use the browser tools when they are available and fix what you see before
continuing. When you cannot open a browser, say plainly in the report that
the pages were built and validated but not viewed.

## Write the note

Append one entry after the existing notes under `## Unreleased` in
`CHANGELOG.md`; preserve the existing notes and their order so concurrent
additions can merge. Write in the designer's
language: what changed and where, as someone reading the release notes would
want it. One or two sentences; no file paths unless a reader needs them.
Lead with the area the change touches, so the note reads `Brand · Color:
...`, `Print DS: ...`, or `Web DS · Components: ...`; the published system
shows every release at `/changelog/` with that area as its label. `submit`
refuses a change without a note, because merging rolls the notes into the
release and an empty one would publish a release that says nothing.

## Submit

Run, with a title the designer would recognize:

```bash
npm run timds -- submit --message "Describe the change"
```

It publishes staged media, validates, creates a `design-system/<change>`
branch when the checkout is still on the default branch, commits, pushes,
and opens a draft pull request. If it refuses, read the reason and fix it:
changes outside the Design System scope come out of the branch; an
unauthenticated media publish needs the designer's one-time
`npm run timds -- auth login`.

## Report, and say what happens next

Give the designer the pull-request link and a two-sentence summary of what
is in it. Then explain the path to production once, in order:

1. An operator reviews and merges the pull request. Merging is the release
   decision: every accepted change becomes a dated version (`2026.10.12-1`,
   the day and the release number that day) and is published, with its notes
   on the changelog page.
2. The product site keeps using the version it pins until a developer moves
   that pin and ports what changed. The `design-handoff` skill writes the
   brief that developer needs; offer to run it once the release exists.

Do not mark the pull request ready for review, merge it, or run `publish`
unless the person asking is authorized to and says so.
