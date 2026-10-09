# TimDS Toolkit

`@dtconcepts/timds` is the public, versioned CLI, repository contract, artifact
publisher, AI editing skills, and contract-driven video engine for client-owned
TimDS Design Systems. Video is part of this package; there is no companion
runtime package for clients to install or copy.

Client repositories select the bounded `0.1.x` package line in
`devDependencies`. The lockfile records the exact resolved release. The CLI runs
from `node_modules`; client Git repositories do not carry a copied `.timds/cli`
tree. TimDS also installs a small repository-local skill for AI-agent discovery
and `.timds/installation.json` for fleet/version inspection.

## Add TimDS to a repository

Create a preferred standalone Design System repository:

```bash
npx --yes @dtconcepts/timds@0.1.x init --standalone --root /path/to/client-design-system
cd /path/to/client-design-system
npm install
npm run timds -- doctor
npm run timds -- check
git add --all
git commit -m "Initialize TimDS design system"
```

To link a standalone Design System to a repository that consumes it as a
submodule, declare the consumer during initialization:

```bash
npx --yes @dtconcepts/timds@0.1.x init --standalone \
  --root /path/to/client-design-system \
  --consumer-repository OWNER/CLIENT-SITE \
  --consumer-branch main \
  --consumer-path design-system
```

Add the Design System to that consumer with a same-host relative URL (for
example `../client-design-system.git`), then configure the Design System
repository secret `TIMDS_CONSUMER_TOKEN` with contents and pull-request access
to the consumer. Every accepted change on `main` becomes a patch release: TimDS
synchronizes the version, publishes that exact commit, then opens or refreshes
a gitlink-update pull request in the consumer. This flow pins the commit SHA and
does not depend on a release tag.

Create an embedded root `design-system/` contract in an existing client app:

```bash
npx --yes @dtconcepts/timds@0.1.x init --root /path/to/client-application
cd /path/to/client-application
npm install
npm run timds -- doctor
npm run timds -- check
```

New contracts include a small authored viewer, deterministic build/check/dev
scripts, starter tokens, and a validated initial artifact. They also include
the agent entry points: `AGENTS.md` (the working contract: a start sequence,
a map of the scaffold, how pages reach the machine-readable layer, a first
design pass, and the protected tooling), a `CLAUDE.md` that imports it for
Claude Code, and the managed skills under `.agents/skills/`. An agent can
start designing from `AGENTS.md` alone. The initializer also
adds the appropriate dependency and artifact ignore rules, so after
`npm install` creates the exact lockfile, `git add --all` is safe. Commit
`package.json`, the lockfile, `.agents/skills/`, the Design System contract,
and the TimDS workflow. Do not commit `node_modules`.

## Designer workflow

After repository access and Node.js 20+ are configured:

```bash
git clone git@github.com:ORG/CLIENT-design-system.git
cd CLIENT-design-system
npm ci
npm run timds -- doctor
npm run timds -- dev
```

`dev` starts the framework authoring server declared in `timds.json`. Use
`npm run timds -- preview` to inspect the exact static artifact that TimDS will
serve. Make ordinary changes in authored source, tokens, docs, components, and
small optimized assets. Never hand-edit generated `dist/`.

Before review:

```bash
npm run timds -- check
npm run timds -- preview
npm run timds -- diff
```

When explicitly asked to submit:

```bash
npm run timds -- submit --message "Describe the design-system change"
```

This validates the artifact, creates or uses a `design-system/<change>` branch,
pushes it, and opens a draft pull request against the default branch. It does
not merge or publish without separate authorization.

## Remote editing through MCP

`npm run timds -- mcp` serves the Design System editing tools over stdio to any
MCP-capable agent, bound to the current checkout. The server is named
`timds-design-system` and provides:

- `get_editing_guide` (also resource `timds://guide`): the editing rules for an
  agent working without a checkout.
- `describe_workspace`: system, layout, authored directories, protected paths,
  workspace commands, and the brand kit report.
- `list_files`, `read_file`, `write_file`, `delete_file`: guarded access to the
  authored surface. Writes are atomic and take an optional change `note`.
- `run_check`: `timds check` as structured findings (`passed`, `warnings`, or
  `failed`, with errors, warnings, artifact counts, and brand kit gaps).
- `read_derived`: the derived `brand`, `tokens`, or `index` document.
- `list_media`: the `media.json` catalog, optionally filtered by tag.

The guard is enforced, not requested. The tools refuse `.git/`, `.timds/`,
`.agents/`, `.github/`, `package.json`, `package-lock.json`, `node_modules/`,
`dist/`, `timds.json`, `media.json`, `.gitignore`, `media-local/`,
`video-local/`, the release automation scripts (`scripts/release.mjs`,
`scripts/release.sh`, `scripts/check-versions.mjs`,
`scripts/prepare-merge-release.mjs`, `scripts/prepare-merge-release.test.mjs`),
symbolic links, and anything outside the authored surface. Build, dev, and
check scripts stay editable. In
the embedded layout the authored surface is `design-system/**` only. stdout
carries only the protocol; build output and progress go to stderr or into the
`run_check` result.

A host that serves drafts remotely imports the same tools from
`@dtconcepts/timds/mcp`. `registerDesignSystemTools(server, { resolveWorkspace,
hooks })` registers them on an `McpServer`. With `hooks.remote` set, every
tool takes a `draftId` that is passed to `resolveWorkspace`, and
`hooks.afterWrite(workspace, { paths, note })` runs after each write or delete.
`isProtectedPath` and `authoredSurfaceRoot` expose the same guard.

## Reading a system through MCP

`npm run timds -- mcp read` serves the consumer read tools over stdio against
the current checkout's derived layer (`dist/`, after `check`), and
`timds mcp read --published <base URL>` serves the layer a system publishes at
its stable CDN prefix. The server is named `timds-design-system-read`, is
read-only apart from `report_gap`, and never sees authored source:

- `get_consumer_guide` (also resource `timds://consumer-guide`): how to use a
  system to produce on-brand work.
- `list_design_systems`, `describe_system`: what is in scope, the served and
  published versions (the current published version is always the default;
  `version` selects an earlier release), the page directory, counts, and the
  consumer bundle a website loads with the immutable copy to pin.
- `resolve_role`: a brand role (`color.accent`, `font.display`, ...) to the
  token that fills it and its value; an unfilled role is a reported gap, never
  a guessed value.
- `get_tokens`: resolved custom properties by name, kind, scope, or base only.
- `get_brand`: roles (each font role with its family and the files or
  service that provide it), logos, imagery, and guidance groups.
- `list_formats`: the asset format catalog, every print sheet and screen
  canvas with its size, bleed, and safe margin.
- `list_pages`, `read_page`: the page directory and one page or block as
  Markdown or structured blocks.
- `search_guidance`: the blocks that answer a question, guidance groups first,
  every result cited by page and block.
- `list_media`: the published media catalog by tag or kind.
- `report_gap`: files one gap into the client's request intake when the host
  provides one; locally it reports that none exists.

Resources `timds://brand.json`, `timds://tokens.json`, `timds://index.json`,
`timds://llms.txt`, `timds://formats.json`, `timds://bundle.json`, and
`timds://guidance/{group}` serve the same documents.

A host that serves consumers imports the tools from
`@dtconcepts/timds/mcp/read`. `registerDesignSystemReadTools(server, {
resolveSystem, listSystems, hooks })` registers them on an `McpServer`.
`resolveSystem({ systemId, version })` returns `{ layer, media, published,
pinned }`; with `hooks.remote` every tool takes an optional `systemId` and
`version`, and resources live under `timds://systems/{system}/...` with the
system id percent-encoded. `hooks.fileGap({ system, gap })` receives each
reported gap.

## Consumer repositories

A product that uses a Design System (a website, an app) pins it and
declares, once, in `timds.consumer.json` at its root, how to preview each app
and which paths a designer pull request may touch. TimDS never builds the
product itself; it runs the commands the manifest declares.

The pin takes one of two forms. A **published pin** names a version:

```json
"designSystem": { "path": "design-system", "systemId": "acme/core", "version": "1.4.0" }
```

