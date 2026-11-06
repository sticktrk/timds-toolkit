## Design System

This site's look comes from a TimDS Design System pinned at
`__DESIGN_SYSTEM_PATH__/`. Read `DESIGN_SYSTEM.md` before changing layouts,
components, or styles, and use the `timds-consume-design-system` skill for a
designer's change. A developer moves the pin to a new release and ports the
designs that changed with the `timds-update-design-system` skill. It
supersedes the "Visual character" notes above: `src/styles/theme.css` exists
and takes every color and font from the system.
