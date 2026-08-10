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
npm run timds -- check
git add --all
git commit -m "Initialize TimDS design system"
```

Create an embedded root `design-system/` contract in an existing client app:

```bash
npx --yes @dtconcepts/timds@0.1.x init --root /path/to/client-application
cd /path/to/client-application
npm install
npm run timds -- doctor
npm run timds -- check
```

New contracts include a small authored viewer, deterministic build/check/dev
scripts, starter tokens, and a validated initial artifact. The initializer also
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

## Machine-readable artifacts

A design system is read by agents and downstream pipelines as well as by people.
`check` and `extract` derive that view from the built artifact, so no design
system has to maintain a parallel hand-written JSON file:

```bash
npm run timds -- extract
```

Beside the published pages this writes `index.json` (the structured tree, with
assets joined to their media records), `llms.txt` (the page index), and an
`index.md` Markdown mirror of every page. Every record carries a stable id such
as `social/shorts#safe-zones/bottom-band`, so an agent can cite a rule and a
reviewer can resolve the citation.

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
to `media.json`. The raw file and `.timds/local-media.json` remain ignored.
If an object transfer fails, the CLI reports the bounded storage response and
cancels the server upload lease before returning the error, so correcting the
problem and rerunning `assets publish` does not wait for a stale lock to expire.
`TIMDS_ACCESS_TOKEN` can be used for non-interactive CI or agent sessions.

To restore a published asset into a fresh local workspace:

```bash
npm run timds -- assets pull founder-interview
```

Never commit tokens, storage credentials, object keys, expiring signed URLs,
`.timds/local-media.json`, or anything except the README under `media-local/`.

## Upgrade a client repository

An operator selects the approved release line. Keep the manifest on `0.1.x`,
refresh its resolved lockfile version, and then synchronize the repository-local
skill and installation record:

```bash
npm update @dtconcepts/timds
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
