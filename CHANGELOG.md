# Changelog

## Unreleased

- Preserve Landing layout and promoted page actions in structure offshoots. Allow source-backed media catalog entries with an exact local path to omit a public URL, so captured inline marks reach native pages and the derived brand kit.

- Bring the brand-kit starter up to the current Use flow: Landing at `/use/`, a promoted Compose page at `/use/compose/` with all 24 formats across seven catalog groups, and corrected Install and example links. The kit keeps its overview at `/`, its slot-based content and its empty Designs directory. Foundation and channel pages now lead with visual previews and fold technical tables and slot evidence into Spec drawers. Starter sync recognizes the previously shipped fragments and advances unchanged page layout and promotion fields, while preserving authored content and home routing. Fresh-scaffold, upgrade, repeated-sync and browser rendering checks cover the kit.

- Fix twelve defects an audit of the instruction surfaces turned up in the code and templates. The stock dependency-upgrade workflow no longer rejects every upgrade PR on a starter-adopted system: its allowlist is read from the selected release (`isUpgradeWritePath` and `upgradeWriteBoundary` in core: the dependency selection, the managed boundary including the designer skills and the Claude skills link, the starter sync of either starter kind, the contract-group migration, and the rebuilt artifact) instead of a hand copy that predated the recurring sync. The stock consumer update workflow accepts dated Design System versions (`YYYY.MM.DD-N`, beside the legacy `MAJOR.MINOR.PATCH`) and moves a binary consumer's published pin with the exact verified `timds-cli` its installation record selects, instead of `npm ci`; the binary consumer install accepts every exact release the record may select, not only the `0.1.x` line. Hosted `active-work`, `principals`, `draft create|list|close` and `rollback` run before a workspace exists fall back to the saved login the way `whoami` and `systems` do. A consumer check always allows `.agents/skills/timds-update-design-system/`, derived from the consumer skill names beside `timds-consume-design-system`. A binary scaffold's `AGENTS.md` says `timds-cli upgrade --version EXACT_VERSION` (the placeholders are filled before the binary rendering), and its `media-local/README.md` is rendered for the executable too. The consume skill's "Designs to match" line reads the designs under the manifest's `designSystem.path`, relative to the app's folder, instead of a fixed `../design-system/`. `video lab --serve` passes `--python` and `--voice` to every render it starts. `timds video --help` prints the video help. The MCP editing guide lists the `.timds/stock.json` paths from the contract module (`STOCK_RECORD_PATH_KINDS`, `src/copy.json` included), and the refusal names the same list. The skill name lists have one source (`src/skill-names.mjs`), re-exported from core and `skills install`. A video contract's `brand.logo` and `brand.fontFiles[].path` accept `{ "mediaKey": "..." }` the way `brand.audio.bed` does: validation keeps the record, `video check` reports an unpublished key by field, and staging copies the published media under the brand root.

- Bring the scaffolded Design System docs, the EmDash site docs, the README, the contributor notes and the module headers up to the toolkit: the composer is the promoted page, `canvas.css` and `viewer.css` are plumbing starter sync replaces, `tokens/` and `media/` groups are the authored files, the merge-release and publish flows are standalone-only while an embedded system commits its `dist/`, the consumer pin is described with the published pin first, every viewer placeholder and derived file is listed, and the stock workflow headers say dated versions. `init` now renders `media-local/README.md` with the other docs, with a `__MEDIA_LOCAL__` placeholder for the staging path, so its example works in the embedded layout and in binary mode. This changelog is sectioned by release from 0.1.470 on.

## 0.1.491

- Make the starter scaffold the canonical structure for a Design System. Real client systems are now a source of ideas rather than a reference the starter mirrors: the golden-system drift script (`npm run golden-drift`) and the mirroring rules in `AGENTS.md` are gone, and the contributor guidance keeps only the rules that still apply when borrowing from any client system (structure, never content; no client names). Nothing changes in a scaffolded or adopted system.

