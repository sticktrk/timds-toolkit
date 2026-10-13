# Changelog

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
