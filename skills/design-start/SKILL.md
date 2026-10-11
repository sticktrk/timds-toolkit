---
name: design-start
description: Begin a design session in a TimDS Design System repository with the tooling handled for the designer. Installs the toolkit, confirms the system builds, opens the local preview, starts a change branch, and reports the state of the system in plain language. Use when the designer wants to start working, look at the system locally, or begin a change ("let's work on the typography page", "open the preview", "I want to redesign the pricing page").
---

# Start a design session

The designer's job is design. Everything else here is yours: installing,
building, branching, and reading the state of the system. Never hand the
designer a command to run, except the one-time browser sign-in that only
they can complete.

## Get the workspace running

1. Read the repository's `AGENTS.md` completely. It holds the rules; the
   `timds-edit-design-system` skill holds the editing procedure. Follow both.
2. Run `git status --short`. Keep every pre-existing change. If the checkout
   is on the default branch, create `design-system/<change>` named for what
   the designer wants to do (`design-system/pricing-page`). If it is already
   on a `design-system/` branch, stay on it unless the designer is starting
   something unrelated.
3. Install: `npm ci` when a lockfile is committed, otherwise `npm install`
   once (the lockfile it writes belongs in the first commit).
4. Run `npm run timds -- doctor`, then `npm run timds -- check`, then
   `npm run timds -- brand`. A failure here is yours to fix or explain, never
   the designer's: a missing dependency, a stale build, a broken link in a
   page. A fresh scaffold passes `check` with two expected warnings (no
   `brand/voice` page and no annotated logo).
5. Start the authoring server with `npm run timds -- dev` in the background
   and give the designer the URL it prints (the starter serves
   `http://127.0.0.1:4321`, with website designs under `/designs/`). The
   starter server does not watch files: after every edit you make, rerun
   `npm run timds -- check` and tell the designer to reload.

## Tell the designer where things stand

Report in the designer's terms, not the toolkit's:

- Which views and pages exist, which are still planned, and what the brand
  kit lacks (from `brand`), each gap with what would fill it.
- Which website designs exist under `src/designs/` and their routes and
  states, when the system has any.
- The current version in `timds.json` and the unreleased notes in
  `CHANGELOG.md`, so the designer knows what is already in flight.
- The URL to look at, and that you will rebuild after each change.

Do not paste command output. Translate it.

## Then design

If the designer named a change, begin it now following
`timds-edit-design-system`. Otherwise ask what they would like to work on,
in one question. When the change is done and looked at, the
`design-ship` skill takes it the rest of the way.
