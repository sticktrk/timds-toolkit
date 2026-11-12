# Design System

This EmDash site lives in `site/` of the workspace of the TimDS Design System
`__SYSTEM_ID__` (__SYSTEM_NAME__). It has no pin and nothing is copied out of
the system: each build reads the system's files from where they are, and
`astro dev` reads them on every request. A change to the system is a change
to this site on its next build, with no sync and no version to move. The
system and the site are edited, reviewed and committed together.

## How the system reaches the site

- **Pages.** Every page of the website design `src/designs/__DESIGN_ID__/`
  that is not under a declared section prefix (`sections.json`) or
  `/topics/` is a page of this site, built from the design file by
  `src/integrations/design-system.mjs` and served by
  `src/pages/[...page].astro`. There is one copy, in the system: editing the
  design is editing the page, and a page added to the design is a page here.
  Only a page's default state is served (`about.html`, or
  `about.default.html`, for `/about`); its other states (`contact.sent`)
  stay references in the system.
- **Layout.** The article, topic and 404 routes render inside the design's
  `layout.html`, its head, header and footer, through `src/layouts/Base.astro`.
  A design with no `layout.html` lends its home page instead, with the
  content of its `<main>` taken out.
- **Styles.** The design's own `<link>`s work here: `/styles/`, `/scripts/`
  and `/assets/` are the system's `src/` folders of those names, and
  `/tokens.css` compiles the system's tokens by the rule its own build uses.
  The site writes no CSS of its own.
- **Base path.** The workspace's dev server (`timds dev` at the repository
  root) serves this site under `/site`. Links in the design (`/about`) and in article bodies get that
  prefix when the page is rendered; a deployed site runs at `/`.

`astro.config.mjs` names the design (`designSystem({ design: "__DESIGN_ID__" })`).

## Forms

A form in the design that posts (`<form method="post">`, such as a contact
form) needs a handler in the site before it can send anything. Until it has
one, the page renders the form disabled: every control carries `disabled`,
the form carries `data-timds-form="not-connected"`, and a line inside it
says it is not connected yet. A POST to the address answers 405, so nothing
is taken in and dropped. Forms that read with GET (a search box) and forms
that post to another origin are left as the design wrote them.

To wire a form up:

1. Find the address it posts to: its `action` (`/contact`), or the page's
   own address when it has none.
2. Add a module under `src/forms/` named for that address, which exports
   `POST`: `src/forms/contact.ts` for `/contact`, `src/forms/index.ts` for
   `/`, `src/forms/support/request.ts` (or `support/request/index.ts`) for
   `/support/request`.

   ```ts
   // src/forms/contact.ts: the contact form, POST /contact.
   import type { APIContext } from "astro";

   export async function POST({ request }: APIContext) {
     const form = await request.formData();
     // Deliver form.get("name") and form.get("email") where the site keeps
     // them (a store, or a mail or form service this site is configured for),
     // and answer only once that succeeded.
     return new Response(null, { status: 303, headers: { Location: `${import.meta.env.BASE_URL.replace(/\/$/, "")}/contact` } });
   }
   ```

3. Rebuild, or let `astro dev` reload: the form renders enabled, with no
   change to the design, and the integration's middleware
   (`src/integrations/form-dispatch.mjs`) passes each POST to the address on
   to `POST` with the request's context, before any page: a page the site
   has at the same address (`/articles`) still answers its GET, never the
   POST.

The integration decides which forms have a handler from the files in
`src/forms/` each time it builds the pages, in development and in the build
alike. It parses each module and reads its exports, so `export async
function POST`, `export const POST = ...`, `export { handler as POST }` and
`export { POST } from "./elsewhere"` count, and a comment or a string that
mentions POST does not; `export * from` does not either, so name `POST`.
A module that does not export `POST` handles nothing, and one whose `POST`
is not a function when the request comes answers 405 (the server log names
the module), never the page at that address. Two modules for one
address (`contact.ts` and `contact/index.ts`) are an error.

EmDash turns Astro's cross-origin form check off for the whole site, so a
handler receives POSTs from other origins too. A handler that should accept
only this site's own form compares the request's `Origin` header with the
site's origin itself and answers 403 when they differ.

A form's POSTs are its own (with `method="post"`) and each submit button's
with a `formmethod="post"` or a `formaction` of its own; any of them that
reaches an address of this site with no handler disables the whole form.
Under the workspace's `/site` mount the form's `action` and a button's
`formaction` get the prefix like every other link, quoted or not. A design
page that needs more than a POST handler, such as server data on GET, is
ported into an Astro route by hand instead (see the rules below).

## Which change goes where

| Change | Lives in | How it is made |
| --- | --- | --- |
| Articles, topics, bylines, media | The EmDash database | The admin at `/_emdash/admin`, the REST API, or the MCP server at `/_emdash/api/mcp`, as `docs/content-api.md` describes. No commit. |
| A page's content, layout, header, footer, head | The design in the system: `src/designs/__DESIGN_ID__/` | Edit the design file. The site follows on its next build. |
| Colors, fonts, spacing, component styles | The system: its tokens and `src/styles/` | One change to the system; the site picks it up. |
| A style the site needs that the system lacks | Added to the system, in the same change | `__SITE_CHECK__`, from the repository root, finds it: a literal that equals a token is rewritten to the token, and anything else is listed for the agent to add to the system, never to the site. |
| What a posting form does with what it receives | `site/src/forms/` | A module named for the form's address that exports `POST` (see "Forms"). Until it exists the form renders disabled. |
| Article routes, serializer, seed, configuration, dependencies | `site/` | A developer change. |

## Rules

- Never copy a design's HTML into `src/pages/`, and never restyle a design
  here. A page that needs server data is the one exception: port it into an
  Astro route by hand, keeping its markup.
- Never write a color, font or size literal in `site/`. Name the system's
  tokens with `var(--…)`; a value the system lacks is added to the system.
- The article routes (`src/routes/articles/`, `src/pages/topics/`) render on
  the system's classes: `hero`, `section`, `article-list`, `article-card`,
  `article-meta`, `topic-list`, `prose`, `table-scroll`, `button` and
  `button--secondary`. A route whose classes the system's stylesheets do not
  declare has no port to this system yet; port it with the
  `timds-update-design-system` skill.
- The collection, field and taxonomy slugs in `seed/seed.json` are the
  contract writers target (`docs/content-api.md`). Renaming one breaks them.
- `.timds/emdash.json` records the TimDS template version and a hash of
  every file the scaffold wrote from its templates, so a later template
  update can tell an edited file from a stock one. Edit those files when the
  site needs it; the update then leaves them to you.

## Run it locally

```bash
cd site
npm ci
npm run dev -- --port 4380 --host 127.0.0.1     # http://127.0.0.1:4380
```

Open `/_emdash/api/setup/dev-bypass?redirect=/articles/` once on a fresh
checkout: it loads the sample articles into the local database and signs you
in as a development administrator. The route answers only under `npm run dev`.
`.env.example` lists the variables; local values go in `.dev.vars`.

EmDash 1.4.0 does not support a base path: its admin, API and media URLs stay
at `/_emdash/` even when the site is served under `/site`. Under the
workspace's dev server, open the admin at `/_emdash/admin`, not under `/site`
(the server prints the address and the local sign-in link). The admin's View
Site, Live View and Preview links also point at the root there: add `/site`
at the start of the path, or run the site alone as above.

Deploying is in `docs/emdash-handover.md`.
