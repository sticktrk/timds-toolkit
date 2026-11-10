# EmDash sites

The scaffold command is in the [README](../README.md#emdash-sites).

`--root` must not exist, or be empty, and must sit outside any git repository.
The scaffold initializes the repository, adds the Design System as the
`design-system` submodule, generates EmDash's unstyled `starter` template with
`create-emdash@1` (the generator needs network access), and writes:

- `src/styles/theme.css`, which imports the system's stylesheets from the
  submodule and styles the site shell with the token that fills each brand
  role (`var(--…)`, never a literal). A role nothing fills leaves its
  declaration out and is listed for the developer.
- `src/utils/design-system.ts`, only for a system that still runs the starter
  build: that build writes `tokens.css` from `tokens.json` into `dist/`, so
  the site compiles the pinned `tokens.json` by the same `--group-name` rule
  and `src/layouts/Base.astro` puts the result on every page.
- Relative symlinks in `public/` for the Design System's top-level `public/`
  files and directories. Root-relative stylesheet URLs such as
  `/fonts/example.woff2` and `/images/background.svg` reach those pinned
  assets in development and in the build. The links and their descendants
  are protected from designer changes; a path that conflicts with the EmDash
  template is refused. A developer must add a link if a later pin introduces
  a new top-level public asset path.
- `timds.consumer.json` with the site as one root app: `preview.serve` runs
  `astro dev` on port 4380 with `--ignore-lock` (Astro otherwise backgrounds
  the server when an agent starts it), `preview.ready` is EmDash's
  development-only seed route (`/_emdash/api/setup/dev-bypass?redirect=/`), so
  waiting for the server also loads the starter's demo content into the local
  database, and the design surface is the theme (`src/layouts`,
  `src/components`, `src/styles`, `src/pages`, `public`).
- `DESIGN_SYSTEM.md` and a section in `AGENTS.md` that say which change goes
  where: content through the EmDash admin or its MCP server, the theme through
  a pull request inside the design surface, the brand through the Design
  System and a pin update.

`--platform` chooses the hosting: `cloudflare` (the default) generates the
Workers variant, with a D1 database and an R2 bucket, and renames the Worker,
database, and bucket in `wrangler.jsonc` after the site (the template ships
one shared placeholder name, and two sites in an account would otherwise
deploy over each other) and writes `.github/workflows/deploy-cloudflare.yml`;
`node` generates a Node.js server with SQLite and local file storage. Local
development and previews need no Cloudflare account on either.

The deploy workflow builds the site against the pinned Design System and runs
`wrangler deploy` with the `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`
secrets; the first deployment creates the D1 database and the R2 bucket. It
runs only when started by hand until the repository variable
`CLOUDFLARE_DEPLOY_ON_PUSH` is `true`, because a deployed EmDash site lets its
first visitor create the administrator until setup is completed. The workflow
is product source: `upgrade` never touches it.

`--stylesheet PATH` (relative to the Design System root, repeatable) names
what the site imports; it defaults to `src/styles/system.css` when the system
has one, and is required for a system on its own framework. With `--site-url`,
`.mcp.json` also gets the site's EmDash MCP server
(`<origin>/_emdash/api/mcp`), which signs each person in through the site's
own OAuth with their EmDash role. Nothing is copied out of the Design System,
nothing is committed, and a failure before the site is adopted removes what
was created. The scaffold writes product source: `upgrade` later refreshes
only the consumer-managed files, never the theme.
