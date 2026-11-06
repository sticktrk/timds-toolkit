---
name: design-start
description: Begin a design session in a TimDS Design System repository with the tooling handled for the designer. Installs the toolkit, confirms the system builds, opens the local preview, starts a change branch, and reports the state of the system in plain language. Use when the designer wants to start working, look at the system locally, or begin a change ("let's work on the typography page", "open the preview", "I want to redesign the pricing page").
---

# Start a design session

The designer's job is design. Everything else here is yours: installing,
building, branching, and reading the state of the system. Never hand the
designer a command to run, except the one-time browser sign-in that only
they can complete.

## Installation mode

Read `.timds/installation.json` before installing tools. With `mode: "binary"`,
use `timds-cli` at its exact `version` in place of `npm run timds --`; skip npm
installation and npm dependency-upgrade steps for the stock system. Check
`timds-cli --version` and `timds-cli doctor`. Select another executable release
only through `timds-cli upgrade --version EXACT_VERSION`. Existing npm mode
keeps its bounded requirement and committed lockfile. Custom product tools
retain their declared prerequisites. The agent runs these steps for the designer.

## Get the workspace running

1. Read the repository's `AGENTS.md` completely. It holds the rules; the
   `timds-edit-design-system` skill holds the editing procedure. Follow both.
   Paths below are relative to the Design System root: the repository in a
   standalone system, `design-system/` in an embedded one.
2. If `timds.json` has a hosted provider or `.timds/session.json` exists,
   this is a hosted workspace: use `timds status` and keep the session, do
   not run Git commands, and follow the installed hosted skill for that
   system (`timds-<system>`, which `timds skills install` renders) to sign
   in, start or join a session, and claim paths. Run the CLI there as
   `npx --yes @dtconcepts/timds@latest <command>` (a session folder has no
   package script for it) and skip step 3 and the branch below. When no session exists
   yet, that skill's start or join step comes first.
   For a Git checkout, run `git status --short` and keep every pre-existing
   change. If it is on the default branch, create `design-system/<change>` named for what
   the designer wants to do (`design-system/pricing-page`). If it is already
   on a `design-system/` branch, stay on it unless the designer is starting
   something unrelated.
3. Install: `npm ci` when a lockfile is committed, otherwise `npm install`
   once (the lockfile it writes belongs in the first commit).
4. Run `npm run timds -- doctor`, then `npm run timds -- check`, then
   `npm run timds -- brand`. A failure here is yours to fix or explain, never
   the designer's: a missing dependency, a stale build, a broken link in a
   page. A fresh ordinary starter passes `check` with two expected warnings
   (no `brand/voice` page and no annotated logo). A fresh brand kit
   (`starter: "brand-kit"` in `.timds/starter.json`) authors its Voice page
   and instead warns that its voice is assumed, still reports no annotated
   logo, and lists the stock media slots it is falling back on.
5. Start the authoring server with `npm run timds -- dev` in the background
   and give the designer the URL it prints (the starter serves
   `http://127.0.0.1:4321`, with website designs under `/designs/`; a system
   with no `workspace.dev` command falls back to `preview` on 4400). If that
   port is busy, use `npm run timds -- dev --port 4322`; do not stop another
   workspace's server. The starter server does not watch files: after every
   edit you make, rerun `npm run timds -- check` and tell the designer to
   reload. A framework dev server may reload on its own; say which applies.

## Tell the designer where things stand

Report in the designer's terms, not the toolkit's:

- Which views and pages exist, which are still planned, and what the brand
  kit lacks (from `brand`), each gap with what would fill it. In the starter
  the front page is the Use view's landing page, and its Start, Compose and
  Install pages are stock fragments the toolkit refreshes on every upgrade
  while they are unmodified, so a change there is a change to stock.
- Whether the system is an offshoot (`.timds/parent.json` names the parent
  release it was shot from); that lineage is protected and `feed` brings
  parent changes in.
- Which website designs exist under `src/designs/` and their routes,
  states, and journeys (the storyboards at `/designs/<design>/journeys/<id>/`),
  when the system has any. A design whose pages a visitor moves through in
  order but that declares no journey in its `design.json` is a gap to name:
  `check` warns about it.
- The current version in `timds.json` and the unreleased notes in
  `CHANGELOG.md`, so the designer knows what is already in flight.
- The URL to look at, and that you will rebuild after each change.

Do not paste command output. Translate it.

## Then design

If the designer named a change, begin it now following
`timds-edit-design-system`. Otherwise ask what they would like to work on,
in one question. When the change is done and looked at, the
`design-ship` skill takes it the rest of the way.
