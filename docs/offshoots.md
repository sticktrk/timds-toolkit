# Offshoots and parent stock

An offshoot starts from one immutable parent release and keeps a structural
feed baseline. A starter is a seed: its structure comes from the toolkit.
An offshoot's structure comes from its parent; ordinary toolkit upgrades keep
its plumbing current without adding the starter's pages or changing ancestry.

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
manifest version. The new system needs its own URL-safe system ID.

Shoot requires a new or empty destination, initializes its own Git repository,
sets its provider to `local`, and runs the workspace check. Failure removes
the new tree, restoring an initially empty directory. No dependencies or
runtime are copied from the parent's working directory. For a full parent with
a custom build toolchain, the CLI runs its declared `workspace.install`, or
`npm ci` against its exact lockfile when it has package dependencies, before
checking. Custom tools retain their external prerequisites. The stock starter
builds without installing dependencies.

## Full and structure

Full copies every exported source layer, including authored content, before
setting the new identity and immediate parent record. Local Git export refuses
secrets, generated directories and submodules rather than importing them.

Structure follows the host's transform revision 1:

- `.timds/starter.json` must have `plumbing:"toolkit"` and hashes matching
  the parent's build, check, dev and viewer scripts. Only recorded
  `scripts/*.mjs`, `src/styles/viewer.css` and `canvas.css` are plumbing.
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
  `build:preview` scripts; exact lockfile resolutions remain. Installation
  metadata selects the recorded toolkit release. `timds.json` keeps the
  artifact contract and brand roles, selects the verified standalone workspace
  scripts, and bundles `dist/tokens.css` and `dist/styles/system.css`.

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
`src/styles/**/*.css` files, or `src/layout.html`. Globs, symbolic links,
media, designs and configuration are refused. Check validates this declaration;
the toolkit never infers whether authored content is safe to reuse. The
declaration opts those bodies/styles into structure creation only. Included
pages must be self-contained: a link to an omitted design or asset fails the
resulting workspace check. Feed never refreshes these authored files.

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

Only catalogs, verified recorded plumbing and the two bookkeeping records
can change. Authored fragments, layout, styles, tokens, media and designs
are never refreshed, including files initially included as parent stock.
Plumbing follows `.timds/starter.json`'s ownership mode: `toolkit` replaces
and reports changes; `recorded` keeps a customized file unless the terminal
prompt approves replacement or `--force scripts/viewer.mjs` names it.
In full mode, customized parent plumbing that no longer matches its recorded
hash is authored source: feed reports and skips it while merging catalogs.
Force cannot copy it. Structure mode continues to require verified plumbing.
`--force` never reaches authored content. Commit or stash uncommitted changes
to any file feed will write first.

Feed runs check and advances the parent version, commit and catalog baseline
only on success. A failure restores all source files and both records. The
check may regenerate ignored build output. Feeding is unavailable inside a
hosted session; a hosted Request to do this remains host follow-up work.

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
  }
}
```

The baseline holds the parent's site/formats catalogs. Structure baselines
use sanitized site structure. Check validates
the file without rewriting it. Sessions may receive/read this record but
cannot create, edit or delete it; `.timds/stock.json` is designer-authored.

The derived index, MCP `describe_system` / `read_derived_layer`, and provenance
carry `lineage:{systemId,sourceId,version,commit,mode}` or `null`. Older
published layers without lineage read as `null`. Public readers do not
receive the source merge baseline. Publication binds lineage to the committed
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