- Lighten CI for pull requests. The validate job (tests, pack check, starter history) still runs on every pull request and master push, but the native executables and the shared upgrade proof run only when the change touches what they prove: binary scripts and modules or the lockfile for the executables; video, templates, skills, the starter and brand-kit modules, or the core module for the upgrade proof. A manual run does everything, and releases build and verify the executables in `release.yml` as before. A newer push to a pull request cancels that pull request's running checks.

- Show the brand before its code on the starter's pages. Each block on Components, Color, Typography, Spacing & shape, and the Digital, Social, and Print overviews now leads with its live preview and its rule in words, and folds the class names, token tables, markup, and catalog or stylesheet pointers into a closed `<details class="spec-drawer">` labelled "Spec" under it; the viewer stylesheet styles the drawer without script. Color gets a swatch grid, Typography a type-scale specimen, and Spacing a scale of bars, each a figure with its token table in the drawer. Repository paths leave the page prose; the overview no longer names the format catalog file. The derived layer is unchanged in substance: `extract` still harvests the drawer's tables, code, and notes, and now skips a `<summary>` label so it never appears as prose. The scaffolded `AGENTS.md` documents the drawer as part of a block.

## 0.1.490

- Make the front of every starter-based system a portal onto the system, with the composer one step behind it. The Use view's own page (`use`, "Start", declared `"layout": "landing"` in `src/site.json`, which the viewer renders without the side navigation and the previous/next links) is the landing: a hero on the ink with three finished pieces floating beside it at their catalog proportions and the counts of formats and views, rails of asset cards by type (social, digital, print) that open the composer on that format, the kit behind them (color, typography, spacing, components), how a piece is made in three steps, every other way in, and a closing call to action. Rows rise into view as they are scrolled to; on a desktop a rail is a plain grid that never scrolls on its own, a phone shows it sideways, and the app bar's call to action stays pinned while the views scroll. Nothing on it names a client, and its links to the client's own pages use the new `{{nearest:ID}}` placeholder (the page's address, or the view's first authored page, else the overview, while it is planned), so the page builds on a system, or a structure offshoot, that has not authored them yet. The composer moves to `use/compose` ("Make something with {{name}}", the promoted "Start making" in the app bar) and offers every format in `src/formats.json` as a preset, one tab per group, through the new `{{presets:GROUP}}` placeholder; `src/scripts/compose.js` opens on `?format=ID` when a card links there and states print sizes in inches. `{{count:formats|views|pages|designs}}` states a count a page would otherwise go stale on. Starter sync manages the new `src/pages/use/compose.html` beside the other Use pages, so an adopted system takes the portal and the composer on its next upgrade while those fragments are unmodified; a structure offshoot whose `.timds/stock.json` keeps the Use pages names all three, since the landing links the composer and Install by `{{page:ID}}`.

## 0.1.489

- Starter sync recognizes every stock version a release shipped of each managed file, not only the hash its record names. A system whose record moved past its files, such as one where a hosted repair reverted the page writes and kept the newer record, had its Use and Install pages still at an earlier release's stock bytes reported as its own page and never refreshed, so its Use page never gained the composer; the next upgrade now brings them to stock. Older stock viewers and viewer stylesheets are recognized the same way. `node scripts/check-starter-history.mjs` walks the release tags and fails when a shipped version is missing from the table, and CI runs it.

## 0.1.488

- Starter sync holds the stock pages (the Digital, Social and Print overviews and the Use pages) back while `scripts/viewer.mjs` or `scripts/build.mjs` is customized and kept, reporting each as `skipped` with a note naming the renderer, instead of writing a page the kept renderer cannot build and rolling the whole upgrade back on its own check. A hosted upgrade of such a system now lands its dependency, skill and record changes; `timds starter sync --force scripts/viewer.mjs` brings the pages in afterwards.

- Upgrade adopts contract groups (`tokens/`, `media/`, `.timds/contract-layout.json`) only when the migrated groups validate; a legacy `tokens.json` whose token value names a plain custom property, such as `var(--theme-body, var(--text))`, keeps the aggregate layout and the upgrade reports why under `contractMigration.reason` instead of failing its own check.

## 0.1.487

