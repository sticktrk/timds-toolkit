# Offshoots and parent stock

An offshoot starts from one immutable parent release and keeps a structural
feed baseline. A starter is a seed: its structure comes from the toolkit.
An offshoot's structure comes from its parent; ordinary toolkit upgrades keep
its plumbing current without adding the starter's pages or changing ancestry.
They also maintain the layout's missing stock stylesheet links and changelog
version-chip link, within the starter's existing narrow layout boundary.
Uncommitted catalogs and authored fragments do not block this plumbing sync;
its cleanliness check covers only the plumbing, layout and starter record it
may write. Feed checks its own catalog and plumbing write paths separately.

The host provisions hosted offshoots and owns grants, source identities and
publication lineage. These commands create and maintain a local repository.
They do not register a source, publish it, or change the host catalog.
Designers direct their agent; the agent runs the commands.

Local `shoot` currently runs through the npm distribution. After reviewing and
committing the new npm offshoot, binary users explicitly adopt it with
`timds-cli installation adopt --binary --apply`. Binary `shoot` refuses before
fetching source or creating files. Feed and sever retain the selected execution
mode.

## Create

```bash
npm run timds -- shoot example/core --version 2026.10.29-1 \
  --system-id example/child --name "Example child" --mode structure \
  --root ../child --portal-url https://host.example
```

The signed-in principal must be allowed to export the parent source.
`GET /api/timds/design-systems/{system}/releases/{label}/source` supplies
`{apiVersion:1,parent:{systemId,sourceId,version,commit},files:[...]}`.
Files use canonical paths, Git modes and base64 content. `latest` is the
default and resolves once to the publication's exact commit.

A local parent is read from its committed Git tree, ignoring worktree edits:

```bash
npm run timds -- shoot ../parent --ref v2026.10.29-1 \
  --source-id 11111111-1111-4111-8111-111111111111 \
  --system-id example/child --mode full --root ../child
```

Supply the parent's source UUID with `--source-id` (or its explicit
`timds.json` `sourceId`); the toolkit never invents a hosted identity.
`--ref` defaults to `HEAD`. An optional `--version` must match that tree's
manifest version. The new system needs its own lowercase URL-safe system ID,
up to 160 characters. A positional local path starts with `./` or `../`, or
is absolute; a bare `org/name` always selects the host even when a directory
of that name exists. Feed's explicit `--from PATH` always selects local Git.

Shoot requires a new or empty destination, initializes its own Git repository,
sets its provider to `local`, and runs the workspace check. Failure removes
the new tree, restoring an initially empty directory. No dependencies or
runtime are copied from the parent's working directory. For a full parent with
a custom build toolchain, the CLI runs `npm ci --ignore-scripts` against its
exact lockfile before checking. It does not run a custom `workspace.install`
by default. After reviewing the source, `--install` explicitly permits that
command, or npm lifecycle scripts when there is no custom installer. The
workspace's declared build/check commands still run as part of creation.
Custom tools retain their external prerequisites. The stock starter builds
without installing dependencies.
Stock builds do not require a `package-lock.json`; when one exists, its
resolutions are retained and only the root package name changes. A custom
toolchain that needs dependency installation still requires its exact lockfile
unless `--install` selects a reviewed `workspace.install` command.

## Full and structure

Full copies every exported source layer, including authored content, before
setting the new identity and immediate parent record. Local Git export refuses
secrets, generated directories and submodules rather than importing them.

Structure retains verified plumbing and exact designer-declared stock. The host's
matching transform revision is 2; its recorded revision 1 remains available for
operations bound before composer and copy-file support:

- `.timds/starter.json` must have `plumbing:"toolkit"` and hashes matching
  the parent's build, check, dev and viewer scripts. Only recorded
  `scripts/*.mjs`, `src/scripts/compose.js`, `src/styles/viewer.css` and
  `canvas.css` are plumbing. The composer is copied only when its bytes match
  the recorded hash, like the other plumbing; its Use page must be declared
  as stock to remain authored in a structure offshoot.
- Views retain IDs and labels; pages retain slugs, titles and groups. Pages
  without an explicitly included body are `planned:true`. Authored summaries,
  design references and other site metadata are omitted. Formats come whole.
- Token names and brand role mappings remain. Every token value is `initial`
  in both the aggregate and split catalogs, and descriptions are removed.
  Check reports these as unresolved warnings. Empty media catalogs replace
  both `media.json` and `media/assets.json`; designs and authored media go away.
