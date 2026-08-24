# Design System

__CONTRACT_DESCRIPTION__

## First local run

```bash
npm install
__TIMDS_CLI__ doctor
__TIMDS_CLI__ check
__TIMDS_CLI__ dev
```

`dev` starts the repository-declared authoring server. `preview` serves the
exact generated static artifact that TimDS will publish.

## Starter viewer

New contracts include a dependency-free starter viewer under `src/` and
deterministic Node.js commands under `scripts/`. The starter exists so the
contract builds and validates immediately; replace its neutral tokens and
examples with approved client foundations rather than treating them as brand
guidance. Later clones should use `npm ci` with the committed lockfile.

Declare framework-specific local commands as argument arrays in `timds.json`:

```json
{
  "workspace": {
    "install": ["npm", "ci"],
    "dev": ["npm", "run", "dev"],
    "build": ["npm", "run", "build"],
    "check": ["npm", "run", "check"]
  }
}
```

The commands execute only on a designer workstation or in isolated CI. TimDS never executes repository code during sync.

The design system should use the client repository's existing framework. For example, an Astro client site can declare commands that target the site package from this directory:

```json
{
  "workspace": {
    "install": ["npm", "--prefix", "../client-site", "ci"],
    "dev": ["npm", "--prefix", "../client-site", "run", "dev"],
    "build": ["npm", "--prefix", "../client-site", "run", "build:timds"]
  }
}
```

TimDS consumes only the resulting `__DIST_PATH__`; Astro or another framework remains a repository-owned authoring detail.

## Full-resolution public media and B-roll

Do not add large originals to Git or `dist/`. Put them under the ignored
`media-local/` workspace and give each one a stable logical key:

```bash
__TIMDS_CLI__ assets add media-local/interview.mp4 \
  --key founder-interview \
  --title "Founder interview" \
  --tags interview,b-roll
```

The authoring viewer reads the ignored local file. Authenticate once and upload
the staged file to public TimDS object storage:

```bash
__TIMDS_CLI__ auth login
__TIMDS_CLI__ assets publish
```

`submit` performs the publish step automatically before building and preparing
the pull request. Git receives only the stable public record in `media.json`.
TimDS uses `ffprobe` during `assets add` to record timed-media duration and video
dimensions. Backfill an older catalog from its stable public URLs without
re-uploading objects:

```bash
__TIMDS_CLI__ assets backfill-metadata
```

On a fresh workstation, restore a published original with:

```bash
__TIMDS_CLI__ assets pull founder-interview
```

## Optional video production

When `timds.json` enables `video`, this repository owns the client-specific
contract, asset choices, scripts, publishing data, captions, and production
records. The installed `@dtconcepts/timds` package supplies the video engine and
commands directly. An optional contract-owned `producer` block can supply
client role labels, structure, CTA copy, and asset vocabulary to TimDS's
programmatic producer/compiler without adding client runtime code:

```bash
__TIMDS_CLI__ video doctor
__TIMDS_CLI__ video check TOPIC
__TIMDS_CLI__ video studio TOPIC
__TIMDS_CLI__ video render TOPIC
```

TimDS supplies the default Remotion component set. If this client's visual
language needs different compositions, `video.components` may point to one
reviewed partial override module in the Design System. Do not create a second
package, copied Remotion runtime, rendering script, or per-topic TSX file.
Generated working files and review packages stay under ignored `video-local/`.

## Before review

```bash
__TIMDS_CLI__ check
__TIMDS_CLI__ preview
__TIMDS_CLI__ diff
```

When asked to submit the reviewed local change:

```bash
__TIMDS_CLI__ submit --message "Describe the design-system change"
```

Submission creates a draft pull request. In a standalone repository, an
operator's merge accepts the change for automatic patch publication; rollback
remains a separate operator decision.

## Linked consumer repository

When `timds.json` declares a `consumer`, every accepted change on `main`
becomes a patch release. CI synchronizes the version, publishes that exact
commit, then opens or refreshes a pull request that advances the consumer's
pinned `design-system` gitlink. Configure a `TIMDS_CONSUMER_TOKEN` repository
secret with contents and pull-request access to that consumer repository.

The consumer owns only its `.gitmodules` record and reviewed gitlink. Prefer a
same-host relative URL such as `../client-design-system.git`, so authenticated
HTTPS and SSH clones both resolve within the organization.

Day-to-day changes go under `## Unreleased` in `CHANGELOG.md`. Merging an
accepted change rolls those notes into the next patch automatically. Use
`./scripts/release.sh` only when intentionally preparing an explicit minor,
major, or selected version. Publication and the consumer update remain
separate, ordered CI work.

## Toolkit upgrades

The repository selects the bounded TimDS `0.1.x` package line and commits its
resolved lockfile. It keeps only the repository-local AI skills and installation
record in Git. When a DT Concepts operator selects a new release line, keep the
package requirement at `0.1.x` and update the resolved lockfile before syncing
those managed files:

```bash
npm update @dtconcepts/timds
npm run timds -- upgrade --root .
```

An older standalone repository adopts the managed automatic release flow with
`npm run timds -- upgrade --root . --auto-release`. The command refuses
customized release files unless replacement is explicitly forced.

The CLI runs from `node_modules`; do not commit that directory or a copied
`.timds/cli` tree. The upgrade does not rewrite this Design System's manifest,
tokens, media catalog, authored source, framework configuration, documentation,
or generated artifact. Review and commit the tooling diff separately.