- Make a stock brand kit read like the ordinary starter: the foundation samples are the starter's own (serif display, sans body, a tinted canvas under white surfaces, the starter's card radius), the kit stylesheet no longer darkens the app bar and page navigation under a dark system preference while the content stays light, and consecutive slot placeholders render as one table with one header row instead of a header before every slot.

- Keep the starter viewer readable on a system whose values arrived out of order: the chrome's page title, h2 and lede are kept in order by the viewer stylesheet while an ordered scale passes through unchanged, and text set on the accent reads `color.accent-ink` when the system declares it. `check` now warns when the accent is nearly the text color, when it falls below 3:1 on the background, or when the fixed type scale puts a smaller step above a larger one; the tokens themselves are never rewritten.

## 0.1.486

- Preserve existing home routes during starter sync so customized installation guidance keeps working through upgrades. Keep the brand-name fallback visible when only the hidden logo variant is filled, including existing kits through shared canvas plumbing, and cover both regressions with upgrade and browser checks.

## 0.1.485

- Add the slot-driven `brand-kit` starter for reusable website-to-kit parents: nine channel views, 24 formats in four treatments, an empty Designs directory, and a public typed slot contract shared with the viewer. Copy and local media placeholders report stock fallbacks, show explicit evidence labels, and render safely on light or inverted palettes. Starter selection and sync retain each kind's catalogs and authored boundaries; structure offshoots keep the composer and explicitly declared copy data. The shared Use composer, authoring guidance, contract tests and rendering checks ship together.

## 0.1.484

- Preserve the parent's toolkit baseline when creating a structure offshoot, accept stock parents without a lockfile and additive source-export metadata, protect Git revision parsing, and keep no-op feed reports accurate. Reuse decoded source bytes and shared path/cleanliness rules, identify malformed published lineage by its URL, and type the full parent record separately from public lineage.

- Keep offshoot starter sync and upgrades available while catalogs or authored overview fragments have uncommitted edits, since those files are outside their write boundary. Protect case aliases of the parent record in hosted sessions and MCP editing.

- Harden offshoot review findings: accept custom-renderer parent catalogs, maintain layout plumbing links, disable automatic install lifecycle scripts unless explicitly requested, make local source selection unambiguous, use lowercase child IDs and batched Git exports, reuse ancestry per workspace operation, check feed cleanliness before prompts, and expose the complete CLI flags.

- Add local offshoot creation with `shoot`, parent catalog updates with `feed`, and confirmed detachment with `sever`. Validate parent and designer-declared stock records, preserve authored grafts with rollback on failed checks, and expose lineage in derived readers and publication provenance. Local creation uses the npm distribution; binary selection remains an explicit adoption after creation.

## 0.1.483

