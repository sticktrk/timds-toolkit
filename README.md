# TimDS Toolkit

`@dtconcepts/timds` is the versioned CLI, contract toolkit, and AI editing skill
for repository-owned TimDS Design Systems. A client repository receives a
vendored snapshot under `.timds/cli/`, so its local workflow keeps working
without a global install or registry access after initialization.

Initialize a preferred standalone Design System repository:

```bash
npx --yes @dtconcepts/timds@0.1.0 init --standalone --root /path/to/client-design-system
```

Initialize an embedded contract in an existing client application repository:

```bash
npx --yes @dtconcepts/timds@0.1.0 init --root /path/to/client-application
```

The initializer installs the CLI and `timds-edit-design-system` skill into the
target repository without overwriting authored Design System files.

Upgrade only the package-managed CLI and skill with an explicitly selected
version:

```bash
npx --yes @dtconcepts/timds@0.2.0 upgrade --root /path/to/client-design-system
```

Upgrade refuses locally modified managed tooling unless `--force` is supplied.
It does not rewrite `timds.json`, tokens, media records, source, framework
configuration, documentation, or generated artifacts. Review and commit the
result like any other repository change. Portal sync never upgrades a client
repository.

## Local development

```bash
npm test
npm run pack:check
```

Releases use the version in `package.json` and a matching GitHub Release tag,
such as `v0.1.0`. The npm package is public; this repository currently remains
`UNLICENSED` until DT Concepts selects an open-source license.
