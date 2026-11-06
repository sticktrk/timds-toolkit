// The managed agent skill names, in one place. The Design System install
// (`init` and `upgrade` in core.mjs) copies every name in
// `designSystemSkillNames` under `.agents/skills/`; `timds skills install`
// (skills-install.mjs) copies the system-independent designer set,
// `installableSkillNames`, into the folder a designer's agent works from. The
// video skill is installed only into a Design System, by `video init` and the
// managed boundary, so it is not in the designer set. AGENTS.md names these
// lists; keep it accurate when one changes.

/** The four designer procedure skills. */
export const designerSkillNames = Object.freeze(["design-start", "design-media", "design-ship", "design-handoff"]);
/** Every skill a Design System repository carries under `.agents/skills/`. */
export const designSystemSkillNames = Object.freeze(["timds-edit-design-system", "timds-create-video", ...designerSkillNames]);
/** The skills `timds skills install` copies as they ship: the editing procedure and the designer set. */
export const installableSkillNames = Object.freeze(designSystemSkillNames.filter((name) => name !== "timds-create-video"));
