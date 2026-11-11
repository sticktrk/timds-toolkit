# EmDash site: handover

This site was written by `timds consumer scaffold emdash --workspace` into
the Design System's workspace. It reads the system from its source paths
(see `DESIGN_SYSTEM.md`), runs on Cloudflare Workers, and commits no
resource name, resource id, origin or credential: whoever deploys it fills
those in. Writers target the contract in [content-api.md](content-api.md).

## What a build produces

```bash
npm ci
npm run build     # astro build: dist/server (the Worker) and dist/client (its static files)
npm run worker    # the build, then wrangler deploy --dry-run --outdir dist/worker
```

`npm run build` writes a complete Worker with no credentials:

- `dist/server/wrangler.json`, the deploy configuration Wrangler reads (a
  build also points `.wrangler/deploy/config.json` at it): the Worker name,
  `main`, the compatibility date `2026-02-24` with the `nodejs_compat` flag,
  the cron trigger, the static assets directory, and the bindings by name.
- `dist/server/entry.mjs` and its chunks, the Worker's code.
- `dist/client/`, the static files: Astro's assets and the Design System's
  stylesheets, scripts and assets, copied from the system at build time.

`npm run worker` also bundles the Worker into `dist/worker/` with Wrangler's
dry run and prints its bindings and size. It needs no Cloudflare account.
Before type-checking with `astro check`, run `npx wrangler types`: it writes
`worker-configuration.d.ts`, which declares the types `src/worker.ts` uses.
The gzip size is about 5 MB, above the 3 MB limit of the Workers Free plan:
deploy on a paid plan.

## Bindings

| Binding | Resource | Used for |
| --- | --- | --- |
| `DB` | D1 database | EmDash's content, users and settings |
| `MEDIA` | R2 bucket | Uploaded media, backups and transfers. Keep it private. |
| `SESSION` | KV namespace | Astro sessions, which EmDash's sign-in uses |

None carries a name or id in `wrangler.jsonc`. A platform that uploads the
Worker attaches its own resources to these names. With Wrangler,
`npx wrangler deploy` on a first deploy finds no resource for them and
creates one each, named `<worker>-db`, `<worker>-media` and
`<worker>-session` (Wrangler 4's automatic provisioning); later deploys of
the same Worker keep the resources it has. Run `npm run build` before it.

## Variables and secrets

| Name | Kind | Value |
| --- | --- | --- |
| `EMDASH_SITE_URL` | variable | The production origin. Setup and passkeys bind to it; canonical and feed URLs use it. Without it, every URL uses the address of the request. |
| `EMDASH_ENCRYPTION_KEY` | secret | `npx emdash secrets generate`. Encrypts plugin secrets in the database. Keep a copy outside Cloudflare: a database backup does not contain it. |
| `SCHEDULED_TASKS_SECRET` | secret | Any long random string. Only needed where the Worker has no Cron Trigger (below). |

Set secrets with `npx wrangler secret put NAME`, or through the platform that
uploads the Worker. Local development reads `.dev.vars`; `.env.example` lists
the same names.

## Migrations

`migrations.runtime` is `"check"`: a Worker whose database has pending core
migrations answers 503 instead of migrating on a visitor's request. Apply
them before the Worker goes live, after `npm run build` (the migrate command
reads `.emdash/migrations.json`), with `CLOUDFLARE_ACCOUNT_ID` and a
`CLOUDFLARE_API_TOKEN` with D1 Edit permission:

```bash
npx emdash migrate --d1 <database name or id> --status
npx emdash migrate --d1 <database name or id>
npx emdash migrate --d1 <database name or id> --check
```

`--d1` is required because `wrangler.jsonc` names no database. In CI the
non-interactive apply also needs `--expected-target-fingerprint` with the
fingerprint `--status` printed.

## Scheduled work

Scheduled publishing and maintenance run every minute from the cron trigger
through the Worker's `scheduled` handler (`src/worker.ts`). A platform that
uploads the Worker may give it no Cron Trigger; it calls the same work over
HTTP instead:

```bash
curl -X POST -H "Authorization: Bearer $SCHEDULED_TASKS_SECRET" https://<origin>/_scheduled
```

The answer is `{"published": N}`, the number of entries the run published.
The path answers 404, like a missing page, to any other method, to a wrong
or missing secret, and to every request while `SCHEDULED_TASKS_SECRET` is
unset. The secret is compared in constant time. Call it about once a minute.

## Handover checklist

1. [ ] Deploy, apply the migrations, and finish setup at `/_emdash/admin`
       on the production origin, never on a `workers.dev` or preview
       address: until setup is finished, the first visitor becomes the
       administrator. `EMDASH_SITE_URL` must already name that origin.
       **Decline the sample content** in the setup wizard.
2. [ ] Create the content writer's user (Author to publish its own
       articles, Editor to also create topics and bylines), sign in as it
       and create a personal access token with the scopes
       `content:read content:write media:write taxonomies:manage`. EmDash
       has no API or CLI for this, so it stays manual. Hand the token and
       [content-api.md](content-api.md) to the writer.
3. [ ] Back up `EMDASH_ENCRYPTION_KEY` outside Cloudflare.
4. [ ] Give the Worker a Cron Trigger, or have the platform call
       `POST /_scheduled` with `SCHEDULED_TASKS_SECRET` about once a minute.
5. [ ] Wire up or remove each posting form of the design. A form with no
       handler in `src/forms/` renders disabled and a POST to its address
       answers 405 (`DESIGN_SYSTEM.md`, "Forms").
6. [ ] Create one draft through the REST API with the writer's token,
       publish it, and confirm it appears at `/articles/<slug>/` without a
       rebuild; unpublish it and confirm the page answers 404.

To put Cloudflare Access in front of the admin, enable `auth: access({ … })`
in `astro.config.mjs` (EmDash's `access` from `@emdash-cms/cloudflare`) and
give the Access application all of `/_emdash/*`, with a bypass for
`/_emdash/api/media/file`, so covers and body images stay public.

## Caching

The article routes send `Cache-Control: private, no-store` to a signed-in
user or a preview link and `public, max-age=60` (one hour for the feed)
otherwise; the pages built from the design send `public, max-age=300`. They
are rendered on request, not prerendered: EmDash's middleware also runs for
prerendered pages, and with `migrations.runtime: "check"` it would answer
503 on a build machine whose local database has no migrations.
