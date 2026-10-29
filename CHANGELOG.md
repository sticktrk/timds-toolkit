# Changelog

## Unreleased

- Harden offshoot review findings: accept custom-renderer parent catalogs, maintain layout plumbing links, disable automatic install lifecycle scripts unless explicitly requested, make local source selection unambiguous, use lowercase child IDs and batched Git exports, reuse ancestry per workspace operation, check feed cleanliness before prompts, and expose the complete CLI flags.

- Add local offshoot creation with `shoot`, parent catalog updates with `feed`, and confirmed detachment with `sever`. Validate parent and designer-declared stock records, preserve authored grafts with rollback on failed checks, and expose lineage in derived readers and publication provenance. Local creation uses the npm distribution; binary selection remains an explicit adoption after creation.

- Website designs gain journeys: the pages a visitor moves through in order, declared in `design.json` as `journeys: [{ id, title, summary?, steps: [{ title, summary?, screens: [{ page, state?, label?, note? }], branches? }] }]`. `readDesignCatalog` validates every reference (a `page` must be a route the design has, a `state` one of that route's states, ids unique, at least one step with one screen) and refuses a design route under `/journeys/`, which is reserved. Each journey is built as a storyboard at `/designs/<design>/journeys/<id>/`: one section per step with its screens as the live page states in lazy same-origin frames at phone width (390px scaled to 0.62), numbered through the journey, branch screens in a second row marked "or", a link over each frame to the full page, and a caption with the label (the page title plus the state name when none is declared), the note, and the route and state; the `/designs/` directory lists each design's journeys as cards above its route table. `designs.json` carries every journey with its screens resolved to routes, states, and urls in visitor order (`journeyCount` beside the other counts, and in `index.json`), `list_designs` returns them so a consumer agent ports screens in that order, and `describe_system` counts them. Journeys are the expected way to add multi-step pages: the designer skills, the editing skill, the hosted skill, the MCP edit guide, the scaffolded `AGENTS.md`, and the sample design (which now declares one) say so; `check` warns, without failing, when a design has several pages or a route with states that no journey shows; the handoff brief lists the journeys that changed; and the consumer update skill has the developer port a journey's screens in its order and express every state it shows.

- Add `--json` to `timds upgrade` and `timds doctor` so a host job can read their results without parsing prose. `upgrade --json` prints one object on stdout (progress goes to stderr): the previous and selected toolkit versions, whether a `--version` selection ran, the managed files written and release automation files updated, the starter sync (files written, current, and customized, the catalog views, pages, and formats merged, and which customized files `starter sync --force` may replace), the publishing defaults available, the designs setup state, and the check the upgrade ran; a selection returns the selected release's own `upgrade --json` document and the checks that ran. A customized starter file is kept and listed under `starter.customized` with the result still a success; a refused or failed upgrade exits non-zero and still prints `{ "ok": false, "error": { "code", "message" } }`, with a code a host job can branch on (`managed_file_conflict`, `dirty_worktree`, `unsupported_requirement`, `install_failed`, `dependency_check_failed`, `check_failed`, `upgrade_failed`) and the step a selection stopped at. `doctor --json` prints the report's facts: roots, system id, name and version, toolkit selected and running (binary or npm), starter record state, media assets, designs, video, consumer, branch, brand kit, and bundle. The prose output is unchanged without the flag.

- Make how to use a published system obvious. The starter's Use view gains an Install page, listed first so the view opens on it: a chooser by job, then four numbered steps with copyable snippets filled with the system's own published address and id in a browser. One address (`llms.txt` or `llms-full.txt`) for a one-off; the `timds-design-system-read` MCP entry for Claude Code, Codex, Cursor, Gemini CLI, VS Code, any stdio client, or a host's HTTP `/mcp`, on tabs; `consumer init` for a product; `skills install` for changing the system; and what each way does on a new release. A page in `src/site.json` may now carry `"promote"`, a label the viewer links as a call to action in the app bar of every page; the starter promotes Install as "Use this system". The overview opens with a "Use this system" band: the paste-one-address line and three ways in. The viewer now appends one script to every page (fills of `data-root`, `data-origin` and `data-system-id`, tabs from `data-tabs`, copy buttons on `pre[data-copy]`), and its stylesheet gains the call to action, the start band, step numbers, tabs and copy strips. The starter sync owns the new fragment the way it owns the Use page.

- Add `timds systems` (and the `timds_systems` MCP tool): list every hosted Design System the signed-in person can see, with its id and name, for the selected or saved host. Give the hosted skill a "Switching" section: another session of the same system goes in a new folder beside the current one, and another system means `timds systems`, then `skills install` for that system. The edit skill names the command too.
- Keep installed skills current: the hosted skill has the agent rerun `timds skills install` for its host and system at the start of each conversation, and every hosted CLI command prints one line after its output when the nearest `.timds/skills.json` (this folder, its parents, then the global record) was written by an older release than the one running.

- Require Developer ID signing and Apple notarization for macOS releases, covering the launcher and every bundled native executable and library. Verify Apple's accepted code hashes before publishing, then check a quarantined download on a separate Mac runner. Pull request builds retain local ad-hoc signing.

- Add the `timds-hosted-design-system` skill template under `skills/`, with its `agents/openai.yaml`: how an agent with a shell contributes to a hosted Design System through the CLI at `@latest`, from sign-in and `whoami` through starting, joining or drafting a session, claiming files, the `dev`/`check`/`pull`/`update --resolve` loop, and `submit`, and what it must never do unless the designer asks. It no longer mentions MCP, and the `__MCP_URL__` placeholder is gone; the remaining placeholders are `__SKILL_NAME__`, `__SYSTEM_NAME__`, `__SYSTEM_ID__`, `__HOST_ORIGIN__` and `__STUDIO_URL__`. A host serves it filled in.
- Add `timds skills install`: copy the designer skills (the editing procedure, `design-start`, `design-media`, `design-ship`, `design-handoff`, and, with `--portal-url` and `--system-id`, the hosted skill rendered for that system) into `.agents/skills/`, `.claude/skills/` and `.cursor/skills/` of the current folder or, with `--global`, of the home folder. Digests in `.timds/skills.json` let a rerun at `@latest` refresh unmodified files and rerender recorded systems while keeping edits unless `--force`.
- Steer the edit skill's hosted sessions to the TimDS CLI only: `timds start`, `join`, `pull`, `update`, `submit`, `claim`, `active-work`, `whoami`, `principals`, `draft create|list|close` and `sessions close`, run as `npm run timds --` in a Design System repository and as `@dtconcepts/timds@latest` elsewhere. The join, claim, intent, conflict, draft and credential rules are unchanged.
- Add `timds whoami` and `timds principals` (and the matching MCP tools) so a caller can report its own principal id and an owner can find who to invite. Let `timds join` take a Studio invite link: it uses the link's host, signs in there when needed and attaches in a new session folder. Print the workspace and next steps after `join`, name a new `--root` when the destination is not empty, and tell editing agents to join a named open session instead of starting another.
- Make hosted setup reuse saved authentication and remember the login host for new workspaces. Show workspace-fetch progress and next steps, support Git-free hosted doctor checks and `dev --port`, and explain busy preview ports.

- Let `timds auth login` discover an independent host's OAuth authorization, use a public PKCE loopback client, and refresh origin-bound credentials. Keep the portal device flow, add explicit flow and headless controls, and select the workspace host consistently for login, status and logout.
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
