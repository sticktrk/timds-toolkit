# TimDS Toolkit Agent Notes

This repository owns the public `@dtconcepts/timds` npm package: its CLI,
repository contracts, templates, artifact publisher, Design System editing
skills, and integrated video runtime. Do not split video into another package
or copy rendering, staging, composition registration, or producer runtime code
into client repositories. A generated client-owned snapshot of the visual
Remotion components is source, not copied runtime.

Before committing changes, run:

```bash
npm test
npm run pack:check
```

Keep package releases cohesive. A version must carry compatible CLI behavior,
templates, workflows, and skill instructions together. Update or add tests
whenever managed-file behavior changes.

Client repositories select the bounded `0.1.x` package line, commit the exact
resolved lockfile, and execute `npm run timds --`. They do not vendor package
source. The always-managed repository-local boundary is
`.timds/installation.json`, `.agents/skills/timds-edit-design-system/`,
`.agents/skills/timds-create-video/`, and the legacy `.timds/cli/` tree only
while removing it during migration. Standalone
initialization also owns the stock release workflows and preparation scripts.
Existing standalone repos enter that expanded boundary only through the
explicit `upgrade --auto-release` migration; refuse customized files unless
replacement is forced. Package and lockfile changes select the resolved package
release.

In a consumer (product) repository, the consumer-managed boundary is
`.agents/skills/timds-consume-design-system/`, the
`timds-consumer-preview.yml` and `timds-designer-change.yml` workflows, the
tracked `.claude/launch.json` and `.mcp.json` entries, and `consumer` in
`.timds/installation.json`; `upgrade` there refreshes only that boundary (and,
with `--version`, the root package and lockfile) and never touches
`timds.consumer.json`, other launch entries or MCP servers, or product source.

`consumer scaffold emdash` creates a new EmDash site repository that consumes
a Design System. It runs EmDash's own generator, never a vendored template;
everything it writes beyond the consumer-managed boundary above (the theme,
the token module, public asset symlinks, `timds.consumer.json`,
`DESIGN_SYSTEM.md`) is product source from then on, so no upgrade may touch it.
The site reads the pinned submodule at build time: never copy stylesheets,
tokens, or media out of it. The token module mirrors the starter build's
`--group-name` rule in
`templates/starter/scripts/viewer.mjs`; change the two together.
Public assets stay in the pin and are exposed through relative symlinks in
the site's `public/`; the links and their descendants are protected paths.
Refuse collisions with generated public files instead of replacing them.

`upgrade --version VERSION` selects one exact tested resolution, restores the
bounded requirement, runs `npm ci`, synchronizes adopted managed files with the
selected CLI, and validates the graph and workspace. Explicit `--own-runtime`
adoption lets it align existing React/Remotion declarations in package.json.
Adopted stock automation follows recorded template hashes; customized files
require explicit `--force`. `upgrade --dependency-prs` explicitly adds
`.github/workflows/timds-upgrade.yml` to that boundary. Repository registrations
and credentials stay in repository settings or an external fleet controller.

Never extend upgrades to authored source, `timds.json`, tokens, `media.json`,
framework configuration, documentation, or generated artifacts without an
explicit contract change and migration plan.

`timds defaults --apply` is the explicit migration for shared publishing defaults.
It updates only `publishing.targets` and `publishing.targetDefaults` and records
the supplied values and persistent override paths in `.timds/defaults.json`.
Compare against that baseline to advance unchanged defaults; never clear an
override merely because a later default matches it. Preserve inherited client
publishing policy on adoption. Ordinary `upgrade`
reports pending defaults without applying them. New video scaffolds use the same
source and baseline. Reusable wording and budgets refined in a client system may
be promoted to these defaults; firm names, URLs, and client-only requirements stay
in the client repository. Keep this migration covered by first-adoption,
subsequent-update, override-preservation, and idempotence tests.

The generic video engine may know only the executable schema and deterministic
tooling. Client brand, copy, source authorization, compliance, asset selection,
production records, and output policy belong under that client's Design System
and must never enter this package.

TimDS owns the complete default Remotion component set, the typed partial
override contract, the one-time component snapshot generator, the shared
production rules in `video/footage.mjs` (footage families, natural-speed
chains, headline copy) that the components, the producer, and `video check`
all import, and the `video lab` command that previews a producer compile
request the way an automated Video Lab renders it. A generated snapshot
imports the rules module rather than copying it. Client
Design Systems may generate a complete editable snapshot or implement partial
visual overrides against that contract. Never overwrite a generated snapshot
during `upgrade`; only `video components init --force` intentionally resets it.
Keep component discovery, rendering, composition registration, media
preparation, and other engine behavior here.

New scaffolds use video contract schema 2, select shared board layout presets,
and declare runtime schema,
component API, minimum release, and feature requirements. Snapshot creation
records exact tested runtime versions. `video components migrate` explicitly
inventories recognized declarations, retains supported visual overrides, flags
custom engine logic, and applies only on request. Rollback copies live under
`.timds/component-migration/`; ordinary upgrades never touch them. Unchanged
snapshots become shared re-exports, preserving registration and named exports.
Custom overrides require reviewed exact runtime versions. Shared geometry and
fit limits live in `video/board-layouts.mjs`. Keep packed-release checks with
two brands and before/after visual comparisons in CI.

Never add client-specific content, credentials, private URLs, access tokens,
media, or portal-internal implementation to this public repository or npm
package.

Release tags must exactly match `package.json` as `v<version>`. Keep
`publishConfig.access` public and use the tracked GitHub Actions trusted
publisher workflow rather than a long-lived npm token.
