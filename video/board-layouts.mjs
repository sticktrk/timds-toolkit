// Shared geometry and fit limits. Opt-in presets leave legacy catalogs alone.
// Both the schema resolver and Remotion components consume these definitions.
export const BOARD_LAYOUT_PRESETS = Object.freeze(["standard", "compact"]);
export function assertSharedBoardLayout(visual, preset, context) {
  const layout = resolveBoardLayout(preset, context);
  for (const [field, limits] of Object.entries(layout.fields[visual.kind] ?? {})) {
    if (Array.isArray(visual[field]) && visual[field].length > limits.maxItems) throw new Error(`shared board ${visual.kind}.${field} allows at most ${limits.maxItems} items in this layout`);
  }
  return layout;
}
export function resolveBoardLayout(preset = "standard", {vertical = false, overFootage = false} = {}) {
  if (!BOARD_LAYOUT_PRESETS.includes(preset)) throw new Error(`Unknown shared board layout ${preset}; choose ${BOARD_LAYOUT_PRESETS.join(", ")}`);
  const compact = preset === "compact";
  return {
    padding: vertical ? "330px 130px 440px 90px" : compact ? "150px 190px 210px" : "150px 150px 210px",
    scale: compact ? 0.9 : 1,
    scrim: overFootage ? (compact ? 82 : 74) : 100,
    // Column layouts need a smaller board than a full horizontal row.
    fields: vertical || overFootage
      ? {cards: {items: {maxItems: 3}}, flow: {nodes: {maxItems: 3}}, steps: {steps: {maxItems: 3}}}
      : {},
  };
}
