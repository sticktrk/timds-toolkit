# Content API for article writers

This site accepts articles from external writers through EmDash's REST API
and its MCP server. This page is the contract those writers target. It was
written against EmDash 1.4.0; statements marked **unconfirmed** could not be
checked against a running site and should be verified on the first one.

Renaming the collection, the taxonomy or any field below, or changing a
field's type, is a breaking change for every writer. Add fields instead;
never rename or remove them without a migration plan agreed with the
writers.

## Content model

### Collections and addresses

`sections.json` declares the collections this site serves. An entry belongs
to exactly one collection; choose it when creating the entry. Every section
uses the same fields and publishing features. The address belongs to the
entry's collection and must not be copied to another section.

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

| Name | Kind | Type | Notes |
| --- | --- | --- | --- |
| `slug` | System | string | The URL segment. Lowercase, unique in the collection. Generated from the title when a create leaves it out. |
| `status` | System | `draft`, `published` or `scheduled` | Only `published` articles are shown to visitors. |
| `publishedAt` | System | ISO 8601 datetime | Set on the first publish and kept on later ones. Shown as the article's date. |
| `bylines` | System | byline credits | EmDash's byline profiles; shown as "By …". See [Bylines](#bylines). |
| `title` | Field | `string`, required | The article's only first-level heading. |
| `summary` | Field | `text` | One or two sentences under the title and on every card. Also the meta description. |
| `body` | Field | `portableText` | The article itself. See [The body](#the-body). |
| `cover` | Field | `image` | Optional. The header image and the social image. See [Cover media](#cover-media). |

The collection supports drafts, revisions, previews, scheduling, search and
the SEO panel. The SEO panel's title, description and image, when an editor
sets them, take precedence over `title`, `summary` and `cover` in the page
head.

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

EmDash's REST reference: "Send `_rev` with `PUT /content/{collection}/{id}`
to prevent overwriting a change made since the read." A stale `_rev` answers
`409`; read again and retry. REST accepts an update without `_rev`, but
writers must always send it. Changing a published article creates a draft
while the published version stays live; publish again to make the change
live.

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

The `_rev` rule, as EmDash's MCP server states it to clients: "Call
content_get first and pass back the _rev it returns. If this call fails with
CONFLICT the item changed in the meantime: call content_get again and retry
with the new token."

## What visitors see

- Each declared prefix lists its published entries, newest first, 20 to a page.
- `<prefix><slug>/` shows a published entry. A draft, an unpublished or
  a missing article answers the site's 404 page. A signed-in editor and a
  valid preview link see the draft; those responses are never cached.
- `/topics/<slug>/` merges that topic's published entries across sections, newest first, with an independent cursor position per collection.
- `<prefix>rss.xml` is a feed of the 20 newest entries when that section enables its feed.
