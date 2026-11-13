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

## Declared sections

`sections.json` lists each collection and its canonical address prefix.
Declaration version 2 supports nested literal prefixes within one selected
Design System, such as `/commercial-division/lease-faq/`; ordinary parent
and sibling pages remain public. Older declaration versions are refused.
`docs/content-api.md` lists the current entry addresses for writers. After
editing the declaration, run `npm run sections:sync` in the site and run
the consumer check at the workspace root. Commit the declaration, generated
seed and updated writer table together. The shared data in
`section-schema.json` supplies identical fields and features to
every collection, including preview, scheduling, search and SEO, and the
`topic` taxonomy attaches to all of them. Sync and build and the toolkit's
consumer check validate this same JSON; the check never executes site code.
Sync preserves authored topic labels, locale, translation group and terms,
unrelated taxonomy metadata and terms, and refuses to discard
an undeclared collection definition or its development content.
Every section must be routable. Sync writes `routable: true`; an explicit
false seed value is rejected before setup, while omission uses EmDash's true
default.

A first setup applies the seed. Once setup is complete, editing the seed
cannot create a new collection: create it through EmDash's schema API or
admin with every declared field, support and URL pattern, and add its name
to the topic taxonomy. A platform that supports section contract 2 can do
this additively before routing a deployment. The TimDS host refuses changes
to an existing collection's fields or features, including adding a field;
choose the shared schema before first creation. Never rename collections or
change stored patterns as an automatic migration. Removing a section only
removes its routes; retained content needs a separate explicit decision.
Writer scopes are global across collections.

TimDS hosted discovery acknowledges template 6, workspace 3, sections 2, composition 1 and tracking 1
before building. An older host without that acknowledgement is refused;
standalone builds do not require a host integration.

Verify each declared list, a published entry and every enabled feed at its
prefix. A missing collection fails the page instead of appearing as an empty
list. Topic pages merge all sections, newest first, with cursors that retain
a position for each collection.

## Contact forms and browser tags

Copy `src/forms/contact.ts.example` to `src/forms/contact.ts` to opt in.
If the site already has a handler for `/contact`, keep it and call
`contactPost(context)` from it where appropriate. The website design owns the
form and all visitor-facing copy. Give the form `method="post"`,
`action="/contact"` and `data-timds-contact`. Include `name` and at least one of
`email` or `phone`. The `message` field is optional. Set
`data-timds-contact-id` to a stable identifier, such as `article-sidebar`,
when multiple forms post to the same address. The script uses the form element
ID if set and the submission path otherwise. Set `data-timds-contact-success` and
`data-timds-contact-error` on the form. Add a child with
`data-timds-contact-status` and `role="status"` for the result.

Use the same `action="/contact"` in a shared sidebar, on an article, or in a
dialog added after the page loads. The single handler receives every POST to
that address. A GET page at `/contact` is optional. The site loads the form
script on each page, including custom Astro pages, and adds the site base
when a form uses a root-relative action in a mounted preview. Submit buttons
can live outside the form when their `form` attribute names it. The script
uses the clicked button's `formaction` and `formmethod` when supplied. It
announces `timds:contact-result` with `detail.ok` from the form.

Custom Astro layouts can include `SiteTracking.astro` for browser tags and
conversion reporting and public-page attribution. A custom client can POST
URL-encoded fields to the
site's contact endpoint with a stable UUID v4 in
`submission_id` and `analytics_consent=yes|no` or
`marketing_consent=yes|no` when a choice was made. Reuse the key and fields after an
uncertain response. A 200 response includes the committed receipt. For Meta
CAPI, the source URL uses the referring page when it is on the same origin,
with query parameters and fragments omitted.

Configure public IDs and the notification sender and recipient in
`src/lib/contact/config.ts`. Connect your consent UI by setting
`window.timdsConsent = { analytics, marketing }` to explicit booleans and
dispatching `new Event("timds:consent")` on `window` after a change.
The `requireConsent` feature flag defaults to `false`. Configured production
tags and conversions can run without a consent UI when the flag is off.
An explicit denial suppresses its category. With the flag on, GA4 requires
an analytics grant and Meta and Google Ads require a marketing grant.
Meta Pixel and CAPI use the same pixel and the same opaque Lead event ID.
Set a supported Meta Graph API version explicitly. For a dedicated test
event source, `meta.testEventCode` sends its CAPI events to Meta's Test
Events view. Use that event source's pixel ID for the browser too. Configure
Google Ads with its tag ID and conversion label, and GA4 with its measurement
ID. Optional Turnstile requires a widget in the design with action `contact`
and a `TURNSTILE_SECRET_KEY` binding. Enable `turnstile.required` to require
verification on the configured HTTPS site. Turnstile responses expire and
must be refreshed by the design before a subsequent submission.

