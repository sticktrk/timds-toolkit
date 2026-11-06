---
name: timds-create-video
description: Create, validate, preview, or render videos and register B-roll with reviewed vertical crop metadata in a client-owned TimDS video contract. Use for video, B-roll, explainer, short, thumbnail, voiceover, or review-package work in a Design System whose timds.json enables video.
---

# Create a TimDS Video

Use the client Design System as the complete production workspace. TimDS owns
the engine and commands; the repository owns all client-specific creative,
content, media, compliance, and publishing decisions.

## Installation mode

Read `.timds/installation.json` before installing tools. With `mode: "binary"`,
use `timds-cli` at its exact `version` in place of `npm run timds --`; skip npm
installation and npm dependency-upgrade steps for the stock system. Check
`timds-cli --version` and `timds-cli doctor`. Select another executable release
only through `timds-cli upgrade --version EXACT_VERSION`. Existing npm mode
keeps its bounded requirement and committed lockfile. Custom product tools
retain their declared prerequisites. The agent runs these steps for the designer.

## Resolve the contract

1. Read the repository instructions and preserve existing work.
2. Locate `timds.json` and confirm it declares `video`.
3. Read the declared video contract, asset catalog, `video.verticalMetadata`
   registry when configured, optional `video.components`
   module, relevant production files, and the Design System pages they cite.
   `timds.json` `video` names them (`contract`, `assets`, `boards`,
   `productions`, `lab`, `local`; defaults `video/…` and `video-local`).
   Do not substitute remembered rules for the repository's current executable
   contract.
4. Run `npm run timds -- video doctor` before authoring. It is the same check
   as `video check`: every production and every lab input is compiled and
   validated, so a broken lab input fails it too.
5. Keep `brand.colors` and `brand.fonts` as references to the Design System's
   derived tokens (`"{color.accent}"` for a brand role, `"{--navy-900}"` for a
   token) rather than copied values; `timds check` reports literals that
   duplicate a token. The scaffold ships literal colors and font stacks, so
   replace them with references once the system's tokens exist; a role
   reference needs that role mapped in `timds.json` `brand.roles`.
   References resolve from the built artifact; checks,
   lab planning, and compiling work without it, but a lab or production
   prepare, studio, and render need `timds check` to have built it.

Prerequisites outside the toolkit: Python with the `edge-tts` module for
narration, `ffprobe` (ffmpeg, or `FFPROBE_PATH`) to register video and audio,
and headless Chrome for Remotion, downloaded on first use into a per-user
cache (`TIMDS_BROWSER_CACHE` moves it; `TIMDS_BROWSER_EXECUTABLE` names an
installed browser instead, for offline or binary-mode hosts). A missing
external tool fails the command that needs it with its name.

If video is not enabled, report that `npm run timds -- video init` is required.
Do not initialize or migrate the repository unless the user asked for that
structural change.

When the user asks the Design System to take ownership of the current TimDS
visual defaults, run `npm run timds -- video components init`. Treat the
generated module as authored client source from that point forward. Never
regenerate it during a normal toolkit upgrade, and use `--force` only when the
user explicitly requests a reset that discards client component changes.

Shared components are the normal path. Prefer `video/boards.json` `layoutPreset`
(`standard` or `compact`) and typed partial visual overrides. The shared presets
enforce the same geometry and item limits in compilation and rendering; cards,
steps, and flow allow at most three items vertically or over footage. Read the
effective budgets with `resolveBoardKind`; never bypass them by editing snapshots.
Keep brand tokens, copy, assets, and client policy in the Design System.

For explicitly requested consolidation, preview `video components migrate`,
review its inventory, then use `--apply`. Recognized defaults become shared
imports; supported visual changes remain typed overrides. Custom registration,
imports/exports, and scene/video logic require manual review. Check horizontal and
vertical frames both full frame and over footage, then commit the migration
separately. `.timds/component-migration/` contains rollback bytes; Git revert is
the preferred rollback. Ordinary upgrades never apply this migration.

