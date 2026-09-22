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
Staging records the current catalog checksum locally. Publishing (including
`submit`) checks every staged entry before uploading and refuses replacements
if the catalog has changed since staging. Older staging entries without a
baseline may still publish new keys or match unchanged records, but cannot
replace existing records until deliberately restaged. To keep the published
asset, remove its stale entry from `.timds/local-media.json` or restore it with
`assets pull KEY --force`. Run `assets add FILE --key KEY` again only after
reviewing the intended replacement; do not restage an original over an
optimized derivative just to clear a conflict. Successful publication advances
the local baseline, so reverting `media.json` does not replay the old upload.
If storage returns an asset ID already registered under another logical key,
publication refuses that catalog write and preserves both keys. Use the
existing key instead of implicitly renaming it.

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

The engine, the producer, and `timds video check` share one set of production
rules from `@dtconcepts/timds/video/footage`: consecutive footage picks must
come from different footage families (offset, mirrored, and vertical
derivatives are one family; intro and outro cards break the sequence), a chain
must cover its scene at natural speed with the last clip holding at least two
seconds, a still (`kind: "image"`) is held under the same push-in as a clip, and
a scene headline must be a complete thought — a dangling article, conjunction,
or possessive fails the check. A client snapshot imports that module rather
than copying it, so a toolkit fix reaches the client's frames without a reset.

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

Outros are rarely watched — least of all in vertical Shorts — so the default
components keep a call to action on every frame when the contract asks for one.
`brand.banners.longform` renders as a pill top-right of horizontal frames (for
example "Subscribe for more"); `brand.banners.short` renders a kicker and URL
under the logo on vertical frames, with the right edge left clear for the
Shorts UI. Vertical frames never place two labels on the bottom baseline, so a
long `watermark.right` cannot collide with `watermark.left`. The producer's
`outro.narrationTemplates.short` may shorten the spoken close for Shorts, and
`publishing.shortDisclaimer` / `publishing.shortArticleLink: false` keep a
Short's packaged description brief while the long-form keeps the full text. A
Short with its own `description` in `publishing.json` uses it instead of the
long-form hook and answer. The video template now requires the question intro
card in both formats, matching what the producer always emits.

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

### Brand files every render host can reach

The contract's brand files are `brand.logo`, `brand.fontFiles[].path`, and the
optional sound design `brand.audio.bed` and `brand.audio.transition`. Each
must be one of the two sources every render host has:

- a path to a file committed in the Design System, such as
  `"public/brand/logo.png"`; or
- a published TimDS media record, `{ "mediaKey": "brand-music-bed" }`, whose
  `media.json` entry has a stable `publicUrl`. Use this for audio and anything
  else too large or of a format the repository does not commit.

```json
"audio": {
  "bed": { "mediaKey": "brand-music-bed" },
  "transition": { "mediaKey": "brand-transition" },
  "voiceGain": 1, "restVolume": 1, "duckVolume": 0.3,
  "attackFrames": 6, "releaseFrames": 20
}
```

`video check` fails when a brand file is missing, is ignored by git, sits under
the ignored `video-local/` directory, or names a media key that is not
published. A file that exists only on the machine that generated it renders
locally and 404s on every other host, so it is refused before merge rather
than discovered in production. Staging never drops a declared file: the lab,
`video render`, and silent previews fail with the contract field that names it.

Render hosts (the lab, `video render`, and automated Video Lab servers) stage
brand files through one exported function and check the finished project
before Remotion starts:

```js
import { assertVideoProjectStaged, stageVideoBrand } from "@dtconcepts/timds/video";

const brand = await stageVideoBrand({ designSystemRoot, contract, publicRoot, mediaCatalog, cacheRoot });
const project = { ...rest, contract: { ...contract, brand } };
await assertVideoProjectStaged(project, publicRoot); // names every missing staticFile() before rendering
```

`stageVideoBrand` validates the sources, copies committed files, downloads
published media (cached by SHA-256 under `cacheRoot` when given), and returns
the brand with runtime paths. `assertVideoProjectStaged` lists every file the
components request, including the logo, fonts, sound design, footage, cover,
and narration, and fails with each missing file's project field.

Prepared media, generated audio, Remotion entry files, and review packages live
under ignored `video-local/`. Registered source media remains governed by the
normal TimDS media catalog. The committed production records refer only to
client-declared logical asset keys; render-time media is always played at its
natural speed, and a scene fails when its approved footage chain is too short.

### The video lab

`video init` also scaffolds `video/lab/`: compile requests for the client's
`producer` block, which the template contract now carries with generic role
labels and CTA templates. A lab input is what an automated Video Lab hands
`compileProduction()` after a model writes to the authoring contract, and the
lab takes it the rest of the way exactly as a render host does — compile,
spoken narration and measured word timings, footage (each beat's own picks first, then the
deterministic fill) and cover, staged brand files
and published media, `createSingleVideoProjectRoot` with the client's
components — then opens Remotion Studio on the result so the Design System
editor sees the frames the lab will ship.

```bash
npm run timds -- video lab                 # first input under video/lab/, in the studio
npm run timds -- video lab NAME            # video/lab/NAME.json
npm run timds -- video lab NAME --plan     # compile + finalize; print the plan, no staging
npm run timds -- video lab NAME --prepare  # stage media and write the entry only
npm run timds -- video lab NAME --render   # TimDSVideo + TimDSCover to video-local/lab/NAME/out/
npm run timds -- video lab --list          # lab inputs and ready productions
```

The lab also ships as a small local web app, the toolkit's standardized copy of
the LawBoost Video Lab flow, so a Design System editor can test-generate a
video without touching Remotion:

