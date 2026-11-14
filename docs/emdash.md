# EmDash sites

The scaffold commands are in the [README](../README.md#emdash-sites).

## Choosing a mode

`timds consumer scaffold emdash` has two modes. A system's own website lives
in the system's workspace with `--workspace` ([a site in its Design System's
workspace](#a-site-in-its-design-systems-workspace)): it has no pin, reads the
system from source, and is edited, reviewed and committed with it. The fresh
mode creates a separate site repository with the system pinned as a submodule
([a new site repository](#a-new-site-repository)).

A third mode, `--existing`, is withdrawn: the command refuses the flag, says
to use `--workspace`, and writes nothing ([adding EmDash to an existing
site](#adding-emdash-to-an-existing-site)).

Use the Design System root's selected `npm run timds --` command, or
`timds-cli` for binary mode. The site still needs Node and npm for its own
Astro/EmDash package. Scaffold output is prose; it has no `--json` contract.
For a read-only workspace-site check, use
`npm --silent run timds -- consumer check --root site --no-fix --json`
(`--root design-system/site` for an embedded system). Omitting `--no-fix`
permits the documented token substitutions in site source.

## A new site repository

For an agent, inspect `consumer scaffold emdash --help` from the selected
toolkit release before creating the destination. The command requires Git,
Node and npm for EmDash's generator and product toolchain even when TimDS
runs as `timds-cli`. `--skip-install` skips the product's final `npm install`;
it still runs the generator and adds the Design System submodule.

`--root` must not exist, or be empty, and must sit outside any git repository.
The scaffold initializes the repository, adds the Design System as the
`design-system` submodule, generates EmDash's unstyled `starter` template with
`create-emdash@1` (the generator needs network access), and writes:

- `src/styles/theme.css`, which imports the system's stylesheets from the
  submodule and styles the site shell with the token that fills each brand
  role (`var(--…)`, never a literal). A role nothing fills leaves its
  declaration out and is listed for the developer.
- `src/utils/design-system.ts`, only when the system's `workspace.build` is
  exactly `["node", "scripts/build.mjs"]`: that starter build writes
  `tokens.css` from `tokens.json` into `dist/`, so
  the site compiles the pinned `tokens.json` by the same `--group-name` rule
  and `src/layouts/Base.astro` puts the result on every page. Other build
  commands, including the binary starter command, are not currently detected
  for token-module generation; their selected stylesheets must supply the
  tokens the site needs.
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

**Withdrawn.** `timds consumer scaffold emdash --existing` refuses with a
message that names `--workspace` and writes nothing: TimDS no longer adds
EmDash to a site in its own repository that reads its Design System through a
pin. The rest of this section describes the mode as it was built. It is kept
because the workspace mode installs the same template set, and it goes when
the mode's code is removed.

The retained `scaffoldExistingEmdashSite` function and its tests describe an
Astro site that already consumes a Design System
through `timds.consumer.json` (adopt it with `timds consumer init` first). It
installs the shared EmDash template set, so the site gains an articles
section whose entries arrive through EmDash's REST API or MCP server. It
writes no default pages: an existing site already ports its own from its
system. This is historical implementation documentation, not an available
CLI workflow; use one of the two supported modes above.

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
  (`{ "template": 3, "platform": "cloudflare" }`).

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
existing page. It also refuses a site page at a route a template page takes
by Astro's file routing, naming both files: `src/pages/articles.astro` beside
the template's `articles/index.astro`, `articles/[id].astro` beside
`articles/[slug].astro`, an endpoint beside a page (`.astro`, Markdown,
`.mdx`, `.html`, `.js` and `.ts` are compared; a name that starts with `_`
is not a route). A static page beside a dynamic one is not a collision, and
an existing dynamic or catch-all page the article routes now outrank is
named in the closing list. The comparison reads `src/pages/` only, so a site
with its own `srcDir` is not checked. A site with its own `src/live.config.ts` moves it aside, reruns,
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

## A site in its Design System's workspace

```bash
npm run timds -- consumer scaffold emdash --workspace [--root PATH] [--skip-install]
```

Run it in a Design System workspace (`timds-cli consumer scaffold emdash
--workspace` in binary mode). The workspace is found the way the workspace
commands find it: the repository root (a hosted session folder, the git top
level, or the nearest folder holding `timds.json` or
`design-system/timds.json`) when it holds `timds.json`, else its
`design-system/` folder. The site goes in `site/` of the Design System root:
`site/` in a standalone system, `design-system/site/` in an embedded one.
`--root` defaults to the current folder.

The mode writes a complete EmDash site for Cloudflare Workers. It runs no
generator and asks nothing; every name comes from the system's id, so one
toolkit release writes the same bytes for the same workspace. It refuses,
before writing anything, when the folder is not in a Design System workspace,
when `timds.json` has no `systemId`, when `site/` exists and is not an empty
directory, when the system has no website design with a page to build (`timds
designs init` adds the starter's sample), when `.agents` or `.agents/skills`
at the repository root is not a directory, when a consumer skill folder there
holds anything but the bytes it would write, and when the system's
`AGENTS.md` is not a regular file. `--existing` is withdrawn and refused
everywhere. `--design-system`, `--stylesheet`, `--portal-url` and `--site-url`
belong to the fresh mode and are refused here. `--layout` belonged to the
withdrawn mode and is refused in both supported modes, as is any workspace
`--platform` but `cloudflare`. A
failed write removes the site and restores the files outside it. Then, unless
`--skip-install`, it runs `npm ci` in `site/`; a failed install leaves the
files in place, and the scaffold is not rerun (it refuses a folder that is
not empty).

### What it writes

In `site/`, the shared template set (`templates/emdash/site/` and
`site-cloudflare/`: the article, topic and feed routes, the Portable Text
serializer, the seed, `src/live.config.ts`, `src/worker.ts` and
`docs/content-api.md`) with `templates/emdash/site-workspace/` laid over it,
where a file at the same path replaces the shared one:

- `astro.config.mjs`: EmDash with D1 (`DB`) and R2 (`MEDIA`) bindings,
  `output: "server"`, `base` from `TIMDS_SITE_BASE` (else `/`), the dev port
  from `TIMDS_SITE_PORT` (else 4380, with `strictPort`), `migrations: {
  runtime: "check", dev: "auto" }`, EmDash's MCP server, no plugin registry,
  and the integration that reads the system, naming the website design.
- `src/integrations/design-system.mjs`, `src/pages/[...page].astro`,
  `src/pages/404.astro`, `src/components/DesignPage.astro`,
  `src/layouts/Base.astro` and `src/design-system.d.ts` (below).
- `wrangler.jsonc`, `tsconfig.json`, `package-lock.json`, `.gitignore`,
  `.env.example`, `AGENTS.md`, `DESIGN_SYSTEM.md` and the workspace version of
  `docs/emdash-handover.md`.
- `package.json`, generated: private, named `<system id>-site` (slugged), the
  exact versions `templates/emdash/site.json` lists for every mode plus the
  workspace block, and the scripts `dev` (`astro dev`), `build`, `preview` and
  `worker`, plus the explicit `sections:sync` command. The site is its own
  package, not an npm workspace of the root, and
  declares no toolkit: it uses the workspace's.
- `timds.consumer.json` and `.timds/emdash.json` (both below).

Outside `site/`, beside the system's own guidance:

- The two consumer skills, `timds-consume-design-system` and
  `timds-update-design-system`, in `.agents/skills/` at the repository root,
  rendered for the site's manifest in their workspace form (the skill sources
  keep that text in `<!-- timds:workspace -->` blocks beside the pinned text,
  and every path in it is written from the repository root). A skill folder
  that already holds exactly those bytes is kept.
- One section in the system's `AGENTS.md` (created when there is none),
  between `<!-- timds:emdash-site -->` and `<!-- /timds:emdash-site -->`: where
  the site is, which change goes where, and the check to run. A section that
  is already there is left as it is.

The run prints the files written, the pages built from the design, the
article routes with no port yet, and what the developer confirms: the
install if it was skipped, loading the sample content, the routes to port,
the deploy handover, and committing the site with the system.

### The manifest has no pin

```json
{
  "schemaVersion": 1,
  "designSystem": { "workspace": true, "systemId": "acme/core" },
  "apps": {
    "site": {
      "cwd": ".",
      "install": ["npm", "ci", "--no-audit", "--no-fund"],
      "preview": {
        "serve": ["npm", "run", "dev", "--", "--host", "127.0.0.1", "--ignore-lock"],
        "port": 4380,
        "ready": "/_emdash/api/setup/dev-bypass?redirect=/",
        "routes": ["/", "/about", "/articles", "/articles/example-article", "/topics/example-topic"],
        "designs": { "/": "website:/", "/about": "website:/about", "/articles": "website:/articles" }
      },
      "designSurface": ["src/layouts/**", "src/components/**", "src/styles/**", "src/pages/**", "public/**"]
    }
  }
}
```

(Abridged: the routes are `/`, every page of the design that is not an
article, topic or 404 route, and the article routes; each route the design
has is paired with it; the preview also discovers routes, at two viewports
and two schemes.) `designSystem.workspace: true` takes no `path`, `version`
or `url`, and each is refused with the reason. The Design System is the
nearest folder above the site that holds `timds.json`. A consumer manifest is
looked for at or above the starting folder, never below it, so the workspace
root stays a plain Design System: `timds upgrade` there is the system's own.

In the site:

- `consumer check` needs no bundle record, gitlink or toolkit lock: it
  confirms a Design System sits above the site (warning when its `systemId`
  differs), that `package.json` and the lockfile are there (warning until
  they are committed), the
  design pairs, `--require-token`, and, with `--base`, the design surface.
  There a change outside the site folder has status `system` and is left to
  the system's own check; such a change previews every app.
  `--allow-pin-update` is refused: there is no pin.
- `consumer sync` does nothing and says so, so a script that runs it
  everywhere still passes. `consumer update` (with a version or `--draft`),
  `consumer migrate`, `consumer register` and `consumer updates` refuse: there
  is nothing to move, migrate or follow; try a draft by checking out its
  branch of the workspace.
- `consumer init`, `timds upgrade` and `timds-cli installation adopt --binary`
  refuse inside the site and name the workspace root, where they belong.
  `consumer init` at a Design System root refuses too and points at
  `--workspace`.
- `consumer preview` builds the base side of `--base` from the same
  repository's merge base, with the site at its folder in the temporary
  worktree; changed files outside the site are named from the site
  (`../src/styles/...`). It starts the site on `preview.port`, which must be
  free. For the designs shown beside the routes it runs the Design System's
  declared `workspace.build` on every run, so they carry the current tokens
  and stylesheets; that build writes the system's `dist/`, as `timds dev`
  does, and when it fails the preview shows the routes without the designs
  and says why.

### Pages from the designs

The site builds its pages from the system's website design named by
`designSystem({ design: "<id>" })` in `astro.config.mjs`. The scaffold picks
the one with a home page (`website` first, else the first in order). Consumer
checks and previews parse the active exported configuration's literal selection
without executing it. Comments, strings and unused calls cannot select a design;
an ambiguous or computed selection is refused. Changing the selection also
changes their page and reference inventory. Its
integration (`src/integrations/design-system.mjs`) runs in Node while `astro
dev` serves and while `astro build` builds, never in the Worker:

- Every ordinary page of the design is a page of the site. Declaration
  version 2 excludes only the stock article/topic references and pages marked
  `site: "reference"` in `design.json`; a public page inside a collection or
  topic namespace is a conflict, never silently omitted. Public pages are filled
  the way the system's own renderer fills it (`layout.html` around the page,
  the `{{name}}`, `{{description}}`, `{{version}}` and `{{title}}`
  placeholders), with Astro's `base` in front of root-relative `href`, `src`,
  `action`, `formaction`, `poster` and `srcset` values, quoted or not (text
  in other attributes, comments, scripts, styles and textareas is never
  rewritten). Only a page's default state is served: `about.html` or
  `about.default.html` (one of them, as the designs catalog requires); named
  states
  (`contact.sent.html`) stay references in the system.
- A form in the design that posts (`<form method="post">`) is rendered
  disabled, with its controls disabled and a line saying it is not connected
  yet, until the site has a handler for the address it posts to. A POST to a
  design page with no handler answers 405 with an `Allow` header, so no
  submission is taken in and dropped. A form's POSTs are its own
  (`method="post"`) and those of each submit button with its own
  `formmethod="post"` or `formaction`; any of them that reaches an address of
  the site with no handler disables the whole form. Forms that read with GET,
  and forms that post to another origin, are left as the design wrote them.
- The article, topic and 404 routes render inside the design's layout, or,
  for a design without `layout.html`, inside its home page with the content
  of its `<main>` taken out.
- `/styles/`, `/scripts/` and `/assets/` are the system's `src/` folders of
  those names, at the URLs its own build serves them from, and, for a system
  on the starter build, `/tokens.css` compiles `tokens.json` (or the
  `tokens/` groups) by the starter build's rule: `--group-name` declarations,
  with each `{group.name}` reference compiled to `var(--group-name)`. In
  development they are read from disk on every request; a build copies them
  into the client output under their names on disk.

To wire a form up, add a module under the site's `src/forms/` named for the
address the form posts to (`src/forms/contact.ts` for `/contact`,
`src/forms/index.ts` for `/`) that exports `POST`, an Astro endpoint function.
Middleware the integration registers passes each POST to that address to it
before Astro picks a page, so a page the site has at the same address (the
article list at `/articles`) answers its GET but never the POST; a GET still
renders the design's page, and the form renders enabled on the next build (at
once under `astro dev`) with no change to the design. The integration decides
which forms have a handler from the site's files each time it builds the
pages, in development and in the build alike. It reads each module's exports
with the parser of the Vite the site's Astro runs on, so `export async
function POST`, `export const POST = …`, `export { handler as POST }` and
`export { POST } from "./elsewhere"` count, and a comment or string that
mentions POST does not; `export *` does not either, so name `POST`. When a
request comes, the middleware checks that `POST` is a function; if it is not,
the address answers 405 and the server log names the module. EmDash turns
Astro's cross-origin form check off, so a handler that should accept only the
site's own form compares the request's `Origin` itself. Template 5 and later
include an opt-in contact handler. A form can use it from any page on the site.

Editing a design or a token changes the site on the next request in
development and on the next build, with no sync and no version to move. The
pages are rendered on request from HTML baked into the server bundle at build
time, not prerendered: EmDash's middleware also runs while a page is
prerendered, and a build machine has no migrated database to answer it. The
stock article routes are installed for every system. They render on the
system's classes (`prose`, `article-card` and the rest), and the scaffold
lists each route whose classes the design's stylesheets do not declare as
having no port yet; the `timds-update-design-system` skill ports it.

### Article sections

Template versions 3 and 4 declare their sections in `site/sections.json` with declaration
version 2. A fresh
site has the same single `articles` section. Any non-empty set can replace
it; `articles` is not mandatory:

```json
{
  "schemaVersion": 2,
  "sections": [
    { "collection": "articles", "prefix": "/articles/", "label": "Articles", "singularLabel": "Article", "feed": true },
    { "collection": "lease_faq", "prefix": "/commercial-division/lease-faq/", "label": "Lease FAQs", "singularLabel": "Lease FAQ", "feed": true },
    { "collection": "recipes", "prefix": "/recipes/", "label": "Recipes", "singularLabel": "Recipe", "feed": false }
  ]
}
```

A collection slug begins with a lowercase letter and uses lowercase letters,
numbers and underscores, at most 63 characters. A version 2 prefix has one
or more literal lowercase address segments with letters, numbers and hyphens,
surrounded by slashes, at most 100 characters in total. Empty, encoded, dot,
query and fragment segments are refused. Collections and prefixes must each
be unique, and no collection prefix may contain another collection prefix.
Reserved framework and topic
addresses are refused, as are the site source and generated directories
`/src/`, `/docs/`, `/seed/`, `/public/` and `/dist/`: those paths are blocked
by the hosted live preview. Every prefix segment is checked against the reserved
names, including Cloudflare's `cdn-cgi`. Entries belong to exactly one collection, and their
canonical address is that section's prefix followed by the entry slug and a
trailing slash. A feed, when enabled, is `<prefix>rss.xml`.

With no divisions declaration, every route uses the site's selected design. For the example
above, `/commercial-division/` and `/commercial-division/about/` can be ordinary
design pages, while `/commercial-division/lease-faq/how-to-lease-building/`
belongs to the `lease_faq` collection. The division prefix does not select
another Design System. Declaration version 2 and section contract 2 are the
supported section format; version 1 is refused. The shared field schema below
remains version 1.

After editing the declaration or shared schema, run `npm run sections:sync` in `site/` and
commit the resulting `seed/seed.json` and writer collection table with it.
The shared field and feature shape lives in `site/section-schema.json`, a
JSON object with `schemaVersion: 1`, `fields` and `supports`. Site sync,
build and development and the toolkit's consumer check read this same data;
consumer check never executes the site's JavaScript. The pure helper in
`site/src/lib/articles/sections.mjs` validates it and derives one identical schema
per section and attaches the `topic` taxonomy to all sections. The sync
keeps existing sample content, unrelated collection metadata, non-topic
taxonomies and their terms, and the topic's authored labels, locale,
translation group, terms and other unrelated metadata. It updates the topic's
collection attachments and keeps the shared flat taxonomy shape. An undeclared
collection definition or content key makes sync fail before writing: removing
a section requires explicitly removing its development seed definition and
content as well. A newly declared section gets the existing
`example-article` sample with its own ID; an explicitly empty content array
stays empty. These are development or first-setup examples: adding a section
to a live database creates schema only. Section removal does not delete
deployed content. `consumer check` refuses a missing declared collection, an
undeclared seeded collection, or drift in fields, features, addresses or
taxonomy attachments. Sections are routable collections: sync writes
`routable: true`, and checks, build and development reject an explicit false
value before setup can create a nonroutable collection. An omitted value uses
EmDash's default of true. Build and development also validate the seed.

Fresh workspace scaffolds select their content profile before database setup:
`consumer scaffold emdash --workspace --content-profile html` adds the optional
`body_html` (text), `short_answer` (text), `state` (string), `video_id` (string)
and `related_guide` (JSON) fields to `title`, `summary`, Portable Text `body`
and `cover`. The default `portable-text` profile keeps those four base fields.
The scaffold records `contentProfile` in `.timds/emdash.json`. Hosted fresh
creation selects `html`; sixteen sections use 144 physical field definitions.
Profile selection never updates an installed site or database.

The writer discovers optional fields per collection and always supplies
Portable Text `body`. Nonempty `body_html` renders with its original bytes
when it passes the site's policy. Missing, blank or rejected HTML uses the
Portable Text body. The stock regions hide duplicate answer and related-guide
cards when the rendered HTML already contains the answer box or guide link.
Article regions and structured metadata are site-owned source. Read the
site's `docs/article-presentation.md` and `docs/content-api.md` before authoring
these components. A guide uses its pipeline's selected section and prefix;
`guides` is an example, not a reserved collection. Canonical links and lead
attribution use the public site origin, independently of the API transport URL.

The shared schema accepts 1–32 fields and at most 144 fields across all
declared collections, within a 64 KiB section contract measured as UTF-8 bytes. Supported field types
are `string`, `text`, `url`, `number`, `integer`, `boolean`, `datetime`,
`select`, `multiSelect`, `portableText`, `image`, `file`, `json` and `slug`.
System field slugs and prototype names are reserved. Relations, blocks and repeaters are outside
this creation contract. Field validation, defaults and widget options must
fit the bounded EmDash-compatible data shape; invalid definitions are refused
before seed generation. The stock route components still expect the shipped
`title`, `summary`, `body` and `cover` fields, so a different article model
also needs corresponding route and writer-document changes.

The design integration injects each section's list, entry and optional feed
route from `src/routes/articles/`. Integration, consumer check and preview use
one route inventory from `src/integrations/section-routes.mjs`. With declaration
version 2, the stock `/articles`, `/articles/example-article`, `/topics` and
`/topics/example-topic` design references stay nonpublic even when `articles`
is removed. Another design sample must opt in through its page metadata:

```json
{
  "title": "Website",
  "pages": {
    "/commercial-division/lease-faq": { "title": "Lease FAQ list", "site": "reference" },
    "/commercial-division/lease-faq/example-article": { "title": "Lease FAQ entry", "site": "reference" }
  }
}
```

The marker belongs in the selected design's `design.json`, and its page still
needs a title and an authored HTML file. Unmarked public design pages at or
below a collection prefix or `/topics/` fail check and build instead of being
silently hidden. Native files under `site/src/pages/` that intersect those
namespaces are also refused, including dynamic routes and routes injected by
other integrations. Resolved-route exemptions match both the expected pattern
and the Toolkit entrypoint for the catch-all, topic, list, entry and feed;
a foreign route cannot replace them merely by having a different origin.
Public files cannot occupy these namespaces, including HTML aliases, and
route or public directory symlinks are refused without following them.
Ordinary parent and sibling pages
stay public. A section without its own samples uses the stock article samples
for preview comparisons. `consumer preview` derives
its section routes from the current declaration without rewriting
`timds.consumer.json`. Explicit preview pairs to a reference page in the
selected design remain authoritative; derived fallback pairs fill only missing
entries. The scaffold's missing-style report covers every
section. The shared topic route merges all declared sections newest first,
and its cursor records an independent position in each collection. The
same mixed-list helper, `getLatestArticles` in `src/lib/articles/latest.ts`,
is available for a site's latest entries. It reads one entry ahead per
collection and advances only the emitted entry's opaque EmDash cursor. A
page makes at most the section count plus the page size in content reads;
it does not depend on EmDash's internal cursor encoding or offsets.

The virtual module `virtual:timds/design-system` exports `sectionsContract`
with value 2, the normalized `sections`
(including each `urlPattern`) and
`sectionSchema` for build consumers. Before Astro resolves its configuration,
build integrations can retain the design integration's `api.getSections`
function and call it after `astro:config:setup` for the same data. Astro strips
extra integration properties while resolving configuration, so that function
must be captured from the original configuration. A hosted discovery integration
must acknowledge the installed template, workspace and sections capabilities.
Template 4 additionally requires the composition capability, through
`api.acknowledgeHostedSections({ template: 4, workspace: 3, sections: 2, composition: 1 })`
before configuration resolves. A hosted build without that acknowledgement
fails; standalone builds do not need it.

Editing the declaration, shared schema or seed restarts development to rebuild
the injected routes. An invalid save keeps the previous validated inventory,
including the inventory used by requests; routes never read the edited JSON
independently. A conflicting route, public file or duplicate form handler keeps dev running but
returns 503 until corrected. Removing the conflict restores routing. Builds
reject these conflicts outright. Consumer checks validate the source route
and public-file inventory without executing the site's integrations.
Section collection reads fail when a
collection is missing; an absent collection cannot appear as an empty page.

To verify dev route changes and recovery against the pinned runtime, run
`node scripts/check-emdash-dev.mjs --dependencies /absolute/path/to/node_modules`
from the toolkit repository. The supplied dependency tree must contain
EmDash 1.4.0 and Astro 7.4.10; omitting `--dependencies` installs the scaffold's
pinned dependencies. The disposable local check exercises nested section
addition and removal, ordinary parent and sibling pages, shared schema changes,
nonroutable seed refusal and sync recovery, duplicate form correction,
foreign injected-route refusal, feeds, invalid JSON, native/public/symlink
conflict recovery, and explicit form
precedence under `/` and `/site`. Feeds explicitly handle HEAD and return 405
with `Allow: GET, HEAD` for other methods. Vite handles development OPTIONS
preflight before Astro. Public pages accept
GET and HEAD; a POST with an explicit `src/forms/` handler reaches that handler,
and other unsupported methods on known pages answer 405. Missing entries,
unknown pages and extra path segments answer 404.

On a database already set up, EmDash does not rerun the seed. Adding a section
there also requires creating its collection, fields and taxonomy attachment
through EmDash's schema API or admin, or a platform that reconciles this
contract. Shared schema edits apply before a collection's first creation.
The TimDS host refuses changes to an existing collection's fields or features,
including adding a field, as well as changing its stored URL pattern;
renaming collections, moving entries and creating redirects are outside this
template. Writer token scopes apply to every collection, not one section.
Existing sites receive these stock files by a reviewed manual change; no
template updater is introduced, and ordinary toolkit upgrades keep the site
untouched.

### Contact forms and tracking

The workspace template includes an opt-in contact handler and support for Meta
Pixel, GA4 and Google Ads. The optional `requireConsent` flag defaults off.
Form handling loads on every site page, including custom Astro pages, and
supports actions under the mounted preview. The site stores contact receipts
and delivery jobs in its D1 database. Its scheduled Worker delivers Resend
notifications and Meta Lead events permitted by the site’s consent setting.
Template 7 adds per-site webhook delivery and attribution through tracking
contract 2. Set up that contact schema with a fresh site database. The
[workspace handover](../templates/emdash/site-workspace/docs/emdash-handover.md#contact-forms-and-browser-tags)
covers configuration and deployment.

### Optional division designs

Template 4 adds an optional `site/divisions.json` declaration. The workspace
site still uses the owner’s selected Astro integration for ordinary pages,
the global topics and latest articles, the EmDash database, and the admin.
A division provides its own presentation for a mount and for the collections
assigned to it. The collection and its address still come from
`sections.json`; the shared article schema stays in `section-schema.json`.

```json
{
  "schemaVersion": 1,
  "systems": { "main": { "workspace": true } },
  "divisions": [
    {
      "id": "commercial",
      "prefix": "/commercial-division/",
      "system": "main",
      "design": "commercial-web",
      "pages": "src/divisions/commercial/pages",
      "layout": "src/layouts/Commercial.astro",
      "collections": ["lease_faq"]
    }
  ]
}
```

Mounts use up to four lowercase, hyphenated segments and a trailing slash.
The site can declare up to eight divisions. Each division supplies regular
HTML fragments using the default design-page filenames, including
`index.html` for the mount itself. A page named `about.html` in this example
has the canonical address `/commercial-division/about/`. Its layout is an
owner-authored Astro component with a default slot for content and a slot
named `head` for the selected design’s stylesheet links and route metadata.
The layout receives `title`, optional `description`, and `context` with the
division `prefix`, Astro `base`, and selected `system`, `design` and
`assetPrefix`. Put the header, footer and navigation in that layout, using
the selected design as a reference. The division selects the design's
stylesheet links from its layout or, if absent, its default home page. The
layout should pass both slots through and leave stylesheet selection to the
integration.

An absolute in-site link in a division fragment such as `/about/` resolves
under the division mount when that division owns the target. Links to
other site routes keep those routes, and asset URLs use a separate
namespace. A layout can build navigation from `context.base` and
`context.prefix`; the full site base is required for a link from an Astro
layout. Form handlers stay in `src/forms/`, named by the full route where
they handle POST. Development keeps serving the site after a corrected save
and answers 503 for public composition routes during an invalid save.

Each collection may be associated once. A collection inside a mount must be
explicitly associated with that division; a collection outside any mount
can also be associated and keeps its existing prefix. Section lists, entries
and feeds keep their native addresses. Topic and latest views keep the
main context and link to entries at the existing canonical URLs. Changing
or removing a division is a presentation change and does not move content
or grant division-specific writer access.

The route inventory refuses overlapping mounts and collisions between
mounted pages, main design pages, collections, public files and Astro
routes. The two-way check reads the styles for each division’s authored
pages, layout and transitive local imports, and preview routes come from that
same inventory. Shared article routes and components are checked against every
context that renders them, including explicitly associated collections outside
the mount, main-context topic lists and native Astro, HTML, JavaScript and
TypeScript pages discovered from the route inventory. Missing classes or token
references in any selected context fail the check. A shared file is never
automatically rewritten to a token from only one context. The stock shared
routes load the main `Base` and `DesignPage` renderers only for main-context pages; their
owner-only markup is checked against the main design.

The build, development server and consumer check read the source dependency
graph without executing it. Local imports and re-exports must use literal
relative paths or site-root paths; packages must be declared in the site's
package manifest. Computed imports, `import.meta.glob`, local symlinks, and
imports outside the site from a division's dependency graph are refused.
This includes a component or a site stylesheet that indirectly imports the
owner's Design System CSS. Select those styles through `divisions.json`.
Composition source graphs use plain CSS; stylesheet preprocessors and non-CSS
Astro `style` languages are refused rather than scanned as a different format.
Ordinary Astro scoped `<style>` blocks remain available for self-contained
family navigation: their classes belong to that component. Locally declared
scoped custom properties are recognized in both main and division contexts.
They do not make another context's tokens available. Development watches these
transitive sources and returns 503 until an invalid import is corrected.
Reference pages in the owner system are available for design comparison.
The generated canonical link and discovery entry assume division pages
are public and indexable. Sites can use the template without adding a
divisions declaration.

The scaffold writes template 4 for a new workspace site. For an existing
site, generate a comparison scaffold in a disposable workspace and port
the composition integration, virtual module types, catch-all page, article
routes and layout wrappers into the existing site while preserving local
customizations. Keep the site's declaration, seed, collection schema and
database as they are. Toolkit upgrades leave the site's files in place.

#### If you use TimDS Cloud

A division can use the verified design metadata and styles of a sibling
Design System's exact published release. Keep `systems.main` as the
workspace entry and add an alias with a system id and release version.

```json
"systems": {
  "main": { "workspace": true },
  "commercial": { "systemId": "timds-example/commercial", "version": "2026.11.1" }
}
```

Set the division's `system` to `commercial` and `design` to a design id
from that release. The site can reference up to four sibling pins, and
every declared sibling must be used by a division. The Host stages each
authorized release in a read-only input directory, verifies the exact
release files and gives the same staged receipt to builds and live
previews. For local work with these inputs, use the supplied staging
directory at `site/.timds-site-inputs/` or point `TIMDS_SITE_INPUTS` at it.
The build, development server and consumer check verify the declared pins
and file digests from its receipt, and need no network access. The staged
directory is generated input and stays outside commits.

The sibling design's default home page in `designs.json` determines its
stylesheet links. The site's layout and page fragments remain
owner-authored. Sibling HTML and scripts are reference data and are never
run by the site. A local consumer preview captures the rendered site
routes and shows side-by-side reference images only for the owner's
workspace designs. Selected styles and their verified static files are
served under a release-specific namespace while relative references
inside stylesheets keep working. In a division fragment, use
`/assets/...` or `/fonts/...` to refer to that context's staged assets.
In an Astro layout, join the asset path to `context.assetPrefix`, which
already includes the site base. The site cannot build against missing
inputs, floating versions, missing files or digest mismatches.

### The check runs both ways

From the repository root:

```bash
npm run timds -- consumer check --root site            # design-system/site when embedded
npm run timds -- consumer check --root site --no-fix   # report without rewriting
```

In a workspace site, `consumer check` also scans the site's design surface
for styles the system lacks. What the system has is what the site loads, read
from source: the stylesheets linked by the website design the site renders
inside (the one `astro.config.mjs` names as `designSystem({ design })`,
served from the system's `src/styles/`), that shell's inline `<style>`
blocks, the compiled tokens when the design links `/tokens.css` and the
system runs the starter build (read directly from the `tokens/` groups when
the system keeps them, so a token added to a group is seen without a system
build), the system stylesheets a site file imports, and the `@import`s of all
of these; then the custom properties and the classes they declare. It never
reads `timds.json` `bundle.include`, a stylesheet the design does not link,
or anything under the system's `dist/`, so a literal is never rewritten to a
token the page would not have, and a check run after a token change matches
the new value whether or not the system was rebuilt. A stylesheet the
design links with a `media` condition (other than `all`), or imports with a
media query, `supports()` or `layer()`, still declares classes for the site,
but its tokens are never rewrite targets, because the site loads them only
under that condition. A site whose
`astro.config.mjs` names a design the system lacks, or a system with no
website design, fails the check with what to do. `--require-token` answers
from the same set: a token the system declares in a stylesheet the design
does not link fails, and the message names the file to link.

What is scanned: site files in the design surface or the protected globs,
skipping `node_modules`, `dist`, `.astro`, `.wrangler`, dot-directories and
git-ignored paths (outside a Git work tree nothing is ignored); `.css` files
whole, and in `.astro`, `.html`, `.jsx`, `.tsx`, `.vue` and `.svelte` files
the `<style>` blocks, static `style` attributes and static class names. Each
start tag's attributes are parsed whole, so CSS-looking text inside another
attribute or a comment is never read or rewritten. The bodies of `<script>`,
`<textarea>`, `<title>`, `<xmp>` and `<plaintext>` are text, and a `{…}`
expression is read as JavaScript: its strings, template literals and
comments are passed over, and JSX inside it is still read as markup. Dynamic
expressions are never guessed at. The module comment of
`src/consumer-workspace-check.mjs` has the full rules.

- A color literal (hex, the color functions, a named color in a color
  property) or a `font-family` stack equal to exactly one document-scope
  token (`:root`/`html`, unconditional) is rewritten to `var(--that-token)`
  in place; with `--no-fix` it is reported and fails the check instead. A
  literal in a protected file is reported, never rewritten.
- A literal no token holds (`literal`), one several tokens hold
  (`ambiguous-literal`, listing the candidates), a site declaration of a
  system custom property (`token-override`), a token reference unavailable in
  a composed file's rendering contexts (`token`), and a class a selected
  context's stylesheets do not declare (`class`) are findings. Each fails the check until it is resolved
  in the same change by adding to the system (a new token, a new class), or
  by using what the system has; the check never proposes changing an existing
  token's value or an existing class's rules. A suggestion names where to add
  it: the `:root` block of a stylesheet, `tokens.json` and its group, or
  `tokens/<group>.json` in a system that keeps groups.
- Lengths, numbers, durations and everything else are never flagged. A
  second run after the rewrites and additions is clean.

`--json` carries `workspaceCheck`: `schemaVersion`, `fix`, `rewrites` (each
with file, line, column, property, `from`, `to`, `token`, `applied`),
`findings` (`kind`, position, the value or class, `candidates`,
`suggestion`), `changedFiles`, `scanned`, and `system` (the stylesheets,
whether `tokens.json` was read, and the token and class counts). The Design
System is never written.

### One dev server

`npm run timds -- dev` at the workspace root (`timds dev`) serves the system
at `/` and the site at `/site/` on one port. This is the stock dev server
(`scripts/dev.mjs`, the viewer's `dev`); a system whose `workspace.dev` runs
its own server does not start the site. It builds the system once, serves
`dist/`, and starts the site's `preview.serve` in `site/` with
`TIMDS_SITE_BASE=/site` and the port in `TIMDS_SITE_PORT`: `preview.port`
(4380), or a free port when that is taken. The site's output is printed with
a `[site]` prefix. Readiness is polled on `preview.ready`, EmDash's
development seed route, at the root with its `redirect` moved under `/site`,
so starting also loads the sample content; the site has 120 seconds.
Requests under `/site` answer 503 while it starts and 502 with the reason if
it stops; the system's pages are served whatever the site does. Closing the
dev server, or `Ctrl-C`, stops the site's whole process group.

EmDash 1.4 does not work under a base path, and Vite answers at its root, so
the dev server routes, in order:

1. `/site` and `/site/**`: the site. A `GET` or `HEAD` under
   `/site/_emdash/**` is redirected (307) to the same path at the root.
2. Reserved root paths no Design System output has: `/_emdash/**`,
   `/@vite/**`, `/@id/**`, `/@fs/**`, `/@react-refresh`, `/__vite*`,
   `/__open-in-editor`, `/node_modules/**`, `/.astro/**`: the site, while it
   runs.
3. `/src/**` and the site folder's absolute path (Vite asks for component
   modules by it): the site, unless the system's `dist/` has that top-level
   entry, which then wins.
4. Everything else: the system's `dist/`.

Every websocket upgrade (Vite's HMR) goes to the running site. With
`site/node_modules` missing the dev server serves the system alone and says
to run `npm ci` in `site/`; a site that fails to start is reported with the
tail of its output and the system is served alone. Token and design edits
reach `/site/` at once; the system's own pages still need a restart of `dev`,
which builds them once and does not watch. `consumer preview` runs the site
without the dev server and still needs `preview.port` free.

If the Design System already builds pages under `/site` (a view named `site`
in `src/site.json`, or a build step that writes `dist/site/`), the dev server
keeps those pages, does not start the site and says so: run the site on its
own with `npm run dev` in `site/`, where it serves at `/` on its own port, or
rename that view.

The EmDash admin is on the same port, at the root:
`http://127.0.0.1:PORT/_emdash/admin/`. The dev server prints it as
`EmDash admin: <origin>/_emdash/admin/ (sign in on this machine at
<origin>/_emdash/api/setup/dev-bypass?redirect=/_emdash/admin/)`. Open that
sign-in link once: it signs you in as a development administrator and loads
the sample content, and it answers only in development. Saving an entry
stores a draft; Publish changes publishes it, and the page under `/site/`
shows it on reload, with no restart. The admin's own View Site, Live View and
Preview links point at the root, not at `/site/`, so through the one port
they reach the Design System (or its 404): put `/site` at the start of the
path. For those links to work as written, run `npm run dev` in `site/`
instead, which serves the site alone at `/` (on 4380, or `TIMDS_SITE_PORT`).

The dev server changes one kind of request: one to `/_emdash/**` whose
`Accept` contains `text/html` (a browser opening the admin or the sign-in
link) is forwarded with `text/html` taken out of `Accept`, because Astro's
dev server answers an HTML page load outside its base path with its own 404
and EmDash 1.4 answers only at the root; EmDash's handlers do not read
`Accept`. Every other request is forwarded unchanged. The module comment of
`src/site-proxy.mjs` holds the full routing table.

### Two builds in one repository

The system and the site build side by side and neither writes into the
other:

- The system's `build`, `check` (with `--require-clean-dist`, which compares
  the system's `dist/` only), `extract`, `doctor` and `upgrade` give the same
  results with and without `site/` and never write into it
  (`src/workspace-site.test.mjs` holds the comparison).
- The consumer bundle walk never enters the site.
- The MCP edit tools may edit the site's source with the system in one
  change. They protect its `package.json`, `package-lock.json`,
  `timds.consumer.json`, `.timds/`, build output and local state (`dist/`,
  `.astro/`, `.wrangler/`, `.emdash/`) and secrets (`.env*` except
  `.env.example`, `.dev.vars*`); `describe_workspace` lists them.
  `run_check` checks the system only.
- `submit` carries the site with the system. In the embedded layout it also
  stages the two root consumer skills, but only those the site's record
  (`site/.timds/emdash.json`, `mode: "workspace"`) lists in `workspaceFiles`,
  and only when the repository root is not itself a consumer
  (`timds.consumer.json`, or `consumer` in `.timds/installation.json`): a
  product's own consumer skills never enter a system submission. Deleting
  an owned skill folder whole is staged too. A change confined to the site
  needs no note under `## Unreleased` in the system's `CHANGELOG.md`; any
  change to the system still does.
- `shoot` never copies the parent's site: an offshoot is a new system and
  starts without one. The site's consumer skills and `AGENTS.md` section stay
  behind with it while they are unedited, so the offshoot can scaffold a site
  of its own; edited ones are kept and reported
  ([Offshoots](offshoots.md)).
- A hosted session carries the site's source, never its dependencies, build
  output, local state or secrets, which its `.gitignore` excludes.

Not handled yet: the stock merge workflow still cuts a system release for a
merge that changed only the site.

### What a build uploads

`npm run build` in `site/` writes the Worker (`dist/server/`, with the
deploy configuration Wrangler reads in `dist/server/wrangler.json`) and its
static files (`dist/client/`, the system's stylesheets, scripts and assets
included). `npm run worker` runs `astro build && wrangler deploy --dry-run
--outdir dist/worker`, which bundles the Worker with no Cloudflare account and
prints its bindings and size. The bundle is about 5 MB gzipped, above the
Workers Free plan's limit.

`wrangler.jsonc` commits the Worker's name (`<system id>-site`), its entry,
the compatibility date `2026-02-24` with `nodejs_compat`, a cron trigger
every minute, and the bindings by name only: `DB` (D1), `MEDIA` (R2) and
`SESSION` (KV, Astro's sessions). No resource name or id and no site URL is
committed: whoever deploys attaches the resources, and the origin is
`EMDASH_SITE_URL` at run time, else the request's origin.

`src/worker.ts` keeps the `scheduled` handler and also runs the scheduled
work (publishing scheduled entries, maintenance) on `POST /_scheduled` for a
caller that sends `Authorization: Bearer <SCHEDULED_TASKS_SECRET>`, answering
`{"published": N}`. Anything else, including every request while the secret
is unset, gets 404. The entry is the shared `site-cloudflare/src/worker.ts`,
so a Cloudflare site from `--existing` has the path too.

The site's `docs/emdash-handover.md` covers the rest: bindings, variables and
secrets, applying migrations with `npx emdash migrate --d1`, the setup
checklist, Cloudflare Access and caching.

### The record

`site/.timds/emdash.json`:

```json
{
  "template": 3,
  "platform": "cloudflare",
  "mode": "workspace",
  "files": { "astro.config.mjs": "<sha256>", "src/worker.ts": "<sha256>" },
  "workspaceFiles": { ".agents/skills/timds-consume-design-system/SKILL.md": "<sha256>" },
  "workspaceSections": { "AGENTS.md": { "marker": "timds:emdash-site", "sha256": "<sha256>" } }
}
```

`files` maps every template file written, relative to the site, to its
SHA-256; `package.json`, `package-lock.json` and `timds.consumer.json` are
left out on purpose (generated, or edited by npm). `workspaceFiles` maps each
consumer skill file, relative to the repository root, and
`workspaceSections` names the `AGENTS.md` section by its path, marker and
hash. There is no template update command yet; the record is what a later
one will read to refuse files that were edited. Everything in `site/` is
product source, and the root skills and section sit outside the Design
System's managed set and release metadata: `upgrade` neither writes nor
reports them. No `.claude/launch.json` entry is added.

### Not verified

No real deploy, resource provisioning or `npx emdash migrate` against a D1
database was run for this mode; the handover's statements about them are
read from EmDash 1.4 and Wrangler, not exercised.