Read `video/contract.json` `runtime` before drafting: `releaseLine`,
`minimumVersion`, `videoSchema`, `componentApi` and `features` must match the
installed host. Snapshots and custom overrides require reviewed exact
`testedVersions`, and that list must contain the running release, so after a
`timds upgrade` every video command fails until the frames are re-reviewed on
the new release and its exact version is added to `testedVersions` in a
reviewed commit; nothing records it automatically. `video components init`
and `migrate --apply` are the commands that edit `contract.json` (`runtime`,
`testedVersions`, `schemaVersion: 2`) and `timds.json` `video.components`. A
catalog or kind `layoutPreset` needs `runtime.features` to include
`shared-board-layouts-v1`; fresh scaffolds have it, an older adopted contract
gains it through `video components migrate --apply`. Deploy the same tested
locked release to producer and renderer hosts; compile/finalize provenance
records that installed version. Do not broaden compatibility or edit
production records to make a failed upgrade pass.

## Test-generate in the lab first

`npm run timds -- video lab --serve` opens the local Video Lab (no Remotion
Studio) on `127.0.0.1:4410` (`--port`): draft or paste a compile request,
edit the beats, check the plan, render headless, and review the MP4 with
spoken narration. Drafting calls Claude and needs credentials the SDK
resolves itself (`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, or a saved
`ant auth login` profile); without them the draft button is off. The
producer's `authoring` prompt blocks resolve from the built artifact's
`index.json`, so run `timds check` first when the contract names any. Use
the web lab to confirm the client's contract, components, banners, and
catalog produce the frames the client expects before authoring a full
production. Saved lab inputs land under `video.lab` (default `video/lab/`)
and are validated by `timds video check`. Planning estimates timing without
synthesis; rendering generates narration and uses measured word timings.

The web lab and the CLI lab (`video lab NAME`) choose Python differently:
both take `TIMDS_PYTHON`, then the client's `.venv-tts`, then `python3`, and
the CLI lab alone also honours `--python PATH` and `--voice NAME` for a local
take; the web lab ignores those two flags and uses the contract's `voiceover`
voice, rate and pitch. Use `--silent` or the browser's Silent preview option
only when a silent result is wanted. Generated lab takes are cached separately
from authored productions; never force-replace a production's locked take to
repair a lab render.

## Author a production

Create one folder under the configured productions directory. Treat its five
JSON files as phase records with one owner each:

- `request.json`: source, authorization, duplicate checks, and requested media
  (client conventions; the toolkit reads the file but validates none of its
  fields).
- `script.json`: `slug` (the folder name), `voice`, `rate`, `pitch`, and
  `lines`, each `{ "id", "tts" }` with the spoken text in `tts` and optional
  per-line `rate` and `pitch`.
- `publishing.json`: `topicName` (the review-package folder name),
  `articleUrl`, `question`, `answer`, `description`, `descriptionHook`,
  `seriesLine`, `disclaimer`, and `shorts[{ id, subtopic, description,
  descriptions }]`.
- `captions.json`: measured word timings for the locked voice take, written
  by `video voiceover` as `lines[{ id, words[{ text, startMs, endMs }],
  durationMs }]`.
- `production.json`: scene, cover, long-form, and short-form composition data.

`video check` holds a production to the contract: `schemaVersion: 1` and
`slug`; every long-form scene id has a caption line; `requireIntro` and
`requireOutro` per format; each short names `harvest` line ids, its scenes
in harvest order and a `cover`; the number of shorts equals
`package.shortCount`; no `subline` in shorts; headline, eyebrow and subline
word limits from `contract.copy`; a cover headline ends in `?` unless
`copy.coverMustBeQuestion` is false, within `coverHeadlineWords` and
`coverHeadlineCharacters`, and contains its `goldPhrase`; every scene asset is
declared in `video/assets.json` with a positive `durationSeconds`; a scene's
footage chain covers its narration at natural speed; and no two clips of one
footage family play back to back (a family is the key minus its `-vertical`,
`-mirrored` or `-offset` suffix; intro, outro and footage-free boards reset
the sequence). The last clip of a chain holds at least two seconds. A
headline must be a complete thought within its limit: one ending in
an article, conjunction, dependent preposition, `your`, `their`, `its` or a
possessive is refused as truncated.

Follow the client contract for output counts, source selection, copy limits,
CTA wording, cover rules, media authorization, and compliance. Put persistent
calls to action in the contract's `brand.banners` (`longform`, a string shown
as a pill top-right; `short: { kicker?, url }`, a banner under the logo; they
render on every frame) rather than only in the outro, which most viewers never reach; give Shorts
their own short `description` in `publishing.json` and, where the client
allows, a shorter outro line than the long-form. Reference only
keys declared by the client video asset catalog. Do not generate new moving
footage unless the request and client contract authorize it. Never recreate a
client logo; use the declared brand file.

## Register B-roll with its vertical framing

When creating or registering B-roll, follow the
[vertical crop authoring contract](references/vertical-crops.md). Register
the clip with `npm run timds -- assets add FILE --key KEY --title "…"
--tags …` (it measures duration and dimensions with `ffprobe`), publish it
with `npm run timds -- assets publish`, and copy the measured
`durationSeconds` into the clip's `video/assets.json` entry beside its
`mediaKey`: the producer and `video check` read the duration from that
catalog, and `check` refuses a production whose `mediaKey` has no public URL.
Footage masters are the keys under the producer's footage prefixes
(`producer.footage.assetPrefix`, one prefix or a list, each ending in `-`,
none nested in another); covers come from `producer.cover.assetPrefix`
(default `cover-subject-`) and need a published image. Include the client's
`vertical-meta.json` record with the asset registration, inspect the subject
and text zone in the first, middle, and last frames, and run
`npm run timds -- video check` before handing off. A horizontal clip's `text`
zone names where the copy box sits (`left-center`, `left-bottom`, `left-top`,
`right-center`, `right-bottom`, `right-top`, or `bottom`); choose a top zone
when the action crosses the middle band. A wide clip's subject-side
label is not sufficient crop metadata. Prefer reviewed, published vertical
derivatives; do not enable a blind center-crop fallback to make a plan pass.

## Preview through the lab first

When the contract declares a `producer` block, put the answer into a compile
request under the declared lab directory (`video/lab/NAME.json` by default):
`schemaVersion: 1`, `slug`, `outputFormat` (`horizontal` or `short`),
`exactQuestion` (ends in `?`, within the cover headline limits), `topic`
(`label`, `engagementQuestion` if required, `coverEmotion`, and `solution`
when `producer.subscribe` is enabled for the format), and ordered
`answerBeats`, each with `id`, `role` (`hook`, `rule`, `risk`, `process`,
`exception`, `answer`), `narration`, a complete micro-headline in `summary`,
and optionally one to three `footage` keys, a `chapter`, a `visual` board or a
`boardGap`. The scaffold's `video/lab/sample-answer.json` and `video/lab/README.md`
show the shape. Then run:

```bash
npm run timds -- video lab NAME --plan      # compile and print the plan
npm run timds -- video lab NAME             # the frames in Remotion Studio
npm run timds -- video lab NAME --render    # video-local/lab/NAME/out/NAME.mp4 and thumbnail.jpg
npm run timds -- video lab --list           # inputs and ready productions
```

The plan prints every scene's timing, eyebrow, headline, footage chain or
board, and cover as the producer resolved them; the studio shows the frames
through the client's components. Fix the request, the catalog, or the
components there before authoring a five-record production. `video check`
compiles every lab input.

Graphic boards are declared in the client's board catalog,
`video/boards.json` (`video.boards` in `timds.json`). It names every board
kind the Design System offers: its `label`, when to `use` it and what to
`avoid`, whether it may sit over footage (`overFootage`: `never`, `optional`,
`always`), whether it may appear only `once`, and a closed JSON-Schema for its
fields with `x-timds-maxWords` budgets, `x-timds-motif` fields (a file stem in
the `brand.staticFiles` mount named by `motifs.mount`), `x-timds-cue` fields
(one word the scene's narration speaks; the item reveals on it), and
`x-timds-substringOf` (an exact part of a sibling field). Its `formats` and
`cadence` (footage-free boards in a row, every chapter containing footage, a
chapter minimum once chapters are used, total words per board) apply to every
long-form production; Shorts get the run and `once` rules, not the chapter
rules, and the catalog's `formats.short` is off by default.

Kinds may also declare `formats`, a `maxWords` total, and contextual
`constraints`: `when.format` (`longform` or `short`) and/or
`when.overFootage` selects tighter field limits and word budgets. Check the
actual format and footage combination with the producer before rendering;
a board that fits a footage-free horizontal frame may not fit over footage
or in a Short. The drafting schema uses limits safe for every permitted
footage layout of its format. Keep these rules in the client's catalog and
have custom components read them with `resolveBoardKind` from
`@dtconcepts/timds/video/producer`. Install a compatible TimDS release on all
hosts before adopting contextual constraints; do not bypass an older host's
unknown-field error or remove limits to make a render pass.

A format offers boards only when both the catalog's `formats` and the
contract's `structure.<format>.graphicScenes` are on; `video init` scaffolds
the default catalog with `graphicScenes: false`, so turn the structure flag on
only when the client asked for boards. Then a beat or production scene may
carry `visual: { "kind": "...", ... }` plus an optional `chapter` slug. Use only
declared kinds and fields; when no declared kind fits a beat, keep footage and
record the gap in `boardGap` (one short sentence) instead of forcing a board, so
the client can decide whether to add a kind. Never author `subscribe`: the
producer inserts it from `producer.subscribe`, which needs the opt-in for each
format it plays in and a `topic.solution` in every request unless
`requireSolution` is false.

Every declared kind needs a component in the Design System's `Boards` registry
(`components.Boards`, keyed by kind; the TimDS defaults draw the default
kinds, and a client `Graphic` slot draws every declared kind its `Boards`
does not register), and a registered component needs a declared kind: `video
check` fails when the two disagree. To add a kind, add it to `boards.json` and
register its component in the same change. Migrating board overrides with
`video components migrate` needs the system to declare a board catalog;
otherwise the migration stops at `review`. A board with no footage keys renders on the
brand background and breaks the footage-family sequence; a board on a scene
that names footage plays over that chain. `compileProduction`, finalize (cues
against the measured take), and `video check` enforce the catalog; fix the
catalog or the scene, never loosen a budget to fit copy.

## Use TimDS for deterministic work

Run commands from the Design System repository root:

```bash
npm run timds -- video voiceover SLUG
npm run timds -- video check SLUG
npm run timds -- video prepare SLUG
npm run timds -- video studio SLUG
npm run timds -- video render SLUG --date YYYY-MM-DD
```

`video voiceover` runs `python3` from `PATH`, or the interpreter named with
`--python PATH`, with `edge-tts` installed; `TIMDS_PYTHON` and `.venv-tts`
apply to the lab only. `video render` writes the review package under
`video-local/out/<topicName> - <date>/` (the `package.longformDirectory`
folder and one `<package.shortDirectoryPrefix><subtopic>` folder per short,
named from `publishing.json`) with a `production.lock.json`; `--date` names the folder, otherwise the contract's
time zone's current day.

`brand.logo` and every `brand.fontFiles[].path` in `video/contract.json` must
be committed Design System paths. Only `brand.audio.bed` and
`brand.audio.transition` may instead be a published `{ "mediaKey": "..." }`.
Never point one at a generated file under `video-local/`: it renders on your
machine and fails on every render host. Publish generated audio through TimDS
media and reference its key. `video check` enforces this. Files the client's
components read with `staticFile()` (an illustration library, board artwork)
are declared in `brand.staticFiles` as committed paths with a `mount` name
(default the path's basename; lowercase segments only; never under `brand`,
`media` or `audio`; no overlap with another mount; not git-ignored or under
`video-local/`); TimDS copies them into the render public root and refuses
mounts that would shadow staged brand files, prepared media, or narration.

Voiceover generation replaces a timing fixture only with explicit approval to
use `--force`. A render must fail when registered footage cannot cover a scene
at natural speed; add another approved asset or shorten the scene instead of
freezing or slowing it.

## Review and hand off

Inspect the generated package for the client contract's visual, audio,
accessibility, legal, and publishing gates. Check the first, middle, and final
frame of people footage for copy collisions. For each short, author separate `descriptions` entries in `publishing.json`
for the targets under `video/contract.json → publishing.targets`
(`youtube_short`, `facebook_reel` and `instagram_reel` are the only targets;
each declares a `brief`, `maxCharacters` and a smaller `maxCopyCharacters`,
inheriting `publishing.targetDefaults`; an existing system adopts the shared
targets with `timds defaults`, then `timds defaults --apply` on a feature
branch), following each target brief. These entries contain clip-specific copy only; TimDS adds
the configured source link, CTA, series line, and disclaimer. Preserve necessary
qualifications and revise oversized copy instead of truncating it. Run
`npm run timds -- video publishing SLUG` to review/export the exact platform
text without rendering again. Existing records without a variants map retain
their legacy description; do not migrate them unless requested. Confirm each
platform output follows its source-link policy and contains the correct brand.

Return the absolute review-package path. Do not commit ignored audio, staged
media, generated covers, or rendered video. Do not push, publish, upload, or
open a pull request unless the user separately asks.
