# TimDS Toolkit

`@dtconcepts/timds` is an open-source toolkit for repository-owned Design
Systems: a versioned CLI, the repository contract, templates and a starter
scaffold, a machine-readable derived layer, MCP servers, AI agent skills, and a
contract-driven video engine. Video is part of this package; there is no
companion runtime package for clients to install or copy.

Everything in this README up to [TimDS Cloud](#timds-cloud) works with a local
or Git checkout and no host. TimDS Cloud, the optional hosted service (hosted
editing sessions, Studio review, publication, media storage and hosted MCP),
is described in one section at the end and in
[docs/timds-cloud.md](docs/timds-cloud.md).

Client repositories select the bounded `0.1.x` package line in
`devDependencies`. The lockfile records the exact resolved release. The CLI runs
from `node_modules`; client Git repositories do not carry a copied `.timds/cli`
tree. TimDS also installs the managed skills under `.agents/skills/` (the
editing and video procedures and the four designer skills) and
`.timds/installation.json` for fleet/version inspection.

## Standalone executable

The `timds-cli` release download includes its JavaScript runtime and production
dependencies. Stock Design Systems build, check, preview, serve MCP and render
video without separately installing Node, npm, npx or Bun. Native macOS arm64
and Linux x64 releases are gated by clean-machine smoke tests. Custom product
builds keep their declared tools; browser and media operations retain their
listed platform prerequisites.

Follow the [download and installation guide](docs/binary-installation.md) for
checksums, PATH setup, an exact workspace pin, explicit npm adoption, upgrades
and rollback. [Packaging details](docs/binary-packaging.md) cover runtime pins,
cache integrity, platform requirements and signing. Existing npm installations
and package imports keep their current contract.

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

To link a standalone Design System to a product repository that consumes it,
declare the consumer during initialization:

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
to the consumer. Every accepted change on `main` becomes a dated release
(`YYYY.MM.DD-N`, the UTC day and the release number that day): TimDS
synchronizes the version, publishes that exact commit, then opens or refreshes
a pull request in the consumer that moves its pin to the release. A consumer
with a published pin (`designSystem.version` in `timds.consumer.json`, the
form `consumer init` writes) is moved through its own toolkit, which fetches
and verifies the published bundle; a consumer that still carries the system
as a git submodule has its gitlink advanced to the exact commit. Neither
depends on a release tag.

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
Claude Code, and the managed skills under `.agents/skills/` (linked from
`.claude/skills` so Claude Code lists them as slash commands): the editing
and video procedures, and four designer skills, `design-start`,
`design-media`, `design-ship`, and `design-handoff`, that run the toolkit
for the designer at each moment of the work. An agent can
start designing from `AGENTS.md` alone. The initializer also
adds the appropriate dependency and artifact ignore rules, so after
`npm install` creates the exact lockfile, `git add --all` is safe. Commit
`package.json`, the lockfile, `.agents/skills/`, the Design System contract,
and the TimDS workflow. Do not commit `node_modules`.

The ordinary starter is organized as views (Brand, Web DS, Digital DS, Social
DS, Print DS, Use) declared in `src/site.json`, each a list of authored or
`planned` pages rendered into one shared shell. It opens on the Use view's
own page, a portal landing (`"layout": "landing"`, rendered without the side
navigation): a hero, rails of asset cards from the format catalog that open
the composer on that format, the kit, three steps, and every other way in.
`use/compose` is the composer, promoted as "Start making" in the app bar of
every page, with every entry of `src/formats.json` as a preset; `use/install`
explains each way to consume the published system. The scaffold also carries
a `CHANGELOG.md`: notes go under `## Unreleased`, a release rolls them under
its dated version, the built system renders the history at `/changelog/`
(linked from the version chip in the app bar) and publishes it as
`changelog.json`, and `submit` refuses a change without an Unreleased note.

`init --starter brand-kit` scaffolds the second starter instead: a
slot-driven brand kit for a website-to-kit parent, with nine channel views
(Brand, Web, Social, Ads, Email, Print, Events, Decks, Use), an authored
Voice page, copy slots in `src/copy.json`, media slots, template formats
rendered in Minimal, Accent, Bold and Photo treatments, and an empty Designs
directory. Its slot contract is exported as `@dtconcepts/timds/brand-kit`;
`.timds/starter.json` records the kind, and starter sync keeps each kind's
catalogs and managed fragments. See [the brand kit](docs/brand-kit.md).

## Designer workflow

After repository access and Node.js 20+ are configured:

```bash
git clone git@github.com:ORG/CLIENT-design-system.git
cd CLIENT-design-system
npm ci
npm run timds -- doctor
npm run timds -- dev
```

`dev` starts the framework authoring server declared in `timds.json`; the
stock starter's server also serves a [workspace site](docs/emdash.md#one-dev-server)
under `/site/` on the same port. Use
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
not merge or publish without separate authorization, and it refuses a change
whose `CHANGELOG.md` has no note under `## Unreleased`, unless every change is
inside the system's [workspace site](docs/emdash.md#two-builds-in-one-repository)
(`site/`), which it carries with the system.

## Agent skills

Every Design System repository carries the managed skills under
`.agents/skills/` (linked from `.claude/skills` so Claude Code lists them as
slash commands): `timds-edit-design-system` and `timds-create-video`, the
editing and video procedures, and four designer skills, `design-start`,
`design-media`, `design-ship`, and `design-handoff`, that run the toolkit for
the designer at each moment of the work. `init` writes them and `upgrade`
refreshes them; see [Upgrade a client repository](#upgrade-a-client-repository).
A consumer repository carries `timds-consume-design-system` and
`timds-update-design-system`, written by `consumer init` and refreshed by
`upgrade` there.

To give an agent the designer skills in a folder that is not a Design System
or consumer repository:

```sh
npx --yes @dtconcepts/timds@latest skills install
```

This writes the system-independent skills into `.agents/skills/`,
`.claude/skills/` and `.cursor/skills/` (`--global` installs under the home
folder instead) and records every written file's digest in
`.timds/skills.json`. Rerun the same command at `@latest` to refresh:
unmodified files are replaced, files a release no longer ships are removed,
and a file someone edited is kept and reported unless `--force`. The command
refuses to run in a Design System repository or a consumer repository, whose
skills `init`, `consumer init` and `upgrade` manage. The per-system hosted
skill is part of [TimDS Cloud](#timds-cloud).

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
the system keeps one), `designs.json` (the website designs, their pages and
journeys), `changelog.json` (the release history, beside the rendered
`/changelog/` page), `bundle.json` (the consumer bundle's digests, when the
manifest declares `bundle.include`), `llms.txt` (the brand essentials and
the page index), `llms-full.txt` (every page in one file), an `index.md`
Markdown mirror of every page, and, when the entry page is at the artifact
root, a `robots.txt` that names `llms.txt` (a `robots.txt` the build wrote
is kept).
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

People send agents to the site as often as to `llms.txt`, so every page the
starter viewer renders points at it from both places an agent reads: the head
holds a comment naming the entry point, a `<link rel="llms-txt">` to it, and a
`<link rel="alternate" type="text/markdown">` to that page's own mirror; the
body ends with one visible line saying the same, outside `<main>` so the
mirrors stay free of it. The changelog page and the designs directory carry the
same pointers; an authored design is published as written. `robots.txt` at the
site root repeats it for a crawler that reads that file first.

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

Pages a visitor moves through in order (a funnel, a checkout, a form with its
states, an onboarding) are declared as journeys in `design.json` when they are
added, so the order is data every consumer can read rather than something a
reader infers from alphabetical route lists:

```json
"journeys": [
  {
    "id": "checkout",
    "title": "Buying a plan",
    "summary": "From the pricing page to the paid confirmation.",
    "steps": [
      { "title": "Choose", "screens": [{ "page": "/pricing" }] },
      {
        "title": "Pay",
        "summary": "The form, then the wait for the payment provider.",
        "screens": [
          { "page": "/checkout", "label": "Checkout" },
          { "page": "/checkout", "state": "pending", "note": "While the payment is checked." },
          { "page": "/checkout", "state": "sent", "label": "Paid" }
        ],
        "branches": [{ "page": "/checkout", "state": "error", "label": "Payment not confirmed" }]
      }
    ]
  }
]
```

A journey is `{ id, title, summary?, steps }`; a step is `{ title, summary?,
screens, branches? }`; a screen is `{ page, state?, label?, note? }`, where
`page` is a route the design has and `state` one of that route's states (the
default when omitted). `label` defaults to the page title plus the state name.
Branches are the screens a visitor meets instead of the step's own (an error,
a stalled read). `check` validates every reference and refuses a route under
`/journeys/`, which is reserved; it warns, without failing, when a design has
several pages or a route with states and no journey shows them.

