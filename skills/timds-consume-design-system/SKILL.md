---
name: timds-consume-design-system
description: Make design changes to a product that consumes a TimDS Design System through its pinned design-system/ submodule, on behalf of a designer who reviews the result rather than the code. Use for changing a product's styles, components, page layout, copy placement, or imagery within its declared design surface; running the product locally to look at a change; and opening a draft pull request with a cloud preview link.
---

# Use the TimDS Design System in this product

You are working in a product repository (a website or app) for a designer who
will judge the change by looking at it, not by reading code. The product's
brand lives in a TimDS Design System, `__SYSTEM_ID__`, pinned at
`__DESIGN_SYSTEM_PATH__/`. `timds.consumer.json` at repository root declares
each app, how to run it, the routes to review, and the paths a designer change
may touch. Work only in the repository the user supplied.

## Start

1. Read the repository's root `AGENTS.md`, `CLAUDE.md`, and any product
   skill or `DESIGN_SYSTEM.md` completely. Product rules add to these; where
   they are stricter, they win.
2. Run `git status --short` and preserve all pre-existing work. Create or use
   a non-default branch named for the change, such as `design/hero-spacing`.
3. Run `git submodule update --init __DESIGN_SYSTEM_PATH__` so the checkout
   matches the pin, then `npm ci` at repository root.
4. Read the app's section under **This product** below before editing.

## The Design System is pinned, not edited here

- `__DESIGN_SYSTEM_PATH__/` is a git submodule at the exact commit this
  product was reviewed against. Never `git pull`, switch, or commit inside it,
  and never stage a new pin. Moving the pin is a separate developer decision.
- Never copy Design System source, stylesheets, fonts, or images into the
  product. Reference what the app already imports from the submodule.
- When the system lacks what the change needs (a token, a component, a role,
  guidance), say so. The fix belongs in the Design System repository through
  its own pull request, not in a product-side workaround.

## Read the system, never invent it

Take every color, font, spacing value, logo, and image from the system:

- After `npm --prefix __DESIGN_SYSTEM_PATH__ ci` and
  `npm --prefix __DESIGN_SYSTEM_PATH__ run timds -- check`, the derived layer
  sits beside the built entry page under `__DESIGN_SYSTEM_PATH__/dist/`
  (usually `dist/design-system/`): `brand.json` (brand roles, logos,
  imagery), `tokens.json` (resolved CSS custom properties by scope),
  `llms.txt`, and a Markdown mirror of every guidance page. These are build
  output: read them, never edit or commit them.
- When the `timds-design-system-read` MCP tools are connected, prefer them:
  `describe_system`, then `resolve_role` for "what is the accent color" or
  "what font are headings" (`color.accent`, `color.text`, `font.display`,
  `font.body`, …), `get_tokens` for token names, `get_brand` and `list_media`
  for marks and imagery, `search_guidance` and `read_page` for voice and
  compliance. Note the version the tools serve; the product is built against
  the pinned commit, which may trail it.
- Prefer brand roles over guessing from token names. In product CSS use the
  token's `name` (`var(--…)`), never its resolved literal.
- An unfilled role or missing token is a gap, not something to invent. Report
  it, and file it with `report_gap` when the user agrees.
- Compliance guidance is binding. When requested copy conflicts with it, say
  so instead of complying silently.

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
   Shared imagery belongs to the Design System and is published with
   `npm run timds -- assets add` and `assets publish` from that repository;
   reference its stable URL or media key here. Small optimized images may
   live in the product only where its rules allow them.
5. Keep light and dark schemes, desktop and phone widths, focus states, and
   contrast working.

## Look at it

Start the app with its `.claude/launch.json` entry (named below) in the
browser pane, or run its serve command from the app folder. Visit each review
route at desktop and phone width, in light and dark scheme, and check the
requested change, overflow, navigation, and images. Fix what you find before
opening the pull request.

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
4. The `timds-consumer-preview` workflow comments a preview link on the pull
   request for each app and updates that comment on every push. Give the
   designer that link; if the comment is missing, say so and offer the local
   preview instead.
5. Never merge, mark ready for review, deploy, move the Design System pin, or
   change managed TimDS files (`.agents/skills/timds-consume-design-system/`,
   `.github/workflows/timds-consumer-preview.yml`, `.timds/installation.json`)
   without separate authorization.

## Report the result

Lead with what changed, in the designer's words. Include the pull-request link,
the preview link, the routes and widths you checked, the Design System roles
and tokens used, and anything that needs a developer or a Design System change.

## This product

__APPS__
