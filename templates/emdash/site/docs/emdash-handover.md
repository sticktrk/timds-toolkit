# EmDash article section: handover

The scaffold added an EmDash article section to this site: the `articles`
collection and `topic` taxonomy in `seed/seed.json`, the routes
`/articles/`, `/articles/<slug>/`, `/topics/<slug>/` and
`/articles/rss.xml`, the components under `src/components/articles/`, the
helpers under `src/lib/articles/`, and `src/live.config.ts`. Writers target
the contract in [content-api.md](content-api.md).

Work through this list from top to bottom. The scaffold printed the same
configuration changes, with a snippet that shows each file in full. If that
output is gone, the snippets are in the TimDS package the site installs,
under `node_modules/@dtconcepts/timds/templates/emdash/manual/`; there the
site's name and origin still read `__SITE_NAME__` and `__SITE_URL__`.

## What the site needs

- [ ] Astro 7, 7.3.2 or later, and Node.js 22.16 or later (22.23.4 or later
      once the site moves to Astro 7.4 or later).
- [ ] The dependencies the scaffold added to `package.json`, installed with
      `npm install`, and `"emdash": { "seed": "seed/seed.json" }` in it.

## What the site's layout must offer

The article and topic routes render inside the site's own layout component,
imported from the path the scaffold recorded. The layout must:

- [ ] accept a `title` prop (the page title, without the site name) and a
      `description` prop (a plain sentence, possibly empty);
- [ ] render `<slot name="head" />` inside its `<head>`. The article page
      puts its canonical link, Open Graph and Twitter tags, `robots` when an
      editor hides the article, and Article structured data there. Without
      this slot they are silently dropped;
- [ ] render the default `<slot />` inside the page's main content area;
- [ ] link the Design System stylesheets that define `hero`, `section`,
      `article-list`, `article-card`, `article-meta`, `topic-list`, `prose`,
      `table-scroll`, `button` and `button--secondary`. The routes write no
      CSS of their own.

The layout should not emit its own canonical link or `og:image` on these
pages, or the head carries two.

## Configuration the scaffold did not change

- [ ] `astro.config.mjs`: add the adapter, `output: "server"`, `react()` and
      `emdash({ … })` as the printed snippet shows. On Cloudflare that is
      `cloudflare({ imageService: "passthrough" })`, D1 and R2,
      `migrations: { runtime: "check", dev: "auto" }`, `mcp: true` and
      `registry: false`, with no `sandboxRunner`.
- [ ] Cloudflare: `wrangler.jsonc` with `"main": "./src/worker.ts"`,
      `nodejs_compat`, the `DB` and `MEDIA` bindings, the `EMDASH_SITE_URL`
      var set to the production origin, and the `* * * * *` cron trigger.
      No `LOADER` binding. Run `npx wrangler types` afterwards.
- [ ] Add `export const prerender = true` to every existing page that should
      stay static. Do not add it to the article or topic routes.
- [ ] If the site has a sitemap, add the URLs from
      `getArticleSitemapEntries()` in `src/lib/articles/sitemap.ts` and serve
      the sitemap on request, with the cache header the snippet sets: for a
      signed-in editor the entries can include a draft revision's unpublished
      slug, so that response must stay out of shared caches. EmDash also
      serves its own `/sitemap-articles.xml`, which a sitemap index can link
      instead. A site with no `src/pages/sitemap.xml.*` of its own gets
      EmDash's `/sitemap.xml`, decided when the server starts.
- [ ] If the site already had `src/live.config.ts`, add the `_emdash`
      collection to it.
- [ ] `tsconfig.json` includes `emdash-env.d.ts` (and on Cloudflare
      `worker-configuration.d.ts`).
- [ ] The links in `src/lib/articles/index.ts` end in a slash
      (`/articles/<slug>/`). If the site sets `trailingSlash: "never"`,
      change `articlePath` and `topicPath` there, and `urlPattern` in the
      seed, to match.
- [ ] The list page's heading and introduction (`src/pages/articles/index.astro`)
      are starter copy. Replace them in the site's voice.

## Check it locally

- [ ] Generate the encryption key: `npx emdash secrets generate --write .env`.
- [ ] `npm run dev`, then open
      `http://localhost:4321/_emdash/api/setup/dev-bypass?redirect=/articles/`.
      In development this applies the seed with its sample articles and signs
      in a development administrator.
- [ ] `/articles/`, `/articles/example-article/` and
      `/topics/example-topic/` render in the brand, and match the Design
      System's article designs.

## First deploy

On Cloudflare, with `migrations.runtime: "check"`, a Worker whose database
has pending core migrations answers 503, so every deploy runs, in this order:

```bash
npm run build
npx emdash migrate --status   # review the target database
npx emdash migrate            # apply pending migrations; asks to confirm
npx wrangler deploy
npx emdash migrate --check
```

`emdash migrate` needs a build first (it reads `.emdash/migrations.json`),
`CLOUDFLARE_ACCOUNT_ID` and a `CLOUDFLARE_API_TOKEN` with D1 Edit
permission. EmDash never creates the D1 database: let the first
`wrangler deploy` create it, or run `npx wrangler d1 create`. In CI, the
non-interactive apply needs `--expected-target-fingerprint` with the
fingerprint `--status` printed. On Node, migrations run at startup.

## Cloudflare resources with the cf CLI