Each journey is rendered as a storyboard at `/designs/<design>/journeys/<id>/`:
one section per step with its screens as the live page states in lazy
same-origin frames at phone width (390px, scaled to about 0.62), numbered
through the journey, branch screens in a second row marked "or", each frame a
link to the full page with a caption of the label, the note, and the route and
state. The `/designs/` directory lists each design's journeys as cards above
its route table.

The `/designs/` directory and the storyboards have toolkit-owned, responsive
chrome. Its scoped stylesheet uses the system's colors and fonts with neutral
fallbacks, and is loaded only on those pages; authored page designs keep
their own layout. Rebuilding with the updated toolkit refreshes them.

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
files it loads, and every journey with its screens resolved to routes, states,
and urls in visitor order; `list_designs` and `read_design` serve it to
consumers, who port a journey's screens in that order, and
`extract --publish` uploads it with the stylesheets, scripts, and media it references.
`@dtconcepts/timds/designs` exports the renderer (`buildDesigns`), the check
(`checkDesigns`), and the catalog reader. A system scaffolded before designs
existed adopts them with `timds designs init`.

### The starter stays current through upgrade

A starter-based system is upgradeable the way a CMS is: the scaffold's
plumbing and structure are TimDS's to refresh, the client's content is not,
and the line between them is recorded in `.timds/starter.json` rather than
guessed. `init` writes the record for a fresh scaffold and every `upgrade`
re-syncs it.

