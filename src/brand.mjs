// Assemble the brand kit from what extract already derived.
//
// A consumer that wants to produce something on-brand needs one answer to
// "what does this system look like": the role colors and fonts (from the
// derived tokens) and the logos and imagery the pages present. Pages already
// show every logo variant and hero photograph; a `data-timds-role` annotation
// on that markup is all it takes for the same asset to reach the kit, so the
// kit is generated from the page a designer already maintains and never kept
// by hand.
//
//   <img src="/logo-white.svg" alt="White logo"
//        data-timds-role="logo primary" data-timds-variant="white"
//        data-timds-lockup="horizontal" data-timds-on="dark">
//
// The annotation may sit on the media element or any wrapper above it, so a
// figure, a grid cell, or the image itself all work. `logo` fills `logos`;
// any other role (`photo`, `illustration`, `graphic`, `icon`, `pattern`, …)
// fills `imagery` under that role. Flags after the role — `primary` today —
// mark the variant a consumer should reach for first.
//
// Guidance groups (voice, compliance, …) point at page blocks the same way
// the video authoring contract already does, and carry each block's Markdown
// so the kit answers "how does this brand speak" on its own.

import { attr } from "./html.mjs";

export const BRAND_KIT_SCHEMA_VERSION = 1;

/**
 * Guidance groups: the named sets of page blocks a consumer reads before
 * producing anything — how the brand speaks, what it may not claim. By
 * convention `voice` is the `brand/voice` page and `compliance` is every
 * page named `compliance`; `timds.json brand.guidance` overrides or adds a
 * group with explicit `page` or `page#block` references, which `check`
 * verifies against the extracted index so a citation never dangles.
 */