- A neutral shell, system stylesheet and overview are generated when absent.
  They use the viewer's `{{title}}`, `{{name}}`, `{{views}}`, `{{sidenav}}`,
  `{{content}}`, `{{pagenav}}` and `{{sitemap}}` placeholders.
- The package keeps dependency/runtime fields and standard `timds` and
  `build:preview` scripts; existing exact lockfile resolutions remain. Installation
  metadata selects the recorded toolkit release. `timds.json` keeps the
  artifact contract and brand roles, selects the verified standalone workspace
  scripts, and bundles `dist/tokens.css` and `dist/styles/system.css`.
- The starter record keeps the parent's recorded toolkit baseline. The
  separate parent record holds the structural feed baseline, so detaching
  does not turn inherited design choices into toolkit defaults.

The retained toolchain allowlist is `package.json`, `package-lock.json`,
`.timds/installation.json`, `.timds/contract-layout.json`,
`cloudflare.config.ts`, `vite.config.mjs` and `.gitignore`, when present.
Custom plumbing fails closed. Passing check with placeholder tokens, planned
pages and no logo/voice is a skeleton that still needs design and review.

## Designer-declared stock

A parent designer may author `.timds/stock.json` before publishing:

```json
{"schemaVersion":1,"paths":["src/pages/brand/color.html","src/styles/system.css"]}
```

Paths name exact existing regular `src/pages/**/*.html` or
`src/styles/**/*.css` files, `src/layout.html`, or the one copy-data file
`src/copy.json`. Globs, symbolic links,
media, designs and configuration are refused. Check validates this declaration;
the toolkit never infers whether authored content is safe to reuse. The
declaration opts those bodies, styles, layout and copy samples into structure
creation, and in both modes it names the files feed keeps following the parent
while the child leaves them unmodified (see below). Ordinary upgrades never
touch them. Included pages must be self-contained: a link to an omitted design
or asset fails the resulting workspace check. A declared path that is also
plumbing (`src/styles/viewer.css`, `canvas.css`) stays the toolkit's and the
stock pass skips it. A declared `src/layout.html` must carry the stylesheet
links and changelog version chip that starter sync maintains on the parent
too: a later local insertion changes the child's bytes and makes the layout a
graft.

## Feed and grafts

```bash
npm run timds -- feed --version 2026.11.01-1
npm run timds -- feed --from ../parent --ref v2026.11.01-1
```

Feed reads `.timds/parent.json`, requires the same parent system and source
UUID, refuses an older dated or semantic release, and reuses starter sync's
three-way merge. Missing entries are added
(new pages as planned); fields still equal to the old baseline advance.
Changed child fields are grafts and stay. The report says when a graft
shades a new parent change; keeping it is the default. To accept that parent
value, edit the named catalog field and review the result. Reports do not
repeat a conflict after its baseline has advanced.

Only catalogs, verified recorded plumbing, the parent's declared stock and
the two bookkeeping records can change. Tokens, media, designs, Evidence and
every file the parent does not declare are never copied.
Plumbing follows `.timds/starter.json`'s ownership mode: `toolkit` replaces
and reports changes; `recorded` keeps a customized file unless the terminal
prompt approves replacement or `--force scripts/viewer.mjs` names it.
In full mode, customized parent plumbing that no longer matches its recorded
hash is authored source: feed reports and skips it while merging catalogs.
Force cannot copy it. Structure mode continues to require verified plumbing.
`--force` never reaches authored content and refuses a stock path. Commit or
stash uncommitted changes to any file feed will write first.

Declared stock follows the parent by hash. For each path the new release's
`.timds/stock.json` declares, feed compares the child's file with the hash
`.timds/parent.json` recorded when it was last written:

- `updated`: the child's file equals the recorded hash and the parent's bytes
  moved; feed writes the parent's bytes.
- `current`: the child's file equals the recorded hash and the parent is
  unchanged, or it already equals the parent's bytes (the hash advances).
- `created`: the parent newly declares a path the child lacks and never had;
  feed writes it, and the catalog page that fragment renders is no longer
  planned.
- `customized`: a graft. The child changed the file, or removed one it was
  given, which stays absent. Feed never writes a graft and reports it as
  shading the parent's change only when the parent's bytes moved since the
  recorded hash.

To accept the parent's version of a graft, replace the file's content with the
parent's (or restore a removed file) and review it; the next feed records it as
`current`. A successful feed advances the hash of every updated, created or
current file. A kept graft keeps the hash last written for it, so reverting it
to that version makes it stock again; a graft first met with no recorded hash
(the child authored the path before the parent declared it) records the
parent's hash it was offered, so deleting it later keeps it removed. Hashes for paths the parent stopped
declaring are kept, and their files are left alone.

