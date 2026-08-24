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
3. Read the declared video contract, asset catalog, relevant production files,
   and the Design System pages they cite. Do not substitute remembered rules
   for the repository's current executable contract.
4. Run `npm run timds -- video doctor` before authoring.

If video is not enabled, report that `npm run timds -- video init` is required.
Do not initialize or migrate the repository unless the user asked for that
structural change.

## Author a production

Create one folder under the configured productions directory. Treat its five
JSON files as phase records with one owner each:

- `request.json`: source, authorization, duplicate checks, and requested media.
- `script.json`: voice configuration and spoken lines.
- `publishing.json`: titles, source link, answers, descriptions, and package labels.
- `captions.json`: measured word timings for the locked voice take.
- `production.json`: scene, cover, long-form, and short-form composition data.

Follow the client contract for output counts, source selection, copy limits,
CTA wording, cover rules, media authorization, and compliance. Reference only
keys declared by the client video asset catalog. Do not generate new moving
footage unless the request and client contract authorize it. Never recreate a
client logo; use the declared brand file.

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
frame of people footage for copy collisions. Confirm every description links
the declared source and every output contains the correct real brand mark.

Return the absolute review-package path. Do not commit ignored audio, staged
media, generated covers, or rendered video. Do not push, publish, upload, or
open a pull request unless the user separately asks.
