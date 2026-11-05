# Brand kit starter contract

The `brand-kit` starter is selected explicitly with `init --starter brand-kit`.
Its slot export, overlay, renderer, sync behavior and authoring guidance ship
together in the same toolkit release.

A second starter template, `templates/brand-kit/`, scaffolds the **stock
parent** a website-to-kit pipeline shoots structure-mode offshoots from. The
result for a visitor is a brand design system built from their website: the
foundations a designer would set, the templates such a pipeline promises (posts,
ads, email, print, decks, a launch page on the brand's components), and a
composer that makes the first
one. Where `templates/starter/` mirrors the golden agency-scale system, the
brand kit is sized to one brand and built so an automated pass can fill it.

The kit provides Minimal, Accent, Bold and Photo treatments, canvases with
safe areas, mark and photo slots in every template, and copy supplied by the
brand. A kit should get there from a crawl plus stated
assumptions, and the owner should see which is which.

## 1. The chain

```
toolkit ──init --starter brand-kit──▶ published brand-kit parent (host)
                                            │ shoot --mode structure (per visitor)
                                            ▼
                                   candidate kit: parent structure + crawl data
                                            │ owner reviews; a designer finishes in a session
                                            ▼
                                   the brand's own published system (llms.txt, MCP, composer)
                                            │ feed when the parent gains a template
```

A structure shoot keeps five things from the parent: the site catalog (all
pages planned unless declared stock), the whole formats catalog, token names
and brand roles (values become `initial`), the files `.timds/stock.json`
declares, and the recorded plumbing. Everything else is dropped. The kit is the
deliberate design of those five, plus the data contract the builder fills.

## 2. The split: the starter owns pages, the builder owns data

Pages and data have separate owners so shared guidance can advance without
replacing the brand's values:

- **The starter owns every stock page except builder-owned Evidence**: brand guidance, the component library, the
  templates, the Use pages. They are stock, written against slots, and read
  the same on every brand. They say, per slot, what was observed, what was
  assumed and why, and what the owner should check.
- **The builder owns data only**: the authored `tokens/*.json` maps (values with their label),
  `src/copy.json` (the brand's words), the media catalog and `src/assets/`
  (marks, photos, icons), and one `brand/evidence` page of captured facts
  (screenshots, spacing distribution, pages crawled) for a designer.

The viewer supports two placeholders beside `{{tokens:GROUP}}`: `{{copy:KEY}}`
and `{{media:KEY}}`. Both fall back to the stock sample when the key is
unfilled, so a template renders before the builder has run. The slot table
shows assumed or unresolved provenance instead of presenting a sample as an
observed fact. A missing copy file remains valid for the ordinary starter.

## 3. The slot vocabulary

Every slot has a key, a source the crawler reads it from, an assumption rule
when it is missing, and the guidance line the page shows. Labels stay the
four the pipeline uses: **confirmed** (owner kept it), **observed** (on the
site), **assumed** (a documented rule filled it), **unresolved**
(the site disagrees with itself; the owner decides).

### Foundations (tokens)

| Slot | Observed from | Assumed when missing |
| --- | --- | --- |
| color.canvas | most-used page background | `#ffffff` |
| color.surface | card / panel background | canvas |
| color.ink | body text color | text on canvas by contrast |
| color.muted | secondary text | ink 65% mixed with canvas 35% |
| color.line | borders, rules | ink 18% mixed with canvas 82% |
| color.accent | primary button background | most chromatic palette color |
| color.accent-ink | primary button text | black or white by contrast on accent |
| color.accent-soft | hover / selected ground | accent mixed 12% into canvas |
| color.accent-2 | second chromatic color in use (links, badges) | accent |
| color.ink-ground | darkest section background (footer, dark band) | ink |
| color.ink-ground-text | text on that band | surface |
| font.display | h1–h3 family | font.body |
| font.body | p family | `system-ui, sans-serif` |
| font.mono | code family | `ui-monospace, monospace` |
| font.display-weight | h1 weight | 700 |
| font.body-weight | p weight | 400 |
| type.display / title / lead / body / small / label | observed scale | 48 / 32 / 20 / 16 / 14 / 12 px |
| type.display-tracking | h1 letter-spacing | 0 |
| type.display-case | h1 text-transform | none |
| type.display-leading / body-leading | line-height | 1.1 / 1.5 |
| radius.control | button radius | 8 px |
| radius.card | card radius | radius.control |
| radius.media | image radius | radius.card |
| line.width | button / field border | 1 px |
| shadow.card | card box-shadow | none |
| space.1 / 2 / 3 / 4 / 6 / 8 / 12 | observed spacing distribution | 4 / 8 / 12 / 16 / 24 / 32 / 48 px |
| space.density | median section padding, bucketed | `regular` (tight / regular / airy) |
| motion.fast | button transition duration | 150 ms |

### Marks and media

| Slot | Observed from | Assumed when missing |
| --- | --- | --- |
| media.logo | header mark, on-light | wordmark set in font.display (flagged unresolved) |
| media.logo-on-dark | mark seen on a dark ground, or SVG recolored to surface | the on-light mark on a surface plate |
| media.mark | square or near-square logo candidate, favicon, touch icon | first letter in font.display on accent |
| media.favicon | `link[rel=icon]` | mark |
| media.photo-1 … photo-6 | largest content images, landscape first, with focal hint | none; templates fall back to the Accent or Bold treatment |
| media.illustration | non-photographic raster or SVG art | none |
| media.icon-family | Font Awesome / Material / inline SVG set in use | Font Awesome, thin, `currentColor` |

### Elements (component styles)

| Slot | Observed from | Assumed when missing |
| --- | --- | --- |
| element.button | primary button: padding, radius, border, weight, case, label | accent flood, 12×24 px, radius.control |
| element.button-secondary | second button style | outline in accent on canvas |
| element.link | link color, underline | accent-2, underlined |
| element.field | input height, border, radius | 48 px, line.width, radius.control |
| element.card | panel padding, border, radius, shadow | surface, space.6, radius.card, shadow.card |
| element.eyebrow | small uppercase label above headings | label size, 0.16 em tracking, accent |
| element.headline | h1 weight, case, tracking | from type slots |
| element.emphasis | styled span inside headings (italic, color, underline) | italic in accent |
| element.rule | hr / divider | 2 px accent, 40 px wide |
| element.badge | chip / pill | accent-soft ground, label type |
| element.nav | header height, ground, link style | 64 px, canvas, muted links |
| element.footer | footer ground and text | ink-ground / ink-ground-text |
| element.section | band rhythm, dividers | space.density, line dividers |

### Treatments (grounds every template comes in)

Derived from the color slots; nothing to crawl.

| Treatment | Ground | Type | Mark | Accent |
| --- | --- | --- | --- | --- |
| Minimal | canvas | ink | logo | eyebrow and rule in accent |
| Accent | accent | accent-ink | logo-on-dark or on-light by contrast | accent-soft |
| Bold | ink-ground | ink-ground-text | logo-on-dark | accent |
| Photo | photo-N with a scrim from ink-ground | ink-ground-text | logo-on-dark | accent |

### Copy (`src/copy.json`)

| Slot | Observed from | Assumed when missing |
| --- | --- | --- |
| copy.name | `og:site_name`, title, logo alt | hostname |
| copy.tagline | `meta description`, hero lead | "What {name} does, in one line." (unresolved) |
| copy.url | canonical host | hostname |
| copy.handles | social links in footer | none |
| copy.contact | mailto / tel / address | none |
| copy.headlines | h1 and h2 bank, deduplicated | three neutral samples |
| copy.ctas | button label bank | "Get started", "Learn more" |
| copy.topics | nav labels, service names | none; eyebrows fall back to "{name}" |
| copy.voice | AI pass: five lines with evidence | "Plain, direct, specific." |
| copy.claims-to-check | AI pass: superlatives and numbers seen | none |

## 4. What the kit makes

Every template is a stock page built from the canvas pieces, in the four
treatments, filled from slots. The pages exist and render on the stock
samples before a crawl; after one they are the brand's. The foundation
samples are the ordinary starter's own values (`templates/tokens.json`: a serif
display family, a sans body, a tinted canvas under white surfaces), so a stock
parent reads like a stock system; the "assumed when missing" rules above are
what a builder applies when the source shows nothing, and the two may differ.
Consecutive slot placeholders on a page render as one table with one header.

| Group | Templates | Formats |
| --- | --- | --- |
| Social | square, portrait, story, carousel (cover / point / last) | 1080², 1080×1350, 1080×1920 |
| Ads | Meta feed and portrait, LinkedIn sponsored, Google display core set | 1080², 1080×1350, 1200×627, 300×250, 728×90, 320×50, 300×600, 1200×628 |
| Email | header, signature banner, one-message template on the system | 1200×400, 1200×200, 600-wide HTML |
| Print | one-page sheet, flyer, poster, business card | Letter, 11×17, 18×24, 3.5×2 |
| Events | event poster, event social post and story, name badge | from Print and Social |
| Decks | title, section, content, closing slide | 1920×1080 |
| Web | launch page demo: hero, three sections, one call to action, footer, live on the components | the Layout page; whole pages are the system's own designs |

The composer's presets are the Social, Ads and Email formats, so the first
thing a visitor makes after the kit opens works.

Shared pieces in `canvas.css`: `.canvas--accent`, `.canvas--photo`
with a scrim, `.canvas-logo` (an `img` from `{{media:logo}}` with the
on-dark swap), `.canvas-photo` with a focal position, `.canvas-badge`,
`.canvas-count` (carousel "2 / 5"), a deck grid, and the business-card and
badge print frames. Every piece reads only slot tokens.

## 5. Views (`src/site.json`)

One view per channel, the way the published systems are organized and the
way `feed` grows a kit. Each channel view opens on an authored overview (the
treatments, that channel's format catalog, the template) and lists a short
set of planned pages, five or six chosen from the golden structure, so the
app bar reads as what the system grows into rather than as empty. A planned
page is declared in the navigation and not yet authored; a designer authors
it in place, and feed adds new ones as the parent gains them.

`home` unset: `/` is the overview (coverage, what was assumed, what to check,
one line per view on what it holds and what it grows into, sitemap).

| View | Authored | Planned |
| --- | --- | --- |
| Brand | Foundation, Logo, Color, Typography, Icons, Voice & Tone, Evidence (builder-written) | none |
| Web | Components, Spacing & shape, Layout (the launch page demo), Photography | Page archetypes, Email principles, Email templates |
| Social | Overview, Posts (square, portrait, story), Carousel | Brand on social, LinkedIn specs and templates, Video, Shorts, Pillars & cadence |
| Ads | Overview, Meta and LinkedIn, Google display | Responsive & PMax, Business profile, Compliance |
| Email | Overview, Header and signature, One message | Email principles, Templates |
| Print | Overview, One-page sheet, Flyer and poster, Business card | Letterheads, Brochures, Booklets, Notepads, Banners |
| Events | Overview, Event poster, Event post and story, Name badge | Webinar banners, Virtual backgrounds, Eventbrite and Facebook covers |
| Decks | Overview, Slides (title, section, content, closing) | Presentation templates, Webinar title slides |
| Use | Compose, Install | none |

Designs keep their contract and their place in the app bar, with no sample
page: `src/designs/` is present and empty, the designs build renders nothing
for it, and the Designs directory and Install page say that whole pages are
authored per system by a designer's agent. The actual designs are each
system's own.

The contract declares 33 authored pages, including the overview and builder-owned
Evidence page, and 24 planned pages. Each of the 24 formats names an authored
page. Carousel previews cover cover, point and last stages; deck previews cover
title, section, content and closing slides, each in all four treatments.

## 6. Formats, tokens, stock

`src/formats.json` holds exactly the formats in §4, each naming its template
page. `tokens/*.json` holds exactly the 40 foundation slots in §3; `tokens.json` is
the generated compatibility view. The full exported vocabulary has 75 slots,
including media, copy and elements. Coverage compares filled values against
these defined slots rather than unrelated tokens. `.timds/stock.json` declares the layout,
`system.css`, every page under `src/pages/` except `brand/evidence`, and
`src/copy.json`. The Evidence page is never declared stock.

`system.css` is the starter's, extended with the elements above and hardened:
every ground names its ink, no assumption that canvas is light, the dark
color-scheme block reads the `ink-ground` pair for viewer chrome. Shared
viewer aliases live in `system.css`, not as extra foundation tokens.

## 7. Pipeline integration

A website-to-kit pipeline may fill the data from captured evidence. Crawling,
model inference, source authorization and owner approval belong to that
pipeline, outside this package. Relevant evidence includes computed element
styles, heading behavior, content images and their focal hints, icon sets,
canonical identity, social and contact links, button labels and heading copy.

The pipeline fills the token and media key maps, writes `src/copy.json`,
places optimized local assets in `src/assets/`, and authors `brand/evidence`.
It does not regenerate the other stock pages. `src/brand-kit.mjs`, exported as
`@dtconcepts/timds/brand-kit`, supplies each slot's key, group, kind, source,
assumption rule, guidance, sample, default label and owning page. It also
exports the foundation and copy samples, views, authored/planned page ids,
stock paths and treatment pairs. The renderer uses this same module, copied
as managed `scripts/brand-kit.mjs`, so the pages and a pipeline read one list.

### Values and labels

Token values remain strings with optional `label` metadata using the four
labels above. The slot table displays token labels and the catalog's media
labels when supplied. Copy values are strings only; supplying arbitrary text
does not prove it was observed or confirmed. Copy and element slot labels
retain the contract's sample label, with decisions and evidence recorded on
the Evidence page. No inferred provenance is silently promoted to confirmed.

`src/copy.json` uses short keys such as `name`, `headlines` and `voice`.
Headline and CTA banks are newline-delimited strings. `{{copy:headlines}}`
renders the whole escaped value; `{{copy:headlines.0}}` selects the first
non-empty line, and subsequent numeric indexes select later lines. A missing
entry falls back to that stock bank entry and is reported. HTML characters
are escaped in both ordinary and indexed placeholders.

Media uses the existing catalog keys, such as `logo` and `photo-1`. An asset
may additionally name a regular local file through `path: "src/assets/..."`.
The catalog still requires its existing stable public URL and media metadata.
The viewer emits the matching `/assets/...` path, refuses traversal and
symbolic links, and rejects an explicitly named file that does not exist.
On grouped systems, `media/*.json` is canonical and `media.json` is generated.
An unfilled logo uses the visible wordmark sample; an unfilled photo uses the
Bold treatment. No generated sample mark is represented as an approved logo.

Accent previews declare `data-logo="auto"`. The viewer enhancement reads the
computed `accent-ink` color and selects the on-dark mark for light ink or the
primary mark for dark ink, updating the choice when the color scheme changes.
The canvas geometry and variant swap remain CSS; before enhancement, the
primary mark has a surface plate. Review the actual assets on their intended
grounds as well as the named text pairs.

### Diagnostics and checks

Build reports the copy/media keys that used stock samples. A fresh kit also
reports that its voice is assumed; replacing `copy.voice` with reviewed
guidance clears that diagnostic. Its authored Voice & Tone page is valid
guidance, so it does not report the ordinary starter's missing-voice-page
warning. The derived brand reports no annotated logo until a real logo slot
is filled. The ordinary starter retains its two expected brand warnings.

Tests check the exact slot, copy, page and stock vocabulary; render every
format and stage on stock and inverted palettes; and verify computed
canvas/ink pairs. The viewer rejects color literals in source stylesheets.
Each non-planned catalog page has exactly one fragment and every format
names a declared page. Whole-page designs begin empty.

## 8. Initialization and sync

An operator or agent scaffolds the kit with:

```bash
timds init --standalone --starter brand-kit --root PATH
```

The default remains `starter`. Initialization selects one overlay, then
records `starter: "brand-kit"` in `.timds/starter.json`; an absent field means
`starter` for older records. `templates/brand-kit/` contains only the changed
catalogs, foundation samples, copy, stock declaration, stylesheet, layout and
pages, plus an empty Designs directory. Shared renderer, canvas, composer and
build scripts come from the ordinary starter; the slot data module comes from
`src/brand-kit.mjs`. No shared plumbing is duplicated in the overlay.

Starter sync selects the stock catalogs, managed fragments, template paths
and history by that record. Histories live under
`templates/starter-history/<kind>/`. A fresh kit's first sync is a no-op.
Catalogs merge against the kit baseline, stock fragments refresh only while
unmodified, and authored tokens, copy, media, evidence, system styles and
layout content retain their ownership boundaries. No ordinary upgrade
converts one starter kind into another or resets these authored values.

A structure shoot retains recorded `src/scripts/compose.js`, declared
`src/copy.json`, and the selected starter kind. It still requires verified
plumbing hashes and exact regular stock paths. The child keeps its parent's
structural feed baseline, while ordinary toolkit sync refreshes plumbing.

Publishing a stock parent is an operator action after scaffolding with
`--provider hosted`: provision the source through the advanced route, publish
`main`, then reserve a structure grant for the pipeline's service principal.
The toolkit does not provision that parent or reserve grants. A Studio starter
kind is separate host work.

## 9. Decisions taken (2026-11-03)

1. One view per channel, each with an authored overview and a short planned
   list, over one grouped Templates view. Moving pages between views later
   is a manual migration per kit, since feed never moves or removes an entry.
2. The designs structure ships; no sample design does. The launch page is a
   live demo on the Web Layout page; whole pages are each system's own.
3. Six photo slots at first, center crops, with the Photography page saying
   so. Focal detection is a later crawler step.
4. `accent-2` and `ink-ground` are captured slots, derived from accent and
   ink only when the site has none.

## Values a crawl gets wrong

A builder fills the slots from what a site shows, and a site can be faithful
and still unusable as a system: a black call to action makes a black accent,
a grey page makes a grey surface, and a hero set in a small `h1` files the
hero size as the lede. The kit's data stays what the builder wrote; two
guards keep that from hiding the kit itself. The starter viewer keeps its own
page title, h2 and lede in order whatever the scale says, and sets text on
the accent in `color.accent-ink`. `check` reports an accent that is nearly
the text color, an accent below 3:1 on the background, and a fixed type scale
whose steps are out of order, so a designer corrects the slot rather than the
page.
