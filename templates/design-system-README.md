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
On a fresh workstation, restore a published original with:

```bash
__TIMDS_CLI__ assets pull founder-interview
```

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

Submission creates a draft pull request. A DT Concepts operator separately controls live publication and rollback.

## Linked consumer repository

When `timds.json` declares a `consumer`, releases publish and tag this Design
System first, then open or refresh a pull request that advances the consumer's
pinned `design-system` gitlink. Configure a `TIMDS_CONSUMER_TOKEN` repository
secret with contents and pull-request access to that consumer repository.

The consumer owns only its `.gitmodules` record and reviewed gitlink. Prefer a
same-host relative URL such as `../client-design-system.git`, so authenticated
HTTPS and SSH clones both resolve within the organization.

Day-to-day changes go under `## Unreleased` in `CHANGELOG.md`. Cut a release
with `./scripts/release.sh`; the release workflow publishes, tags, and then
offers the consumer update as separate reviewable work.

## Toolkit upgrades

The repository selects the bounded TimDS `0.1.x` package line and commits its
resolved lockfile. It keeps only the repository-local AI skill and installation
record in Git. When a DT Concepts operator selects a new release line, keep the
package requirement at `0.1.x` and update the resolved lockfile before syncing
those managed files:

```bash
npm update @dtconcepts/timds
npm run timds -- upgrade --root .
```

The CLI runs from `node_modules`; do not commit that directory or a copied
`.timds/cli` tree. The upgrade does not rewrite this Design System's manifest,
tokens, media catalog, authored source, framework configuration, documentation,
or generated artifact. Review and commit the tooling diff separately.
