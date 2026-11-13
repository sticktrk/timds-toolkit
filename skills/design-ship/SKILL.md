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

Read `.timds/installation.json` under the Design System root (the folder
holding `timds.json`) before installing tools. With `mode: "binary"`,
use `timds-cli` at its exact `version` in place of `npm run timds --`; skip npm
installation and npm dependency-upgrade steps for the stock system. Check
`timds-cli --version` and `timds-cli doctor`. Select another executable release
only through `timds-cli upgrade --version EXACT_VERSION`. Existing npm mode
keeps its bounded requirement and committed lockfile. Custom product tools
retain their declared prerequisites. The agent runs these steps for the designer.

## Validate

1. Run `npm run timds -- check` until it passes. Fix the cause, never the
   symptom: a color literal in a stylesheet becomes an authored token first
   (`tokens/<group>.json`; `tokens.json` is generated from the groups when
   `.timds/contract-layout.json` exists, and is the authored file only in the
   older single-file layout); a broken link gets the site-absolute artifact
   path; a class a website design uses that no stylesheet declares is added
   to the system stylesheet and documented on the components page, in the
   block's Spec drawer after its preview. Warnings about a missing voice
   page or logo, an accent nearly the text color or under 3:1 on the
   background, an out-of-order type scale, or a brand kit's assumed voice
   and stock slot fallbacks are gaps to name in the report, not to paper
   over. A warning that a design's pages have no journey is fixed before
   shipping when the change added them: pages a visitor moves through in
   order (a funnel, a checkout, a form with its states) are declared as a
   journey in that design's `design.json` (`journeys: [{ id, title,
   steps: [{ title, screens: [{ page, state? }], branches? }] }]`), so the
   storyboard at `/designs/<design>/journeys/<id>/` shows them in order.
2. If this system has a workspace site (`site/timds.consumer.json` with
   `designSystem.workspace: true`), root `check` excludes it. Follow its
   consumer skill, run `consumer check --root SITE_PATH --base REF` using
   its site folder and review base, then build the site's own package and
   review the affected routes under `/site/`. Ship the site and system changes
   together; no pin moves, and deployment remains separate.
3. Run `npm run timds -- brand` and note any gap the change was meant to
   close that is still open.
4. In a Git checkout, run `npm run timds -- diff` to see exactly what will
   ship, and confirm it is only this change. Unrelated files, protected
   tooling, media originals, and credentials never go in. A standalone
   system keeps `dist/` out of source changes; an embedded system commits
   its rebuilt `design-system/dist/` with the authored change so CI's
   `check --require-clean-dist` can verify it. A hosted workspace has no
   Git; see "If you use TimDS Cloud".

## Look at it

Serve the exact artifact with `npm run timds -- preview` and open every
changed page, every website design route and state the change touched, and
the storyboard of every journey those pages belong to,
at desktop and phone widths (1440 and 390, the widths the product's review
uses) and in each color scheme the system offers.
Use the browser tools when they are available and fix what you see before
continuing. When you cannot open a browser, say plainly in the report that
the pages were built and validated but not viewed.

## Write the note

Append one entry after the existing notes under `## Unreleased` in
`CHANGELOG.md`; preserve the existing notes and their order so concurrent
additions can merge. Write in the designer's
language: what changed and where, as someone reading the release notes would
want it. One or two sentences; no file paths unless a reader needs them.
Lead with the area the change touches: the view label from `src/site.json`,
then the page, so the note reads `Brand · Color: ...`, `Print DS: ...`, or
`Web DS · Components: ...` (a brand kit's labels are `Web`, `Print`, `Ads`
and so on; toolkit work is `Maintenance: ...`); the published system shows
every release at `/changelog/` with that area as its label. Write a note for
every change even when others are already listed: `submit` refuses to run
while `## Unreleased` is empty, because merging rolls the notes into the
release and an empty one would publish a release that says nothing, and the
gate checks only that the section is not empty.

## Submit

In a Git checkout, run, with a title the designer would recognize:

```bash
npm run timds -- submit --message "Describe the change"
```

It publishes staged media, validates, creates a `design-system/<change>`
branch when the checkout is still on the default branch, commits, pushes,
and opens a draft pull request; `--dry-run` prints the commands first. If it
refuses, read the reason and fix it: changes outside the Design System scope
come out of the branch. A workspace whose provider is `local` does not
submit at all; say so.

## Report, and say what happens next

Give the designer the pull-request link (or the submission id and preview
URL) and a two-sentence summary of what is in it. Then explain the path to
production once, in order:

1. An operator reviews and merges the pull request. In a standalone system
   with managed releases, merging is the release decision: every accepted
   change becomes a dated version (`2026.10.12-1`, the day and the release
   number that day) with its notes on the changelog page. An embedded
   system's workflow only validates; its release is whatever the product's
   own process does.
2. A separate product site keeps using the version it pins until a developer
   moves that pin and ports what changed. A workspace EmDash site has no pin:
   its next build reads this system's source, and deploying it is still a
   separate decision. The `design-handoff` skill writes the
   brief that developer needs; offer to run it once the release exists.

Do not mark the pull request ready for review, merge it, or run `publish`
unless the person asking is authorized to and says so.

## If you use TimDS Cloud

- In a Git checkout, `submit` publishes staged media to the TimDS host first;
  an unauthenticated media publish needs the designer's one-time
  `npm run timds -- auth login`.
- In a hosted workspace (`timds.json` has a hosted provider, or
  `.timds/session.json` exists) there is no Git: `timds status` and the
  session's claims say what is yours. Publish any staged media first, then
  `timds submit --note "Describe the change"` (`--message` is accepted too).
  It freezes a submission with a preview for review in Studio; there is no
  branch and no pull request. Report the submission id and the Preview URL
  it prints.
- On the path to production, an operator reviews the submission in Studio,
  and a hosted system is published from Studio by someone with the right to.
  For a standalone system, publication to its public root follows the
  system's Automatic updates setting (on: published and verified; off: an
  operator publishes the candidate).
