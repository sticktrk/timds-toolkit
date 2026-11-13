# Content API for article writers

This site accepts articles from external writers through EmDash's REST API
and its MCP server. This page is the contract those writers target. It was
written against EmDash 1.4.0; statements marked **unconfirmed** could not be
checked against a running site and should be verified on the first one.

Renaming the collection, the taxonomy or any field below, or changing a
field's type, is a breaking change for every writer. Hosted deployment
preserves existing collection schemas, including their field inventory;
choose the shared schema before first creation. Any later schema change
needs a separate migration plan agreed with the writers.

## Content model

### Collections and addresses

`sections.json` declares the collections this site serves. An entry belongs
to exactly one collection; choose it when creating the entry. Every section
uses the same fields and publishing features. The address belongs to the
entry's collection and must not be copied to another section. A nested
address such as `/commercial-division/lease-faq/{slug}/` still belongs to one
collection in this same site; use its collection slug in API requests.

Identify content by site, collection and database entry ID. A slug can be
the same in two collections. Use the public site origin and that section's
trailing-slash address for canonical links, redirect verification and
attribution. The API origin is a transport address. Uploaded media uses its
declared public URL, which may be on a separate media origin.

<!-- timds:sections -->
| Collection | Entry address | Feed |
| --- | --- | --- |
| `articles` | `/articles/{slug}/` | `/articles/rss.xml` |
<!-- /timds:sections -->

The examples below use `articles`; substitute the collection from this table
in every content API path and MCP call. `npm run sections:sync` refreshes
this table and the seed after a declaration change. Changing a declaration
does not create collections in an already set-up database by itself.

### Shared article fields

`section-schema.json` is the site's shared field and feature declaration.
The table below describes the stock article model; update this writer guide
alongside an authored schema change before the collection is first created.

<!-- timds:content-profile -->

`portable-text` installs the four base fields. `html` installs those plus
the five optional fields below. Discover supported fields for the selected
collection in `GET /_emdash/api/schema` (`data.collections[].fields`) with
the writer credential, or use the site's published collection inventory.
Always send Portable Text `body` when writing article content. Send an
optional field only when the collection declares that name and type.
Report skipped fields without treating them as publishing failures.

