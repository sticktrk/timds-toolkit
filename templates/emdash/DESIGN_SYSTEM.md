# Design System

This is an EmDash CMS site. Its look comes from the TimDS Design System
`__SYSTEM_ID__` (__SYSTEM_NAME__), pinned at `__DESIGN_SYSTEM_PATH__/` as a git
submodule. The Design System is a separate repository with its own review and
releases; this site follows the commit it pins.

## How the system reaches the site

__IMPORTS__
- Nothing is copied out of the submodule. Moving the pin, in a pull request
  the Design System's release automation opens here, is what changes the
  brand on this site.

## Which change goes where

| Change | Lives in | How it is made |
| --- | --- | --- |
| Pages, posts, menus, media, site settings | The EmDash database | The admin at `/_emdash/admin`, or an agent through the site's EmDash MCP server at `/_emdash/api/mcp`. No pull request. |
| Layouts, components, page templates, site styles | This repository | A draft pull request that stays inside the design surface in `timds.consumer.json`; the TimDS preview shows it before it merges. |
| Colors, fonts, tokens, logos, brand guidance | The Design System repository | A pull request there, then the pin update here. |

Content never needs a pull request, and the theme is never edited through the
CMS. When a request mixes them, split it.

## Rules for theme changes

- Never edit, pull, or commit inside `__DESIGN_SYSTEM_PATH__/`, and never
  stage a new pin. Moving the pin is a developer decision.
- Take every color, font, and spacing value from the system as `var(--…)`.
  A value the system lacks is a gap to report, not a literal to add here.
- `seed/seed.json` (collections, fields, and demo content), `astro.config.mjs`,
  `src/live.config.ts`, `src/utils/`, dependencies, and deployment are
  developer changes, outside the design surface.
- Pages are server-rendered from the database. Keep the EmDash wiring in
  `src/layouts/Base.astro` (`EmDashHead`, `EmDashBodyStart`, `EmDashBodyEnd`,
  the menu and settings queries) when restyling it.

## Hosting

__HOSTING__

## Run it locally

```bash
git submodule update --init __DESIGN_SYSTEM_PATH__
npm ci
npm run dev     # http://localhost:4321
```

Open `__DEV_SEED_ROUTE__?redirect=/_emdash/admin` once on a fresh checkout. It
loads the starter's demo content into the local database and signs you in as
a development administrator; the route answers only under `npm run dev`.
