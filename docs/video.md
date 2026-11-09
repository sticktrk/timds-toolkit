# Contract-driven video in depth

The overview, `video init` and the component model are in the [README](../README.md#contract-driven-video).

## Graphic scenes, chapters, and static files

A scene may carry a client-drawn board instead of, or over, footage once the
contract opts the format in with `structure.longform.graphicScenes: true` (and
`structure.short.graphicScenes` for Shorts). The scene declares
`visual: { "kind": "steps", ... }`; TimDS validates only that `kind` is a slug
and the opt-in is on, and the Design System's `Graphic` component owns every
kind, its copy budget, and its motion. A board without `asset`/`assets`
renders on the brand background and breaks the footage-family sequence, so the
next clip may repeat the family of the clip before the board; a board whose
scene names footage plays over that chain under the normal natural-speed and
family rules. Asset keys alone decide which: there is no separate flag. The
default `Graphic` shows the scene's optional `eyebrow` and `headline` so a
production renders before the client has implemented the kind; the TimDS
`Scene` keeps the footage, watermark, and captions around whichever board is
mounted. A scene's optional `chapter` slug groups consecutive scenes for client
chapter rails; TimDS validates and carries it, nothing more.

Committed files the client's components read with `staticFile()` are declared
as `brand.staticFiles: [{ "path": "public/illustrations", "mount": "illustrations" }]`
and copied into the render public root under their mount. Each path must be a
committed Design System file or directory, never under ignored `video-local/`;
`video check` refuses missing or git-ignored sources the way it refuses a
missing logo. Mounts are lowercase (Linux render hosts resolve `staticFile()`
names exactly), cannot be `brand`, `media`, or `audio` (staged brand files,
prepared footage, and narration live there), cannot overlap one another, and
cannot land on a staged brand path such as a `public/`-relative logo or audio
bed, even in a silent preview that leaves the bed out. Asset `text` zones now include `left-top` and `right-top` for clips whose
action crosses the middle band; the default scene keeps the copy box under the
wordmark for them.

The producer can insert a spoken subscribe board early in the video with
`producer.subscribe`:

```json
"subscribe": {
  "enabled": true,
  "formats": ["horizontal"],
  "afterBeat": 1,
  "narrationTemplate": "Want to know more about {{topic}}? Subscribe to learn how to {{solution}}.",
  "requireSolution": true
}
```

The board is a graphic scene of kind `subscribe` carrying `topic` and
`solution`, placed after the Nth content beat and joining that beat's chapter,
so the contract must enable `graphicScenes` for each format the board plays in;
validation refuses the contract otherwise. `{{solution}}` comes from the compile
request's `topic.solution`. The authoring contract asks the drafting model for
it (required by default; with `requireSolution: false` a request without one
simply gets no board), the lab offers a Solution field beside the engagement
question, and `subscribe` joins the reserved scene ids. Hand-authored compile
requests may also give beats a `chapter` and a `visual`. Without a board
catalog the drafting schema offers `chapter` but never `visual`; with one, it
offers the catalog's kinds (below).

## Board catalog

A Design System declares its board vocabulary in `video/boards.json`
(registered as `video.boards` in `timds.json`; `timds video init` scaffolds the
default catalog, and `video/boards.json` is read when present even if
unregistered). TimDS owns the mechanism, the client owns the vocabulary:

```json
{
  "schemaVersion": 1,
  "formats": { "longform": true, "short": false },
  "cadence": { "maxConsecutiveFootageFree": 3, "chapterReturnsToFootage": true, "minimumChapters": 3, "maxBoardWords": 28 },
  "motifs": { "mount": "illustrations" },
  "kinds": {
    "cards": {
      "label": "Cards",
      "use": "A list of 2 to 5 parallel items.",
      "avoid": "Sequences, contrasts, or a single rule.",
      "overFootage": "optional",
      "once": false,
      "schema": { "type": "object", "required": ["items"], "properties": { "…": {} } }
    }
  }
}
```

Each kind's `schema` is a closed JSON-Schema subset (`type`, `properties`,
`required`, `additionalProperties`, `items`, `minItems`, `maxItems`, `enum`,
`const`, `minimum`, `minLength`, `maxLength`, `description`) plus `x-timds-maxWords` (a
field's word budget; budgeted fields also sum against `cadence.maxBoardWords`),
`x-timds-motif` (a file stem in the `brand.staticFiles` mount named by
`motifs.mount`), `x-timds-cue` (one word the scene's narration must speak), and
`x-timds-substringOf` (an exact part of a sibling field). Kinds are slugs and a
schema never declares `kind`. A format offers boards only when both the
catalog's `formats` and the contract's `structure.<format>.graphicScenes` are
on.

Kinds may restrict `formats` to `["longform"]` or `["short"]`, set a
`maxWords` total, and declare `constraints` for narrower layouts. For example,
`{"when":{"overFootage":true},"maxWords":14,"fields":{"nodes":{"maxItems":3}}}`
tightens a flow over footage; a separate rule with `when.format: "short"`
applies to every Short. When both selectors occur in one `when`, both must
match. Field paths name object properties in the base schema, such as
`left.items`; their numeric limits may only tighten that schema. All matching
rules apply, and the smallest word budget wins. These are client-owned limits:
TimDS does not infer geometry or change visual components.

Compilation, finalization, and `video check` use the scene's actual format and
footage. The model's visual schema uses the intersection of permitted footage
layouts for the requested format, because footage is chosen alongside the
visual. This safe subset prevents a draft from requesting a board that only
fits a wider layout; an explicit compile request can still use the larger
board in its supported context. Existing catalogs need no migration. To adopt
constraints, first release and install a compatible TimDS version on all
producer and renderer hosts, then declare the client limits; older versions
reject the new fields rather than silently ignoring them.

With a catalog, the authoring contract (schema version 2) exposes
`answerBeats[].visual` as a `oneOf` of the declared kinds with their use/avoid
guidance, describes `chapter`, adds `answerBeats[].boardGap` for a beat no
declared kind fits (the beat keeps footage and the gap is carried onto the
compiled and finalized scene), and returns a `boards` summary. `subscribe` is
compiler-owned: never offered, refused when authored, and held to the catalog
only when the catalog declares it. `compileProduction` validates every board
against its kind and runs the cadence rules (footage-free runs, every chapter
containing footage, the chapter minimum once any chapter is set, `once`,
`overFootage`, `formats`); `finalizeProduction` fails a cue the measured take
never says, skipping a timing that carries no `words`. `timds video check` holds
committed productions to the same rules and fails when the catalog's kinds and
the components' registered `Boards` disagree. The machine index carries the
catalog summary under `video.boards`, and the MCP `describe_system` lists the
kinds. The compiler's `subscribe` board follows `producer.subscribe.formats`,
not the catalog's `formats`. A catalog that declares only compiler-owned kinds
offers the model no boards. A staged project carries the catalog as
`contract.boards`, with `motifs.files` mapping each motif stem to its file in
the mount (`.svg` preferred when several share a stem);
`resolveVideoBoardMotifs({ designSystemRoot, catalog, contract })` from
`@dtconcepts/timds/video` resolves the same list for a remote producer host. A
client component file that exports `Graphic` counts as drawing every declared
kind.

Without a catalog, the default scene keeps rendering the existing headline
fallback. Built-in board components are selected automatically only after
catalog adoption; explicit client `Boards` and `Graphic` overrides still apply.
Drafting instructions follow each kind's `overFootage` rule, so footage-free
boards omit clip picks while ordinary beats keep them.

When any scene has a `chapter`, `finalizeProduction` adds
`plan.chapters: [{ id, label, startMs }]`. A `chapter-title` board's title
labels its chapter, otherwise the id is title-cased, and `startMs` is where the
chapter's first scene starts in the timed take. The lab plan prints the
chapters as `m:ss Label` lines. TimDS does not write them into publishing
descriptions: those come from committed publishing records, which the client
owns. The compile input stays at producer schema version 1: boards,
`chapter`, and `boardGap` are additive.

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

## Brand colors and fonts come from the Design System

`brand.colors` and `brand.fonts` accept a reference in place of a literal:
`"{color.accent}"` names a brand role and `"{--navy-900}"` names a token, both
from the `tokens.json` that `timds check` derives from the built stylesheets.
References resolve when the workspace loads, so the renderer, the lab, and
every prepared project see values. The values come from the derived
`tokens.json`, or straight from the built pages' stylesheets when that file
is not written yet. Before the artifact is built, checks, the lab's plan and
compile, and every other reader still work: references stay unresolved and
`video check` warns which ones are unverified, and the full `check` verifies
them once the pages are built. Only handing the contract to Remotion — a
production or lab prepare, studio, render — needs the values and fails with
the instruction to build first. A literal that duplicates a
derived token is reported by `check` with the reference to use instead. Video surfaces often
pick a darker face of the same palette than the page does, which is what a
token reference is for:

```json
"brand": {
  "colors": {
    "background": "{--navy-900}",
    "panel": "rgba(10, 23, 41, 0.96)",
    "accent": "{--gold-300}",
    "text": "{--cream}",
    "muted": "{--navy-200}"
  },
  "fonts": {
    "display": "{font.display}",
    "body": "{font.body}",
    "ui": "{font.ui}"
  }
}
```

## Brand files every render host can reach

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

`video check` fails when a brand file or `brand.staticFiles` source is missing,
is ignored by git, sits under the ignored `video-local/` directory, or names a
media key that is not published. It fails the same way when a production scene
or cover names a `video/assets.json` entry whose `mediaKey` has no published
entry in `media.json`; a catalog entry no production uses yet only warns, so
footage can be registered ahead of the production that plays it. A file that exists only on the machine that generated it renders
locally and 404s on every other host, so it is refused before merge rather
than discovered in production. Staging never drops a declared file: the lab,
`video render`, and silent previews fail with the contract field that names it.

Render hosts (the lab, `video render`, and automated Video Lab servers) stage
brand files through one exported function and check the finished project
before Remotion starts:

```js
import { assertVideoProjectStaged, resolveVideoBrand, stageVideoBrand } from "@dtconcepts/timds/video";

// tokens comes from the same Design System release as the raw contract.
// loadVideoWorkspace already resolves these when a built artifact is available.
const { contract: resolved } = resolveVideoBrand(contract, tokens);
const brand = await stageVideoBrand({ designSystemRoot, contract: resolved, publicRoot, mediaCatalog, cacheRoot });
const project = { ...rest, contract: { ...resolved, brand } };
await assertVideoProjectStaged(project, publicRoot); // names every missing staticFile() before rendering
```

`stageVideoBrand` validates the sources, copies committed files, downloads
published media (cached by SHA-256 under `cacheRoot` when given), and returns
the brand with runtime paths. `assertVideoProjectStaged` lists every file the
components request, including the logo, fonts, sound design, footage, cover,
and narration, and fails with each missing file's project field.
Both functions reject unresolved color/font references, including when a host
reads the contract JSON directly instead of using `loadVideoWorkspace`. A value
such as `{color.text}` must never reach CSS: the browser ignores it and may
render black text. Hosted consumers must verify the published tokens' system
and version and the artifact's source commit against their pinned Design System
before calling `resolveVideoBrand`; no fallback palette is applied.

Prepared media, generated audio, Remotion entry files, and review packages live
under ignored `video-local/`. Registered source media remains governed by the
normal TimDS media catalog. The committed production records refer only to
client-declared logical asset keys; render-time media is always played at its
natural speed, and a scene fails when its approved footage chain is too short.

## The video lab

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
an automated Video Lab flow, so a Design System editor can test-generate a
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
every footage master under the producer's footage prefixes to have a valid
record tied to its published SHA-256, with a crop position, vertical text zone,
and first/middle/last-frame review. This checks the records, not the visual
correctness of a crop or automatic object detection. The designer must inspect
the subject throughout the clip. Existing catalogs opt in by adding the
manifest path and completing their records; ordinary upgrades do not migrate
authored metadata. The normal `timds check`/submission checks include this video
gate too. See the [B-roll crop authoring contract](../skills/timds-create-video/references/vertical-crops.md)
for the schema and adoption procedure. Programmatic callers pass the same
registry as `verticalMetadata` to `createVideoProducer`.

Preparing or rendering downloads assets from their `media.json` public URLs
when no usable local media file exists, including stale or empty cache entries.
Cached published media must match the catalog's byte count and SHA-256; a
different local clip under the same media key is downloaded again before staging.
No manual asset pull or cloud login is required for published media.

`video check` compiles every lab input and warns when the registered catalog
cannot finalize one yet, so a new system can commit the sample before it has
registered footage under the producer's `footage.assetPrefix` keys (one prefix
or a list of them, when dashcam clips, character B-roll, and inserts share one
library) and a cover library under its `cover.assetPrefix` keys.
