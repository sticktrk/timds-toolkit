# Brand kit starter: design proposal

Status: draft for discussion, 2026-11-03. Nothing here is implemented.

A second starter template, `templates/brand-kit/`, scaffolds the **stock
parent** a website-to-kit pipeline shoots structure-mode offshoots from. The
result for a visitor is a brand design system built from their website: the
foundations a designer would set, the templates such a pipeline promises (posts,
ads, email, print, decks, a launch page on the brand's components), and a
composer that makes the first
one. Where `templates/starter/` mirrors the golden agency-scale system, the
brand kit is sized to one brand and built so an automated pass can fill it.

The bar is the three published systems: treatments in Minimal, Accent and
Bold, canvases with safe areas, a mark and a photo in every template, copy
that sounds like the brand. A kit should get there from a crawl plus stated
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

Today the builder writes ten pages of HTML and the tokens. That makes every
page's guidance live in the pipeline and makes the kit unupgradeable. Proposed:

- **The starter owns every page**: brand guidance, the component library, the
  templates, the Use pages. They are stock, written against slots, and read
  the same on every brand. They say, per slot, what was observed, what was
  assumed and why, and what the owner should check.
- **The builder owns data only**: `tokens.json` (values with their label),
  `src/copy.json` (the brand's words), the media catalog and `src/assets/`
  (marks, photos, icons), and one `brand/evidence` page of captured facts
  (screenshots, spacing distribution, pages crawled) for a designer.

The viewer gains two placeholders beside `{{tokens:GROUP}}`: `{{copy:KEY}}`
and `{{media:KEY}}`. Both fall back to the stock sample when the key is
unfilled, so a template renders before the builder has run and shows
"assumed" rather than a hole afterwards.

## 3. The slot vocabulary

Every slot has a key, a source the crawler reads it from, an assumption rule
when it is missing, and the guidance line the page shows. Labels stay the
four the pipeline uses: **confirmed** (owner kept it), **observed** (on the
site), **assumed** (our rule filled it; today's "proposed"), **unresolved**
(the site disagrees with itself; the owner decides).

### Foundations (tokens)

| Slot | Observed from | Assumed when missing |
| --- | --- | --- |
| color.canvas | most-used page background | `#ffffff` |
| color.surface | card / panel background | canvas |
| color.ink | body text color | text on canvas by contrast |
| color.muted | secondary text | ink mixed 35% into canvas |
| color.line | borders, rules | ink mixed 82% into canvas |
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
| space.1 … space.12 | observed spacing distribution | 4 8 12 16 24 32 48 |
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
samples before a crawl; after one they are the brand's.

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

Pieces `canvas.css` needs beyond today: `.canvas--accent`, `.canvas--photo`
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

About thirty authored pages and thirty planned.

## 6. Formats, tokens, stock

`src/formats.json` holds exactly the formats in §4, each naming its template
page. `tokens.json` holds exactly the slots in §3, so the coverage score is
filled slots over slots that matter. `.timds/stock.json` declares the layout,
`system.css`, every page under `src/pages/` except `brand/evidence`, and
`src/copy.json` once stock admits it (§8).

`system.css` is the starter's, extended with the elements above and hardened:
every ground names its ink, no assumption that canvas is light, the dark
color-scheme block the builder already appends reads `ink-ground` slots.

## 7. The crawler and builder (the pipeline repository, MVP, modifiable)

Capture to add, per page, from computed styles on sampled elements:

- buttons (exists), plus the second button style, links, fields, cards
  (`[class*=card]`, `article`, bordered or shadowed blocks), badges, the
  header and footer grounds, section backgrounds for accent-2 and ink-ground;
- h1 letter-spacing, transform, line-height; small uppercase labels for the
  eyebrow;
- the largest six content images with natural size, aspect and a focal hint
  (face or center of mass is a later step; start with center), and whether
  they are photographic; SVG or transparent art as illustration;
- favicon and touch icons; social, mailto and tel links; `og:` and meta
  description; nav labels; button label bank; h1/h2 bank.

Builder: fill tokens from the slot rules, write `copy.json` and the media
catalog, copy assets, write `brand/evidence`, stop writing other pages. The
assumption rules are data the toolkit exports (`src/brand-kit.mjs`): slot
key, source, rule, guidance. The builder applies the rules; the stock pages
quote the guidance. The two cannot drift because they read one list.

## 8. Toolkit changes, in order

1. **Structure shoots keep the composer and the copy file.** `isPlumbingPath`
   (and a host `transform-v2`) admit `src/scripts/compose.js`;
   `.timds/stock.json` admits `src/copy.json`. Without the first, no
   structure offshoot has a working Use page today. Designs need nothing:
   a shoot drops them and the kit ships none.
2. **Viewer placeholders** `{{copy:KEY}}` and `{{media:KEY}}` with stock
   fallbacks, in `templates/starter/scripts/viewer.mjs` (shared plumbing).
3. **`templates/brand-kit/` overlay**: `site.json`, `formats.json`,
   `tokens.json`, `copy.json`, `stock.json`, `system.css`, `layout.html`,
   pages, an empty `src/designs/`. `init --starter brand-kit`; `.timds/starter.json`
   records `starter`; `starter sync` reads it for baselines and fragments;
   `templates/starter-history/brand-kit/`.
4. **`src/brand-kit.mjs`**: the slot list with rules and guidance, the builder
   page and stock contract, exported for the pipeline and asserted by tests.
5. **Tests**: fresh kit passes `check`; every template renders on the stock
   samples and on an inverted palette with no color literals; every format
   names an existing page; slot keys in `tokens.json`, `copy.json` and the
   pages agree with the export.
6. Docs and skills: this file becomes `docs/brand-kit.md`; AGENTS.md gains
   the rule that the brand kit mirrors the slot contract the way the starter
   mirrors the golden system; scaffolded entry points describe the kit.

Publishing the first parent needs no host change: scaffold with
`--provider hosted`, provision through the advanced route, publish `main`,
grant the service principal structure offshoots. A host starter kind can
follow.

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