The default `delivery: "test"` records leads and test jobs in D1 and makes no
email, advertising or webhook calls. Set `delivery: "production"` and set
`EMDASH_SITE_URL` to the public HTTPS origin to enable configured providers.
Production delivery and tag loading are suppressed in dev and private
staging. Use a sending-only Resend API key for a verified sending domain and a
Meta CAPI access token for the same event source as the pixel.

For standalone deployment, attach the site's D1 database and apply the
initial contact schema for a new site before routing traffic or starting cron:

```sh
npx wrangler d1 migrations apply DB --remote
npx wrangler secret put RESEND_API_KEY
npx wrangler secret put META_CAPI_ACCESS_TOKEN
npx wrangler secret put TURNSTILE_SECRET_KEY
```

Set only the bindings used by the site. The local dev handler prepares its
local schema automatically. When using TimDS Cloud, private staging verifies
the contact schema and an administrator configures bindings with
`timds site secrets set NAME --source-id UUID`. Check application with
`timds site secrets status --source-id UUID`.

Inspect `id`, `provider`, `status` and `failure` in `timds_contact_jobs`.
Scheduled work retries temporary failures with backoff. A failed job can be
redriven with an authenticated `POST /_scheduled/contact/redrive?job=JOB_ID`
using the same bearer as scheduled work. The original payload and delivery ID
are reused. Resend retries stop before its 24-hour idempotency window ends. The
contact lead remains in the site's database independently of provider
delivery.

### Optional webhook delivery

Set the public HTTPS receiver endpoint in `TIMDS_CONTACT_WEBHOOK_URL` and the
authentication header name in `TIMDS_CONTACT_WEBHOOK_HEADER`. Set its value
as the Worker secret `TIMDS_CONTACT_WEBHOOK_SECRET`. Keep credentials out of
the endpoint and site source. When using TimDS Cloud, use
`timds site webhook set --source-id UUID --endpoint URL --header NAME` to apply
all three as one revision. The command reads the secret from a hidden prompt
or `--stdin`. Check application with `timds site webhook status --source-id UUID`.

The Worker sends JSON with `submission_id`, `pageUrl`, `submittedAt`,
`formId`, `referrer`, `fields` (`fullName`, `email`, `phone`, `message`),
and `meta.first_touch` / `meta.last_touch` (`url`, `referrer`, `at`).
The submission UUID and server timestamp stay the same on retry. The
receiver must deduplicate by UUID and return a 2xx JSON response with
`accepted: true`. Accepted leads with `linked: false` or `duplicate: true`
are successful deliveries. Failed responses and redirects are retried,
starting after five minutes and capped at six hours between attempts. The
queue retains failures after 16 attempts. Requeue them by ID using
`timds site contact redrive JOB --source-id UUID` on TimDS Cloud or the
authenticated scheduled endpoint on a standalone site.

The receipt stores the public form page without its query or fragment.
If the client and same-origin HTTP referrer provide no valid page address,
it uses the public submission address. The browser records first touch for
up to 90 days in a first-party cookie and last touch in session storage.
Internal navigation preserves the session's last acquisition touch unless
a new campaign or external referrer is present. Analytics consent controls
touch storage and referral context. Marketing consent also governs `gclid`
and `fbclid`; the standard `utm_*` campaign fields require analytics consent.
The server checks that touch URLs share the public site origin. Missing
or refused browser storage and absent consent can leave touch values null.
Setting `attribution: false` in contact config disables attribution.

A queued job retains the endpoint and header revision it was created for.
Rotating the secret for the same endpoint and header preserves the queue.
If the receiver derives account identity from the secret, rotate it within
that account. Use a distinct destination endpoint for a different account.
If either changes, old jobs stay recoverable under the original destination
and cannot be redirected to the replacement. Inspect pending and failed
deliveries, oldest pending age and last success with
`timds site contact status --source-id UUID` on TimDS Cloud.

## Scheduled work

Scheduled publishing and maintenance run every minute from the cron trigger
through the Worker's `scheduled` handler (`src/worker.ts`). A platform that
uploads the Worker may give it no Cron Trigger; it calls the same work over
HTTP instead:

```bash
curl -X POST -H "Authorization: Bearer $SCHEDULED_TASKS_SECRET" https://<origin>/_scheduled
```

The answer counts published entries and claimed contact jobs.
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
       publish it, and confirm it appears at its section's `<prefix><slug>/` without a
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
