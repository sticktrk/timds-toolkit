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

## Decide where the file belongs

| The designer gives you | Where it goes |
| --- | --- |
| A small optimized logo, icon, or UI image (SVG, or a PNG/WebP well under 1 MB) that pages render | `src/assets/`, referenced by site-absolute path such as `/assets/logo.svg`, committed to git |
| A photo, illustration, large graphic, video, audio, or any full-resolution original | The ignored `media-local/` workspace, registered with a logical key and published to TimDS storage; only its public record enters git, in `media.json` |
| A font file the system licenses | `src/assets/fonts/` with an `@font-face` in a stylesheet the pages load, so the font role is usable outside the browser |

Never commit a full-resolution original, a video master, or source audio.
When a large original needs a web derivative, keep the original under one
key and the optimized derivative under the key the pages reference.

## Stage and publish

1. Copy the file into `media-local/` (create the folder if it is missing;
   it is ignored by git). Keep the designer's file name unless it is
   unusable.
2. Choose a stable logical key: lowercase, hyphenated, descriptive of the
   subject rather than the campaign (`founder-portrait`, `hero-loop`). Keys
   are permanent once consumers reference them.
3. Register it:

```bash
npm run timds -- assets add media-local/FILE --key KEY --title "Title" --tags tag1,tag2
```

   Video and audio need `ffprobe` on the machine for duration and
   dimensions; if it is missing, say so and continue, then run
   `npm run timds -- assets backfill-metadata` once it is installed.
4. Publish. The first time on a machine, `npm run timds -- auth login` opens
   a browser sign-in only the designer can complete: ask them to finish it,
   then continue. Then:

```bash
npm run timds -- assets publish
```

   `submit` also publishes staged files, so a designer who ships right away
   loses nothing if this step waits.
5. Reference the published file by the `publicUrl` in its `media.json`
   record. The starter viewer does not resolve logical keys.

## Replacing media

Replacing a key is deliberate. Before restaging, check what references the
key (pages, designs, consumers) and compare dimensions and format. Never
restage an older original over an optimized derivative. Publication refuses
a stale replacement; if it does, read the message rather than forcing it.

## Put it on the page

- A logo goes on the page that presents it (usually `brand/logo`) with
  `data-timds-role="logo"`, and `"logo primary"` on the default variant.
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