- Register consumer followers and validate approved pin updates, and align consumer receipt labels with the host contract (pull requests #118 and #119).

## 0.1.482

- Website designs gain journeys: the pages a visitor moves through in order, declared in `design.json` as `journeys: [{ id, title, summary?, steps: [{ title, summary?, screens: [{ page, state?, label?, note? }], branches? }] }]`. `readDesignCatalog` validates every reference (a `page` must be a route the design has, a `state` one of that route's states, ids unique, at least one step with one screen) and refuses a design route under `/journeys/`, which is reserved. Each journey is built as a storyboard at `/designs/<design>/journeys/<id>/`: one section per step with its screens as the live page states in lazy same-origin frames at phone width (390px scaled to 0.62), numbered through the journey, branch screens in a second row marked "or", a link over each frame to the full page, and a caption with the label (the page title plus the state name when none is declared), the note, and the route and state; the `/designs/` directory lists each design's journeys as cards above its route table. `designs.json` carries every journey with its screens resolved to routes, states, and urls in visitor order (`journeyCount` beside the other counts, and in `index.json`), `list_designs` returns them so a consumer agent ports screens in that order, and `describe_system` counts them. Journeys are the expected way to add multi-step pages: the designer skills, the editing skill, the hosted skill, the MCP edit guide, the scaffolded `AGENTS.md`, and the sample design (which now declares one) say so; `check` warns, without failing, when a design has several pages or a route with states that no journey shows; the handoff brief lists the journeys that changed; and the consumer update skill has the developer port a journey's screens in its order and express every state it shows.

## 0.1.481

- Add `--json` to `timds upgrade` and `timds doctor` so a host job can read their results without parsing prose. `upgrade --json` prints one object on stdout (progress goes to stderr): the previous and selected toolkit versions, whether a `--version` selection ran, the managed files written and release automation files updated, the starter sync (files written, current, and customized, the catalog views, pages, and formats merged, and which customized files `starter sync --force` may replace), the publishing defaults available, the designs setup state, and the check the upgrade ran; a selection returns the selected release's own `upgrade --json` document and the checks that ran. A customized starter file is kept and listed under `starter.customized` with the result still a success; a refused or failed upgrade exits non-zero and still prints `{ "ok": false, "error": { "code", "message" } }`, with a code a host job can branch on (`managed_file_conflict`, `dirty_worktree`, `unsupported_requirement`, `install_failed`, `dependency_check_failed`, `check_failed`, `upgrade_failed`) and the step a selection stopped at. `doctor --json` prints the report's facts: roots, system id, name and version, toolkit selected and running (binary or npm), starter record state, media assets, designs, video, consumer, branch, brand kit, and bundle. The prose output is unchanged without the flag.

- Make how to use a published system obvious. The starter's Use view gains an Install page, listed first so the view opens on it: a chooser by job, then four numbered steps with copyable snippets filled with the system's own published address and id in a browser. One address (`llms.txt` or `llms-full.txt`) for a one-off; the `timds-design-system-read` MCP entry for Claude Code, Codex, Cursor, Gemini CLI, VS Code, any stdio client, or a host's HTTP `/mcp`, on tabs; `consumer init` for a product; `skills install` for changing the system; and what each way does on a new release. A page in `src/site.json` may now carry `"promote"`, a label the viewer links as a call to action in the app bar of every page; the starter promotes Install as "Use this system". The overview opens with a "Use this system" band: the paste-one-address line and three ways in. The viewer now appends one script to every page (fills of `data-root`, `data-origin` and `data-system-id`, tabs from `data-tabs`, copy buttons on `pre[data-copy]`), and its stylesheet gains the call to action, the start band, step numbers, tabs and copy strips. The starter sync owns the new fragment the way it owns the Use page.

## 0.1.480

- Add `timds systems` (and the `timds_systems` MCP tool): list every hosted Design System the signed-in person can see, with its id and name, for the selected or saved host. Give the hosted skill a "Switching" section: another session of the same system goes in a new folder beside the current one, and another system means `timds systems`, then `skills install` for that system. The edit skill names the command too.

- Keep installed skills current: the hosted skill has the agent rerun `timds skills install` for its host and system at the start of each conversation, and every hosted CLI command prints one line after its output when the nearest `.timds/skills.json` (this folder, its parents, then the global record) was written by an older release than the one running.

## 0.1.479

- Require Developer ID signing and Apple notarization for macOS releases, covering the launcher and every bundled native executable and library. Verify Apple's accepted code hashes before publishing, then check a quarantined download on a separate Mac runner. Pull request builds retain local ad-hoc signing.

## 0.1.478

- Ship the standalone `timds-cli` executable with exact binary workspace pins: explicit binary workspace mode, binary selections enforced across the hosted and consumer APIs, clean binary workflows, and a read-only migration preflight (pull request #112).

## 0.1.477

- Add `timds skills install`: copy the designer skills (the editing procedure, `design-start`, `design-media`, `design-ship`, `design-handoff`, and, with `--portal-url` and `--system-id`, the hosted skill rendered for that system) into `.agents/skills/`, `.claude/skills/` and `.cursor/skills/` of the current folder or, with `--global`, of the home folder. Digests in `.timds/skills.json` let a rerun at `@latest` refresh unmodified files and rerender recorded systems while keeping edits unless `--force`.

- Steer the edit skill's hosted sessions to the TimDS CLI only: `timds start`, `join`, `pull`, `update`, `submit`, `claim`, `active-work`, `whoami`, `principals`, `draft create|list|close` and `sessions close`, run as `npm run timds --` in a Design System repository and as `@dtconcepts/timds@latest` elsewhere. The join, claim, intent, conflict, draft and credential rules are unchanged.

## 0.1.476

- Add a dry-run check of npm trusted publishing to the release workflow (pull request #108).

## 0.1.475

- Point the package metadata at the `sticktrk/timds-toolkit` repository (pull request #107).

## 0.1.474

- Add the `timds-hosted-design-system` skill template under `skills/`, with its `agents/openai.yaml`: how an agent with a shell contributes to a hosted Design System through the CLI at `@latest`, from sign-in and `whoami` through starting, joining or drafting a session, claiming files, the `dev`/`check`/`pull`/`update --resolve` loop, and `submit`, and what it must never do unless the designer asks. It no longer mentions MCP, and the `__MCP_URL__` placeholder is gone; the remaining placeholders are `__SKILL_NAME__`, `__SYSTEM_NAME__`, `__SYSTEM_ID__`, `__HOST_ORIGIN__` and `__STUDIO_URL__`. A host serves it filled in.

## 0.1.473

- Add `timds whoami` and `timds principals` (and the matching MCP tools) so a caller can report its own principal id and an owner can find who to invite. Let `timds join` take a Studio invite link: it uses the link's host, signs in there when needed and attaches in a new session folder. Print the workspace and next steps after `join`, name a new `--root` when the destination is not empty, and tell editing agents to join a named open session instead of starting another.

- Make hosted setup reuse saved authentication and remember the login host for new workspaces. Show workspace-fetch progress and next steps, support Git-free hosted doctor checks and `dev --port`, and explain busy preview ports.

## 0.1.472

- Use the Apache License 2.0 for the toolkit and complete hosted publication waits reliably (pull request #104).

## 0.1.471

- Let `timds auth login` discover an independent host's OAuth authorization, use a public PKCE loopback client, and refresh origin-bound credentials. Keep the portal device flow, add explicit flow and headless controls, and select the workspace host consistently for login, status and logout.

## 0.1.470

- Validate and retain the optional native live-preview HMR contract, with exact restart paths and unchanged full-restart defaults. Preserve the authored declaration through checks, upgrades, and release preparation.

## 0.1.469

- Keep hosted MCP bootstrap in its requested empty or interrupted workspace, including inside another repository. Bind session tools to that workspace and prevent pre-bootstrap editing from reaching ancestor files.

## 0.1.468

- Recover hosted update and submission edge timeouts with bounded retries of the exact original payload. Preserve ordinary conflict handling and avoid retrying unrelated operations.

## 0.1.467

- Make release validation's local Git fixtures use independent object transfers and bounded cleanup, avoiding runner-specific local clone and background-maintenance races while retaining the full test gate.

## 0.1.466

- Let consumers explicitly require CSS tokens with repeatable `consumer check --require-token=--NAME` flags. Check actual published or local draft bundle definitions and aliases, report missing tokens as normal check failures, and keep the tracked production pin untouched.
- Return compact local hosted MCP receipts after snapshot transfer, preserving revisions and exact conflicts without duplicating image bytes beyond the stdio transport limit. The version-1 host HTTP snapshot contract is unchanged.

## 0.1.465

- Resolve local draft consumer bundles relative to the source artifact entry, so systems published under a nested directory integrate correctly without moving the production pin.

## 0.1.464

- Add hosted multiplayer agent tools for advisory claims, active work, invited members, shared sessions, and named drafts. Preserve intent notes, rich key conflicts, and bounded stale-session rebase retries across the CLI and MCP.
- Split authored token and media contracts into mergeable group maps on initialization and upgrade. Validate references and retain generated aggregate views and the existing consumer bundle contract.
- Add local consumer draft integration and draft read MCP sources without moving the published production pin. Add optional query-string or hostname token previews, plus human rollback and updated workflow guidance.

- Export a host-independent three-way file-tree merge with key resolutions and conflict receipts. Add workspace-free publication stamps and release callbacks while preserving the schema-1 digest and anonymous public-root verification.

Validation: `npm test` and `npm run pack:check` are required before release.
