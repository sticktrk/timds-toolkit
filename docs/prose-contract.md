# Keeping the shipped instructions in step with the toolkit

The toolkit ships more words than code paths: nine skills, the agent and
human files `init` scaffolds into a Design System, the EmDash site docs,
the README, and this repository's own agent notes. Every one of them makes
claims the source makes true or false, and each release that adds a command,
a flag, a managed file or a rule leaves a few of them behind. This page is
the procedure that stops that: what is checked mechanically, what a change
must carry, and how the periodic agent audit works.

## What is mechanical

`src/prose-contract.mjs` reads both sides and `src/prose-contract.test.mjs`
fails `npm test` on any difference. The surfaces it reads are listed in
`proseSurfaces`, each with its kind (`toolkit`, `scaffold`, `consumer`,
`hosted`), which decides where the paths it names must exist. The checks:

- **Commands and flags.** Every `timds ...` invocation inside inline code or
  a fenced block (in any of its spellings: `timds`, `timds-cli`, `npm run
  timds --`, `npx --yes @dtconcepts/timds@latest`, `__TIMDS_CLI__`) must be a
  command some `Usage:` text in `src/` lists, with flags that text gives it.
- **Usage texts agree.** Every module's own `Usage:` block must say what the
  public `--help` in `src/core.mjs` says for the same command, in both
  directions, except for a family `--help` delegates (`timds video --help`).
  Every top-level command the dispatcher accepts must have a usage line.
- **Coverage.** Every command in the usage texts is mentioned by at least one
  instruction surface.
- **Placeholders.** Every `__X__` in a rendered surface is one its renderer
  fills: `hostedSkillPlaceholders` for the hosted skill, the fill map in
  `src/consumer-init.mjs` for the consumer skills, the substitutions in
  `src/core.mjs` for the scaffolded docs.
- **MCP tool names.** Every `timds_*` name is registered by `src/mcp.mjs`.
- **Files.** A file path in inline code (under `src/`, `scripts/`, `.timds/`,
  `.github/`, `video/`, `templates/`, `skills/`, `.agents/`) exists where the
  reader will look: this repository for toolkit docs, the scaffold under
  `templates/` for Design System docs, or the files the source writes by name
  (`.timds/...` records, stamps, the EmDash scaffold's files).
- **Skills.** The directories under `skills/` are exactly the names the
  installers list, each with a matching frontmatter `name` and an
  `agents/openai.yaml` that invokes it.
- **Surfaces.** Every tracked Markdown file under `skills/`, `templates/` and
  `docs/` is either a listed surface or excluded with a reason.

What the source cannot be read for is declared once in `proseAllowances`,
each entry with its reason. Adding one is a reviewed change; removing a stale
one is expected.

## What a change must carry

`scripts/check-prose-impact.mjs` runs in CI on every pull request. It maps
each changed module to the surfaces that describe it (`proseOwnership`) and
fails when a module changed and none of its surfaces did. A commit in the
pull request may carry a `Prose-impact:` trailer saying why none is needed;
the trailer is printed in the job summary so the reviewer sees the claim.

```bash
node scripts/check-prose-impact.mjs --base origin/master
```

So the rule for a change is: a new command, flag, placeholder, skill,
`.timds/` file, MCP tool or managed file is not done until the surfaces in
`proseOwnership` say so, and the contract test will name the first thing you
missed. When you add a module, add its row to `proseOwnership`; when you add
an instruction file, add it to `proseSurfaces` with its kind.

## What is not mechanical

The checks read names, not meaning. A paragraph that describes the release
flow as "every merge becomes a patch release" with every command spelled
right passes them and is still wrong. That drift is caught two ways:

- **Review.** The impact check puts the affected surfaces in front of the
  reviewer; reading them against the change is part of the review.
- **The periodic audit.** Once a quarter, or after a run of releases that
  changed a workflow (versions, pins, a new starter), run the audit below. It
  was first run on 2026-11-06 across every surface and found 226 findings,
  of which 39 would have sent an agent down a wrong path; the mechanical
  checks above came out of its drift-prone fact types.

### Running the audit

Give one agent per surface group a read-only brief. Each brief names the
surface files, the source modules that make their claims true or false, the
`CHANGELOG.md` and recent tags for shipped features, and asks for a findings
table (`wrong`, `stale`, `missing`, `nit`, each with the surface line and
the source line), the categories of facts that drifted, and a verdict. The
groups that work:

1. `skills/timds-edit-design-system` against `src/core.mjs`, `src/mcp.mjs`,
   `src/designs.mjs`, `src/changelog.mjs`, `src/starter.mjs`, `src/media.mjs`
   and `templates/starter/`.
2. `skills/timds-create-video` against `src/video*.mjs`, `video/` and
   `templates/video/`.
3. The four `design-*` skills against the commands they run, `src/media.mjs`,
   `src/changelog.mjs`, `src/designs.mjs` and `src/hosted.mjs`.
4. The consumer skills and `templates/timds-consumer*`, `templates/emdash/`
   against `src/consumer*.mjs` and `src/mcp-read.mjs`.
5. The hosted skill against `src/hosted.mjs`, `src/auth.mjs`,
   `src/oauth.mjs` and `src/skills-install.mjs`.
6. The scaffolded `templates/design-system-*.md`, `templates/CHANGELOG.md`,
   `templates/media-local-README.md` and the stock workflows against `init`,
   `upgrade`, `starter sync` and the workflow YAML.
7. `CLAUDE.md`, `AGENTS.md`, `README.md`, `docs/` and the module-top comments
   against `package.json`, the dispatcher and the CI workflows.

Ask each agent to verify by running the commands where it can (a fresh
`init` in a scratch folder is cheap) and to say explicitly what it could not
verify. Fix `wrong` findings before the next release; fold `missing` ones
into the surface that owns the feature; turn any new drift-prone fact type
into a check here.