No Design System bytes enter the repository. `timds consumer sync`, which
`timds consumer init --system acme/core` wires into `postinstall`, fetches
that version's bundle (the stylesheets, scripts, and small assets the system
declares in its `bundle.include`) from the public prefix into the gitignored
`design-system/` directory under the same paths the files have in the Design
System tree, verifying every digest, and records what it fetched in
`design-system/.timds-bundle.json`. A clone and `npm ci` is all a website or
an agent needs; nobody needs access to the Design System repository.
`timds consumer update [VERSION]` moves the pin to a version, or to the
current published release, and syncs; a pin of `"current"` follows every
release at the next install instead. `url` overrides the public prefix
(default `https://design-systems.timds.com/<systemId>/artifact`). A developer
working on both repositories symlinks `design-system/` to a Design System
checkout; `sync` leaves a symbolic link alone, and the checkout serves the
same paths live. `consumer check` validates that checkout and its design
pairings, with a warning that the local working copy replaces the published
pin. A named bundle carries its release's design-route summary, so pairing
checks need no current-release metadata or provenance stamp. Older bundles
without that summary remain installable and report that pairings could not
be checked; republish the selected release with the current toolkit to add it.

A **submodule pin** is the `design-system` git submodule at an exact commit,
the form the first consumers adopted; `consumer check` verifies it is pinned
and checked out, and CI checks it out with a deploy key. `timds consumer
migrate` moves a product from the submodule to a published pin in one
reviewable change: it reads the version the checked-out submodule declares
(or takes `--version`), downloads and verifies that version's bundle, plans
the installation without writing, then removes the submodule (deinit,
gitlink, `.git/modules`, the `.gitmodules` section, the checkout), pins the
version, applies init's plan so `postinstall`, `.gitignore`, and the managed
skill follow, installs the verified bundle, and warns about
any tracked symlink into the directory the bundle leaves dangling. It edits
no product-owned file: a deploy script or hook that still mentions the
submodule is listed at the end for a developer. The working tree must be
clean, including modified, staged, or untracked work in the submodule.
`--force` replaces customized managed files while preserving the manifest's
app settings. A failed migration write restores the original checkout,
submodule registration, index, and files, so the migration can be retried.

```json
{
  "schemaVersion": 1,
  "designSystem": { "path": "design-system", "systemId": "acme/core", "version": "1.4.0" },
  "apps": {
    "web": {
      "cwd": "web",
      "install": ["npm", "ci"],
      "preview": { "serve": ["npm", "run", "dev"], "port": 4321, "routes": ["/", "/contact"] },
      "designSurface": ["src/styles/**", "src/components/**", "public/**"],
      "protected": ["src/server/**"]
    }
  }
}
```

`preview` takes either `build` + `output` (the build output is the preview;
add `routes` to crawl it) or `serve` + `port` + `routes` (start the app and
crawl it). `ready` defaults to `/`, `viewports` to `["desktop", "phone"]`
(`tablet` is also allowed), and `schemes` to `["light", "dark"]`.
`designSurface` and `protected` are globs (`**`, `*`, `?`) relative to the
app's `cwd`; `protected` always wins.

In crawl mode, `preview.designs` pairs a route with a page of a website
design in the pinned Design System, as `"<design>:<route>"`:

```json
"preview": { "serve": ["npm", "run", "dev"], "port": 4321, "routes": ["/", "/contact"], "designs": { "/": "website:/", "/contact": "website:/contact" } }
```

Every paired route must be in `routes`; `consumer check` verifies each pairing
against the pin's `src/designs/`. The preview then builds the pin's artifact
with its own declared commands when it is not built yet, renders its designs,
and captures the design page at the same widths and schemes into `designs/`,
so the gallery and the portal show the design beside the route: the reference
on one side, the product on the other. `preview.json` records the pairing on
each route as `design` and the outcome under `designs`; a pin that cannot be
shown is reported there and never fails the preview.

In crawl mode, `preview.discover` adds routes beyond `routes`: starting from
`from` (default `["/"]`), it follows same-origin `<a href>` links breadth-first
and reads `/sitemap.xml` when the app serves one (sitemap entries are used by
path), skipping query strings, non-page files, and `exclude` URL path globs
such as `"/admin/**"`, until `limit` routes (default 40, at most 200) are found.
Declared `routes` always come first and always stay.

- `timds consumer check [--app NAME] [--base REF]` validates the manifest and
  the pin: for a published pin, that the synced bundle is present and at the
  pinned version; for a submodule, that it is pinned and checked out (warning
  when the checkout drifts from the pin). It also checks that every app's
  `cwd` exists. With `--base`, it
  fails when the branch or working tree changes anything outside a declared
  design surface or inside a protected path, or moves the Design System pin
  (the gitlink, or `designSystem` in the manifest),
  listing those paths. The surface is read from the manifest at the merge
  base, so a branch cannot widen its own scope; a branch whose base has no
  manifest is an adoption and may add the submodule. When automatic previews
  are enabled, the stock workflow runs this on each eligible pull request
  and reports a scope failure in the preview comment without failing the job,
  since developer pull requests leave the
  surface by design. The same diff names the apps worth previewing
  (`previewApps` in `--json`, `preview-apps` as a GitHub Actions step output):
  an app whose design surface changed, or every app when the Design System pin
  or `timds.consumer.json` changed. The stock workflow builds a preview only
  for those apps, so a pull request that cannot change how an app looks skips
  the preview job.
