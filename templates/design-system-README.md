# Design System

__CONTRACT_DESCRIPTION__

## First local run

```bash
__TIMDS_CLI__ doctor
__TIMDS_CLI__ dev
```

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

## Full-resolution media and B-roll

Do not add large originals to Git or `dist/`. Upload them directly to TimDS object storage and commit only the stable `media.json` catalog record:

```bash
TIMDS_ACCESS_TOKEN=... __TIMDS_CLI__ assets add ~/Media/interview.mov \
  --rights client-owned \
  --visibility private \
  --title "Founder interview master" \
  --tags interview,b-roll
```

Use `--visibility public` only when the rights are known and the original is intended for stable public CDN delivery. Private media is downloaded into the ignored local cache when needed:

```bash
TIMDS_ACCESS_TOKEN=... __TIMDS_CLI__ assets pull ASSET_ID
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

## Toolkit upgrades

The repository pins a vendored TimDS CLI and AI skill so normal local work does
not depend on a global install. When a DT Concepts operator selects a new
release, upgrade those managed files with:

```bash
npx --yes @dtconcepts/timds@VERSION upgrade --root .
```

The upgrade does not rewrite this Design System's manifest, tokens, media
catalog, authored source, framework configuration, or generated artifact.
Review and commit the resulting tooling diff before using it elsewhere.
