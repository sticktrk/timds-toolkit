# Claude Code instructions

@AGENTS.md

Claude Code loads this file rather than `AGENTS.md`. The import above is the
whole contract, so add rules to `AGENTS.md` and keep this file a pointer.

The managed TimDS skills live in `__SKILLS_PATH__`. Read
`timds-edit-design-system/SKILL.md` there before design work and
`timds-create-video/SKILL.md` before video work. The designer skills beside
them (`design-start`, `design-media`, `design-ship`, `design-handoff`) are
slash commands through the `.claude/skills` link; use them for the moments
they name so the designer never has to run the toolkit.
