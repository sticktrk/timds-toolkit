# Article presentation

The article route owns entry lookup, preview access, the canonical link,
cache policy and the Article and BreadcrumbList JSON-LD. The page uses the
section's declared collection and address prefix. The workspace may give
that collection an authored layout in `divisions.json`. Keep the division's
landing-page mount outside the collection's namespace. Use the same article
components for guides and hubs. Select each collection by its declared mapping.

The site owns the components under `src/components/articles/regions/`. They
receive `ArticleRegionProps` from `src/lib/articles/presentation.ts`. Its
`context` contains the EmDash entry, section, canonical URL, preview flag and
presentation information such as the division and active body format. Import
other site components using literal local paths so the design checks can
follow them and verify their classes in each division where they render.

| Region | Placement and use |
| --- | --- |
| `Head.astro` | Additional head metadata. The route emits the canonical link and the Article and breadcrumb objects. |
| `Header.astro` | Below the summary and byline. The stock component shows the plain-text answer and the updated date when it differs from the publication date. |
| `BeforeBody.astro` | Above the prose. The stock component displays the approved video player when the entry has a valid `video_id`. |
| `WithinBody.astro` | Between complete top-level HTML nodes or Portable Text block groups. Use an authored link or call to action. |
| `AfterBody.astro` | Below the prose. The stock component shows the related guide when its title and path are valid. This is also a place for an author card or footer disclaimer. |
| `Sidebar.astro` | Beside the body on a wide screen when the component renders an `aside`. Put an authored contact prompt or form here. |

Enable an in-body region by setting `withinBody: 0.25` in
`articlePresentation`. The route finds the closest interior boundary to a
quarter of the body. One-node bodies and Portable Text in inline edit mode
omit that region. List and quote runs remain intact, including numbered list
continuations. Put a closing CTA in `AfterBody.astro` when it should always
be visible. Keep contact destinations, disclaimer copy and organizational
identity in the site's Design System and region components.

An author card can use the article's EmDash bylines:

```astro
---
import { bylineNames } from "../../../lib/articles/index";
import type { ArticleRegionProps } from "../../../lib/articles/presentation";

interface Props extends ArticleRegionProps {}
const names = bylineNames(Astro.props.context.entry.data);
---
{names.length > 0 && <aside class="article-note"><strong>About the author</strong><p>{names.join(", ")}</p></aside>}
```

A sidebar can render an `aside` containing the authored contact form. Set
its `action` to `sitePath("/contact/")` and connect the workspace's contact
handler first. Reuse the site's form fields, stable form ID and attribution
binding from the contact handover. A disclaimer can use an `article-note`
aside with the site's approved wording. The site's region components own
these elements independently of the writer's content.

Set `articlePresentation.organization` with a name and optional public URL
and logo to add an organization publisher. The Article object uses Person
bylines by default. To credit the configured organization as author, set
`author: "organization"`. Breadcrumbs use the home page, the section label
and the current entry. All addresses use the public site origin.

## HTML policy version 1

Keep HTML as a fragment. Use explicit closing tags for non-void elements,
including list items. The policy accepts up to 1 MiB of UTF-8 source with up
to 64 levels of nesting. Escape literal angle brackets in text. Use the
entry's title field for its `h1`.

- Structure and text elements: `div`, `section`, `h2`–`h6`, `p`, `br`, `hr`,
  `span`, `strong`, `b`, `em`, `i`, `small`, `mark`, `s`, `sub`, `sup`,
  `abbr`, `code`, `pre`, `kbd`, `time`, `cite`, `blockquote`, `q` and `a`.
- Lists and tables: `ol`, `ul`, `li`, `dl`, `dt`, `dd`, `table`, `caption`,
  `thead`, `tbody`, `tfoot`, `tr`, `th` and `td`. Use a `table-scroll` wrapper
  for a table that may be wider than the screen.
- Media: `figure`, `figcaption`, `img` and `iframe`. Give `img` an `alt`
  attribute and use the published EmDash media path or an HTTPS media
  origin the site has declared in `articlePresentation.html.mediaOrigins`.
  Give an `iframe` a title and use `https://www.youtube-nocookie.com/embed/<id>`
  with an 11-character YouTube identifier. Prefer `video_id` for video the
  writer will set or clear separately.
- Common attributes: unique `id`, approved `class`, `title`, `lang`, `dir`,
  `aria-label`, `aria-labelledby` and `aria-describedby`. Use letters, digits
  and underscores to start an ID, then letters, combining marks, digits,
  underscores, periods, colons or hyphens. Keep existing IDs when editing.
- Element-specific attributes: link `href`, `rel` and `target`; quotation
  `cite`; image `src`, `alt`, dimensions, `loading` and `decoding`; iframe
  `src`, dimensions, `loading`, `allowfullscreen`, `allow` and `referrerpolicy`;
  list `start`, `reversed` and item `value`; table `colspan`, `rowspan` and
  header `scope`; time `datetime`. Iframe `allow` accepts `accelerometer`,
  `autoplay`, `clipboard-write`, `encrypted-media`, `gyroscope`,
  `picture-in-picture`, `web-share` and `fullscreen` as semicolon-delimited
  feature names. Link destinations may be root-relative paths, anchors,
  HTTP(S) URLs or `mailto:` and `tel:` links. Link targets are `_self` and
  `_blank`; new windows cannot opt back into `opener` access.
- Use the stock classes `article-lede`, `article-steps`, `article-risks`,
  `article-scenario` and `table-scroll`. A guide can open with
  `<p class="article-lede">`, use `<ol class="article-steps">` for numbered
  steps and `<ul class="article-risks">` for risk lists. Wrap a scenario in
  `<section class="article-scenario" aria-labelledby="scenario-id">` with
  a heading of that ID. Additional approved classes belong in both the
  site's Design System and `articlePresentation.html.classes`.

Use the public site's URLs in the source, including image URLs. Rendering
keeps the source unchanged and may insert a site-owned region at a complete
node boundary. Root-relative URLs keep their literal values in a mounted
preview. Executable content, inline style, forms, arbitrary frames and
unapproved classes or media sources cause a plain 500 response without
rendering the fragment. Change the source in the CMS and publish a new
revision to correct it.

## Designed Gone response

For a workspace site, set `TIMDS_DESIGNED_GONE=1` in the environment when
starting Astro or building the Worker. Customize `src/components/Gone.astro`
with the site's layout and copy. The outer middleware adds a body to a
bodyless native 410 for GET requests. EmDash still owns rule matching and
the response status. HEAD requests stay bodyless.
