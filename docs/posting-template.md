# The blog posting template

A posting template is the layout of a published article: its named blocks, the
order they come in, each block's element and fixed heading, and what each
block is for. A Design System keeps its own template in one file,
`src/posting/blog.json`. A publishing engine builds articles from that file,
and a website styles the same blocks from the same system, so the layout and
the page come from one place and ship in one release.

Who owns what:

| | The designer, in the Design System | The publishing engine |
| --- | --- | --- |
| Owns | Which blocks an article has, their order, each block's element, id and fixed heading, and how they look | Which blocks an article fills and what each one says |
| Never decides | The words | Wrappers, fixed headings, order, classes |

An engine asks its writer for content only, block by block, and builds the
HTML from the template: each block in its element with its id and fixed
heading, in the file's order, with no class. The designer changes the layout
by editing the file and the stylesheet, without touching the engine.

A template has three parts, all in the Design System:

| Part | What it decides | Where it lives |
| --- | --- | --- |
| Structure | The blocks, their order, and what goes in each | `src/posting/blog.json` |
| Style | How each block looks | The system stylesheet, one rule per block id (`.prose #answer-box`) |
| Preview | The template drawn with those styles | Any page that holds `{{posting:preview}}`; the starters' Web → Components page does |

Anything outside the article body (a card under the title, a contact form, a
call block) is the website's page, not the template.

## The file

```json
{
  "schemaVersion": 1,
  "template": "blog",
  "name": "Question-and-answer article",
  "page": { "supplies": ["the title", "the cover image", "the publication date"] },
  "html": { "classes": [{ "name": "article-facts", "use": "a <ul> of facts about the reader" }] },
  "blocks": [
    { "id": "answer-box", "element": "section", "heading": "Short Answer", "required": true, "plain": true,
      "write": "Two to four sentences that answer the question." },
    { "id": "detailed-answer", "required": true },
    { "id": "clock-to-watch", "element": "aside", "write": "A deadline the reader must not miss." }
  ]
}
```

| Key | Required | Meaning | When absent |
| --- | --- | --- | --- |
| `schemaVersion` | yes | Always `1` | The file is refused |
| `template` | yes | Always `"blog"` | The file is refused |
| `name` | no | A label for people | No label |
| `page.supplies` | no | What the page shows by itself, in plain words, so a writer leaves it out | Title, cover image and publication date |
| `html.classes[]` | no | Extra classes the stylesheet styles in an article body, each with a `name` and a `use`. A record for people who write or edit an article by hand: a publishing engine writes no class, and a site approves a class in its own settings | No extra classes |
| `blocks[]` | yes, at least one | The article's named blocks, in page order | The file is refused |
| `blocks[].id` | yes | The block's `id` in the HTML: lowercase letters, digits and hyphens, starting with a letter, used once | The file is refused |
| `blocks[].element` | no | The element the block is wrapped in: `section`, `aside` or `div` | `section` |
| `blocks[].heading` | no | Fixed heading text, which an engine writes as the block's heading | No fixed heading; any heading is the writer's |
| `blocks[].required` | no | `true`: the layout expects the block in every article. A note for people; a publishing engine decides which blocks an article has | No note |
| `blocks[].plain` | no | `true`: one paragraph of plain text, so a site can show it in a card of its own | Ordinary prose |
| `blocks[].write` | no | What the block is for, in a sentence or two. An engine gives it to its writer | The writer is given only the id |

Limits: 24 blocks, 40 classes, 16 `page.supplies` entries; a `write` of 600
characters, a `use` of 200, a `heading` or `supplies` entry of 80.

## How the structure grows

Every Design System's file has this one structure, and it only grows:

1. `schemaVersion` stays `1`.
2. Only `schemaVersion`, `template` and each block's `id` are required. Every
   other key is optional, and leaving it out means the behaviour before the
   key existed.
3. A reader ignores keys it does not know, so a file written for a newer
   toolkit still loads on an older reader. `check` names such keys, because an
   unknown key is more often a misspelling than a newer file.
4. A key is never renamed and never changes meaning. A new ability is a new
   optional key.
5. A block id, once published, stays. Sites style blocks by id.

## Add or change a block

1. Edit the block's entry in `src/posting/blog.json`. Order in the file is
   order on the page.
2. Add a rule for its id to the system stylesheet, with tokens only:

   ```css
   .prose #what-changes-this { padding: var(--space-4); border: var(--size-line) solid var(--color-line); border-radius: var(--radius-md); }
   ```

3. Run `timds check` and open the page that holds `{{posting:preview}}`
   (Web → Components in the starters). The preview draws every block in its
   element, with its heading and its `write` text as the sample, inside
   `<div class="prose">`; `{{posting:blocks}}` is the spec table.
4. Release the system. A website moves its pin to that release to style a new
   block; until then it shows the block as ordinary text.

## What `check` does

- Refuses a file a reader could not use (wrong `schemaVersion` or `template`,
  no block, a bad or repeated id, a value of the wrong type, a limit passed),
  naming the entry.
- Warns about a block no stylesheet styles. The sheets compared are the
  `.css` files the consumer bundle holds, since those are what a website
  loads; a system that bundles no stylesheet is compared with `src/styles/`.
- Warns about a key it does not know.
- Warns when the system keeps a template and nothing publishes it: the
  manifest declares no bundle, or a `bundle.exclude` pattern leaves the file
  out.

## How it is published

The consumer bundle carries `src/posting/blog.json` whenever the system keeps
one, without a `bundle.include` pattern naming it (an `exclude` pattern still
leaves it out). It is listed in `bundle.json` with its digest like every
bundled file, at `bundle/src/posting/blog.json` beside the stylesheets that
style its blocks, under the current prefix and each immutable version prefix.
A publishing engine reads it there by the system's public address; a website
reads the same file from its pinned bundle or submodule.

`@dtconcepts/timds/posting` exports `readPostingTemplate`,
`normalizePostingTemplate`, `unstyledPostingBlocks`, `renderPostingPreview`
and `renderPostingTable`.

## A system that is not built on a starter

Validation, the style and publication warnings and the bundle entry need only
the file and `timds check`. The two placeholders belong to the starter
viewer; a system with its own build shows the template its own way, or calls
`renderPostingPreview` from its build.
