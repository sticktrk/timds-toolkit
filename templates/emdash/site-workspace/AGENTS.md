# EmDash site

This folder is an EmDash site inside the workspace of the TimDS Design
System `__SYSTEM_ID__`. Read `DESIGN_SYSTEM.md` before changing anything here:
the site's pages, layout and styles come from the system's website design
`src/designs/__DESIGN_ID__/` and its stylesheets and tokens, read from their
source paths, so a change to how the site looks is a change to the system.

- Content (articles, topics, media) goes through EmDash: the admin, the REST
  API or the MCP server, never a commit. The writer's contract is
  `docs/content-api.md`.
- A page's look and copy are edited in the design file in the system, never
  copied into `src/pages/`.
- A style the site needs that the system lacks is added to the system in the
  same change: `__SITE_CHECK__`, run from the repository root, finds
  it and says what to add. Never change an existing token's value or an
  existing class's rules.
- The `timds-consume-design-system` and `timds-update-design-system` skills
  in the repository root's `.agents/skills/` walk through a design change
  and the article routes the system does not style yet.
- The site is its own package: run npm in this folder, not at the workspace
  root. Deploying is in `docs/emdash-handover.md`.
