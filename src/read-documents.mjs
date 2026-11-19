// Pure operations on published Design System documents.

/**
 * The brand roles every consumer can ask for by name, with the token names
 * that fill each one by convention when `timds.json brand.roles` does not say
 * otherwise. Candidates are tried in order against the document scope and
 * must have the role's kind. The vocabulary mirrors the video contract's
 * brand block so one name means one thing everywhere.
 */
export const BRAND_ROLES = Object.freeze({
  "color.background": ["--color-background", "--color-canvas", "--background", "--canvas", "--color-bg", "--bg"],
  "color.panel": ["--color-panel", "--color-surface", "--panel", "--surface"],
  "color.accent": ["--color-accent", "--accent", "--color-primary", "--primary", "--brand"],
  "color.text": ["--color-text", "--color-ink", "--text", "--ink", "--color-fg", "--fg"],
  "color.muted": ["--color-muted", "--color-text-muted", "--muted", "--text-muted"],
  "font.display": ["--font-display", "--font-heading", "--font-headline", "--font-serif", "--display"],
  "font.body": ["--font-body", "--font-text", "--font-sans", "--body"],
  "font.ui": ["--font-ui", "--font-sans", "--font-body", "--ui"],
});

/** One block as Markdown, heading included — the unit a guidance group or a citation hands to an agent. */
export function blockToMarkdown(block) {
  const lines = [];
  const anchor = block.id.includes("#") ? block.id.slice(block.id.indexOf("#") + 1) : block.id;
  lines.push(`## ${block.title || anchor}   \`#${anchor}\``, "");
  if (block.intro) lines.push(block.intro, "");
  for (const table of block.specs ?? []) {
    const columns = table.columns.length ? table.columns : Object.keys(table.rows[0].fields);
    lines.push(`| ${columns.join(" | ")} |`, `| ${columns.map(() => "---").join(" | ")} |`);
    for (const row of table.rows) {
      const source = row.markdown ?? row.fields;
      lines.push(`| ${columns.map((column) => String(source[column] ?? "").replace(/\|/g, "\\|")).join(" | ")} |`);
    }
    lines.push("");
  }
  for (const note of block.notes ?? []) lines.push(`> **Note.** ${note.text}`, "");
  for (const entry of block.code ?? []) lines.push("```", entry.text, "```", "");
  if (block.assets?.length) {
    lines.push("| Asset | Media key | Notes |", "| --- | --- | --- |");
    for (const asset of block.assets) {
      const brand = asset.brand
        ? [asset.brand.role, asset.brand.primary ? "primary" : null, asset.brand.variant, asset.brand.lockup, asset.brand.on ? `on ${asset.brand.on}` : null].filter(Boolean).join(" ")
        : null;
      const detail = [brand ? `**${brand}**` : null, ...(asset.lines ?? [])].filter(Boolean).join(" · ").replace(/\|/g, "\\|");
      lines.push(`| ${asset.name} | \`${asset.media.key ?? "—"}\` | ${detail} |`);
    }
    lines.push("");
  }
  for (const entry of block.prose ?? []) lines.push(entry.text, "");
  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}

export function pageToMarkdown(page) {
  const lines = [`# ${page.title || page.id}`, ""];
  if (page.eyebrow) lines.push(`*${page.eyebrow}*`, "");
  if (page.lede) lines.push(page.lede, "");
  lines.push(`<!-- source: ${page.url} · id: ${page.id} -->`, "");
  for (const block of page.blocks) lines.push(blockToMarkdown(block));
  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}

/** One-line readiness of a brand kit, for `doctor` and for a consumer deciding whether the kit is usable. */
export function summarizeBrandKit(kit) {
  if (!kit) return null;
  const filled = Object.keys(kit.roles ?? {});
  const missing = kit.missingRoles ?? [];
  return {
    version: kit.system?.version ?? null,
    roles: { filled: filled.length, missing, total: filled.length + missing.length },
    logos: (kit.logos ?? []).length,
    primaryLogo: (kit.logos ?? []).find((logo) => logo.primary)?.name ?? null,
    imagery: (kit.imagery ?? []).length,
    guidance: Object.keys(kit.guidance ?? {}),
  };
}

export const DEFAULT_STATE = "default";

/** A journey as a listing carries it: the steps and screens in visitor order, without the pages' HTML. */
function journeyListing(journey) {
  const screen = ({ route, state, label, note, url }) => ({ route, state, label, ...(note ? { note } : {}), url });
  return {
    id: journey.id,
    title: journey.title,
    ...(journey.summary ? { summary: journey.summary } : {}),
    url: journey.url,
    stepCount: journey.stepCount ?? journey.steps?.length ?? 0,
    screenCount: journey.screenCount ?? 0,
    steps: (journey.steps ?? []).map((step) => ({
      title: step.title,
      ...(step.summary ? { summary: step.summary } : {}),
      screens: (step.screens ?? []).map(screen),
      ...(step.branches?.length ? { branches: step.branches.map(screen) } : {}),
    })),
  };
}

/**
 * The directory of a designs document without the HTML, for listings: each
 * design's routes and states, and its journeys with the screens in the order
 * a visitor meets them (a document written before journeys lists none).
 */
export function designsDirectory(document) {
  return (document?.designs ?? []).map((design) => ({
    id: design.id,
    title: design.title,
    ...(design.summary ? { summary: design.summary } : {}),
    url: design.url,
    pageCount: design.pages?.length ?? 0,
    pages: (design.pages ?? []).map((page) => ({
      route: page.route,
      title: page.title,
      url: page.url,
      states: (page.states ?? []).map((state) => state.name),
    })),
    journeys: (design.journeys ?? []).map(journeyListing),
  }));
}

/** One page state of a designs document, by design id, route, and state name. */
export function findDesignPage(document, designId, route, state = DEFAULT_STATE) {
  const design = (document?.designs ?? []).find((candidate) => candidate.id === designId);
  if (!design) return { design: null, page: null, state: null };
  const normalized = String(route ?? "/").trim();
  const wanted = normalized.length > 1 ? `/${normalized.replace(/^\/+|\/+$/g, "")}` : "/";
  const page = design.pages.find((candidate) => candidate.route === wanted) ?? null;
  const found = page?.states.find((candidate) => candidate.name === (state || DEFAULT_STATE)) ?? null;
  return { design, page, state: found };
}
