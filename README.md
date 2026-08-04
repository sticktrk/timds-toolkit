# TimDS Toolkit

`@dtconcepts/timds` is the public, versioned CLI, repository contract, artifact
publisher, and AI editing skill for client-owned TimDS Design Systems.

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
```

Create an embedded root `design-system/` contract in an existing client app:

```bash
npx --yes @dtconcepts/timds@0.1.x init --root /path/to/client-application
cd /path/to/client-application
npm install
npm run timds -- doctor
```

Commit `package.json`, the lockfile, `.agents/skills/`, the Design System
contract, and the TimDS workflow. Do not commit `node_modules`.

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

## Large images, video, audio, and B-roll

Full-resolution originals stay out of Git and `dist/`. With a TimDS access token,
upload the original to managed object storage and commit only its stable
`media.json` catalog entry:

```bash
TIMDS_ACCESS_TOKEN=... npm run timds -- assets add /path/to/interview.mov \
  --rights client-owned \
  --visibility private \
  --title "Founder interview master" \
  --tags interview,b-roll
```

Use `private` for masters and production inputs. Use `public` only for assets
with confirmed rights that are intentionally served from a stable public CDN.
Pull a private original into the ignored local cache with:

```bash
TIMDS_ACCESS_TOKEN=... npm run timds -- assets pull ASSET_ID
```

Never commit tokens, storage credentials, object keys, expiring signed URLs, or
the `.timds/cache/` directory.

## Upgrade a client repository

An operator selects the approved release line. Refresh the package and lockfile first,
then synchronize the repository-local skill and installation record:

```bash
npm install --save-dev @dtconcepts/timds@0.1.x
npm run timds -- upgrade --root .
npm run timds -- doctor
npm run timds -- check
```

`upgrade` removes the legacy `.timds/cli` tree when present. It refuses locally
modified managed files unless `--force` is explicitly supplied and never
rewrites `timds.json`, tokens, media records, authored source, framework config,
documentation, or artifacts.

## Toolkit development and release

```bash
npm test
npm run pack:check
```

Release tags must match `package.json` as `v<version>`. The npm package is
public; this repository remains `UNLICENSED` until DT Concepts selects an
open-source license.