- `timds consumer preview --app NAME [--base REF] [--publish]` builds or serves
  the app and writes a review folder to `.timds/preview/<app>/`: `preview.json`,
  a script-free gallery `index.html`, `captures/` (full-page PNGs per route,
  viewport, and scheme), `pages/` (rendered HTML), and, in crawl mode,
  `maps/<route>/<viewport>-<scheme>.json`: every visible element's full-page
  rectangle, CSS selector, own text, and source location when the dev server
  stamps one (Astro dev, `data-source-file`, lovable-tagger, react-dev-inspector,
  React's `_debugSource`), relative to the repository. With `--base`, the
  merge base of REF and HEAD is first built and served in a temporary git
  worktree (with its own manifest, install, and commands, on the same port,
  before the head starts) and every route is compared: each route records
  `change` (`changed`, `unchanged`, `added`, `removed`) and `affectedBy`, the
  changed files its element maps point at. Changed and declared routes get
  `base/captures/` and `diffs/` overlays (the head faded, changed pixels in
  magenta); unchanged discovered routes are listed without captures. When
  the base cannot be built or has no manifest, the preview still covers the
  head and `compare.reason` says why. When the folder would exceed the
  portal's upload limits, the least useful images are left out and listed
  under `dropped`.
- `timds consumer init [--skip-install] [--portal-url URL]` writes a manifest
  skeleton and installs the managed consumer skill, the preview and
  designer-change workflows, `.claude/launch.json` entries, and the
  `timds-design-system-read` HTTP MCP server in `.mcp.json` (authorized with
  `TIMDS_ACCESS_TOKEN` from the environment). Merged entries beside your own
  are tracked one by one; customized ones are kept unless `--force`. Apps are
  discovered from a `package.json` one folder down, and from the root
  `package.json` when it has a `dev`, `start`, `preview`, or `build` script
  (that app gets `"cwd": "."`, comes first, and is named after the package).
- `timds consumer notes [--app NAME] [--pull-request N] [--all] [--json]`
  lists the notes a designer left on the pull request's preview in the portal,
  grouped by page, with the element, its source `file:line` when the dev build
  stamps one, and the designer's words. `timds consumer notes resolve ID...
  [--commit SHA] [--dismiss]` marks them addressed (or dismissed) after the fix
  is pushed. Both need `TIMDS_ACCESS_TOKEN` or `timds auth login`.

- `timds consumer scaffold emdash --root PATH --design-system GIT_URL` creates
  a new EmDash CMS site repository that consumes a Design System (see
  **EmDash sites** below), then adopts it the way `consumer init` does.

Automatic consumer previews are **off by default**. To enable
`.github/workflows/timds-consumer-preview.yml`, set the repository variable
`TIMDS_PREVIEWS_ENABLED` to `true` and configure the `TIMDS_ACCESS_TOKEN`
repository secret. Also configure `DESIGN_SYSTEM_DEPLOY_KEY` (a read-only
deploy key) or `TIMDS_CONSUMER_SUBMODULE_TOKEN` (with `contents:read`) so CI can
check out the private Design System submodule. An unset or false variable
skips all preview jobs without allocating a runner. With the variable enabled
but no publishing token, only a short token-presence job runs; checkout,
installation, validation, rendering, artifact upload, and comments are skipped.
There is no artifact-only preview fallback. Product build, test, and smoke
workflows remain independent, and `consumer check` and local
`consumer preview --app NAME` still work without enabling CI previews.
When previews are disabled, review locally and include the review URL,
screenshots, and routes in the draft pull request.

The designer-change workflow (`.github/workflows/timds-designer-change.yml`)
lets a designer start a change with no setup. An issue labeled
`timds-design-change` (the portal opens one from a plain-language request), a
comment carrying `<!-- timds-designer-request -->` on a `design/` pull request
or on such an issue (the portal posts review notes this way, with a fenced
`json` block of notes), or a manual dispatch runs Codex through the OpenAI API
with the consumer skill on a `design/<issue>-<title>` branch. Codex edits in a
workspace sandbox without a GitHub write token. A subsequent workflow step
runs `consumer check` against the merge-base design surface, pushes validated
edits and opens a draft pull request that closes the issue. When
`TIMDS_PREVIEWS_ENABLED=true`, the workflow then calls the preview workflow,
which checks for the publishing token, because pushes made with the job token
start no other workflows. Without previews, the draft describes the routes
to review and states that visual checks were not performed. Designer changes
and note handling still run independently of the preview flag. Nothing is
merged. Only owners, members, collaborators, and the bots listed in the
`TIMDS_DESIGNER_BOTS` repository variable (the portal's GitHub App bot login)
can trigger it, and fork branches are skipped. It needs the
`OPENAI_API_KEY` repository or inherited organization secret, the
`timds-design-change` label, and permission for Actions to create pull
requests; with `TIMDS_ACCESS_TOKEN` it also reads and resolves notes through
the portal after successfully pushing the change. It uses the official
`openai/codex-action@v1` with `workspace-write` and `drop-sudo`.

To upgrade a consumer, run `npm run timds -- upgrade` at the product root:
it refreshes the consumer skill, the two consumer workflows, and the tracked
launch and MCP entries from the installed toolkit, replacing only what nobody
edited since TimDS wrote it (customized files are refused, customized entries
kept, until `--force`), and records the new version in
`.timds/installation.json`. Upgrading an unmodified preview workflow adopts
the opt-in behavior above; customized workflows and skills still require
review or explicit replacement with `--force`. Repository variables and
secrets stay in GitHub settings and are never written by TimDS.
`upgrade --version 0.1.<patch>` (or `0.1.x`) first
selects that release under the bounded requirement, runs `npm ci`, and lets
the new CLI do the refresh. It never touches `timds.consumer.json` or product
source, and `--own-runtime`, `--auto-release`, and `--dependency-prs` are for
Design System repositories only.

Hosts and other tools read the manifest with `loadConsumer` from
`@dtconcepts/timds/consumer`.

### EmDash sites

[EmDash](https://github.com/emdash-cms/emdash) is an Astro-based CMS: page
content lives in its database and the theme is Astro source in the site
repository. That makes an EmDash site an ordinary consumer, and one command
creates it already wired to a Design System:

```bash
npx --yes @dtconcepts/timds@0.1.x consumer scaffold emdash \
  --root /path/to/client-site \
  --design-system git@github.com:ORG/CLIENT-design-system.git \
  --site-url https://www.client.example
```

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

## Machine-readable artifacts

A design system is read by agents and downstream pipelines as well as by people.
`check` and `extract` derive that view from the built artifact, so no design
system has to maintain a parallel hand-written JSON file:

```bash
npm run timds -- extract
```

Beside the published pages this writes `index.json` (the structured tree, with
assets joined to their media records), `tokens.json` (the design tokens),
`brand.json` (the brand kit), `formats.json` (the asset format catalog, when
the system keeps one), `llms.txt` (the brand essentials and the page index),
`llms-full.txt` (every page in one file), and an `index.md` Markdown mirror
of every page.
Every record carries a stable id such as `social/shorts#safe-zones/bottom-band`,
so an agent can cite a rule and a reviewer can resolve the citation.

`tokens.json` is read from the stylesheets the built pages actually load —
linked files, their `@import`s, and inline `<style>` blocks — never from
authored source. Every CSS custom property is recorded with the selector and
conditional at-rules it sits under, its `var()` chain resolved (own scope
first, then `:root`), and a coarse kind such as `color`, `font-family`, or
`length`. A theme scope like `[data-theme=dark]` or `.theme-admin` appears as
its own records, so a consumer can ask for the base brand or a specific
theme. Because the values come from the same CSS the pages render with, the
tokens cannot drift from the system; there is no file to keep in sync.

`tokens.json` also fills a small set of **brand roles** so a consumer can ask
for "the accent color" or "the display font" without knowing a system's token
names: `color.background`, `color.panel`, `color.accent`, `color.text`,
`color.muted`, `font.display`, `font.body`, and `font.ui`. Each role is filled
by convention from the `:root` scope — `--color-accent`, `--accent`, or
`--primary` for the accent, `--font-display` or `--font-serif` for the display
face, and so on — and `check` reports any role nothing fills. A system whose
names differ maps the role in `timds.json`; the mapping names the token, never
the value, so the value still comes from the CSS:

```json
"brand": {
  "roles": {
    "color.accent": "--gold-300",
    "font.ui": "--font-sans"
  }
}
```

`check` fails when a mapped token is not declared on `:root` or is not the
role's kind. Additional `color.*` and `font.*` roles may be mapped the same way.

`brand.json` is the **brand kit**: the role colors and fonts above plus every
logo and image the pages present as brand material. Pages already show each
logo variant and hero photograph; a `data-timds-role` annotation on that
markup — on the image, its figure, or any wrapper — is what puts the same
asset in the kit, so the kit is generated from the page a designer already
maintains:

```html
<div data-timds-role="logo primary" data-timds-lockup="horizontal" data-timds-on="light">
  <img src="/design-system/logo-colour.svg" alt="Colour logo">
</div>
<img src="/design-system/logo-white.svg" alt="White logo"
     data-timds-role="logo" data-timds-variant="white" data-timds-on="dark">
<figure data-timds-role="photo" data-timds-tags="hero, family">…</figure>
```

`logo` fills `logos`; any other role — `photo`, `illustration`, `graphic`,
`icon`, `pattern` — fills `imagery` under that role. `variant`, `lockup`, `on`
(the background the variant is for), and `tags` are free lowercase qualifiers,
and the `primary` flag sorts a variant first. An asset shown on several pages
appears once with every citation, and each carries the file `format` its URL
implies (`svg`, `png`, …). `check` warns when no logo is annotated.

A font is only usable outside the browser when the face can be obtained, so
each `font.*` role in the kit also names its `family` and where to get it:
`files`, the `@font-face` sources the loaded stylesheets declare for the
family (published with the logos, by weight and style); `stylesheets`, the
external stylesheets the pages link that serve it (a font service); and for
Google Fonts a `specimen` page to download it by hand. `check` warns about a
font role with none of these unless it is a conventional system stack.
Generic stacks and web-safe families use the device's fonts and may render
with a platform fallback; named platform-specific faces still need a source.

The kit's **guidance groups** are the pages a consumer reads before producing
anything. By convention `voice` is the `brand/voice` page and `compliance` is
every page named `compliance`, each block carried with its Markdown so the kit
answers "how does this brand speak" on its own. `timds.json` overrides a group
or adds one with `page` or `page#block` references, which `check` verifies
against the extracted index:

```json
"brand": {
  "guidance": {
    "voice": ["brand/voice#clear", "social/voice"],
    "shorts": ["social/shorts#authoring"]
  }
}
```

### Asset formats and the public link

A system that keeps an asset format catalog at `src/formats.json` (the
starter does: print sheets in inches, screen canvases in pixels, each tied to
the page that shows it) gets `formats.json` beside `brand.json`, so a consumer
can ask for "the business card" and receive its size, bleed, safe margin, and
stock, not a page to scrape. `check` validates the catalog and warns about a
format whose page is not built unless `src/site.json` explicitly marks it
planned. Planned entries carry `planned: true` without a page link, so the
catalog still gives their production sizes. `@dtconcepts/timds/formats`
exports the reader and the validator.

`llms.txt` is the one URL a person pastes into any AI tool. It opens with how
to use the file, then the brand essentials — every role color as hex, every
font with its family and the files or service that provide it, every logo by
variant with its URL, and every asset format with its size — and only then the
page directory. `llms-full.txt` beside it is every page's Markdown in one
file, for a tool that reads a single URL. Both are rewritten to absolute URLs
on publish, so nothing in them depends on a viewer origin.

### The consumer bundle

A website needs a handful of what a Design System holds: its stylesheets, a
behaviour script, the logos and small assets. `timds.json` names them with
globs relative to the Design System root:

```json
"bundle": {
  "include": ["src/styles/ds/**", "public/ds-marketing.js", "public/design-system/**"],
  "exclude": ["public/design-system/brand/**"]
}
```

`check` copies the matches into `<entry>/bundle/` under their source paths
and writes `bundle.json` beside `brand.json`: every file with its size and
digest, and where it sits. Paths mirror the source tree on purpose, so a
developer who symlinks a website's bundle location to a Design System
checkout serves the same paths live. A pattern under `dist/` is allowed, for
a built file such as the starter's `tokens.css`; `node_modules/`, local
media, and the bundle's own output are never bundled, a symbolic link or an
empty file is skipped with a warning, and a pattern that matches nothing fails `check`.
`extract --publish` uploads the bundle under the current prefix and again
under an immutable `v/<version>/` prefix; `bundle.json` names that copy as
`versioned`, and a website pins it, so a release can never change what a
pinned site loads. Publishing checks the existing versioned manifest before
uploading: changed bundle files or an existing design-route summary require
a new Design System version, and a stale local bundle must be rebuilt.
`current` pins read the provenance stamp, then fetch that version's immutable
bundle rather than the mutable current copy. `@dtconcepts/timds/bundle` exports the builder and the
validator.

### Website designs

A Design System is designer-owned down to the pages. Under
`src/designs/<design>/` a designer authors a whole website, or any set of
screens, in HTML with JavaScript on the system's own stylesheets: `design.json` names
it, an optional `layout.html` is the shell, and `pages/` holds one file per
route and state (`index.html` is `/`, `contact.html` is `/contact`,
`contact.sent.html` is `/contact` after the form is sent). A backend engineer
ports the design to whatever runs production; the design is the reference the
port must match, never the production site itself.

The `/designs/` directory has toolkit-owned, responsive navigation and page
listings. Its scoped stylesheet uses the system's colors and fonts with neutral
fallbacks, and is loaded only on the directory; authored page designs keep
their own layout. Rebuilding with the updated toolkit refreshes the directory.

`check` builds the designs to `/designs/` and refuses anything the system does
not define: `<style>`, `style` attributes, a
class no linked stylesheet declares, a relative reference. A design that
passes carries the system's stylesheets, markup, and JavaScript interactions.
Inline scripts, linked scripts (including modules), and event handlers are allowed.
Place shared scripts in `src/assets/` so the workspace copies them into `dist/`,
and link them by site-absolute path. TimDS does not execute scripts during checks
or bundle their imports; publish self-contained scripts or build their dependencies
into the artifact. Preview scripts run under the host's sandbox and content policy.
`designs.json` beside `index.json` carries every page state's HTML and the
files it loads; `list_designs` and `read_design` serve it to consumers, and
`extract --publish` uploads it with the stylesheets, scripts, and media it references.
`@dtconcepts/timds/designs` exports the renderer (`buildDesigns`), the check
(`checkDesigns`), and the catalog reader. A system scaffolded before designs
existed adopts them with `timds designs init`.

### The starter stays current through upgrade

A starter-based system is upgradeable the way a CMS is: the scaffold's
plumbing and structure are TimDS's to refresh, the client's content is not,
and the line between them is recorded in `.timds/starter.json` rather than
guessed. `init` writes the record for a fresh scaffold; an existing system
opts in once with `timds starter sync`; every `upgrade` then re-syncs it.

```bash
npm run timds -- starter sync            # adopt once, on a feature branch; in a terminal it asks about each customized stock file
npm run timds -- starter sync --force scripts/viewer.mjs   # non-interactive: replace the named customized stock script or stylesheet (never a fragment)
```

Inside the boundary the sync touches three kinds of things. The stock
`scripts/build.mjs`, `check.mjs`, `dev.mjs`, `viewer.mjs`,
`src/styles/canvas.css`, and `src/styles/viewer.css` are plumbing, and the
record's `plumbing` mode says who a local change to them belongs to. A
system scaffolded by `init` is `"toolkit"`: every upgrade brings the six
files to stock, replacing a local change and saying so, without halting and
without naming files. A system adopted later with `starter sync` is
`"recorded"`: a file is replaced while it still matches a hash the toolkit
wrote, and a customized one is kept unless the person running the sync in a
terminal chooses to replace it when asked (keep, replace, or diff first,
file by file). Edit the field to switch. `src/site.json` and `src/formats.json`
are merged three ways against the recorded stock baseline: views, pages, and
formats the system lacks are appended (pages as `planned`, so a new primitive
is there to author), fields still equal to the baseline advance to the new
scaffold, and anything the client changed is kept, and reported when the
scaffold's own value moved rather than on every sync; nothing is removed,
reordered, or retitled, and a format whose page the system does not declare
is skipped. The Digital, Social, and Print overview fragments are written
when the sync adds or authors their page and refreshed while unmodified; one
that differs is the system's own page and is never replaced. `src/layout.html`
only gains a missing stock stylesheet link. Everything else, other fragments,
`tokens.json`, `system.css`, `timds.json`, stays the client's. In the
recorded mode, customized scripts and stylesheets are asked about in a
terminal and otherwise reported and replaced only by `starter sync --force`
naming each file; `upgrade --force` never reaches them. The sync
refuses to run over uncommitted changes to the files it writes, so its diff
is always reviewable on its own. It ends with `check` and rolls back every
file it wrote when that check fails, so a system is never left between two
structures, and `upgrade` runs it before touching its own managed files so a
failed sync aborts the upgrade cleanly. The
report is a per-file status table (`created`, `updated`, `current`,
`customized`, `skipped`) and the catalog changes it merged.

### The derived layer is the contract consumers read

Together `index.json`, `tokens.json`, `brand.json`, `llms.txt`,
`llms-full.txt`, and, when the system keeps them, `formats.json`,
`designs.json`, and `bundle.json` are the
**derived layer**: generated on every `check`, published on every
`extract --publish`, and the only thing a consumer — an MCP server, a render
host, a pipeline, another agent — needs. Nothing in it is authored by hand,
every document is stamped with the system version, and each file declares its
`schemaVersion`; additions are compatible, and a breaking change bumps the
version. `@dtconcepts/timds/derived` reads the layer the same way from a
checkout or from the published prefix, and ships type declarations for every
document:

```js
import { readDerivedLayer, fetchDerivedLayer } from "@dtconcepts/timds/derived";

const local = await readDerivedLayer("/path/to/client-design-system", manifest);
const published = await fetchDerivedLayer("https://assets.timds.com/.../artifact");
published.brand.roles["color.accent"].value;   // "#d4b876"
published.brand.logos[0].media.url;            // CDN URL of the primary logo
published.brand.guidance.compliance.blocks;    // blocks with Markdown
```

The published prefix carries `.timds-artifact.json`, which names the version,
source commit, and location of each derived file, so a remote reader needs
only the base URL. `timds doctor` reports the kit's readiness in one line and
`timds brand` prints it in full, with the fix for every gap; `--json` returns
the kit itself.

Extraction keys on HTML semantics — `main`, `section`, `h1`/`h2`, `table`,
`figure`, `pre` — and needs no configuration. Content the vocabulary does not
recognize is captured as untyped prose and counted rather than dropped; a rising
untyped count is the signal that a page family deserves real markup. A system
whose markup needs a hint declares one in `timds.json`:

```json
"machine": {
  "root": "main.content",
  "block": "section.block",
  "note": ".note",
  "code": "pre.codeblock",
  "ignore": [".sidenav"]
}
```

Selectors are limited to `tag`, `.class`, or `tag.class`. Set `"machine": false`
to opt out entirely.

## Large public images, video, audio, and B-roll

Full-resolution files stay out of Git and `dist/`. Put them in the ignored
`media-local/` workspace and register each file with a stable logical key:

```bash
cp /path/to/interview.mp4 media-local/
npm run timds -- assets add media-local/interview.mp4 \
  --key founder-interview \
  --title "Founder interview" \
  --tags interview,b-roll
```

The local viewer resolves `founder-interview` to that local file. Authenticate
once through the operator portal, then upload changed staged files:

```bash
npm run timds -- auth login
npm run timds -- assets publish
```

`submit` also publishes staged media before it builds and opens the pull
request. Only the stable key, checksum, metadata, and public CDN URL are written
to `media.json`. Timed media is inspected with `ffprobe` during `assets add`, so
video and audio records also carry their measured duration; video records carry
dimensions, frame rate, and codec when available. The raw file and
`.timds/local-media.json` remain ignored.
Staging records the current catalog checksum locally. Publishing (including
`submit`) checks every staged entry before uploading and refuses replacements
if the catalog has changed since staging. Older staging entries without a
baseline may still publish new keys or match unchanged records, but cannot
replace existing records until deliberately restaged. To keep the published
asset, remove its stale entry from `.timds/local-media.json` or restore it with
`assets pull KEY --force`. Run `assets add FILE --key KEY` again only after
reviewing the intended replacement; do not restage an original over an
optimized derivative just to clear a conflict. Successful publication advances
the local baseline, so reverting `media.json` does not replay the old upload.
If storage returns an asset ID already registered under another logical key,
publication refuses that catalog write and preserves both keys. Use the
existing key instead of implicitly renaming it.

If an object transfer fails, the CLI reports the bounded storage response and
cancels the server upload lease before returning the error, so correcting the
problem and rerunning `assets publish` does not wait for a stale lock to expire.
`TIMDS_ACCESS_TOKEN` can be used for non-interactive CI or agent sessions.

Catalogs created before timed metadata was supported can be repaired in place
from their stable public URLs without re-uploading the objects:

```bash
npm run timds -- assets backfill-metadata
```

Both commands require `ffprobe` from FFmpeg on the workstation. Set
`FFPROBE_PATH` only when it is installed outside the normal command path.

To restore a published asset into a fresh local workspace:

```bash
npm run timds -- assets pull founder-interview
```

Never commit tokens, storage credentials, object keys, expiring signed URLs,
`.timds/local-media.json`, or anything except the README under `media-local/`.

## Contract-driven video

A client can opt its Design System into the TimDS video runtime:

```bash
npm run timds -- video init
npm run timds -- video doctor
```

The opt-in creates `video/contract.json`, `video/assets.json`, and
`video/productions/`, and declares their paths in `timds.json`. The template
contract names a logo file, so a fresh scaffold also writes a neutral starter
logo at that path when nothing is there yet; replace it with the client's logo
before publication. A logo already at that path is never overwritten. The client
Design System owns every brand, content, compliance, media-selection, and
publishing decision in those records. `@dtconcepts/timds` owns the shared
schemas, validation, voiceover orchestration, natural-speed footage runtime,
Remotion compositions, programmatic producer/compiler, render commands,
packaging, provenance, and managed `timds-create-video` skill. A client that
serves an automated Video Lab can add a `producer` block to its video contract;
that block owns role labels, structure, CTA templates, and asset-key
vocabulary. Its optional `producer.authoring` block selects published TimDS
page/block ids for the shared and format-specific writing brief. Consumers ask
`createVideoAuthoringContract()` for the exact prompt, JSON Schema, constraints,
and Design System provenance, compile with `@dtconcepts/timds/video/producer`,
and render with `@dtconcepts/timds/video/remotion`. This keeps client writing
direction in the client system while TimDS owns the generic model boundary.
Remote clients import `VideoAuthoringContractSchema`,
`VideoFootageCatalogSchema`, and `VideoCompiledProductionSchema` from
`@dtconcepts/timds/video/transport`. The producer validates its emitted responses
with those same schemas. They preserve additive fields, normalize legacy
single-prefix footage catalogs, and read authoring versions 1 and 2 and saved
compilations that predate runtime identity. Compose application metadata with
`.and()` or application policies with `.refine()`; do not recreate TimDS's
response shapes. The transport uses the `zod/v3` compatibility API, so Zod 3
hosts can include the shared validators in their own schemas.
Hosts using a different Zod version can use the corresponding
`safeParseVideoAuthoringContract`, `safeParseVideoFootageCatalog`, and
`safeParseVideoCompiledProduction` functions; their declared result types do
not depend on Zod's type hierarchy. Reading another
supported producer release does not select a rendering runtime: compilation
and finalization must still use the same client-pinned runtime.
The compiler rejects over-limit summaries and engagement questions; it never
truncates model copy into a fragment to make it fit.

The engine, the producer, and `timds video check` share one set of production
rules from `@dtconcepts/timds/video/footage`: consecutive footage picks must
come from different footage families (offset, mirrored, and vertical
derivatives are one family; intro and outro cards break the sequence), a chain
must cover its scene at natural speed with the last clip holding at least two
seconds, a still (`kind: "image"`) is held under the same push-in as a clip, and
a scene headline must be a complete thought — a dangling article, conjunction,
or possessive fails the check. A client snapshot imports that module rather
than copying it, so a toolkit fix reaches the client's frames without a reset.

Fresh systems use shared TimDS components directly. Select `standard` or
`compact` with `video/boards.json` `layoutPreset`; a kind may select its own
`layoutPreset`. Compiler validation and rendering consume the same executable
geometry and fit limits. Cards, steps, and flow in vertical layouts and over
footage allow at most three items; larger horizontal full-frame boards retain
their catalog budgets. Drafting schemas use the safe intersection before footage
is selected. Brand tokens, fonts, logos, copy, assets, compliance, and publishing
policy stay in the Design System. Prefer configuration and typed partial visual
overrides for deliberate exceptions.

The Remotion export includes a complete default component set. A client Design
System can fork those exact installed defaults into one complete, editable
source module:

```bash
npm run timds -- video components init
```

The command writes `video/remotion.tsx` and declares it as `video.components`
in `timds.json`. It is a one-time snapshot: normal TimDS upgrades never modify
the file, so the client begins source-equivalent to the selected defaults and
then evolves independently. Running the command again is refused; `--force`
is an explicit destructive reset to the currently installed defaults.

A Design System may instead hand-author a partial
`VideoProjectComponentOverrides` object at the declared path. TimDS passes the
module to the same `createVideoProjectRoot()`, `createSingleVideoProjectRoot()`,
or `registerVideoProject()` APIs available to integrated renderers. `Video`,
`Scene`, `Graphic`, `Intro`, `Outro`, `Cover`,
`HorizontalCover`, and `VerticalCover` are independently replaceable; omitted
components continue to use TimDS defaults, and format-specific covers take
precedence over the shared `Cover` override. This keeps rendering mechanics in
TimDS while allowing a reviewed client Design System to own its visual
compositions.

### Graphic scenes, chapters, and static files

A scene may carry a client-drawn board instead of, or over, footage once the
contract opts the format in with `structure.longform.graphicScenes: true` (and
`structure.short.graphicScenes` for Shorts). The scene declares
`visual: { "kind": "steps", ... }`; TimDS validates only that `kind` is a slug
and the opt-in is on, and the Design System's `Graphic` component owns every
kind, its copy budget, and its motion. A board without `asset`/`assets`
renders on the brand background and breaks the footage-family sequence, so the
next clip may repeat the family of the clip before the board; a board whose
scene names footage plays over that chain under the normal natural-speed and
family rules. Asset keys alone decide which: there is no separate flag. The
default `Graphic` shows the scene's optional `eyebrow` and `headline` so a
production renders before the client has implemented the kind; the TimDS
`Scene` keeps the footage, watermark, and captions around whichever board is
mounted. A scene's optional `chapter` slug groups consecutive scenes for client
chapter rails; TimDS validates and carries it, nothing more.

Committed files the client's components read with `staticFile()` are declared
as `brand.staticFiles: [{ "path": "public/illustrations", "mount": "illustrations" }]`
and copied into the render public root under their mount. Each path must be a
committed Design System file or directory, never under ignored `video-local/`;
`video check` refuses missing or git-ignored sources the way it refuses a
missing logo. Mounts are lowercase (Linux render hosts resolve `staticFile()`
names exactly), cannot be `brand`, `media`, or `audio` (staged brand files,
prepared footage, and narration live there), cannot overlap one another, and
cannot land on a staged brand path such as a `public/`-relative logo or audio
bed, even in a silent preview that leaves the bed out. Asset `text` zones now include `left-top` and `right-top` for clips whose
action crosses the middle band; the default scene keeps the copy box under the
wordmark for them.

The producer can insert a spoken subscribe board early in the video with
`producer.subscribe`:

```json
"subscribe": {
  "enabled": true,
  "formats": ["horizontal"],
  "afterBeat": 1,
  "narrationTemplate": "Want to know more about {{topic}}? Subscribe to learn how to {{solution}}.",
  "requireSolution": true
}
```

The board is a graphic scene of kind `subscribe` carrying `topic` and
`solution`, placed after the Nth content beat and joining that beat's chapter,
so the contract must enable `graphicScenes` for each format the board plays in;
validation refuses the contract otherwise. `{{solution}}` comes from the compile
request's `topic.solution`. The authoring contract asks the drafting model for
it (required by default; with `requireSolution: false` a request without one
simply gets no board), the lab offers a Solution field beside the engagement
question, and `subscribe` joins the reserved scene ids. Hand-authored compile
requests may also give beats a `chapter` and a `visual`. Without a board
catalog the drafting schema offers `chapter` but never `visual`; with one, it
offers the catalog's kinds (below).

### Board catalog

A Design System declares its board vocabulary in `video/boards.json`
(registered as `video.boards` in `timds.json`; `timds video init` scaffolds the
default catalog, and `video/boards.json` is read when present even if
unregistered). TimDS owns the mechanism, the client owns the vocabulary:

```json
{
  "schemaVersion": 1,
  "formats": { "longform": true, "short": false },
  "cadence": { "maxConsecutiveFootageFree": 3, "chapterReturnsToFootage": true, "minimumChapters": 3, "maxBoardWords": 28 },
  "motifs": { "mount": "illustrations" },
  "kinds": {
    "cards": {
      "label": "Cards",
      "use": "A list of 2 to 5 parallel items.",
      "avoid": "Sequences, contrasts, or a single rule.",
      "overFootage": "optional",
      "once": false,
      "schema": { "type": "object", "required": ["items"], "properties": { "…": {} } }
    }
  }
}
```

Each kind's `schema` is a closed JSON-Schema subset (`type`, `properties`,
`required`, `additionalProperties`, `items`, `minItems`, `maxItems`, `enum`,
`const`, `minimum`, `minLength`, `maxLength`, `description`) plus `x-timds-maxWords` (a
field's word budget; budgeted fields also sum against `cadence.maxBoardWords`),
`x-timds-motif` (a file stem in the `brand.staticFiles` mount named by
`motifs.mount`), `x-timds-cue` (one word the scene's narration must speak), and
`x-timds-substringOf` (an exact part of a sibling field). Kinds are slugs and a
schema never declares `kind`. A format offers boards only when both the
catalog's `formats` and the contract's `structure.<format>.graphicScenes` are
on.

Kinds may restrict `formats` to `["longform"]` or `["short"]`, set a
`maxWords` total, and declare `constraints` for narrower layouts. For example,
`{"when":{"overFootage":true},"maxWords":14,"fields":{"nodes":{"maxItems":3}}}`
tightens a flow over footage; a separate rule with `when.format: "short"`
applies to every Short. When both selectors occur in one `when`, both must
match. Field paths name object properties in the base schema, such as
`left.items`; their numeric limits may only tighten that schema. All matching
rules apply, and the smallest word budget wins. These are client-owned limits:
TimDS does not infer geometry or change visual components.

Compilation, finalization, and `video check` use the scene's actual format and
footage. The model's visual schema uses the intersection of permitted footage
layouts for the requested format, because footage is chosen alongside the
visual. This safe subset prevents a draft from requesting a board that only
fits a wider layout; an explicit compile request can still use the larger
board in its supported context. Existing catalogs need no migration. To adopt
constraints, first release and install a compatible TimDS version on all
producer and renderer hosts, then declare the client limits; older versions
reject the new fields rather than silently ignoring them.

With a catalog, the authoring contract (schema version 2) exposes
`answerBeats[].visual` as a `oneOf` of the declared kinds with their use/avoid
guidance, describes `chapter`, adds `answerBeats[].boardGap` for a beat no
declared kind fits (the beat keeps footage and the gap is carried onto the
compiled and finalized scene), and returns a `boards` summary. `subscribe` is
compiler-owned: never offered, refused when authored, and held to the catalog
only when the catalog declares it. `compileProduction` validates every board
against its kind and runs the cadence rules (footage-free runs, every chapter
containing footage, the chapter minimum once any chapter is set, `once`,
`overFootage`, `formats`); `finalizeProduction` fails a cue the measured take
never says, skipping a timing that carries no `words`. `timds video check` holds
committed productions to the same rules and fails when the catalog's kinds and
the components' registered `Boards` disagree. The machine index carries the
catalog summary under `video.boards`, and the MCP `describe_system` lists the
kinds. The compiler's `subscribe` board follows `producer.subscribe.formats`,
not the catalog's `formats`. A catalog that declares only compiler-owned kinds
offers the model no boards. A staged project carries the catalog as
`contract.boards`, with `motifs.files` mapping each motif stem to its file in
the mount (`.svg` preferred when several share a stem);
`resolveVideoBoardMotifs({ designSystemRoot, catalog, contract })` from
`@dtconcepts/timds/video` resolves the same list for a remote producer host. A
client component file that exports `Graphic` counts as drawing every declared
kind.

Without a catalog, the default scene keeps rendering the existing headline
fallback. Built-in board components are selected automatically only after
catalog adoption; explicit client `Boards` and `Graphic` overrides still apply.
Drafting instructions follow each kind's `overFootage` rule, so footage-free
boards omit clip picks while ordinary beats keep them.

When any scene has a `chapter`, `finalizeProduction` adds
`plan.chapters: [{ id, label, startMs }]`. A `chapter-title` board's title
labels its chapter, otherwise the id is title-cased, and `startMs` is where the
chapter's first scene starts in the timed take. The lab plan prints the
chapters as `m:ss Label` lines. TimDS does not write them into publishing
descriptions: those come from committed publishing records, which the client
owns. The compile input stays at producer schema version 1: boards,
`chapter`, and `boardGap` are additive.

Outros are rarely watched — least of all in vertical Shorts — so the default
components keep a call to action on every frame when the contract asks for one.
`brand.banners.longform` renders as a pill top-right of horizontal frames (for
example "Subscribe for more"); `brand.banners.short` renders a kicker and URL
under the logo on vertical frames, with the right edge left clear for the
Shorts UI. Vertical frames never place two labels on the bottom baseline, so a
long `watermark.right` cannot collide with `watermark.left`. The producer's
`outro.narrationTemplates.short` may shorten the spoken close for Shorts, and
`publishing.shortDisclaimer` / `publishing.shortArticleLink: false` keep a
Short's packaged description brief while the long-form keeps the full text. A
Short with its own `description` in `publishing.json` uses it instead of the
long-form hook and answer. The video template now requires the question intro
card in both formats, matching what the producer always emits.

The default cover set includes separate horizontal and reel layouts. A cover's
explicit `objectPosition` wins, followed by its prepared asset position; the
reel fallback keeps right-biased portrait subjects in the upper photographic
region. The horizontal cover scales its 1280×720 design grid to the declared
export size, and both layouts adapt the headline to its available box. Both
retain a visible, non-breaking separator before a highlighted final word,
including with subsetted or variable client fonts.

Each production is a directory with five reviewable phase records:
`request.json`, `script.json`, `publishing.json`, `captions.json`, and
`production.json`. There is no per-topic TSX entry and no client-owned copy of
the engine; an optional client-owned component snapshot contains only visual
compositions. The generic workflow is:

```bash
npm run timds -- video voiceover TOPIC
npm run timds -- video check TOPIC
npm run timds -- video prepare TOPIC
npm run timds -- video studio TOPIC
npm run timds -- video render TOPIC
```

### Brand colors and fonts come from the Design System

`brand.colors` and `brand.fonts` accept a reference in place of a literal:
`"{color.accent}"` names a brand role and `"{--navy-900}"` names a token, both
from the `tokens.json` that `timds check` derives from the built stylesheets.
References resolve when the workspace loads, so the renderer, the lab, and
every prepared project see values. The values come from the derived
`tokens.json`, or straight from the built pages' stylesheets when that file
is not written yet. Before the artifact is built, checks, the lab's plan and
compile, and every other reader still work: references stay unresolved and
`video check` warns which ones are unverified, and the full `check` verifies
them once the pages are built. Only handing the contract to Remotion — a
production or lab prepare, studio, render — needs the values and fails with
the instruction to build first. A literal that duplicates a
derived token is reported by `check` with the reference to use instead. Video surfaces often
pick a darker face of the same palette than the page does, which is what a
token reference is for:

```json
"brand": {
  "colors": {
    "background": "{--navy-900}",
    "panel": "rgba(10, 23, 41, 0.96)",
    "accent": "{--gold-300}",
    "text": "{--cream}",
    "muted": "{--navy-200}"
  },
  "fonts": {
    "display": "{font.display}",
    "body": "{font.body}",
    "ui": "{font.ui}"
  }
}
```

### Brand files every render host can reach

The contract's brand files are `brand.logo`, `brand.fontFiles[].path`, and the
optional sound design `brand.audio.bed` and `brand.audio.transition`. Each
must be one of the two sources every render host has:

- a path to a file committed in the Design System, such as
  `"public/brand/logo.png"`; or
- a published TimDS media record, `{ "mediaKey": "brand-music-bed" }`, whose
  `media.json` entry has a stable `publicUrl`. Use this for audio and anything
  else too large or of a format the repository does not commit.

```json
"audio": {
  "bed": { "mediaKey": "brand-music-bed" },
  "transition": { "mediaKey": "brand-transition" },
  "voiceGain": 1, "restVolume": 1, "duckVolume": 0.3,
  "attackFrames": 6, "releaseFrames": 20
}
```

`video check` fails when a brand file or `brand.staticFiles` source is missing,
is ignored by git, sits under the ignored `video-local/` directory, or names a
media key that is not published. It fails the same way when a production scene
or cover names a `video/assets.json` entry whose `mediaKey` has no published
entry in `media.json`; a catalog entry no production uses yet only warns, so
footage can be registered ahead of the production that plays it. A file that exists only on the machine that generated it renders
locally and 404s on every other host, so it is refused before merge rather
than discovered in production. Staging never drops a declared file: the lab,
`video render`, and silent previews fail with the contract field that names it.

Render hosts (the lab, `video render`, and automated Video Lab servers) stage
brand files through one exported function and check the finished project
before Remotion starts:

```js
import { assertVideoProjectStaged, resolveVideoBrand, stageVideoBrand } from "@dtconcepts/timds/video";

// tokens comes from the same Design System release as the raw contract.
// loadVideoWorkspace already resolves these when a built artifact is available.
const { contract: resolved } = resolveVideoBrand(contract, tokens);
const brand = await stageVideoBrand({ designSystemRoot, contract: resolved, publicRoot, mediaCatalog, cacheRoot });
const project = { ...rest, contract: { ...resolved, brand } };
await assertVideoProjectStaged(project, publicRoot); // names every missing staticFile() before rendering
```

`stageVideoBrand` validates the sources, copies committed files, downloads
published media (cached by SHA-256 under `cacheRoot` when given), and returns
the brand with runtime paths. `assertVideoProjectStaged` lists every file the
components request, including the logo, fonts, sound design, footage, cover,
and narration, and fails with each missing file's project field.
Both functions reject unresolved color/font references, including when a host
reads the contract JSON directly instead of using `loadVideoWorkspace`. A value
such as `{color.text}` must never reach CSS: the browser ignores it and may
render black text. Hosted consumers must verify the published tokens' system
and version and the artifact's source commit against their pinned Design System
before calling `resolveVideoBrand`; no fallback palette is applied.

Prepared media, generated audio, Remotion entry files, and review packages live
under ignored `video-local/`. Registered source media remains governed by the
normal TimDS media catalog. The committed production records refer only to
client-declared logical asset keys; render-time media is always played at its
natural speed, and a scene fails when its approved footage chain is too short.

### The video lab

`video init` also scaffolds `video/lab/`: compile requests for the client's
`producer` block, which the template contract now carries with generic role
labels and CTA templates. A lab input is what an automated Video Lab hands
`compileProduction()` after a model writes to the authoring contract, and the
lab takes it the rest of the way exactly as a render host does — compile,
spoken narration and measured word timings, footage (each beat's own picks first, then the
deterministic fill) and cover, staged brand files
and published media, `createSingleVideoProjectRoot` with the client's
components — then opens Remotion Studio on the result so the Design System
editor sees the frames the lab will ship.

```bash
npm run timds -- video lab                 # first input under video/lab/, in the studio
npm run timds -- video lab NAME            # video/lab/NAME.json
npm run timds -- video lab NAME --plan     # compile + finalize; print the plan, no staging
npm run timds -- video lab NAME --prepare  # stage media and write the entry only
npm run timds -- video lab NAME --render   # TimDSVideo + TimDSCover to video-local/lab/NAME/out/
npm run timds -- video lab --list          # lab inputs and ready productions
```

The lab also ships as a small local web app, the toolkit's standardized copy of
the LawBoost Video Lab flow, so a Design System editor can test-generate a
video without touching Remotion:

```bash
npm run timds -- video lab --serve            # http://127.0.0.1:4410/
npm run timds -- video lab --serve --port 4500
```

Describe the source (the exact question, a topic label, notes or an article
excerpt), let Claude draft the compile request against this Design System's
authoring contract — the same prompt, brief, and JSON Schema
`createVideoAuthoringContract()` hands an automated Video Lab, including the
footage catalog (every eligible clip's key, published title, tags, and
duration) so the draft names one to three clips per beat — or paste one, edit
the answer beats and their footage keys, check the compiled plan (scenes,
estimated timings, footage chain, cover), save it under `video/lab/`, and
render. A beat's picks open its scene in order; the compiler fills any
remaining time from the clips the production has played least, ranked by how
many words their title and tags share with the narration, and still refuses a
family back to back. Rendering runs
headless through the same path as `video lab NAME --render` and the page hands
back the MP4 and thumbnail. Drafting uses `claude-opus-5` with the Anthropic
SDK's own credential lookup (`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, or an
`ant auth login` profile); without credentials the draft button is off and
everything else still works. The server binds to `127.0.0.1` only. When the
producer selects prompt blocks, run `timds check` first so the built
`dist/…/index.json` can resolve them; a producer with no blocks needs no index.

Renders include spoken narration by default. The browser offers an explicit
**Silent preview** option, also available as `--silent` on the CLI. Planning
and checks use estimated reading times without calling a speech service;
preparation and rendering generate each scene's narration with Edge TTS,
then finalize footage and captions using the measured word timings. A speech
failure stops the render instead of returning a silent video.

Use Python with `edge-tts` installed. TimDS selects `--python`, then
`TIMDS_PYTHON`, then the client's `.venv-tts` Python if present, then `python3`.
The default voice is `en-US-AriaNeural`; override it with `--voice` or declare
`voiceover: { "voice": "en-US-AriaNeural", "rate": "+0%", "pitch": "+0Hz" }`
in `video/contract.json`. Generated takes stay under ignored
`video-local/lab/NAME/voiceover/`, keyed by the exact script, voice settings,
and generator. Edits get new audio and timings; incomplete caches regenerate.
Authored production scripts and locked takes remain untouched.

Shorts use each master's published `vertical` derivative by default. A client
can set `producer.footage.allowShortCrop: true` to use the published master
when no derivative is linked **and** that master has a reviewed crop in the
registry configured by `timds.json → video.verticalMetadata`. The video component
uses that record's `objectPosition` and vertical `text` zone; a horizontal
`subject` label or a default center crop is insufficient. Explicit derivatives
still take precedence, and footage duration and family rules still apply.
Each Short scene uses clips with one compatible vertical text zone, keeping
its headline in the reviewed position throughout the chain. If the preferred
zone cannot cover the scene, the producer tries the other zone before failing.
Horizontal renders retain their original framing and text layout.

New `video init` scaffolds include `video/vertical-meta.json` and enable its
catalog gate. `video check` (and workspace loading before rendering) requires
every footage master under the producer's footage prefixes to have a valid
record tied to its published SHA-256, with a crop position, vertical text zone,
and first/middle/last-frame review. This checks the records, not the visual
correctness of a crop or automatic object detection. The designer must inspect
the subject throughout the clip. Existing catalogs opt in by adding the
manifest path and completing their records; ordinary upgrades do not migrate
authored metadata. The normal `timds check`/submission checks include this video
gate too. See the [B-roll crop authoring contract](skills/timds-create-video/references/vertical-crops.md)
for the schema and adoption procedure. Programmatic callers pass the same
registry as `verticalMetadata` to `createVideoProducer`.

Preparing or rendering downloads assets from their `media.json` public URLs
when no usable local media file exists, including stale or empty cache entries.
Cached published media must match the catalog's byte count and SHA-256; a
different local clip under the same media key is downloaded again before staging.
No manual asset pull or cloud login is required for published media.

`video check` compiles every lab input and warns when the registered catalog
cannot finalize one yet, so a new system can commit the sample before it has
registered footage under the producer's `footage.assetPrefix` keys (one prefix
or a list of them, when dashcam clips, character B-roll, and inserts share one
library) and a cover library under its `cover.assetPrefix` keys.