```bash
npm run timds -- starter sync            # sync by hand; in a terminal it asks about each customized stock file
npm run timds -- starter sync --force scripts/build.mjs    # non-interactive: replace the named customized stock script or stylesheet (never a fragment)
npm run timds -- starter status                            # starter level, floor, pending steps, declines, conflicts
npm run timds -- starter migrate --accept ID               # decide a step that changes what visitors see (or --decline ID)
```

Inside the boundary the sync touches four kinds of things. The stock
`scripts/build.mjs`, `check.mjs` and `dev.mjs` (stubs that call the renderer
in the package, `@dtconcepts/timds/viewer`), `src/scripts/compose.js`,
`src/styles/canvas.css`, and
`src/styles/viewer.css` are plumbing (`starterPlumbingFiles` in
`src/starter.mjs`), and the record's `plumbing` mode says who a local change
to them belongs to. A system scaffolded by `init` is `"toolkit"`: every
upgrade brings those files to stock, replacing a local change and saying so, without halting and
without naming files. In `"recorded"` mode a file is replaced while it still matches a hash the toolkit
wrote, and a customized one is kept unless the person running the sync in a
terminal chooses to replace it when asked (keep, replace, or diff first,
file by file). Edit the field to switch. `src/site.json` and `src/formats.json`
are merged three ways against the recorded stock baseline: views, pages, and
formats the system lacks are appended (pages as `planned`, so a new primitive
is there to author), fields still equal to the baseline advance to the new
scaffold, and anything the client changed is kept, and reported when the
scaffold's own value moved rather than on every sync; nothing is removed,
reordered, or retitled, and a format whose page the system does not declare
is skipped. The Digital, Social, and Print overview fragments and the Use
pages (the landing, the composer, and Install) are written
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
`customized`, `skipped`, `removed`) and the catalog changes it merged.

The fourth kind is the starter level. Defaults a system never chose change
through numbered steps declared as data: `.timds/starter.json` records the
`level` reached and the steps `declined`, `upgrade` settles every step that is
not visible or has nothing to change, and a step that changes what visitors
see waits for `starter migrate --accept` or `--decline`. This release is
level 1 with floor 1 and no steps. A starter-based system from before starter
levels (a record without `level`, or none) is below the floor: `upgrade`,
`starter sync`, `starter migrate` and `feed` refuse it with `below_floor`, and
it is regenerated from the current starter rather than carried forward.

The renderer is never copied: the stub scripts call the package, and a system
that needs an extra build step declares it as a command in `timds.json`:

