---
name: design-media
description: Add or replace a logo, photo, illustration, video, or other media in a TimDS Design System on the designer's behalf, handling staging, logical keys, publication to TimDS storage, and the page annotations the brand kit reads. Use when the designer has a file to add ("here is the new logo", "add these photos", "swap the hero video") or asks where an image should go.
---

# Add media for the designer

The designer supplies the file and says what it is. You decide where it
lives, name it, publish it, and put it on the page so the brand kit and
every consumer can find it. Read the media rules in `AGENTS.md` and the
media section of `timds-edit-design-system` first; this skill is the
procedure, those are the rules.

## Installation mode

Read `.timds/installation.json` under the Design System root (the folder
holding `timds.json`) before installing tools. With `mode: "binary"`,
use `timds-cli` at its exact `version` in place of `npm run timds --`; skip npm
installation and npm dependency-upgrade steps for the stock system. Check
`timds-cli --version` and `timds-cli doctor`. Select another executable release
only through `timds-cli upgrade --version EXACT_VERSION`. Existing npm mode
keeps its bounded requirement and committed lockfile. Custom product tools
retain their declared prerequisites. The agent runs these steps for the designer.

## Decide where the file belongs

| The designer gives you | Where it goes |
| --- | --- |
| A small optimized logo, icon, or UI image (SVG, or a PNG/WebP well under 1 MB) that pages render | `src/assets/`, referenced by site-absolute path such as `/assets/logo.svg`, committed to git |
| A photo, illustration, large graphic, video, audio, or any full-resolution original | The ignored `media-local/` workspace, registered with a logical key; once published (see "If you use TimDS Cloud"), only its public record enters git, in the media catalog (`media/<group>.json`, with `media.json` regenerated from the groups when `.timds/contract-layout.json` exists; `media.json` alone otherwise) |
| A font file the system licenses | `src/assets/fonts/` with an `@font-face` in a stylesheet the pages load, so the font role is usable outside the browser |

A logo or font file the product's website must load itself reaches it only
through the consumer bundle, which carries the files `timds.json`
`bundle.include` names (a fresh system ships only `dist/tokens.css` and
`dist/styles/system.css`). That manifest is protected: report which pattern
an operator should add rather than editing it.

Never commit a full-resolution original, a video master, or source audio.
When a large original needs a web derivative, keep the original under one
key and the optimized derivative under the key the pages reference.

## Stage and reference

1. Choose a stable logical key: lowercase letters, digits, dots, underscores
   and hyphens, descriptive of the subject rather than the campaign
   (`founder-portrait`, `hero-loop`). The part before the first `.` or `/`
   names the group file the record lands in (`photos.founder` goes to
   `media/photos.json`; a plain `founder-portrait` gets its own file). Keys
   are permanent once consumers reference them. In a brand kit
   (`starter: "brand-kit"` in `.timds/starter.json`) the media slots have
   fixed keys (`logo`, `logo-on-dark`, `mark`, `favicon`, `photo-1` to
   `photo-6`, `illustration`, `icon-family`): use the slot key.
2. Register it from wherever the designer's file is:

```bash
npm run timds -- assets add PATH/TO/FILE --key KEY --title "Title" --tags tag1,tag2
```

   It copies the file into the ignored `media-local/` workspace as
   `<key><extension>` (a file already inside `media-local/` is used where it
   is) and refuses a name collision. Video and audio need `ffprobe` on the
   machine (ffmpeg, or `FFPROBE_PATH`) to measure duration and dimensions;
   without it the file cannot be staged at all, so tell the designer ffmpeg
   is needed and stop for that file. `assets backfill-metadata` is only for
   older catalogs published before measurement existed.
3. Reference the file by what resolves everywhere. The starter viewer
   resolves `{{media:KEY}}` to the record's regular path under `src/assets/`
   (a display copy such as a logo, whose record carries that `path`; in a
   brand kit the stock pages already carry the slot markup, so filling a
   slot is the record and the file, never a page rewrite); it never
   resolves a key to a remote URL, so a published-only asset is referenced
   by the `publicUrl` in its catalog record. Until it is published, a
   staged file resolves only on this machine.

## Replacing media

Replacing a key is deliberate. Before restaging, check what references the
key (pages, designs, consumers) and compare dimensions and format. Never
restage an older original over an optimized derivative.

## If you use TimDS Cloud

Publishing staged media needs a TimDS host:

- The first time on a machine, `npm run timds -- auth login` opens a browser
  sign-in only the designer can complete (add `--portal-url` with the host in
  `timds.json` `media.portalUrl` when it is not the default;
  `TIMDS_ACCESS_TOKEN` is the non-interactive alternative): ask them to
  finish it, then run `npm run timds -- assets publish`.
- In a Git checkout `submit` also publishes staged files, so a designer who
  ships right away loses nothing if this step waits. A hosted `submit` does
  not: publish before submitting there, and keep large files out of the
  session's change set.
- Publication refuses a stale replacement; read the message rather than
  forcing it: remove the stale entry from `.timds/local-media.json` to keep
  the catalog, restore the published asset with `assets pull KEY --force`, or
  restage with `assets add` only for a replacement the designer intends.

## Put it on the page

- A logo goes on the page that presents it (usually `brand/logo`) with
  `data-timds-role="logo"`, and `"logo primary"` on the default variant. In
  the ordinary starter that page is still `planned` in `src/site.json`:
  author `src/pages/brand/logo.html` and remove the flag in the same change,
  since a file and a `planned` flag together fail the build.
  Add `data-timds-variant`, `data-timds-lockup`, `data-timds-on`, and
  `data-timds-tags` as they apply.
- Reusable imagery takes `photo`, `illustration`, `graphic`, `icon`, or
  `pattern` the same way.
- Every asset needs a name: a `<figcaption>` or `alt`.
- Reference artifact files by site-absolute path and published media by
  URL; a relative `src` reaches consumers as written and cannot be resolved.

Finish with `npm run timds -- check` and `npm run timds -- brand`, and tell
the designer in plain language what was added, where it shows, and whether
the brand kit now lists it.