## Upgrade a client repository

An operator selects the approved release line. Keep the manifest on `0.1.x`,
refresh its resolved lockfile version, and then synchronize the repository-local
skill and installation record:

```bash
npm update @dtconcepts/timds
npm run timds -- upgrade --root .
npm run timds -- defaults
npm run timds -- defaults --apply
npm run timds -- doctor
npm run timds -- check
```

`upgrade` removes the legacy `.timds/cli` tree when present, synchronizes
both managed skills, and re-syncs the starter of an adopted system (see "The
starter stays current through upgrade"); a system that has not adopted it is
told to run `timds starter sync`. It refuses locally modified managed files
unless `--force` is explicitly supplied (that flag never extends to starter
files; `starter sync --force <path>` is the only way to replace those) and never
rewrites `timds.json`,
tokens, media records, authored source outside the recorded starter boundary,
framework config, documentation, or artifacts.

### One dependency selection

After bootstrapping a release that supports dependency selection, prepare a
compatible upgrade on a clean feature branch:

```bash
npm run timds -- upgrade --version 0.1.x
# Or select an exact reviewed patch with --version 0.1.<patch>.
```

This resolves the patch once, restores the bounded package requirement, installs
with `npm ci` from the exact lockfile, synchronizes adopted managed files with
the selected CLI, and runs dependency and Design System checks. A configured
`package.json` `check:timds-upgrade` also runs client producer, render, and visual
checks. Commit the package, lockfile, skills, and installation record together.
A failed check leaves the attempted change available for diagnosis; restore the
tracked dependency and managed files and run `npm ci` to return to the previous
resolution. The command does not merge or deploy.

TimDS owns exact React/Remotion runtime versions. Clients can consume hoisted
modules without redeclaring them. Existing direct declarations require one
explicit ownership adoption when their versions differ:

```bash
npm run timds -- upgrade --version 0.1.x --own-runtime
npm run timds -- dependencies check
```

This records `timds-v1` ownership and aligns existing React/Remotion dependency
declarations on subsequent selections. The graph check rejects duplicate or
missing runtime versions, dependency/lockfile disagreement, and an invalid
installed graph. PR validation and publication both use `npm ci`; ordinary
validation does not probe new releases or re-resolve after review.

### Explicit component consolidation

Preview copied visual declarations on a feature branch before applying:

```bash
npm run timds -- video components migrate
npm run timds -- video components migrate --apply
npm run timds -- check
```

The inventory recognizes installed defaults and the stock board-catalog snapshot
from 0.1.438 (also shared by 0.1.437). Unchanged snapshots become shared re-exports
at the same path. Supported visual variations become typed partial overrides,
retaining their helper declarations. Custom imports, exports, registration,
unclassified code, or scene/video logic require review and block application.
For unsupported older copies, implement reviewed partial overrides manually.

Apply changes only the configured component module and the contract's schema
version and `runtime` requirements. Brand, catalog, media, production records, publishing policy, and
`.timds/defaults.json` stay intact. Original component, contract, and manifest
bytes are saved in `.timds/component-migration/`; the migration is safe to rerun.
Before adoption, compare horizontal and vertical images both full frame and over
footage, including every retained override. Commit consolidation separately.
Roll back with `git revert <migration-commit>`, or restore the backed-up component
to its original `video.components` path and restore the contract and manifest.
Normal `upgrade` never consolidates snapshots or updates compatibility policy.

### Consumer and runtime compatibility

New scaffolds use video contract schema 2, which requires `runtime` in
`video/contract.json`: bounded `releaseLine`,
exact `minimumVersion`, `videoSchema`, `componentApi`, and required `features`.
The machine index exposes these requirements and the extracting runtime's exact
identity. Authoring, compile/finalize, and staged projects retain the installed
package version. Compilation and finalization use the same locked release.
Unsupported requirements fail before drafting or rendering.

Shared components use the declared release line only when schema, component API,
minimum version, and features match. Snapshots and migrated custom overrides list
reviewed exact `testedVersions`; a new patch requires their producer/render/visual
checks and an explicit contract review. Unchanged snapshots remove this
restriction when explicitly consolidated. Untested custom components have no
automatic compatibility promise. Schema 1 contracts retain their legacy behavior until explicit adoption. Schema
2 makes older hosts reject the contract instead of ignoring runtime requirements.

Consumers read the published derived layer or the selected repository contract,
and import `assertRuntimeCompatibility` from `@dtconcepts/timds/runtime` to verify
`index.video.runtime` or `contract.runtime` before invoking a producer or renderer.
Deploy a compatible locked TimDS release to remote hosts before adopting new
features; use the same tested resolution on producer and renderer hosts. TimDS
owns component discovery, staging, and composition registration.

### Opt-in dependency PR automation

```bash
npm run timds -- upgrade --dependency-prs
```

This adopts a weekly and manually dispatched workflow in the current repository.
Configure `TIMDS_UPGRADE_TOKEN` in repository settings with contents and pull
request permissions (a GitHub App credential is preferred), and configure
`check:timds-upgrade` for project-specific render checks. The workflow selects and
tests one locked release, opens or refreshes a draft dependency PR, and reports
the failing check when adoption fails. It refuses to include authored changes.
A fleet controller can register repositories privately and dispatch their
adopted workflows with exact versions; registrations and credentials stay outside
the public package. Review, merging, runtime deployment, and consumer deployment
are separate operations.

### Shared defaults across existing Design Systems

TimDS owns reusable publishing wording and budgets in
`templates/video/publishing-defaults.json`. Improvements developed in a client
system can become the next package defaults after removing firm names, campaign
URLs, and client-only requirements. New video workspaces receive these defaults.

`timds defaults` previews an existing system's update. On a feature branch,
`timds defaults --apply` adds missing publishing fields and records the supplied
defaults and explicit override paths in `.timds/defaults.json`. Commit that
baseline with the contract. Unedited toolkit values follow later defaults;
client edits and intentional deletions stay protected, even when a later default
happens to match them. First adoption also preserves existing values and inherited
CTAs, disclosures, and article-link policy. New scaffolds use the toolkit policy.
The command is safe to repeat and migrates older baselines automatically.

To return an override to toolkit control, set its contract field to the value in
the baseline's `videoPublishing` object (or remove it if absent there), remove
its path from the baseline's `overrides` list, then preview and apply defaults.
Review both files together.

After upgrading the package, run the same command, inspect its reported overrides
and Git diff, validate, and open a PR in each Design System. `upgrade` reports
available defaults without applying them. This is a local, reviewed update; it
does not discover repositories, push branches, merge, or deploy. Currently only
`publishing.targets` and `publishing.targetDefaults` participate. Historical
productions, legacy publishing fields, brand, components, and media are untouched.
Client-specific CTAs and legal/disclosure requirements remain local overrides.

Standalone repositories created by older TimDS releases can adopt the managed
merge-to-patch automation explicitly:

```bash
npm run timds -- upgrade --root . --auto-release
```

The migration replaces only recognized stock release files, adds the release
preparation test, and records `merge-patch-v1` in `.timds/installation.json`.
It stops when release automation was customized; inspect that customization and
use `--auto-release --force` only when replacing it is intentional.

## Toolkit development and release

```bash
npm test
npm run pack:check
```

To release the latest `master` from GitHub, open
[Actions → Publish npm package](https://github.com/dtconceptsnc/timds-toolkit/actions/workflows/release.yml),
click **Run workflow**, leave the branch set to **master**, and click **Run workflow**
again. No version input is needed: the workflow checks out the latest `master`,
runs the checks above, bumps the patch version in `package.json` and the lockfile,
pushes the release commit and matching tag, creates a GitHub Release with generated
notes, and publishes to npm. Release runs are serialized. If `master` changes
during validation, the push fails without publishing a stale release; start a new
run against the updated branch.

The workflow uses the built-in GitHub token to create the release and the existing
npm trusted publisher for `release.yml` to publish. No additional secret is needed.
If npm publishing fails after the release was created, use **Re-run failed jobs**
to retry publishing the same version. **Run workflow** or **Re-run all jobs** creates
another patch release.

You can also cut a release locally from a clean, synced `master`:

```bash
npm run release              # bump the patch: 0.1.403 -> 0.1.404
npm run release -- 0.2.0     # release an explicit version
npm run release -- --dry-run # run every check, change nothing
```

The script runs the checks above, bumps `package.json`, tags, pushes, and opens
the GitHub Release. Publishing to npm is left to
`.github/workflows/release.yml`, which authenticates through the trusted
publisher. Never run `npm publish` by hand: it beats CI to the registry and
leaves that run failing on a version conflict.

Release tags must match `package.json` as `v<version>`. The npm package is
public; this repository remains `UNLICENSED` until DT Concepts selects an
open-source license.


Portal provisioning can pass immutable identity explicitly:

```sh
npm run timds -- init --standalone --root ./new-system --name "Client Design System" --system-id "client/unique-id" --description "Shared standards" --json
```

`--json` returns the initialization result with the manifest, layout, exact toolkit package version, created paths, and validation artifact. Existing contracts retain their identity; conflicting explicit inputs are rejected.