A record without `files`, from a child shot before stock hashes, is adopted on
its first feed. Feed reads the release the record names (its version and
commit) from the same source as the new release: the host, the local Git
parent at the recorded commit for `--from`, or `--baseline-file`. A child file
equal to that release's declared bytes is unmodified stock. The adopted hashes
are written with the first successful feed; without a baseline, feed refuses
before writing anything.

Feed runs check and advances the parent version, commit, catalog baseline and
stock hashes only on success. A failure restores all source files and both
records. The check may regenerate ignored build output. Repeating a feed at
the same release leaves unchanged files reported as `current` in both the
terminal report and `--json` output.

The host's runner feeds a hosted session workspace from the source export it
materialises (the shape the release source route returns):

```bash
TIMDS_HOSTED_RUNNER=1 timds feed --source-file export.json \
  [--baseline-file baseline.json] --json
```

`--source-file` cannot be combined with `--from`, `--version`, `--ref`,
`--source-id` or `--portal-url`, and `--baseline-file` requires it. Without
`TIMDS_HOSTED_RUNNER=1`, feed still refuses a tree carrying
`.timds/session.json`. With `--json`, stdout is one JSON document and progress
goes to stderr. The report carries `files` (every file's status), `site` and
`formats` (catalog changes), `stock` (the declared-stock entries), `grafts`
(`[{path, shades, note, removed?}]`), `adopted`, `written`, `check`, `parent`
(the advanced record with its `files`) and `previousParent`. A failure prints
`{ok:false,error:{code,message}}` and exits nonzero, so a host branches on
`code` rather than the message: `dirty_worktree` (uncommitted changes to files
the feed writes), `check_failed` (the workspace check failed and the feed was
rolled back), `not_offshoot` (no `.timds/parent.json`), `parent_mismatch` (the
source belongs to another parent, is older than the recorded release, disagrees
with its own release identity, or the baseline is not the recorded release),
`baseline_required` (a record shot before stock hashes and no baseline) or
`feed_failed` (anything else). The hosted
feed operation, its reconciler, publication gate and lineage advance, a
proposal flow back to the parent, and moving pages between views are host or
later work, not performed here.

## Records and readers

The host and local shoot write this schema without credentials:

```json
{
  "schemaVersion": 1,
  "systemId": "example/core",
  "sourceId": "11111111-1111-4111-8111-111111111111",
  "version": "2026.10.29-1",
  "commit": "1111111111111111111111111111111111111111",
  "mode": "structure",
  "baseline": {
    "site": {"views": [{"id":"web","label":"Web DS","pages":[{"slug":"","title":"Overview","planned":true}]}]},
    "formats": null
  },
  "files": {
    "src/pages/brand/color.html": "2c26b46b68ffc68ff99b453c1d30413413422d706483bfa0f98a5e886266e7ae"
  }
}
```

The baseline holds the parent's site/formats catalogs. Structure baselines
use sanitized site structure. `files` maps every path the release's
`.timds/stock.json` declared, in both modes, to the SHA-256 of the bytes last
written for it (`{}` when nothing is declared); records without it stay valid
until feed adopts them. A child whose inherited toolkit pin (its
`package-lock.json` entry, else `.timds/installation.json`) predates stock
hashes gets a record without `files`, which that older CLI can read, until it
is upgraded and fed; feed refuses a child whose selected toolkit is older than
the running release, naming the upgrade to run first. Check validates
the file without rewriting it. Sessions may receive/read this record but
cannot create, edit or delete it; `.timds/stock.json` is designer-authored.

The derived index, MCP `describe_system` / `read_derived_layer`, and provenance
carry `lineage:{systemId,sourceId,version,commit,mode}` or `null`. Older
published layers without lineage read as `null`. Public readers do not
receive the source merge baseline or the stock hashes. Publication binds lineage to the committed
source and verifies it in the returned provenance stamp.

## Sever

```bash
npm run timds -- sever         # terminal confirmation
npm run timds -- sever --yes   # explicit noninteractive confirmation
```

Sever removes only `.timds/parent.json`, permanently discarding its feed
baseline. Source remains as it was and the system becomes independent.
Review and commit the deletion. It is unavailable in a hosted session. For a
hosted source, the host catalog must also be severed before publishing; that
catalog operation is a separate host follow-up and is not performed here.
