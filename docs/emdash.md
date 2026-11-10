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

## Adding EmDash to an existing site

```bash
npx --yes @dtconcepts/timds@0.1.x consumer scaffold emdash --existing \
  --root /path/to/site [--platform cloudflare|node] [--layout PATH] \
  [--site-url URL] [--skip-install]
```

`--existing` is for an Astro site that already consumes a Design System
through `timds.consumer.json` (adopt it with `timds consumer init` first). It
installs the shared EmDash template set, so the site gains an articles
section whose entries arrive through EmDash's REST API or MCP server. It
writes no default pages: an existing site already ports its own from its
system. The fresh scaffold will move onto the same template set, so a fix
found on one site lands in one place.

The files install at the site root: the folder of the manifest's only app, or
of its root app (`"cwd": "."`) when it declares several. It writes:

- Every file under `templates/emdash/site/`, and under `site-cloudflare/` or
  `site-node/` for the chosen platform (`cloudflare` by default), at the same
  path in the site: the article and topic routes, the Portable Text
  serializer, the seed, `src/live.config.ts`, `docs/content-api.md` and
  `docs/emdash-handover.md`. The placeholders are filled: the layout import,
  relative from each file to the layout component (`--layout PATH`, an
  `.astro` file relative to the site root, else `src/layouts/Base.astro`), the
  origin of `--site-url` (`https://example.com` without it, listed for the
  developer to replace), and the `package.json` name.
- In `package.json`, each dependency the templates need that the site does
  not declare yet, and the `emdash.seed` key. A dependency the site already
  declares, in either block, is kept exactly as it is and reported with the
  version the templates were written for. The file keeps its indentation and
  final newline.
- In `timds.consumer.json`, for the app's crawl preview: the article routes
  not yet listed, a `preview.designs` pair for each article route whose
  design the pinned system has (never replacing a pair the site declared),
  `/_emdash/**` in `preview.discover.exclude` when the app discovers routes,
  and EmDash's seed route as `preview.ready` when the app's is absent or `/`.
  The result is validated before it is written.
- `.timds/emdash.json`, the template version and platform the site came from
  (`{ "template": 1, "platform": "cloudflare" }`).

The seed defines the content model external writers target: an `articles`
collection (`title`, `summary`, `body` as Portable Text, and `cover`; the
slug, status, published date and bylines are EmDash's own system fields) and
a flat `topic` taxonomy, named in the singular as EmDash names taxonomies and
served at `/topics/<slug>/`. `docs/content-api.md` in the site is that
contract, and renaming any slug in it is a breaking change for writers. The
seed's three sample articles load only through EmDash's development seed
route, so a preview has `/articles/example-article` and
`/topics/example-topic` to show beside their designs; a production setup that
declines sample content starts empty. The routes render the starter's article
designs: plain elements inside one `prose` wrapper, a table inside
`table-scroll`, and no CSS of their own.

The design pairs come from the pinned system's designs: the designs summary
in the bundle of the exact version a published pin names (the record
`consumer sync` keeps and `consumer check` reads), or the submodule checkout.
The current release never stands in for the pinned one, so a site pinned to a
version from before the article designs gets no pairs until it moves the pin.
When they cannot be read the mode pairs nothing and says so. A route whose
design the pinned version lacks is listed as having no design yet:
the article designs arrive with the starter, and a system with its own
website design authors them.

It refuses, before writing anything, when `--root` is not a directory, when
there is no `timds.consumer.json` or it is invalid, when the site's
`package.json` is missing or does not depend on `astro`, when the manifest
declares several apps and none at the root, when the layout cannot be found,
when `--platform` or `--site-url` is not one it accepts, and when any path it
would write already exists, file or directory alike. Every colliding path is
listed in one error: the mode never overwrites a file and never edits an
existing page. A site with its own `src/live.config.ts` moves it aside, reruns,
and adds its collections to the installed file, which defines the `_emdash`
live collection EmDash reads entries through. A different `emdash.seed` in
`package.json` is refused the same way. A failure part-way through the writes
removes the files the run created and restores `package.json` and the
manifest. A second run refuses, because the paths exist.

It prints the files written, the dependencies added and kept, the changes to
`astro.config` (and, on Cloudflare, `wrangler.jsonc`) with the snippet for
each, and the `.gitignore` lines to add, and only then, unless
`--skip-install`, runs `npm install` in the site, so a failed install does not
take the instructions with it. It does not make those changes
itself: an existing site's adapter, `output: "server"`, bindings and
prerendered pages are its own choices, and an edit the mode cannot verify
would break a build silently. The handover checklist is in the site's
`docs/emdash-handover.md`; the printed list adds what only this run knows:
kept dependencies, routes with no design, a `preview.ready` it left alone,
and the install it skipped. Rerun `timds consumer init` afterwards so the
consumer skill and the launch entries match the edited manifest.

On Cloudflare the site builds with Astro and deploys with Wrangler. The
handover names Cloudflare's `cf` CLI for the account and resource tasks beside
that (the D1 database, the R2 bucket, the Access application for `/_emdash/*`
and the writer's Access service token), and says why deploy stays on
Wrangler: `cf build` and `cf deploy` need a build output the Astro Cloudflare
adapter does not write yet, and `cf` cannot set a single secret.

Everything written is product source. `upgrade` never touches it, and neither
`upgrade` nor `consumer init` reads or rewrites `.timds/emdash.json`; a
`consumer init --force` regenerates the manifest, so the article routes and
pairs are then added back by hand. Template fixes reach an existing site by
hand, and the recorded template version says how far behind it is.
