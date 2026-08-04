# TimDS Toolkit Agent Notes

This repository owns the public `@dtconcepts/timds` npm package: its CLI,
repository contracts, templates, artifact publisher, and Design System editing
skill.

Before committing changes, run:

```bash
npm test
npm run pack:check
```

Keep package releases cohesive. A version must carry compatible CLI behavior,
templates, and skill instructions together. Update or add upgrade tests whenever
managed-file behavior changes.

The upgrade boundary is intentionally limited to `.timds/cli/`,
`.timds/installation.json`, and
`.agents/skills/timds-edit-design-system/`. Never extend it to authored source,
`timds.json`, tokens, `media.json`, framework configuration, or generated
artifacts without an explicit contract change and migration plan.

Never add client-specific content, credentials, private URLs, access tokens,
media, or portal-internal implementation to this public repository or npm
package.

Release tags must exactly match `package.json` as `v<version>`. Keep
`publishConfig.access` public and use the tracked GitHub Actions trusted
publisher workflow rather than a long-lived npm token.
