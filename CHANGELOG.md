# Changelog

## Unreleased

- Add the `timds-hosted-design-system` skill template under `skills/`, with its `agents/openai.yaml`: how an agent with a shell contributes to a hosted Design System through the CLI at `@latest`, from sign-in and `whoami` through starting, joining or drafting a session, claiming files, the `dev`/`check`/`pull`/`update --resolve` loop, and `submit`, and what it must never do unless the designer asks. It no longer mentions MCP, and the `__MCP_URL__` placeholder is gone; the remaining placeholders are `__SKILL_NAME__`, `__SYSTEM_NAME__`, `__SYSTEM_ID__`, `__HOST_ORIGIN__` and `__STUDIO_URL__`. A host serves it filled in.
- Add `timds skills install`: copy the designer skills (the editing procedure, `design-start`, `design-media`, `design-ship`, `design-handoff`, and, with `--portal-url` and `--system-id`, the hosted skill rendered for that system) into `.agents/skills/`, `.claude/skills/` and `.cursor/skills/` of the current folder or, with `--global`, of the home folder. Digests in `.timds/skills.json` let a rerun at `@latest` refresh unmodified files and rerender recorded systems while keeping edits unless `--force`.
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