export const GUIDANCE_CONVENTIONS = Object.freeze({
  voice: (page) => page.id === "brand/voice",
  compliance: (page) => page.id === "compliance" || page.id.endsWith("/compliance"),
});
const GROUP_NAME = /^[a-z][a-z0-9-]*$/;
const BLOCK_REFERENCE = /^[a-z0-9][a-z0-9/._-]*(?:#[a-z0-9][a-z0-9._-]*)?$/i;

const ROLE_TOKEN = /^[a-z][a-z0-9-]*$/;
const ANNOTATION_ATTRIBUTES = ["variant", "lockup", "on", "tags"];

/** Parse the `data-timds-*` annotation on one element, or null when it has no role. */
export function parseAnnotation(node) {
  const raw = String(attr(node, "data-timds-role") ?? "").trim().toLowerCase();
  if (!raw) return null;
  const [role, ...flags] = raw.split(/\s+/);
  if (!ROLE_TOKEN.test(role)) return null;
  const annotation = { role };
  if (flags.includes("primary")) annotation.primary = true;
  for (const name of ANNOTATION_ATTRIBUTES) {
    const value = String(attr(node, `data-timds-${name}`) ?? "").trim().toLowerCase();
    if (!value) continue;
    annotation[name] = name === "tags" ? value.split(",").map((tag) => tag.trim()).filter(Boolean) : value;
  }
  return annotation;
}

/**
 * The annotation that applies to a media element: its own, else the nearest
 * annotated ancestor's. `parents` maps each node to its parent within the
 * block, so lookup stops at the block boundary.
 */
export function annotationFor(node, parents) {
  for (let current = node; current; current = parents.get(current)) {
    const annotation = parseAnnotation(current);
    if (annotation) return annotation;
  }
  return null;
}

/**
 * The brand kit: role colors and fonts plus every annotated logo and image,
 * each with its media record and the page block that presents it. An asset
 * shown on several pages appears once, under the first annotation found in
 * page order; a `primary` flag anywhere promotes it.
 */
export function buildBrandKit({ manifest, tokens, pages, renderBlock }) {
  const resolvedGuidance = resolveGuidance(pages, manifest.brand?.guidance ?? {}, renderBlock);
  if (resolvedGuidance.errors.length) throw new Error(`timds.json brand.guidance does not match the built pages:\n${resolvedGuidance.errors.map((error) => `- ${error}`).join("\n")}`);
  const logos = [];
  const imagery = [];
  const byUrl = new Map();
  for (const page of pages) {
    for (const block of page.blocks) {
      for (const asset of block.assets ?? []) {
        if (!asset.brand) continue;
        const key = `${asset.brand.role}|${asset.media.url}`;
        const existing = byUrl.get(key);
        if (existing) {
          if (asset.brand.primary) existing.primary = true;
          existing.citations.push(asset.id);
          continue;
        }
        const entry = {
          id: asset.id,
          // Caption names keep inline Markdown for the page mirror; the kit wants plain text.
          name: String(asset.name).replace(/\*\*|__|(?<!\\)[*_`]/g, "").trim(),
          ...asset.brand,
          ...(asset.lines?.length ? { notes: asset.lines } : {}),
          media: asset.media,
          page: page.id,
          block: block.id,
          citations: [asset.id],
        };
        byUrl.set(key, entry);
        (entry.role === "logo" ? logos : imagery).push(entry);
      }
    }
  }
  // A primary variant sorts first so a consumer that takes the first logo is right by default.
  const byPrimary = (left, right) => Number(Boolean(right.primary)) - Number(Boolean(left.primary));
  logos.sort(byPrimary);
  imagery.sort(byPrimary);

  const warnings = [...resolvedGuidance.warnings];
  if (!logos.length) warnings.push('no asset is annotated data-timds-role="logo"; the brand kit has no logo');

  const roles = {};
  for (const [role, entry] of Object.entries(tokens.roles ?? {})) roles[role] = { ...entry };

  return {
    kit: {
      schemaVersion: BRAND_KIT_SCHEMA_VERSION,
      system: { id: manifest.systemId, name: manifest.name, version: manifest.version },
      roles,
      ...(tokens.missingRoles?.length ? { missingRoles: tokens.missingRoles } : {}),
      logos,
      imagery,
      guidance: resolvedGuidance.guidance,
    },
    warnings,
  };
}

/** `timds.json brand.guidance`: group name → page or block references, validated. */
export function normalizeBrandGuidance(input) {
  if (input === undefined || input === null) return {};
  if (!input || Array.isArray(input) || typeof input !== "object") throw new Error("timds.json brand.guidance must be an object of group → block references");
  const guidance = {};
  for (const [group, raw] of Object.entries(input)) {
    if (!GROUP_NAME.test(group)) throw new Error(`timds.json brand.guidance ${group} must be a lowercase name such as voice or compliance`);
    const list = Array.isArray(raw) ? raw : [raw];
    const references = list.map((value) => String(value ?? "").trim()).filter(Boolean);
    if (!references.length) throw new Error(`timds.json brand.guidance ${group} must list at least one page or page#block reference`);
    for (const reference of references) {
      if (!BLOCK_REFERENCE.test(reference)) throw new Error(`timds.json brand.guidance ${group} reference ${reference} must be page or page#block`);
    }
    guidance[group] = references;
  }
  return guidance;
}

/**
 * Fill every guidance group from the extracted pages: manifest references
 * first, conventions for the rest. A manifest reference that resolves to
 * nothing is an error; an empty conventional `voice` is a warning, since
 * every brand has one somewhere.
 */
export function resolveGuidance(pages, mapping = {}, renderBlock = () => undefined) {
  const byPage = new Map(pages.map((page) => [page.id, page]));
  const entry = (page, block) => ({ id: block.id, page: page.id, title: block.title || "", ...(renderBlock(block) ? { markdown: renderBlock(block) } : {}) });
  const guidance = {};
  const errors = [];
  const warnings = [];
  for (const [group, references] of Object.entries(mapping)) {
    const blocks = [];
    for (const reference of references) {
      const [pageId, anchor] = reference.split("#", 2);
      const page = byPage.get(pageId);
      if (!page) {
        errors.push(`guidance group ${group} references ${reference}, but the artifact has no page ${pageId}`);
        continue;
      }
      const matched = anchor ? page.blocks.filter((block) => block.id === `${pageId}#${anchor}`) : page.blocks;
      if (!matched.length) {
        errors.push(`guidance group ${group} references ${reference}, but page ${pageId} has no block #${anchor}`);
        continue;
      }
      for (const block of matched) if (!blocks.some((existing) => existing.id === block.id)) blocks.push(entry(page, block));
    }
    guidance[group] = { source: "manifest", blocks };
  }
  for (const [group, matches] of Object.entries(GUIDANCE_CONVENTIONS)) {
    if (guidance[group]) continue;
    const blocks = pages.filter(matches).flatMap((page) => page.blocks.map((block) => entry(page, block)));
    if (blocks.length) guidance[group] = { source: "convention", blocks };
    else if (group === "voice") warnings.push("guidance group voice is empty: no brand/voice page; declare it in timds.json brand.guidance.voice");
  }
  return { guidance, errors, warnings };
}

/** Every media record in a kit, for publish-time URL rewriting. */
export function eachBrandKitMedia(kit, visit) {
  for (const entry of [...(kit.logos ?? []), ...(kit.imagery ?? [])]) if (entry?.media) visit(entry.media);
}