```json
"workspace": {
  "build": ["node", "scripts/build.mjs"],
  "after": { "build": [["node", "scripts/build-runtime.mjs"]] }
}
```

The commands run in order from the design-system root after every stock build
(`build`, `dev`, and the build `check` runs), and a non-zero exit fails it.
See [upgrading in depth](docs/upgrade.md#starter-levels) for the rules and
the status `starter status --json` reports.

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
the kit itself. `timds doctor --json` prints the whole report as one JSON
object: the repository and design system roots, the system id, name and
version, the toolkit selected and running (binary or npm), the starter record
(synced version, plumbing mode and starter status, including `belowFloor`, or
not a starter system), the
media asset count, designs, video, consumer, branch, brand kit, and bundle.

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

### Token and media groups

New systems author `tokens/<group>.json` and `media/<group>.json`.
`timds upgrade` migrates legacy aggregates without changing token values or
media records and refuses conflicting existing group files. The groups are
adopted only when they validate as the contract the aggregates never checked:
a legacy token value that names a plain custom property, such as
`var(--theme-body, var(--text))`, keeps the aggregate layout and the upgrade
reports why under `contractMigration.reason`. The layout record is
`.timds/contract-layout.json`; old systems remain readable until upgraded.
A token group file is a key map such as `{"600":{"value":"#2457d6"}}` in
`tokens/color.brand.json`. Media maps use full logical asset keys as keys.
`check` validates group structure, duplicate keys, token references, cycles,
CSS name collisions, and media references. `{color.brand.600}` is a token
reference; a token’s optional `media` field names a catalog key.

`tokens.json` and `media.json` become generated compatibility views for existing
builds and consumers. Never edit those views. The published derived layer and
bundle schema remain unchanged.

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

The local viewer resolves `founder-interview` to that local file. Timed
media is inspected with `ffprobe` during `assets add`, so video and audio
records also carry their measured duration, and video records carry
dimensions, frame rate, and codec when available. Publication writes only the
stable key, checksum, metadata, and public URL to the catalog. Set `FFPROBE_PATH` only when
`ffprobe` is installed outside the normal command path. The raw file and
`.timds/local-media.json` remain ignored. Uploading staged media to public
storage (`assets publish`, which Git `submit` also runs), restoring it
(`assets pull`) and `assets backfill-metadata` work on media published to a
TimDS host; see [TimDS Cloud](#timds-cloud).

Never commit tokens, storage credentials, object keys, expiring signed URLs,
`.timds/local-media.json`, or anything except the README under `media-local/`.

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
check scripts stay editable. A workspace site (`site/` with a workspace-form
`timds.consumer.json`) is editable with the system, except its
`package.json`, `package-lock.json`, `timds.consumer.json`, `.timds/`, build
output and local state (`dist/`, `.astro/`, `.wrangler/`, `.emdash/`) and
secrets (`.env*` but `.env.example`, `.dev.vars*`); `run_check` checks the
system only. In
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
product itself; it runs the commands the manifest declares. A system's own
EmDash site inside its workspace is the exception with no pin
(`designSystem: { "workspace": true, "systemId": ... }`); see
[EmDash sites](#emdash-sites).

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
Published-mode `consumer init` and `consumer migrate` resolve a missing or
older toolkit lock to the running release while keeping the `0.1.x` requirement.
Init installs that resolution with `npm ci` before postinstall runs. With
`--skip-install`, init refuses an older lock before writing files; rerun
without the flag to refresh it. `consumer check` reports locks older than the
release that introduced published pins, with a command to repair them.
Because the root package and lockfile are what fetches the bundle, `consumer
init`, `consumer migrate`, and `timds upgrade` refuse, before writing
anything, when a `.gitignore` pattern would keep a file they write out of git
(naming the pattern and its line), and `consumer check` fails on a root
package, lockfile, manifest, installation record, or managed file that git
ignores, on a published pin whose package or lockfile is missing, and warns
on ones not committed yet.
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

- `timds consumer check [--app NAME] [--base REF] [--require-token=--NAME]...` validates the manifest and
  the pin: for a published pin, that the synced bundle is present and at the
  pinned version; for a submodule, that it is pinned and checked out (warning
  when the checkout drifts from the pin). It also checks that every app's
  `cwd` exists. Repeat `--require-token=--focus-ring` for each CSS custom
  property the product needs. The check reads the actual synced bundle,
  including a local draft override, or the checkout's tracked and unignored
  CSS. Missing definitions, empty values, and unresolved aliases in the same
  selector or document scope fail the check. This checks token availability;
  verify product stylesheet imports, browser cascade, and contrast in the
  actual product preview. In a workspace site the check also runs the other
  way: a color or `font-family` literal equal to exactly one system token is
  rewritten to it (`--no-fix` reports it instead), and a literal with no
  token, an ambiguous one, a site override of a system token, or a class no
  system stylesheet declares fails the check until the style is added to the
  system in the same change (`workspaceCheck` in `--json`; see
  [the two-way check](docs/emdash.md#the-check-runs-both-ways)). With `--base`, it
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
- A developer carrying a release into the product runs
  `timds consumer check --base origin/main --allow-pin-update LABEL` with the
  exact target label. This explicit opt-in accepts that published version
  change while keeping every other manifest value fixed, including app
  commands, routes, scope, protected paths, system identity and bundle path.
  Adding an explicit default is also a manifest change; JSON key order and
  formatting may differ. It still checks the base manifest's design surface and
  protected paths; a branch cannot expand its own permissions. It requires an existing published
  pin and `--base`, and rejects `current` and `latest`. The ordinary check
  without the flag continues to reject all pin moves. Submodule migration
  remains an explicit separate operation.
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

- `timds consumer scaffold emdash --root PATH --design-system GIT_URL` creates
  a new EmDash CMS site repository that consumes a Design System (see
  **EmDash sites** below), then adopts it the way `consumer init` does. With
  `--existing --root PATH` it installs EmDash's article section into an Astro
  site that already has `timds.consumer.json`. With `--workspace [--root
  PATH]`, run in a Design System workspace, it writes a complete site with no
  pin into the system's `site/`.

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

An Astro site that already consumes a Design System gains an articles section
fed through EmDash's API with `--existing`:

```bash
npx --yes @dtconcepts/timds@0.1.x consumer scaffold emdash --existing \
  --root /path/to/client-site --site-url https://www.client.example
```

It installs the shared EmDash template set (the article routes, the seed,
`src/live.config.ts` and the site docs), adds the dependencies and the
article routes with their design pairs to `package.json` and
`timds.consumer.json`, records the template version in `.timds/emdash.json`,
and prints the `astro.config`, `wrangler.jsonc` and `.gitignore` changes for
the developer to make. It never overwrites a path or edits an existing page,
and `upgrade` never touches what it writes.

A system's own website lives in the system's workspace instead, with no pin:

```bash
npm run timds -- consumer scaffold emdash --workspace
```

Run at the root of a Design System workspace, it writes a complete EmDash
site for Cloudflare Workers into `site/` (`design-system/site/` when
embedded): its own package with exact versions and a lockfile, the Astro and
Worker configuration, and pages built from the system's website design, with
its stylesheets and tokens read from source, so a change to the system is a
change to the site at its next build. It asks nothing and runs no generator.
`npm run timds -- consumer check --root site` checks the site both ways and
rewrites a literal that equals one system token; `npm run timds -- dev`
serves the system at `/` and the site at `/site/` on one port; `npm run
worker` in `site/` bundles an uploadable Worker with no credentials. The
system's `build`, `check` and `upgrade` give the same results with and
without the site.

What each mode writes, the hosting platforms, the deploy workflow, and the
workspace mode's dev server, check and upload output are described in
[docs/emdash.md](docs/emdash.md).

## Offshoots follow a parent release

`timds shoot example/core --system-id example/child --root ../child
--mode structure` creates a local offshoot from the parent's published source.
Full mode keeps authored layers; structure keeps verified toolkit plumbing,
catalogs, placeholder tokens and any exact files the parent's designer listed
in `.timds/stock.json`. Both write `.timds/parent.json` and pass the workspace
check before creation completes. Neither carries the parent's workspace site
(`site/`): an offshoot starts without one.

`timds feed` merges the next parent release against that record: unchanged
catalog fields advance, missing entries are added as planned pages, and local
grafts stay. The files the parent declares as stock follow it by the hash
`.timds/parent.json` recorded when they were last written: an unmodified copy
is refreshed, one the child changed or removed is a graft and is kept. Every
other authored file is never replaced; failed checks roll back the feed.
`--source-file EXPORT --json` feeds from a materialised source export instead
of a checkout (see [TimDS Cloud](#timds-cloud)). Ordinary upgrades
keep plumbing current and leave the parent's structure alone, while
maintaining the layout's stock stylesheet links.
`timds sever` confirms before removing the parent baseline. See
[offshoots](docs/offshoots.md) for local Git parents, stock declarations,
lineage readers and the hosted catalog boundary.

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

Graphic scenes, chapters and static files, the board catalog, brand colors and fonts, brand files every render host can reach, and the video lab are described in [docs/video.md](docs/video.md).

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
the managed skills (the editing and video procedures and the four designer
skills), and re-syncs the starter of a starter-based system (see "The
starter stays current through upgrade"); one below the starter floor is
refused before anything is written. It refuses locally modified managed files
unless `--force` is explicitly supplied (that flag never extends to starter
files; `starter sync --force <path>` is the only way to replace those) and never
rewrites `timds.json`,
tokens, media records, authored source outside the recorded starter boundary,
framework config, documentation, or artifacts.

`upgrade --json` and its error codes, one dependency selection, runtime ownership, component consolidation, consumer and runtime compatibility, dependency PR automation, shared publishing defaults and `--auto-release` are described in [docs/upgrade.md](docs/upgrade.md).

## Toolkit development and release

```bash
npm test
npm run pack:check
```

To release the latest `master` from GitHub, open
[Actions → Publish TimDS package and executables](https://github.com/sticktrk/timds-toolkit/actions/workflows/release.yml),
click **Run workflow**, leave the branch set to **master**, and click **Run workflow**
again. No version input is needed: the workflow checks out the latest `master`,
runs the checks above, bumps the patch version in `package.json` and the lockfile,
pushes the release commit and matching tag, creates a GitHub Release with generated
notes, builds, signs, notarizes and verifies the native macOS arm64 and Linux
x64 executables (`binary.yml`), publishes to npm only when both built, and
attaches the executables with their `SHA256SUMS` to the release. The `dry_run`
input only exchanges the workflow's OIDC token with npm and prints the
answer, with no release and no publish. Release runs are serialized. If
`master` changes during validation, the push fails without publishing a stale
release; start a new run against the updated branch.

The workflow uses the built-in GitHub token to create the release and the existing
npm trusted publisher for `release.yml` to publish. It refuses to start
without the six Apple signing secrets (`TIMDS_MACOS_CERTIFICATE_BASE64`,
`TIMDS_MACOS_CERTIFICATE_PASSWORD`, `TIMDS_CODESIGN_IDENTITY`,
`TIMDS_NOTARY_APPLE_ID`, `TIMDS_NOTARY_TEAM_ID`, `TIMDS_NOTARY_PASSWORD`; see
[signing](docs/binary-packaging.md)), and it publishes to npm only after the
executables are uploaded to the public download host, which needs the
`TIMDS_DOWNLOAD_ENDPOINT`, `TIMDS_DOWNLOAD_ACCESS_KEY_ID` and `TIMDS_DOWNLOAD_SECRET_ACCESS_KEY`
secrets ([download host](docs/binary-hosting.md)). If npm publishing fails after the
release was created, use **Re-run failed jobs** to retry publishing the same
version. **Run workflow** or **Re-run all jobs** creates another patch release.

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

Release tags must match `package.json` as `v<version>`. The npm package is public.
Original toolkit code is licensed under the Apache License 2.0; see
[LICENSE](LICENSE) and [NOTICE](NOTICE). Third-party dependencies retain their
respective licenses. Previously published versions retain the license
distributed with that version; `0.1.471` was published with MIT metadata.

Automation that provisions a system can pass immutable identity explicitly:

```sh
npm run timds -- init --standalone --root ./new-system --name "Client Design System" --system-id "client/unique-id" --description "Shared standards" --json
```

`--json` returns the initialization result with the manifest, layout, exact toolkit package version, created paths, and validation artifact. Existing contracts retain their identity; conflicting explicit inputs are rejected.

The read-only
[`@dtconcepts/timds/release-metadata` package export](docs/release-metadata.md)
gives hosts and build tools preparing toolkit upgrades deterministic resource
metadata and exact managed-file bytes from the installed npm package. Starter
seed templates, rendered hosted skills, and upgrade-managed files have
separate policies and hashes. The `@dtconcepts/timds/merge` export is
deprecated and will be removed in a later release; see the public toolkit
boundary in [AGENTS.md](AGENTS.md).

## TimDS Cloud

TimDS Cloud is the optional hosted layer on top of the toolkit. The toolkit
calls the host's public API (`@dtconcepts/timds/hosted`, session API version
1) and nothing else; it ships no server. Everything above keeps working
without it. The full command reference is
[docs/timds-cloud.md](docs/timds-cloud.md).

**Sign in.** `timds auth login` (also `timds login`) selects `--portal-url`
first, then the nearest workspace's hosted `provider.url`, then
`TIMDS_PORTAL_URL` or `https://timds.com`. It uses OAuth with PKCE on a host
that advertises it and the portal's device login otherwise (`--oauth`,
`--device`, `--no-browser`). Credentials stay outside the repository in the
owner-only TimDS credentials file; `TIMDS_ACCESS_TOKEN` is the
non-interactive alternative. `timds auth status` and `timds auth logout`
select the same host.

**Hosted sessions.** A `provider` of `{ "kind": "hosted", "url": "..." }` in
`timds.json` selects the host API instead of Git. Humans use `login`,
`status`, `history`, `publish` and `rollback`, or Studio; agents write with
`start`, `join`, `pull`, `update`, `submit`, `claim`, `active-work`,
`whoami`, `systems`, `principals`, `draft create|list|close` and
`sessions close`:

```sh
npm install --global @dtconcepts/timds@latest
timds auth login --portal-url https://YOUR-HOST --oauth
timds start example/core --root ./core
cd core
npm ci
timds dev
# After editing:
timds check
timds submit --note "Describe the change"
```

`timds skills install --portal-url https://YOUR-HOST --system-id example/core`
adds the per-system hosted skill (`timds-<system>`, rendered from
`skills/timds-hosted-design-system/`) beside the designer skills. `timds init
--standalone --provider hosted --portal-url https://timds.com` creates a new
hosted source. The `live` block in `timds.json` opts a system into native
hot module replacement in hosted live previews.

**Publish.** In a hosted workspace, `timds publish` publishes the latest
submission (or `--submission`) after rechecking current main and the
publisher grant, and requires confirmation (`--yes`; `--dry-run` reports
conflicts and checks without publishing); `timds rollback VERSION` also
requires a publisher and confirmation. In a Git checkout, `timds publish`
builds and checks, pushes `artifact.publishRef`, and asks the portal to
promote that exact build with an operator token. `extract --publish` uploads
the derived layer and consumer bundle to the host's CDN.

**Media.** `timds assets publish` uploads staged `media-local/` files to the
host's public storage (Git `submit` does this first); `assets pull KEY`
restores one and `assets backfill-metadata` measures older catalog entries
from their public URLs. `media.portalUrl` in `timds.json` names the host
these uploads and publication use.

**Consumers.** `timds consumer register` and `timds consumer updates` enrol a
product for hosted pin updates and read their receipts; `timds consumer
notes` reads and resolves designer notes left on a preview;
`timds consumer preview --publish` and the stock preview workflow (off until
`TIMDS_PREVIEWS_ENABLED` is `true`) upload previews to the portal;
`timds consumer init --draft-preview` and `timds consumer update --draft
NAME` preview an unpublished draft. Published pins fetch from
`https://design-systems.timds.com/<systemId>/artifact` unless `url` overrides
it.

**Hosted MCP.** `timds mcp` started in an empty workspace with
`TIMDS_PORTAL_URL` set serves the hosted editing tools, and `timds mcp read
--draft NAME --system-id ID --portal-url URL` serves a draft's derived layer.
`consumer init` registers the host's `timds-design-system-read` HTTP MCP
server in `.mcp.json`, authorized with `TIMDS_ACCESS_TOKEN`.

Running and administering a host is documented in the host repository, not
here; see [docs/hosted-operations-moved.md](docs/hosted-operations-moved.md).
