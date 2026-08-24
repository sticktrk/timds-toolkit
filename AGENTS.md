# TimDS Toolkit Agent Notes

This repository owns the public `@dtconcepts/timds` npm package: its CLI,
repository contracts, templates, artifact publisher, Design System editing
skills, and integrated video runtime. Do not split video into another package
or copy runtime code into client repositories.

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

Never extend upgrades to authored source, `timds.json`, tokens, `media.json`,
framework configuration, documentation, or generated artifacts without an
explicit contract change and migration plan.

The generic video engine may know only the executable schema and deterministic
tooling. Client brand, copy, source authorization, compliance, asset selection,
production records, and output policy belong under that client's Design System
and must never enter this package.

Never add client-specific content, credentials, private URLs, access tokens,
media, or portal-internal implementation to this public repository or npm
package.

Release tags must exactly match `package.json` as `v<version>`. Keep
`publishConfig.access` public and use the tracked GitHub Actions trusted
publisher workflow rather than a long-lived npm token.