```bash
npm run timds -- video lab --serve            # http://127.0.0.1:4410/
npm run timds -- video lab --serve --port 4500
```

Describe the source (the exact question, a topic label, notes or an article
excerpt), let Claude draft the compile request against this Design System's
authoring contract — the same prompt, brief, and JSON Schema
`createVideoAuthoringContract()` hands an automated Video Lab, including the
footage catalog (every eligible clip's key, published title, tags, and
duration) so the draft names one to three clips per beat — or paste one, edit
the answer beats and their footage keys, check the compiled plan (scenes,
estimated timings, footage chain, cover), save it under `video/lab/`, and
render. A beat's picks open its scene in order; the compiler fills any
remaining time from the clips the production has played least, ranked by how
many words their title and tags share with the narration, and still refuses a
family back to back. Rendering runs
headless through the same path as `video lab NAME --render` and the page hands
back the MP4 and thumbnail. Drafting uses `claude-opus-5` with the Anthropic
SDK's own credential lookup (`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, or an
`ant auth login` profile); without credentials the draft button is off and
everything else still works. The server binds to `127.0.0.1` only. When the
producer selects prompt blocks, run `timds check` first so the built
`dist/…/index.json` can resolve them; a producer with no blocks needs no index.

Renders include spoken narration by default. The browser offers an explicit
**Silent preview** option, also available as `--silent` on the CLI. Planning
and checks use estimated reading times without calling a speech service;
preparation and rendering generate each scene's narration with Edge TTS,
then finalize footage and captions using the measured word timings. A speech
failure stops the render instead of returning a silent video.

Use Python with `edge-tts` installed. TimDS selects `--python`, then
`TIMDS_PYTHON`, then the client's `.venv-tts` Python if present, then `python3`.
The default voice is `en-US-AriaNeural`; override it with `--voice` or declare
`voiceover: { "voice": "en-US-AriaNeural", "rate": "+0%", "pitch": "+0Hz" }`
in `video/contract.json`. Generated takes stay under ignored
`video-local/lab/NAME/voiceover/`, keyed by the exact script, voice settings,
and generator. Edits get new audio and timings; incomplete caches regenerate.
Authored production scripts and locked takes remain untouched.

Shorts use each master's published `vertical` derivative by default. A client
can set `producer.footage.allowShortCrop: true` to use the published master
when no derivative is linked **and** that master has a reviewed crop in the
registry configured by `timds.json → video.verticalMetadata`. The video component
uses that record's `objectPosition` and vertical `text` zone; a horizontal
`subject` label or a default center crop is insufficient. Explicit derivatives
still take precedence, and footage duration and family rules still apply.
Each Short scene uses clips with one compatible vertical text zone, keeping
its headline in the reviewed position throughout the chain. If the preferred
zone cannot cover the scene, the producer tries the other zone before failing.
Horizontal renders retain their original framing and text layout.

New `video init` scaffolds include `video/vertical-meta.json` and enable its
catalog gate. `video check` (and workspace loading before rendering) requires
every footage master under `producer.footage.assetPrefix` to have a valid
record tied to its published SHA-256, with a crop position, vertical text zone,
and first/middle/last-frame review. This checks the records, not the visual
correctness of a crop or automatic object detection. The designer must inspect
the subject throughout the clip. Existing catalogs opt in by adding the
manifest path and completing their records; ordinary upgrades do not migrate
authored metadata. The normal `timds check`/submission checks include this video
gate too. See the [B-roll crop authoring contract](skills/timds-create-video/references/vertical-crops.md)
for the schema and adoption procedure. Programmatic callers pass the same
registry as `verticalMetadata` to `createVideoProducer`.

Preparing or rendering downloads assets from their `media.json` public URLs
when no usable local media file exists, including stale or empty cache entries.
Cached published media must match the catalog's byte count and SHA-256; a
different local clip under the same media key is downloaded again before staging.
No manual asset pull or cloud login is required for published media.

`video check` compiles every lab input and warns when the registered catalog
cannot finalize one yet, so a new system can commit the sample before it has
registered footage under the producer's `footage.assetPrefix` keys and a cover
library under its `cover.assetPrefix` keys.

## Upgrade a client repository

An operator selects the approved release line. Keep the manifest on `0.1.x`,
refresh its resolved lockfile version, and then synchronize the repository-local
skill and installation record:

```bash
npm update @dtconcepts/timds
npm run timds -- upgrade --root .
npm run timds -- defaults
npm run timds -- defaults --apply
npm run timds -- doctor
npm run timds -- check
```

`upgrade` removes the legacy `.timds/cli` tree when present and synchronizes
both managed skills. It refuses locally modified managed files unless `--force`
is explicitly supplied and never
rewrites `timds.json`, tokens, media records, authored source, framework config,
documentation, or artifacts.

### Shared defaults across existing Design Systems

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

To release the latest `master` from GitHub, open
[Actions → Publish npm package](https://github.com/dtconceptsnc/timds-toolkit/actions/workflows/release.yml),
click **Run workflow**, leave the branch set to **master**, and click **Run workflow**
again. No version input is needed: the workflow checks out the latest `master`,
runs the checks above, bumps the patch version in `package.json` and the lockfile,
pushes the release commit and matching tag, creates a GitHub Release with generated
notes, and publishes to npm. Release runs are serialized. If `master` changes
during validation, the push fails without publishing a stale release; start a new
run against the updated branch.

The workflow uses the built-in GitHub token to create the release and the existing
npm trusted publisher for `release.yml` to publish. No additional secret is needed.
If npm publishing fails after the release was created, use **Re-run failed jobs**
to retry publishing the same version. **Run workflow** or **Re-run all jobs** creates
another patch release.

You can also cut a release locally from a clean, synced `master`:

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
