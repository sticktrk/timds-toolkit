# EmDash site

This folder is an EmDash site inside the workspace of the TimDS Design
System `__SYSTEM_ID__`. Read `DESIGN_SYSTEM.md` before changing anything here:
the site's pages, layout and styles come from the system's website design
`src/designs/__DESIGN_ID__/` and its stylesheets and tokens, read from their
source paths, so a change to how the site looks is a change to the system.

- Content (articles, topics, media) goes through EmDash: the admin, the REST
  API or the MCP server, never a commit. The writer's contract is
  `docs/content-api.md`. Valid `body_html` renders with its original bytes.
  Missing, blank or rejected HTML uses the Portable Text body.
  Read `docs/article-presentation.md` for literal site-owned article regions,
  structured metadata, related-guide and video fields. Content profile selection
  happens only when scaffolding, before database setup.
- `sections.json` declares the collections and their address prefixes;
  version 2 permits nested prefixes within this one selected design, while
  ordinary parent and sibling pages stay public. Public design pages or
  native Astro routes cannot occupy collection namespaces. Mark additional
  design samples with `{ "title": "Sample title", "site": "reference" }`
  in `design.json`'s `pages` entry; see `DESIGN_SYSTEM.md`.
  Public-file collisions and route/public symlinks are also refused. Only
  declaration version 2 is supported. Invalid section JSON keeps the last
  validated dev inventory; a route conflict returns 503 until corrected.
  `section-schema.json` declares their shared fields and features. After
  editing either, run `npm run sections:sync` here and the consumer check.
  A live database also needs new collections created; a seed is applied only
  during setup. Hosted deployment never changes an existing collection's schema.
- A page's look and copy are edited in the design file in the system, never
  copied into `src/pages/`.
- A style the site needs that the system lacks is added to the system in the
  same change: `__SITE_CHECK__`, run from the repository root, finds
  it and says what to add. Never change an existing token's value or an
  existing class's rules.
- A form in the design that posts (`<form method="post">`) is rendered
  disabled, with a line saying it is not connected yet, until the site has a
  handler for the address it posts to: a module in `src/forms/` named for
  that address (`src/forms/contact.ts` for `/contact`) that exports a `POST`
  function.
  `DESIGN_SYSTEM.md`, "Forms", has the steps. Never add a handler that
  pretends to deliver what it does not.
- The `timds-consume-design-system` and `timds-update-design-system` skills
  in the repository root's `.agents/skills/` walk through a design change
  and the article routes the system does not style yet.
- The site is its own package: run npm in this folder, not at the workspace
  root. Deploying is in `docs/emdash-handover.md`.


Optional `divisions.json` mounts owner-authored HTML fragments in
`src/divisions/` with a layout in `src/layouts/` and a selected reference
design. Put division navigation in that layout and expose both its default
and `head` slots. Associate collections by slug while keeping their native
URL patterns and shared schema in the sections files. A layout receives
`context.base` and `context.prefix` for mounted links. Keep styling in the
selected design rather than importing an additional Design System.
That rule also applies to components and stylesheets the layout imports.
Use literal relative local imports; the check, build and dev read the same
dependency graph without executing it. Shared article components must work
with every collection context and the main topic views; their literals are
never automatically rewritten against a single context. Scoped Astro styles
can provide self-contained family navigation without importing system CSS.
