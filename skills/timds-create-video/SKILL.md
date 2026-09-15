---
name: timds-create-video
description: Create, validate, preview, or render videos governed by a client-owned TimDS video contract. Use when a user asks to create a video, long-form explainer, short, thumbnail, voiceover, or review package in a Design System whose timds.json enables video.
---

# Create a TimDS Video

Use the client Design System as the complete production workspace. TimDS owns
the engine and commands; the repository owns all client-specific creative,
content, media, compliance, and publishing decisions.

## Resolve the contract

1. Read the repository instructions and preserve existing work.
2. Locate `timds.json` and confirm it declares `video`.
3. Read the declared video contract, asset catalog, optional `video.components`
   module, relevant production files, and the Design System pages they cite.
   Do not substitute remembered rules for the repository's current executable
   contract.
4. Run `npm run timds -- video doctor` before authoring.

If video is not enabled, report that `npm run timds -- video init` is required.
Do not initialize or migrate the repository unless the user asked for that
structural change.

When the user asks the Design System to take ownership of the current TimDS
visual defaults, run `npm run timds -- video components init`. Treat the
generated module as authored client source from that point forward. Never
regenerate it during a normal toolkit upgrade, and use `--force` only when the
user explicitly requests a reset that discards client component changes.

## Test-generate in the lab first

`npm run timds -- video lab --serve` opens the local Video Lab (no Remotion
Studio): draft or paste a compile request, edit the beats, check the plan,
render headless, and review the MP4. Use it to confirm the client's contract,
components, banners, and catalog produce the frames the client expects before
authoring a full production. Saved lab inputs land under `video/lab/` and are
validated by `timds video check`.

## Author a production

Create one folder under the configured productions directory. Treat its five
JSON files as phase records with one owner each:

- `request.json`: source, authorization, duplicate checks, and requested media.
- `script.json`: voice configuration and spoken lines.
- `publishing.json`: titles, source link, answers, descriptions, and package labels.
- `captions.json`: measured word timings for the locked voice take.
- `production.json`: scene, cover, long-form, and short-form composition data.

Follow the client contract for output counts, source selection, copy limits,
CTA wording, cover rules, media authorization, and compliance. Put persistent
calls to action in the contract's `brand.banners` (they render on every frame)
rather than only in the outro, which most viewers never reach; give Shorts
their own short `description` in `publishing.json` and, where the client
allows, a shorter outro line than the long-form. Reference only
keys declared by the client video asset catalog. Do not generate new moving
footage unless the request and client contract authorize it. Never recreate a
client logo; use the declared brand file.

## Preview through the lab first

When the contract declares a `producer` block, put the answer into a compile
request under the declared lab directory (`video/lab/NAME.json` by default:
exact question, topic label, engagement question if required, ordered answer
beats with role, narration, and a complete micro-headline) and run:

```bash
npm run timds -- video lab NAME --plan
npm run timds -- video lab NAME
```

The plan prints every scene's timing, eyebrow, headline, footage chain, and
cover as the producer resolved them; the studio shows the frames through the
client's components. Fix the request, the catalog, or the components there
before authoring a five-record production. `video check` compiles every lab
input.

## Use TimDS for deterministic work

Run commands from the Design System repository root:

```bash
npm run timds -- video voiceover SLUG
npm run timds -- video check SLUG
npm run timds -- video prepare SLUG
npm run timds -- video studio SLUG
npm run timds -- video render SLUG
```

Voiceover generation replaces a timing fixture only with explicit approval to
use `--force`. A render must fail when registered footage cannot cover a scene
at natural speed; add another approved asset or shorten the scene instead of
freezing or slowing it.

## Review and hand off

Inspect the generated package for the client contract's visual, audio,
accessibility, legal, and publishing gates. Check the first, middle, and final
frame of people footage for copy collisions. For each short, author separate `descriptions` entries in `publishing.json`
for the targets under `video/contract.json → publishing.targets`, following
each target brief. These entries contain clip-specific copy only; TimDS adds
the configured source link, CTA, series line, and disclaimer. Preserve necessary
qualifications and revise oversized copy instead of truncating it. Run
`npm run timds -- video publishing SLUG` to review/export the exact platform
text without rendering again. Existing records without a variants map retain
their legacy description; do not migrate them unless requested. Confirm each
platform output follows its source-link policy and contains the correct brand.

Return the absolute review-package path. Do not commit ignored audio, staged
media, generated covers, or rendered video. Do not push, publish, upload, or
open a pull request unless the user separately asks.