| Name | Kind | Type | Notes |
| --- | --- | --- | --- |
| `slug` | System | string | The URL segment. Lowercase, unique in the collection. Generated from the title when a create leaves it out. |
| `status` | System | `draft`, `published` or `scheduled` | Only `published` articles are shown to visitors. |
| `publishedAt` | System | ISO 8601 datetime | Set on the first publish and kept on later ones. Shown as the article's date. |
| `bylines` | System | byline credits | EmDash's byline profiles; shown as "By …". See [Bylines](#bylines). |
| `title` | Field | `string`, required | The article's only first-level heading. |
| `summary` | Field | `text` | One or two sentences under the title and on every card. Also the meta description. |
| `body` | Field | `portableText` | Portable Text body. See [The body](#the-body). |
| `cover` | Field | `image` | Optional. The header image and the social image. See [Cover media](#cover-media). |
| `body_html` | Field | `text` | Optional original HTML source. Nonempty HTML that passes the site's policy takes precedence over `body`. |
| `short_answer` | Field | `text` | Optional plain text shown in the article header unless the rendered HTML already contains `<section id="answer-box">`. |
| `state` | Field | `string` | Optional two uppercase letters. Omit the field when the article has no applicable geography. |
| `video_id` | Field | `string` | Optional 11-character YouTube video identifier. The site builds the player outside the body. |
| `related_guide` | Field | `json` | Optional `{"url":"/guides/example/","title":"Example guide"}`. The URL is a same-site path with no query or fragment. The card is hidden when the rendered HTML already links to that path. |

The collection supports drafts, revisions, previews, scheduling, search and
the SEO panel. The SEO panel's title, description and image, when an editor
sets them, take precedence over `title`, `summary` and `cover` in the page
head.

Map guide and hub pipelines to sections declared by the site. For example,
the site may declare a `guides` collection at `/guides/`; the writer should
use its configured mapping for the selected site and pillar. Guide content
can use the same HTML field and the site can give that collection a division
layout. Authored pages such as contact, about and terms are site source.

### Taxonomy `topic`

Topics are the `topic` taxonomy, flat (not hierarchical), attached to
every declared section. A topic page lives at `/topics/<term slug>/`. A term has a `slug`,
a `label` (the visible name) and an optional `description` (the line under
the topic page's heading).

An article's terms are written as `taxonomies: { "topic": ["<term slug>"] }`.
A slug that names no existing term is rejected with a validation error, so
create the term first.

### Bylines

Bylines are EmDash's own byline profiles, not a field. An article with no
byline credit shows the byline profile linked to the user who created it, if
that user has one. To credit someone else, pass
`bylines: [{ "bylineId": "<id>" }]` on create or update; the first credit is
the primary one. Byline profiles are created and listed through the MCP
`byline_list` and `byline_create` tools; EmDash's REST contract has no
supported byline endpoints, and a token reaching `/_emdash/api/bylines`
needs the `admin` scope.

## The body

`body` is Portable Text: an array of blocks. The site renders these block
shapes, which are the ones EmDash's editor writes:

| Element | Block |
| --- | --- |
| Paragraph | `{ "_type": "block", "style": "normal", "children": [spans], "markDefs": [] }` |
| Heading | The same with `"style": "h2"` or `"h3"`. `h1` renders as `h2`; `h4`, `h5` and `h6` render as `h3`. |
| Quotation | The same with `"style": "blockquote"`. Consecutive quote blocks render as one quotation. |
| Bulleted list | One block per item with `"listItem": "bullet"` and `"level": 1` (2 and deeper nest). |
| Numbered list | The same with `"listItem": "number"`. |
| Code block | `{ "_type": "code", "code": "…", "language": "javascript" }` |
| Image | `{ "_type": "image", "asset": { "_ref": "<media id>", "url": "<media url>" }, "alt": "…", "caption": "…", "width": 1600, "height": 900 }` |
| Table | `{ "_type": "table", "hasHeaderRow": true, "rows": [{ "_type": "tableRow", "_key": "…", "cells": [{ "_type": "tableCell", "_key": "…", "isHeader": true, "content": [spans] }] }] }` |
| Separator | `{ "_type": "break" }` |

Give every block and span a `_key` string, unique in the body, as EmDash's
editor does. **Unconfirmed:** whether EmDash rejects or fills in a missing key.

A span is `{ "_type": "span", "_key": "…", "text": "…", "marks": [] }`. The
marks `strong`, `em` and `code` are written by name; a link is a key that
points at a `markDefs` entry on the same block:

```json
{
	"_type": "block",
	"_key": "p1",
	"style": "normal",
	"markDefs": [{ "_type": "link", "_key": "l1", "href": "https://example.org/" }],
	"children": [
		{ "_type": "span", "_key": "s1", "text": "Read the " },
		{ "_type": "span", "_key": "s2", "text": "source", "marks": ["l1"] },
		{ "_type": "span", "_key": "s3", "text": "." }
	]
}
```

Write the article's title in `title`, not as a heading in the body. Block
types the site does not know render nothing. EmDash's other built-in block
types (embeds, galleries, video and the like) render with EmDash's own
markup, which the Design System does not style.

Through MCP, `body` may instead be a Markdown string: `content_create` and
`content_update` convert Markdown to Portable Text for `portableText` fields.
Through REST, send Portable Text JSON; REST does not convert Markdown.

### Original HTML

For a collection that declares `body_html`, send the source as a string in
`data.body_html`. [HTML policy version 1](article-presentation.md#html-policy-version-1)
defines the allowed elements, classes, media and embeds. Validate before
sending. The public renderer uses `body` when the HTML is missing, blank or
fails the policy. The stored source remains available in the CMS.

Compare `data.item.data.body_html` from the API to the exact submitted
string, including whitespace, entity spellings and attribute order. Check
the public page separately for the intended composition, including stable
anchors and images. The site can insert a component between top-level nodes.
Review the HTML field in the CMS when present. It has no inline Portable
Text editor.

## Tokens and permissions

A writer authenticates with a personal access token (prefix `ec_pat_`)
created in the admin and sent as `Authorization: Bearer <token>`. EmDash
documents no API or CLI for creating one. Create it while signed in as the
writer's own user, since the token acts with that user's role.
**Unconfirmed:** the exact admin screen; EmDash's secrets guide places token
revocation under Users, API tokens.

Scopes the writer's token needs:

| Scope | For |
| --- | --- |
| `content:read` | Reading articles, terms and revision tokens (`_rev`). |
| `schema:read` | Reading the per-collection field inventory through `/_emdash/api/schema`. |
| `content:write` | Creating, updating, publishing and unpublishing articles; MCP byline tools. It also grants `taxonomies:manage`. |
| `media:write` | Uploading cover and body images. |
| `taxonomies:manage` | Creating topic terms through REST. Implied by `content:write`; list it anyway so the grant survives a later change to that rule. |
| `media:read` | Optional: listing and reading media records. |

When the site puts Cloudflare Access in front of `/_emdash/*`, every REST and
MCP request also carries an Access service token, in the headers
`CF-Access-Client-Id` and `CF-Access-Client-Secret`, beside the
`Authorization` header. The site's owner issues it with the personal access
token. EmDash itself accepts the bearer token without an Access login, but
Access answers before EmDash does. **Unconfirmed** on a deployed site.

A scope never grants more than the user's role allows. The writer's user
has global scopes across all collections; it cannot be restricted to one
section. It needs the **Author** role to publish its own articles, and **Editor** to
create topic terms or bylines, to publish other users' articles, or to set
`publishedAt` directly.

## REST

Every REST path is under the site's origin. Responses are
`{ "success": true, "data": … }` or `{ "success": false, "error": { "code", "message" } }`.
EmDash publishes the full schema at `GET /_emdash/api/openapi.json`.

### Create a draft

```http
POST /_emdash/api/content/articles
Authorization: Bearer <token>
Content-Type: application/json

{
	"slug": "launch-notes",
	"data": {
		"title": "Launch notes",
		"summary": "What changed in the launch, in two sentences.",
		"body": [ … ],
		"cover": { … }
	},
	"taxonomies": { "topic": ["releases"] },
	"bylines": [{ "bylineId": "<byline id>" }]
}
```

The create body accepts `data` (required), `slug`, `status`, `bylines`,
`taxonomies`, `seo`, `locale`, `translationOf`, `references`,
`publishedAt` and `createdAt`. `status` accepts only `"draft"`: REST creates
are always drafts, and publishing is a separate call. Setting `publishedAt`
or `createdAt` needs the `content:publish_any` permission (Editor). The
response is `201` with `data.item` (including its database `id`) and
`data._rev`.

### Update

Read the article, then send the fields that change with the `_rev` the read
returned:

```http
GET /_emdash/api/content/articles/<id or slug>
```

```http
PUT /_emdash/api/content/articles/<id or slug>
Authorization: Bearer <token>
Content-Type: application/json

{
	"data": { "summary": "A better summary." },
	"_rev": "<_rev from the read>"
}
```

A stale `_rev` answers `409`. Record the conflict and leave the editor's
changes in place. Resume with a reviewed change against a fresh revision.
Changing a published article creates a draft while the published version
stays live. Publish again to make the change live, with the latest revision
from the update.

When setting or clearing `related_guide` or `video_id`, send only that field
and the observed `_rev`. Send `null` to clear either field. Leave both body
representations and unrelated metadata untouched. Publish the resulting
revision when it is ready to go live. The site reads these fields from the
entry and updates through ordinary EmDash content cache invalidation.

### Publish and unpublish

```http
POST /_emdash/api/content/articles/<id>/publish
POST /_emdash/api/content/articles/<id>/unpublish
```

Both take an optional JSON body `{ "_rev": "…" }`; send it. Publishing makes
the article visible at `/articles/<slug>/` on the next request, without a
rebuild. Unpublishing keeps the article and its date and removes it from the
site. Scheduling is `POST /_emdash/api/content/articles/<id>/schedule` with
`{ "scheduledAt": "<ISO 8601>", "_rev": "…" }`.

### Redirect, retire and restore

Use the native `/_emdash/api/redirects` routes to create and manage rules.
For a permanent move send `{"source":"/old/","destination":"/new/","type":301}`
to `POST /_emdash/api/redirects`. For permanent removal send
`{"source":"/old/","type":410}`. Use same-site paths for source and
destination. With a denied rule write (`403`), record `redirect_pending`
and leave the entry in place. Verify the exact `301` and `Location`, or the
`410`, with a request to the public URL before moving the source entry to
trash. `DELETE /_emdash/api/content/<collection>/<id>` moves an entry to
trash. Restore with `POST /_emdash/api/content/<collection>/<id>/restore`.
Use the rule ID and verify its ownership and current source, destination
and status before removing a writer-owned rule. Keep the entry recoverable.

### Topic terms

```http
GET  /_emdash/api/taxonomies/topic/terms
POST /_emdash/api/taxonomies/topic/terms
Content-Type: application/json

{ "slug": "releases", "label": "Releases", "description": "What shipped, and when." }
```

`slug` may be left out; EmDash then derives one from the label.

### Cover media

Upload the file as multipart form data:

```bash
curl --request POST \
	--header "Authorization: Bearer $TOKEN" \
	--form "file=@./cover.jpg;type=image/jpeg" \
	--form "alt=What the image shows" \
	https://<site>/_emdash/api/media
```

A new file answers `201`; identical bytes answer `200` with the existing
item and `deduplicated: true`. Put the uploaded item into `cover` in the
shape EmDash stores for image fields:

```json
{
	"id": "<media id>",
	"src": "/_emdash/api/media/file/<storage key>",
	"alt": "What the image shows",
	"width": 1600,
	"height": 900,
	"provider": "local",
	"meta": { "storageKey": "<storage key>" }
}
```

**Unconfirmed:** which properties of the upload response map onto each of
these (the storage key and URL property names), and whether a `cover` of
only `{ "id": "<media id>" }` is completed by EmDash on write. Send the full
object. For a body image, use the same media in an image block's `asset`:
`{ "_ref": "<media id>", "url": "/_emdash/api/media/file/<storage key>" }`.

## MCP

The MCP server is at `POST /_emdash/api/mcp` (Streamable HTTP, stateless),
authenticated with the same bearer token. Call `tools/list` for the exact
input schemas.

| Task | Tool | Notes |
| --- | --- | --- |
| Create a draft | `content_create` | `collection: "articles"`, `data`, `slug`, `taxonomies`, `bylines`, `seo`. `status: "published"` creates and publishes in one call (Author role). |
| Read | `content_get` | Returns the article and its `_rev`. |
| Update | `content_update` | `_rev` is required. |
| Publish | `content_publish` | `_rev` is required. |
| Unpublish | `content_unpublish` | `_rev` is required. |
| Upload media | `media_upload` | `filename`, `base64`, `contentType`, `alt`, `caption`. Returns the item with `id`, `storageKey` and `url`. |
| Topics | `taxonomy_list_terms`, `taxonomy_create_term` | Taxonomy name `topic`. |
| Bylines | `byline_list`, `byline_create` | `content:write` scope, Editor role. |

Read with `content_get` and send the returned `_rev`. Record `CONFLICT`
and resolve it through the same review flow as a stale REST revision.

## What visitors see

- Each declared prefix lists its published entries, newest first, 20 to a page.
- `<prefix><slug>/` shows a published entry. A draft, an unpublished or
  a missing article answers the site's 404 page. A signed-in editor and a
  valid preview link see the draft; those responses are never cached.
- `/topics/<slug>/` merges that topic's published entries across sections, newest first, with an independent cursor position per collection.
- `<prefix>rss.xml` is a feed of the 20 newest entries when that section enables its feed.