`cf` is Cloudflare's own command-line tool, in beta. Use it for the account
and resource tasks below. The site still builds with Astro and deploys with
Wrangler: `cf build` and `cf deploy` need a build output that the Astro
Cloudflare adapter does not write (checked with adapter 14.3.1 and
cf 1.0.0-beta.28), and `cf` cannot set a single secret yet, so
`wrangler deploy` and `wrangler secret put` stay. Do not run `cf dev`,
`cf build` or `cf deploy` in this project: without a `cloudflare.config.ts`
they write a configuration of their own.

- [ ] Sign in with `cf auth login`; `cf` does not reuse Wrangler's login. In
      CI both tools read `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.
- [ ] To create the database and the bucket before the first deploy, rather
      than letting that deploy create them:

      ```bash
      cf d1 create --name <database_name from wrangler.jsonc>
      cf r2 buckets create --name <bucket_name from wrangler.jsonc>
      ```

      Add the `database_id` the first command prints to the `DB` binding in
      `wrangler.jsonc`.
- [ ] With Cloudflare Access (step 1 of the checklist below), create the
      Access application for all of `/_emdash/*` on the production host, not
      for the admin path alone: EmDash's guide says an application on
      `/_emdash/admin/*` leaves its API without the Access token it expects.

      ```bash
      cf zero-trust access applications create --body @access-application.json
      cf zero-trust access policies create --name "EmDash editors" --decision allow --include @editors.json
      cf zero-trust access applications get <app-id>
      ```

      The first command takes the JSON body of Cloudflare's Access
      applications API (a self-hosted application whose domain is
      `<host>/_emdash`). The last one shows the application's audience tag,
      the value of `CF_ACCESS_AUDIENCE`.
- [ ] With Cloudflare Access, keep uploaded media public. Covers and body
      images are served from `/_emdash/api/media/file/<key>`, inside the
      application above, so without one of these two changes visitors and
      social crawlers get the Access login instead of the image:

      - a second, more specific Access application for
        `<host>/_emdash/api/media/file` with a bypass policy for everyone.
        EmDash itself treats that path as public, so nothing new is exposed:

        ```bash
        cf zero-trust access applications create --body @access-media.json
        cf zero-trust access policies create --name "Public media" --decision bypass --include @everyone.json
        ```

      - or a public origin for the bucket, such as a custom domain on it,
        named in `astro.config.mjs` as
        `storage: r2({ binding: "MEDIA", publicUrl: "https://media.example.com" })`,
        so media URLs leave `/_emdash/` altogether.

      **Unconfirmed** on a deployed site: open an article's cover image in a
      private window after the first deploy. A site that uses EmDash's public
      search or comments needs the same for `/_emdash/api/search` and
      `/_emdash/api/comments/`.
- [ ] With Cloudflare Access, the content writer needs to pass it too. Its
      REST and MCP requests go to `/_emdash/api/`, inside the application.
      EmDash accepts the writer's bearer token without an Access login, but
      Access answers first and turns away a request that carries neither an
      Access session nor a service token:

      ```bash
      cf zero-trust access service-tokens create --name "content writer"
      cf zero-trust access policies create --name "Content writer" --decision non_identity --include @writer-service-token.json
      ```

      The writer then sends `CF-Access-Client-Id` and
      `CF-Access-Client-Secret` on every request, beside
      `Authorization: Bearer <token>`. **Unconfirmed** on a deployed site:
      check it with step 5 of the checklist.

## Handover checklist

1. [ ] Start the first deploy by hand and finish setup on the production
       origin, never on a `workers.dev` or preview address: until setup is
       finished, the first visitor to it becomes the administrator.
       `EMDASH_SITE_URL` must already name the production origin, because
       setup and passkeys bind to it. **Decline the sample content** in the
       setup wizard, so production starts with no articles, topics or
       bylines.
       With Cloudflare Access in front of `/_emdash/*`, enable the commented
       `auth: access({ teamDomain, audienceEnvVar: "CF_ACCESS_AUDIENCE" })`
       block in `astro.config.mjs` and set the audience with
       `npx wrangler secret put CF_ACCESS_AUDIENCE` before this deploy. The
       Access application, its policy and the writer's service token are in
       [Cloudflare resources with the cf CLI](#cloudflare-resources-with-the-cf-cli).
2. [ ] Create the content writer's user (Author role to publish its own
       articles; Editor to also create topics and bylines), sign in as that
       user and create a personal access token with the scopes
       `content:read content:write media:write taxonomies:manage`. EmDash
       documents no API or CLI for creating tokens, so this stays manual.
       Hand the token and [content-api.md](content-api.md) to the writer,
       with the Access service token's client id and secret when Cloudflare
       Access is in front of `/_emdash/*`.
3. [ ] Back up `EMDASH_ENCRYPTION_KEY` outside Cloudflare (a password
       manager). Set it on the Worker with
       `npx wrangler secret put EMDASH_ENCRYPTION_KEY` (on Node, in the
       host's secret manager). A database backup does not contain it.
4. [ ] Once the first deploy and setup are done, set the repository variable
       `CLOUDFLARE_DEPLOY_ON_PUSH` to `true`, so later pushes deploy, if the
       site's deploy workflow reads it.
5. [ ] Create one draft through the REST API with the writer's token,
       publish it, and confirm it appears at `/articles/<slug>/` without a
       rebuild; unpublish it and confirm the page answers 404.

## Caching

The routes set `Cache-Control: private, no-store` for a signed-in user or a
preview link, and `public, max-age=60` (one hour for the feed) otherwise.
EmDash keeps signed-in and preview responses out of Astro's route cache on
its own. If the site turns on Astro route caching, give `/articles`,
`/articles/[slug]`, `/topics/[slug]` and `/articles/rss.xml` route rules
tagged `articles`, so a publish invalidates them.
