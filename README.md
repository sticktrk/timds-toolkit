# TimDS Toolkit

`@dtconcepts/timds` is the public, versioned CLI, repository contract, artifact
publisher, AI editing skills, and contract-driven video engine for client-owned
TimDS Design Systems. Video is part of this package; there is no companion
runtime package for clients to install or copy.

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

To link a standalone Design System to a repository that consumes it as a
submodule, declare the consumer during initialization:

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
to the consumer. Every accepted change on `main` becomes a patch release: TimDS
synchronizes the version, publishes that exact commit, then opens or refreshes
a gitlink-update pull request in the consumer. This flow pins the commit SHA and
does not depend on a release tag.

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
to `media.json`. Timed media is inspected with `ffprobe` during `assets add`, so
video and audio records also carry their measured duration; video records carry
dimensions, frame rate, and codec when available. The raw file and
`.timds/local-media.json` remain ignored.
If an object transfer fails, the CLI reports the bounded storage response and
cancels the server upload lease before returning the error, so correcting the
problem and rerunning `assets publish` does not wait for a stale lock to expire.
`TIMDS_ACCESS_TOKEN` can be used for non-interactive CI or agent sessions.

Catalogs created before timed metadata was supported can be repaired in place
from their stable public URLs without re-uploading the objects:

```bash
npm run timds -- assets backfill-metadata
```

Both commands require `ffprobe` from FFmpeg on the workstation. Set
`FFPROBE_PATH` only when it is installed outside the normal command path.

To restore a published asset into a fresh local workspace:

```bash
npm run timds -- assets pull founder-interview
```

Never commit tokens, storage credentials, object keys, expiring signed URLs,
`.timds/local-media.json`, or anything except the README under `media-local/`.

## Contract-driven video

A client can opt its Design System into the TimDS video runtime:

```bash
npm run timds -- video init
npm run timds -- video doctor
```

The opt-in creates `video/contract.json`, `video/assets.json`, and
`video/productions/`, and declares their paths in `timds.json`. The client
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
The compiler rejects over-limit summaries and engagement questions; it never
truncates model copy into a fragment to make it fit.

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
`Scene`, `Intro`, `Outro`, `Cover`,
`HorizontalCover`, and `VerticalCover` are independently replaceable; omitted
components continue to use TimDS defaults, and format-specific covers take
precedence over the shared `Cover` override. This keeps rendering mechanics in
TimDS while allowing a reviewed client Design System to own its visual
compositions.

The default cover set includes separate horizontal and reel layouts. A cover's
explicit `objectPosition` wins, followed by its prepared asset position; the
reel fallback keeps right-biased portrait subjects in the upper photographic
region. The horizontal cover scales its 1280×720 design grid to the declared
export size, and both layouts adapt the headline to its available box. Both
retain a visible, non-breaking separator before a highlighted final word,
including with subsetted or variable client fonts.

Each production is a directory with five reviewable phase records:
`request.json`, `script.json`, `publishing.json`, `captions.json`, and
`production.json`. There is no per-topic TSX entry and no client-owned copy of
the engine; an optional client-owned component snapshot contains only visual
compositions. The generic workflow is:

```bash
npm run timds -- video voiceover TOPIC
npm run timds -- video check TOPIC
npm run timds -- video prepare TOPIC
npm run timds -- video studio TOPIC
npm run timds -- video render TOPIC
```

Prepared media, generated audio, Remotion entry files, and review packages live
under ignored `video-local/`. Registered source media remains governed by the
normal TimDS media catalog. The committed production records refer only to
client-declared logical asset keys; render-time media is always played at its
natural speed, and a scene fails when its approved footage chain is too short.

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

`upgrade` removes the legacy `.timds/cli` tree when present and synchronizes
both managed skills. It refuses locally modified managed files unless `--force`
is explicitly supplied and never
rewrites `timds.json`, tokens, media records, authored source, framework config,
documentation, or artifacts.

Standalone repositories created by older TimDS releases can adopt the managed
merge-to-patch automation explicitly:

```bash
npm run timds -- upgrade --root . --auto-release
```

The migration replaces only recognized stock release files, adds the release
preparation test, and records `merge-patch-v1` in `.timds/installation.json`.
It stops when release automation was customized; inspect that customization and
use `--auto-release --force` only when replacing it is intentional.

## Toolkit development and release

```bash
npm test
npm run pack:check
```

Cut a release from a clean `master`:

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

Release tags must match `package.json` as `v<version>`. The npm package is
public; this repository remains `UNLICENSED` until DT Concepts selects an
open-source license.
