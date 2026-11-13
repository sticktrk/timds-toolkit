# Upgrading a client repository in depth

The upgrade commands are in the [README](../README.md#upgrade-a-client-repository).

Agents run the repository's selected release: `npm run timds --` in an npm
client, or `timds-cli` when `.timds/installation.json` selects binary mode.
Read `doctor --json` and `starter status --json` before choosing a migration.
Use plain `upgrade` to synchronize the selected release; `upgrade --version`
is the explicit release-selection operation. Binary selection requires the
exact version of the verified running executable, never `0.1.x` or `latest`;
see [binary installation](binary-installation.md).

## Write boundary

Upgrade refreshes the managed skills, installation record, adopted automation
and starter boundary. It creates `.claude/skills -> ../.agents/skills` only
when nothing exists there. Starter plumbing recorded as `"toolkit"` returns
to stock on every sync, with local replacements reported. In `"recorded"`
mode, only unchanged stock bytes advance automatically: a customized script
or stylesheet is kept until a terminal decision or `starter sync --force PATH`
explicitly replaces that file. `upgrade --force` does not extend into starter
files. Customized overview fragments remain authored under either mode.
Catalogs use their recorded three-way merge, and the layout only gains missing
stock stylesheet links. An offshoot keeps its parent's catalog baselines and
stock; toolkit sync updates its plumbing and missing layout links only.

There is one explicit authored-contract migration: initialization and upgrade
split aggregate tokens and media into `tokens/*.json` and `media/*.json` key
maps and record `.timds/contract-layout.json`. Those maps become authored;
later upgrades never replace them. Root `tokens.json` and `media.json` remain
generated compatibility views. Conflicting existing maps are refused; invalid
group references leave the aggregate layout in place with a diagnostic. Edit
the maps once the record exists, not the generated views. Checks may rebuild
the generated artifact in `dist/`; that does not grant upgrade permission to
rewrite authored pages, styles, documentation, components or `timds.json`.

Consumer repositories have their own smaller boundary: the two consumer
skills, preview/designer-change workflows, TimDS launch and MCP entries, and
the installation record. Upgrade retains the product manifest, Design System
pin, other launch/MCP entries and product source. `--version` also selects the
toolkit dependency and exact lockfile; it does not select a Design System
release.

A workspace site (`site/timds.consumer.json` with `designSystem.workspace:
true`) is product source inside a Design System, not a pinned consumer
installation. Run upgrades at the Design System root: they never touch
`site/`, its two root consumer skills, or the scaffolded site section in
`AGENTS.md`. Those extra files are recorded in `site/.timds/emdash.json` and
remain outside the managed release metadata. An upgrade run inside the site
refuses and names the workspace root. Template updates currently require a
reviewed manual change; see [EmDash sites](emdash.md#the-record).

## Machine-readable upgrade results

For a parser, invoke `npm --silent run timds -- upgrade --json` (or
`timds-cli upgrade --json`) and capture stdout separately from stderr. The
`--silent` npm option suppresses its script banner. Check the process exit
status and `ok`; do not interpret progress text as a result.

`upgrade --json` prints one JSON object on stdout and nothing else (progress
goes to stderr) for a host job or script that runs the upgrade: the previous
and selected toolkit versions, whether a `--version` selection ran, the
managed files written and the release automation files updated, the starter
sync (the files written, current, and customized, the catalog views, pages,
and formats it merged, and which customized files `starter sync --force` may
replace), the publishing defaults available, the designs setup state, and the
check the upgrade ran itself, plus `contractMigration: { migrated, reason? }`.
The `check` field is null when that invocation ran no check; run `check`
explicitly before delivery rather than treating `ok` as a build receipt.
A committed customization of a recorded starter file is
not a failure: the file is kept, listed under `starter.customized` (and
`starter.replaceable` when `starter sync --force` may replace it), and the
result is still `"ok": true`. The `starter` object also carries the starter
status described below (`level`, `current`, `floor`, `belowFloor`, `behind`,
`pending`, `declined`, `conflicts`), the files the sync left at stock as
`currentFiles`, files a starter step removed as `removed`, and the steps it ran
as `levels`. A refused or failed upgrade exits non-zero and
still prints `{ "ok": false, "error": { "code": "...", "message": "..." } }`,
with `error.step` naming the command a `--version` selection stopped at. The
codes a host job can branch on:

| `error.code` | Meaning |
| --- | --- |
| `below_floor` | The system is starter-based and predates starter levels (no `.timds/starter.json`, or one without `level` or below the floor). Nothing was written; regenerate it from the current starter. |
| `managed_file_conflict` | A managed file (skill, installation record, starter record) is locally modified; commit or restore it, or rerun with `--force`. |
| `dirty_worktree` | Uncommitted changes to files the starter sync writes, or (for a selection) any uncommitted change. |
| `unsupported_requirement` | The `@dtconcepts/timds` requirement, `scripts.timds`, the requested version, or the lockfile is not in the form a selection needs. |
| `install_failed` | `npm install`, `npm dedupe`, or `npm ci` failed during a selection. |
| `dependency_check_failed` | `timds dependencies check` failed after the selection installed. |
| `check_failed` | The post-upgrade check failed: the starter sync was rolled back, or `timds check` or `check:timds-upgrade` failed after a selection. |
| `upgrade_failed` | Anything else, including the selected release's own `upgrade` failing without a code of its own. |

The prose output is unchanged without the flag, apart from the starter
status lines it ends with.

## Starter levels

A system can be on the newest toolkit and behind the starter. Upgrade keeps
code current; the starter level says how far the system's own defaults have
moved with it. `.timds/starter.json` records `level` and `declined` (the ids
of steps settled by decision). The toolkit declares the level a fresh
scaffold starts at and `floor`, the oldest level it supports. This release is
level 1, floor 1, with no steps.

A starter-based system whose record is missing, has no `level`, or has one
below the floor predates starter levels. `upgrade` (including `--version`),
`starter sync`, `starter migrate` and `feed` (child or parent) refuse it with
`below_floor` before writing anything, and `shoot` refuses such a parent.
`check`, `doctor` and `starter status` only report it (`belowFloor: true`): it
still builds with what it has and stays editable until it is regenerated from
the current starter. Nothing in the toolkit migrates or recognizes an earlier
shape.

Each level above the floor is one numbered step, declared as data in the
release metadata (`describeToolkitRelease().starterSteps`, see
[release metadata](release-metadata.md#starter-steps)) and applied by one
interpreter (`src/starter-steps.mjs`). Steps above the recorded level are
evaluated in order on the tree as it stands after the sync and the earlier
steps:

1. A step for another starter kind (`starters`) or layer, or one whose
   requirements do not hold, does not apply: it settles with nothing written
   (`skipped`). An offshoot (`.timds/parent.json`) takes `code` steps only;
   its structure comes from its parent through `feed`.
2. Otherwise its effective operations are a `remove-file` whose file exists
   and a field move whose current value is in `from` (`null` meaning absent).
   A field holding any other value is the system's own: kept and reported.
3. A `remove-file` whose file exists with bytes no listed hash matches is a
   conflict. The level stops there.
4. With no effective operation the step settles (`applied`, nothing changed).
5. With effective operations a step that is not visible applies them.
6. With effective operations a visible step needs a decision: `timds starter
   migrate --accept ID` applies it, `--decline ID` (declinable steps only)
   records it in `declined` and settles it, and otherwise the level stops
   there and the step is pending.

`upgrade` and `starter sync` run the same steps and never accept, so they
never apply a visible step with something to change; they do settle one that
does not apply or has nothing to change. A step's writes are part of the
sync, so a failed check rolls them back with everything else.

```bash
npm run timds -- starter status [--json]                 # level, floor, pending, declined, conflicts
npm run timds -- starter migrate --accept ID [--json]    # apply a visible step
npm run timds -- starter migrate --decline ID            # settle it by decision
```

`starter status --json`, the `starter` section of `doctor --json` and the
upgrade report carry the same status, here for a system one visible step
behind a later release:

```json
{
  "starter": "starter", "plumbing": "toolkit",
  "level": 1, "current": 2, "floor": 1, "belowFloor": false, "behind": 1,
  "pending": [{ "level": 2, "id": "example-step", "visible": true, "declinable": true }],
  "declined": [],
  "conflicts": []
}
```

`pending` lists the steps above the recorded level that apply to this kind of
system and are not declined. A conflict is `{ step, path, reason }`. `check`
warns, without failing, below the floor, on what a sync would settle, on a
visible step waiting for a decision, on conflicts, and on a view labelled like
an entry the viewer adds to the app bar itself (`Designs`).

The renderer is the package's: `scripts/build.mjs`, `check.mjs` and `dev.mjs`
are stubs that call `@dtconcepts/timds/viewer`. A system that needs an extra
build step declares it in `timds.json` as `workspace.after.build` (argv
arrays, run in order from the design-system root after every stock build,
failing it on a non-zero exit) rather than editing the build stub.

## A workspace site

A Design System may hold its own EmDash site in `site/`
(`consumer scaffold emdash --workspace`, see [EmDash sites](emdash.md#a-site-in-its-design-systems-workspace)).
`upgrade` at the workspace root is the system's own upgrade with the same
result and records as without the site: it never writes into `site/`, and it
neither writes nor reports the two consumer skills or the `AGENTS.md`
section the scaffold added beside the system's guidance, which sit outside
the managed set. `timds upgrade` inside `site/` refuses and names the
workspace root; the site has no toolkit of its own.

## One dependency selection

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
resolution. The command does not merge or deploy. With `--json`, the selection
asks the selected release's CLI for its own `upgrade --json` document and
returns it as `upgrade` (null when that release prints prose), beside the
versions and the list of checks that ran.

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

## Explicit component consolidation

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

## Consumer and runtime compatibility

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

## Opt-in dependency PR automation

```bash
npm run timds -- upgrade --dependency-prs
```

This adopts a weekly and manually dispatched workflow in the current repository.
Configure `TIMDS_UPGRADE_TOKEN` in repository settings with contents and pull
request permissions (a GitHub App credential is preferred), and configure
`check:timds-upgrade` for project-specific render checks. The workflow selects and
tests one locked release, opens or refreshes a draft dependency PR, and reports
the failing check when adoption fails. It refuses to include authored changes.
Review, merging, runtime deployment, and consumer deployment are separate
operations.

## Shared defaults across existing Design Systems

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
merge-to-release automation explicitly:

```bash
npm run timds -- upgrade --root . --auto-release
```

The migration replaces only recognized stock release files, adds the release
preparation test, and records `merge-patch-v1` in `.timds/installation.json`.
It stops when release automation was customized; inspect that customization and
use `--auto-release --force` only when replacing it is intentional.
