// The Design System read surface as an MCP server for consumers.
//
// A consumer — a client's own agent, a render pipeline, a content team — reads
// the published derived layer (brand kit, tokens, guidance pages, media
// catalog) and never the authored source. The toolkit owns the tool
// definitions and every read against the derived documents; the host owns
// transport, identity, which systems a caller may read, which version each
// consumer has pinned, and where a reported gap is filed.
//
// One tool surface, two transports: `timds mcp read` serves it over stdio
// against the current checkout's `dist/` or a published base URL, and a host
// registers the same tools on its own server with
// `registerDesignSystemReadTools`, resolving each call's `systemId` and
// `version` to a derived layer.

import { promises as fs } from "node:fs";
import process from "node:process";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";
import { findRepositoryRoot, loadWorkspace, setOutputStream } from "./core.mjs";
import { fetchDerivedLayer, readDerivedLayer, summarizeBrandKit } from "./derived.mjs";
import { blockToMarkdown, pageToMarkdown } from "./extract.mjs";
import { readMediaCatalog } from "./media.mjs";
import { BRAND_ROLES } from "./tokens.mjs";

export const DESIGN_SYSTEM_READ_MCP_SERVER_NAME = "timds-design-system-read";
export const CONSUMER_GUIDE_URI = "timds://consumer-guide";
export const GAP_KINDS = Object.freeze(["missing-guidance", "missing-token", "missing-role", "missing-media", "incorrect", "other"]);

const TOKEN_KINDS = ["color", "font-family", "length", "gradient", "duration", "easing", "number", "other"];
const MAX_SEARCH_RESULTS = 25;
const MAX_SNIPPET_CHARS = 2_400;
const MAX_TOKENS_PER_CALL = 1_000;
const MAX_MEDIA_PER_CALL = 500;

// ---------------------------------------------------------------------------
// Consumer guide

const CONSUMER_GUIDE = `# Read a TimDS Design System through MCP

You are producing something for a client whose brand is defined by a TimDS
Design System. The \`timds-design-system-read\` tools serve that system's
published, derived layer: the brand kit, the design tokens, the guidance
pages, and the media catalog. Nothing here is editable; use it to be on-brand.

## Start

1. Call \`list_design_systems\` when more than one system may be in scope, then
   \`describe_system\` for the system you are producing for. It reports the
   version being served, the currently published version, and what the
   system contains.
2. The current published version is always served by default: the client
   wants the latest brand. Every result names the version it was read from.
   Pass \`version\` only when the user asks for a specific earlier release.
   When \`pinned\` is present it names the version the client's application
   is built against; mention it if the user is producing for that
   application and it trails the published version.

## Brand roles before raw tokens

- \`resolve_role\` answers "what color is the accent" and "what font are
  headings" by role: \`color.background\`, \`color.panel\`, \`color.accent\`,
  \`color.text\`, \`color.muted\`, \`font.display\`, \`font.body\`, \`font.ui\`.
  A role resolves to the token that fills it and the token's value. Prefer
  roles over guessing from token names.
- \`get_tokens\` lists the resolved CSS custom properties, filterable by name,
  kind, and scope (for example a dark-theme selector). Use the \`resolved\`
  value when you need a literal; use the \`name\` when the output is CSS that
  loads the system's stylesheets.
- An unfilled role is a gap in the system, not something to invent. Say so,
  and file it with \`report_gap\` when the user agrees.

## Logos, imagery, and media

- \`get_brand\` returns the logos and imagery the system presents, each with
  its role, variant, the background it is meant for (\`on\`), and a stable URL
  with integrity. Take the primary logo unless the context calls for a
  variant. Never draw, recolor, or stretch a mark.
- \`list_media\` lists the published media catalog by tag or kind: reviewed
  photography, B-roll, and audio with stable public URLs. Reference assets by
  their stable URL or key; never paste an expiring or private URL.
- Use only what the system presents. Stock, generated, or third-party imagery
  is off-brand unless the client's guidance allows it.

## Voice, compliance, and guidance

- \`search_guidance\` finds the guidance blocks that answer a question ("how
  do we refer to clients", "what may we not claim"). Guidance groups such as
  \`voice\` and \`compliance\` rank first; every result cites its page and
  block.
- \`read_page\` returns a whole page as Markdown when you need the full
  context. \`list_pages\` is the directory.
- Compliance guidance is binding. When copy you are asked to produce
  conflicts with it, say so instead of complying silently.

## When the system falls short

\`report_gap\` files one gap — missing guidance, an unfilled role, a token or
asset the system should have, or something that reads wrong — into the
client's request intake, stamped with the version it was observed on, for
the operator and designer to act on. File a gap when the user agrees it is
one; an identical gap is not filed twice, and opinions about style are not
gaps.

## Report the result

Cite what you used: the version, the roles and tokens, the assets by name, and
the guidance blocks by page. Name anything you could not resolve.
`;

/** The consumer guide: how an agent reads a Design System through these tools. */
export function consumerGuideText() {
  return CONSUMER_GUIDE;
}

// ---------------------------------------------------------------------------
// Reading the derived documents

function requireDocument(layer, name) {
  const document = layer?.[name];
  if (document === null || document === undefined) {
    const where = layer?.source?.kind === "published"
      ? `${name} has not been published for this system`
      : `${name} has not been derived yet; run timds check`;
    throw new Error(where);
  }
  return document;
}

function systemStamp(resolved) {
  const layer = resolved.layer;
  return {
    id: layer.system?.id ?? null,
    name: layer.system?.name ?? null,
    version: layer.system?.version ?? null,
    published: resolved.published ?? null,
    pinned: resolved.pinned ?? null,
    ...(layer.stale ? { stale: true } : {}),
    source: layer.source?.kind ?? null,
  };
}

function pageDirectory(index) {
  return (index?.pages ?? []).map((page) => ({
    id: page.id,
    title: page.title,
    url: page.url,
    view: page.view,
    ...(page.eyebrow ? { eyebrow: page.eyebrow } : {}),
    ...(page.lede ? { lede: page.lede } : {}),
    blockCount: page.blocks?.length ?? 0,
  }));
}

function guidanceSummary(kit) {
  return Object.fromEntries(Object.entries(kit?.guidance ?? {}).map(([group, entry]) => [group, {
    source: entry.source,
    blockCount: entry.blocks?.length ?? 0,
    blocks: (entry.blocks ?? []).map((block) => ({ id: block.id, page: block.page, title: block.title })),
  }]));
}

function findPage(index, reference) {
  const wanted = String(reference ?? "").trim();
  if (!wanted) return null;
  const candidates = new Set([wanted, wanted.replace(/^\/+/, ""), `/${wanted.replace(/^\/+/, "")}`]);
  return (index.pages ?? []).find((page) => candidates.has(page.id) || candidates.has(page.url)) ?? null;
}

function blockAnchor(blockId) {
  return blockId.includes("#") ? blockId.slice(blockId.indexOf("#") + 1) : blockId;
}

function findBlock(page, reference) {
  const wanted = String(reference ?? "").trim().replace(/^#/, "");
  return (page.blocks ?? []).find((block) => block.id === wanted || block.id === `${page.id}#${wanted}` || blockAnchor(block.id) === wanted) ?? null;
}

function truncate(text, max = MAX_SNIPPET_CHARS) {
  return text.length > max ? `${text.slice(0, max).trimEnd()}\n…` : text;
}

// ---------------------------------------------------------------------------
// Guidance search

function blockText(block) {
  const parts = [block.intro ?? ""];
  for (const table of block.specs ?? []) {
    for (const row of table.rows ?? []) parts.push(Object.values(row.fields ?? {}).join(" "));
  }
  for (const note of block.notes ?? []) parts.push(note.text ?? "");
  for (const entry of block.code ?? []) parts.push(entry.text ?? "");
  for (const asset of block.assets ?? []) parts.push(asset.name ?? "", ...(asset.lines ?? []));
  for (const entry of block.prose ?? []) parts.push(entry.text ?? "");
  return parts.join("\n");
}

function searchTerms(query) {
  return [...new Set(String(query).toLowerCase().split(/[^\p{L}\p{N}-]+/u).filter((term) => term.length >= 2))];
}

function countOccurrences(haystack, needle) {
  if (!needle) return 0;
  let count = 0;
  let position = haystack.indexOf(needle);
  while (position !== -1) {
    count += 1;
    position = haystack.indexOf(needle, position + needle.length);
  }
  return count;
}

/**
 * Rank the index's blocks against a query. Every term must appear somewhere
 * in the block or its page title; guidance-group membership and title hits
 * rank higher; the whole phrase ranks highest. Deterministic for a given layer.
 */
export function searchBlocks({ index, brand, query, group = null, limit = 8 }) {
  const terms = searchTerms(query);
  const phrase = String(query).toLowerCase().trim();
  if (!terms.length) return [];
  const groupsByBlock = new Map();
  for (const [name, entry] of Object.entries(brand?.guidance ?? {})) {
    for (const block of entry.blocks ?? []) {
      if (!groupsByBlock.has(block.id)) groupsByBlock.set(block.id, []);
      groupsByBlock.get(block.id).push(name);
    }
  }
  const results = [];
  for (const page of index?.pages ?? []) {
    const pageTitle = String(page.title ?? "").toLowerCase();
    for (const block of page.blocks ?? []) {
      const groups = groupsByBlock.get(block.id) ?? [];
      if (group && !groups.includes(group)) continue;
      const title = String(block.title ?? "").toLowerCase();
      const body = blockText(block).toLowerCase();
      let score = 0;
      let matchedTerms = 0;
      for (const term of terms) {
        const titleHits = countOccurrences(title, term);
        const bodyHits = countOccurrences(body, term);
        const pageHits = countOccurrences(pageTitle, term);
        if (titleHits + bodyHits + pageHits === 0) continue;
        matchedTerms += 1;
        score += titleHits * 4 + Math.min(bodyHits, 6) + pageHits;
      }
      if (matchedTerms < terms.length) continue;
      if (terms.length > 1 && (title.includes(phrase) || body.includes(phrase))) score += 6;
      if (groups.length) score += 2;
      results.push({
        page: page.id,
        pageTitle: page.title,
        url: page.url,
        block: block.id,
        title: block.title,
        groups,
        score,
        markdown: truncate(blockToMarkdown(block)),
      });
    }
  }
  results.sort((left, right) => right.score - left.score || left.page.localeCompare(right.page) || left.block.localeCompare(right.block));
  return results.slice(0, Math.min(limit, MAX_SEARCH_RESULTS));
}

// ---------------------------------------------------------------------------
// Role resolution

/** Resolve brand roles against a tokens document, with a hint for each unfilled role. */
export function resolveRoles(tokens, roles) {
  const resolved = {};
  for (const role of roles) {
    const entry = tokens.roles?.[role];
    if (entry) {
      resolved[role] = { filled: true, ...entry };
      continue;
    }
    const conventional = BRAND_ROLES[role] ?? null;
    const known = Object.hasOwn(BRAND_ROLES, role) || (tokens.missingRoles ?? []).includes(role);
    resolved[role] = {
      filled: false,
      known,
      ...(conventional ? { conventionalTokens: conventional } : {}),
      hint: known
        ? `${role} is unfilled in this version: the system declares none of its conventional tokens and timds.json does not map it. Treat it as a gap rather than choosing a value.`
        : `${role} is not a role this system defines. Known roles: ${Object.keys(BRAND_ROLES).join(", ")}${Object.keys(tokens.roles ?? {}).filter((name) => !Object.hasOwn(BRAND_ROLES, name)).map((name) => `, ${name}`).join("")}.`,
    };
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// MCP registration

function toolResult(value) {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
  };
}

function toolError(caught) {
  return {
    content: [{ type: "text", text: caught instanceof Error ? caught.message : String(caught || "Design System read tool failed") }],
    isError: true,
  };
}

const READ_ONLY = { destructiveHint: false, idempotentHint: true, openWorldHint: false, readOnlyHint: true };

function normalizeResolved(resolved) {
  if (!resolved?.layer?.system) throw new Error("The Design System could not be resolved");
  return {
    layer: resolved.layer,
    media: resolved.media ?? null,
    published: resolved.published ?? null,
    pinned: resolved.pinned ?? null,
  };
}

/**
 * Register the Design System read tools on an McpServer.
 *
 * `resolveSystem({ systemId, version })` returns `{ layer, media, published,
 * pinned }`: `layer` is a derived layer (see `readDerivedLayer` and
 * `fetchDerivedLayer`), `media` an optional media catalog (`{ assets }`),
 * `published` the version label currently published, and `pinned` the version
 * the caller's application is built against, when the host knows one, for
 * information only: the default served version is the published one. With
 * `hooks.remote` every tool takes an optional `systemId` (the host resolves a
 * missing one when the caller has exactly one system) and an optional
 * `version`; otherwise tools take only `version`. `listSystems()` backs
 * `list_design_systems`. `hooks.fileGap({ system, gap })` files a reported gap
 * and returns what the agent should be told; without it `report_gap` reports
 * that no intake exists.
 */
export function registerDesignSystemReadTools(server, { resolveSystem, listSystems, hooks = {} } = {}) {
  if (typeof resolveSystem !== "function") throw new Error("registerDesignSystemReadTools requires resolveSystem");
  const remote = Boolean(hooks.remote);
  const scopeShape = {
    ...(remote ? { systemId: z.string().min(1).max(300).optional().describe("The Design System's systemId from list_design_systems; may be omitted when only one system is in scope") } : {}),
    version: z.string().min(1).max(100).optional().describe("A specific version label. Defaults to the current published version"),
  };
  const systemFor = async (args) => normalizeResolved(await resolveSystem({
    systemId: remote ? args.systemId?.trim() || undefined : undefined,
    version: args.version?.trim() || undefined,
  }));
  const tool = (name, config, handler) => {
    server.registerTool(name, { ...config, inputSchema: { ...scopeShape, ...(config.inputSchema ?? {}) } }, async (args) => {
      try {
        return toolResult(await handler(args ?? {}));
      } catch (caught) {
        return toolError(caught);
      }
    });
  };

  server.registerTool("get_consumer_guide", {
    title: "Consumer guide",
    annotations: READ_ONLY,
    description: "Read how to use a TimDS Design System through these tools: roles before raw tokens, logos and media, guidance and compliance, versions, and when to report a gap. Read it before producing anything.",
    inputSchema: {},
  }, async () => toolResult({ uri: CONSUMER_GUIDE_URI, guide: consumerGuideText() }));

  server.registerTool("list_design_systems", {
    title: "List Design Systems",
    annotations: READ_ONLY,
    description: "List the Design Systems in scope: systemId, name, the published version, and the version the caller's application has pinned.",
    inputSchema: {},
  }, async () => {
    try {
      const systems = typeof listSystems === "function"
        ? await listSystems()
        : [await systemFor({})].map((resolved) => {
            const stamp = systemStamp(resolved);
            return { systemId: stamp.id, name: stamp.name, publishedVersion: stamp.published ?? stamp.version, pinnedVersion: stamp.pinned, source: stamp.source };
          });
      return toolResult({ total: systems.length, systems });
    } catch (caught) {
      return toolError(caught);
    }
  });

  tool("describe_system", {
    title: "Describe a Design System",
    annotations: READ_ONLY,
    description: "Describe a Design System at the served version: name, versions (served, pinned, published), page directory, token and role counts, brand kit summary, guidance groups, and media catalog size.",
  }, async (args) => {
    const resolved = await systemFor(args);
    const { layer } = resolved;
    const index = layer.index;
    const tokens = layer.tokens;
    const kit = layer.brand;
    return {
      system: systemStamp(resolved),
      derived: Boolean(layer.derived),
      provenance: layer.provenance ? { sourceCommit: layer.provenance.sourceCommit ?? null, version: layer.provenance.version ?? null } : null,
      pages: pageDirectory(index),
      tokens: tokens ? { count: tokens.count, kinds: tokens.kinds, roles: Object.keys(tokens.roles ?? {}), missingRoles: tokens.missingRoles ?? [], scopes: tokens.scopes?.length ?? 0 } : null,
      brand: kit ? { summary: summarizeBrandKit(kit), guidance: guidanceSummary(kit) } : null,
      media: { catalog: Boolean(resolved.media), assets: resolved.media?.assets?.length ?? 0 },
      llms: layer.llms ?? null,
    };
  });

  tool("get_brand", {
    title: "Brand kit",
    annotations: READ_ONLY,
    description: "The brand kit: every filled role with its token and value, unfilled roles, logos and imagery with their variants, intended backgrounds, and stable URLs, and the guidance groups. Read guidance text with search_guidance or read_page.",
  }, async (args) => {
    const resolved = await systemFor(args);
    const kit = requireDocument(resolved.layer, "brand");
    return {
      system: systemStamp(resolved),
      roles: kit.roles ?? {},
      missingRoles: kit.missingRoles ?? [],
      logos: kit.logos ?? [],
      imagery: kit.imagery ?? [],
      guidance: guidanceSummary(kit),
    };
  });

  tool("resolve_role", {
    title: "Resolve brand roles",
    annotations: READ_ONLY,
    description: "Resolve brand roles (color.background, color.panel, color.accent, color.text, color.muted, font.display, font.body, font.ui, or any role the system defines) to the token that fills each and its value. An unfilled role is reported as a gap with a hint, never a guessed value.",
    inputSchema: {
      role: z.string().min(1).max(100).optional().describe("One role, e.g. color.accent"),
      roles: z.array(z.string().min(1).max(100)).min(1).max(20).optional().describe("Several roles"),
    },
  }, async (args) => {
    const roles = [...new Set([...(args.role ? [args.role.trim()] : []), ...(args.roles ?? []).map((role) => role.trim())].filter(Boolean))];
    if (!roles.length) throw new Error("Pass role or roles");
    const resolved = await systemFor(args);
    const tokens = requireDocument(resolved.layer, "tokens");
    return {
      system: systemStamp(resolved),
      roles: resolveRoles(tokens, roles),
      availableRoles: Object.keys(tokens.roles ?? {}),
    };
  });

  tool("get_tokens", {
    title: "Design tokens",
    annotations: READ_ONLY,
    description: "The resolved CSS custom properties, filterable by name substring, kind, and scope selector. Each token carries its declared value, the resolved literal, kind, selector, conditions, and whether it is a base (:root) declaration.",
    inputSchema: {
      query: z.string().min(1).max(200).optional().describe("Only tokens whose name contains this text, e.g. gold or --space"),
      kind: z.enum(TOKEN_KINDS).optional().describe("Only tokens of this kind"),
      scope: z.string().min(1).max(300).optional().describe("Only declarations under this exact selector, e.g. :root or [data-theme=dark]"),
      baseOnly: z.boolean().optional().describe("Only unconditional :root declarations (the document scope roles are filled from)"),
      limit: z.number().int().min(1).max(MAX_TOKENS_PER_CALL).optional().describe(`Maximum tokens returned; defaults to 200`),
    },
  }, async (args) => {
    const resolved = await systemFor(args);
    const document = requireDocument(resolved.layer, "tokens");
    const query = args.query?.trim().toLowerCase();
    const scope = args.scope?.trim();
    let tokens = document.tokens ?? [];
    if (query) tokens = tokens.filter((token) => token.name.toLowerCase().includes(query));
    if (args.kind) tokens = tokens.filter((token) => token.kind === args.kind);
    if (scope) tokens = tokens.filter((token) => token.selector === scope);
    if (args.baseOnly) tokens = tokens.filter((token) => token.base);
    const limit = args.limit ?? 200;
    return {
      system: systemStamp(resolved),
      total: tokens.length,
      returned: Math.min(tokens.length, limit),
      truncated: tokens.length > limit,
      kinds: document.kinds ?? {},
      scopes: document.scopes ?? [],
      tokens: tokens.slice(0, limit).map((token) => ({
        name: token.name,
        value: token.value,
        resolved: token.resolved,
        kind: token.kind,
        selector: token.selector,
        condition: token.condition ?? [],
        base: Boolean(token.base),
        source: token.source,
        ...(token.unresolved?.length ? { unresolved: token.unresolved } : {}),
      })),
    };
  });

  tool("list_pages", {
    title: "List pages",
    annotations: READ_ONLY,
    description: "The page directory: id, title, url, view, eyebrow, lede, and block count for every page in the system.",
  }, async (args) => {
    const resolved = await systemFor(args);
    const index = requireDocument(resolved.layer, "index");
    const pages = pageDirectory(index);
    return { system: systemStamp(resolved), total: pages.length, pages };
  });

  tool("read_page", {
    title: "Read a page",
    annotations: READ_ONLY,
    description: "Read one page, or one block of it, as Markdown (default) or as structured blocks. Address the page by id (brand/voice) or url.",
    inputSchema: {
      page: z.string().min(1).max(300).describe("Page id or url"),
      block: z.string().min(1).max(300).optional().describe("Only this block, by anchor or full block id"),
      format: z.enum(["markdown", "blocks"]).optional().describe("markdown (default) or blocks"),
    },
  }, async (args) => {
    const resolved = await systemFor(args);
    const index = requireDocument(resolved.layer, "index");
    const page = findPage(index, args.page);
    if (!page) throw new Error(`No page ${JSON.stringify(args.page)}; list_pages shows the directory`);
    const format = args.format ?? "markdown";
    const header = { system: systemStamp(resolved), page: { id: page.id, title: page.title, url: page.url }, format };
    if (args.block) {
      const block = findBlock(page, args.block);
      if (!block) throw new Error(`Page ${page.id} has no block ${JSON.stringify(args.block)}`);
      return { ...header, block: block.id, ...(format === "markdown" ? { markdown: blockToMarkdown(block) } : { blocks: [block] }) };
    }
    return { ...header, ...(format === "markdown" ? { markdown: pageToMarkdown(page) } : { blocks: page.blocks ?? [] }) };
  });

  tool("search_guidance", {
    title: "Search guidance",
    annotations: READ_ONLY,
    description: "Find the blocks that answer a question. Every query term must appear; guidance groups (voice, compliance, ...) and title matches rank first. Each result cites its page and block and carries the block as Markdown.",
    inputSchema: {
      query: z.string().min(2).max(300).describe("What you need to know, e.g. how to refer to clients"),
      group: z.string().min(1).max(50).optional().describe("Only blocks in this guidance group, e.g. voice or compliance"),
      limit: z.number().int().min(1).max(MAX_SEARCH_RESULTS).optional().describe("Maximum results; defaults to 8"),
    },
  }, async (args) => {
    const resolved = await systemFor(args);
    const index = requireDocument(resolved.layer, "index");
    const brand = resolved.layer.brand;
    const group = args.group?.trim().toLowerCase() || null;
    if (group && !brand?.guidance?.[group]) {
      throw new Error(`No guidance group ${group}; groups: ${Object.keys(brand?.guidance ?? {}).join(", ") || "none"}`);
    }
    const results = searchBlocks({ index, brand, query: args.query, group, limit: args.limit ?? 8 });
    return { system: systemStamp(resolved), query: args.query, group, total: results.length, groups: Object.keys(brand?.guidance ?? {}), results };
  });

  tool("list_media", {
    title: "List catalog media",
    annotations: READ_ONLY,
    description: "The published media catalog: reviewed assets with logical keys, titles, kinds, tags, stable public URLs, sizes, and measured dimensions or durations. Filter by tag or kind. Logos and brand imagery come from get_brand.",
    inputSchema: {
      tag: z.string().min(1).max(100).optional().describe("Only assets carrying this tag"),
      kind: z.string().min(1).max(40).optional().describe("Only assets of this kind, e.g. image, video, audio"),
      limit: z.number().int().min(1).max(MAX_MEDIA_PER_CALL).optional().describe("Maximum assets returned; defaults to 200"),
    },
  }, async (args) => {
    const resolved = await systemFor(args);
    const catalog = resolved.media;
    const tag = args.tag?.trim().toLowerCase();
    const kind = args.kind?.trim().toLowerCase();
    let assets = catalog?.assets ?? [];
    if (tag) assets = assets.filter((asset) => (asset.tags ?? []).some((entry) => String(entry).toLowerCase() === tag));
    if (kind) assets = assets.filter((asset) => String(asset.kind ?? "").toLowerCase() === kind);
    const limit = args.limit ?? 200;
    return {
      system: systemStamp(resolved),
      catalog: Boolean(catalog),
      ...(catalog ? {} : { note: "No media catalog is published for this system; logos and imagery are in get_brand." }),
      total: assets.length,
      returned: Math.min(assets.length, limit),
      truncated: assets.length > limit,
      tag: tag ?? null,
      kind: kind ?? null,
      assets: assets.slice(0, limit),
    };
  });

  tool("report_gap", {
    title: "Report a gap",
    annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: true, readOnlyHint: false },
    description: "File one gap in the Design System — missing guidance, an unfilled role, a missing token or asset, or something incorrect — into the client's review queue, stamped with the version it was observed on. File only what the user agrees is a gap.",
    inputSchema: {
      kind: z.enum(GAP_KINDS).describe("What kind of gap"),
      title: z.string().min(3).max(200).describe("One line naming the gap"),
      detail: z.string().min(1).max(4_000).describe("What was needed, what was found, and what would close the gap"),
      reference: z.string().max(500).optional().describe("The page, block, role, token, or media key it concerns"),
    },
  }, async (args) => {
    const resolved = await systemFor(args);
    const system = systemStamp(resolved);
    const gap = {
      kind: args.kind,
      title: args.title.trim(),
      detail: args.detail.trim(),
      reference: args.reference?.trim() || null,
      observedVersion: system.version,
    };
    if (typeof hooks.fileGap !== "function") {
      return { filed: false, system, gap, message: "No gap intake is configured for this server; include the gap in your report so the designer can act on it." };
    }
    const outcome = await hooks.fileGap({ system, gap });
    return { filed: true, system, gap, ...(outcome && typeof outcome === "object" ? outcome : {}) };
  });

  // Resources: the consumer guide, the four derived documents, and each
  // guidance group. In remote mode the system id sits in the path,
  // percent-encoded, so a hierarchical id such as `client/core` stays one
  // segment.
  server.registerResource("consumer-guide", CONSUMER_GUIDE_URI, {
    title: "TimDS Design System consumer guide",
    description: "How to read a TimDS Design System through the timds-design-system-read tools.",
    mimeType: "text/markdown",
  }, async (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/markdown", text: consumerGuideText() }] }));

  const decodeSystem = (variables) => (remote ? decodeURIComponent(String(variables?.system ?? "")) || undefined : undefined);
  const resolveForResource = async (variables) => normalizeResolved(await resolveSystem({ systemId: decodeSystem(variables) }));
  const resourceUri = (suffix) => (remote ? `timds://systems/{system}/${suffix}` : `timds://${suffix}`);
  const documents = [
    ["brand.json", "brand", "application/json", "The brand kit: roles, logos, imagery, and guidance groups."],
    ["tokens.json", "tokens", "application/json", "Every resolved CSS custom property with its scope and the roles it fills."],
    ["index.json", "index", "application/json", "Every page as structured blocks with assets joined to media."],
    ["llms.txt", "llms", "text/plain", "The page directory in the llms.txt convention."],
  ];
  for (const [suffix, name, mimeType, description] of documents) {
    const read = async (uri, variables) => {
      const resolved = await resolveForResource(variables);
      const document = requireDocument(resolved.layer, name);
      return { contents: [{ uri: uri.href, mimeType, text: typeof document === "string" ? document : `${JSON.stringify(document, null, 2)}\n` }] };
    };
    if (remote) {
      server.registerResource(name, new ResourceTemplate(resourceUri(suffix), { list: undefined }), { title: `Design System ${suffix}`, description, mimeType }, read);
    } else {
      server.registerResource(name, resourceUri(suffix), { title: `Design System ${suffix}`, description, mimeType }, (uri) => read(uri, {}));
    }
  }
  server.registerResource("guidance", new ResourceTemplate(resourceUri("guidance/{group}"), {
    list: remote
      ? undefined
      : async () => {
          const resolved = await resolveForResource({});
          return {
            resources: Object.keys(resolved.layer.brand?.guidance ?? {}).map((group) => ({
              uri: `timds://guidance/${group}`,
              name: `guidance-${group}`,
              title: `Guidance: ${group}`,
              mimeType: "text/markdown",
            })),
          };
        },
  }), {
    title: "Guidance group",
    description: "One guidance group (voice, compliance, ...) as Markdown with a citation per block.",
    mimeType: "text/markdown",
  }, async (uri, variables) => {
    const resolved = await resolveForResource(variables);
    const kit = requireDocument(resolved.layer, "brand");
    const group = String(variables?.group ?? "");
    const entry = kit.guidance?.[group];
    if (!entry) throw new Error(`No guidance group ${group}; groups: ${Object.keys(kit.guidance ?? {}).join(", ") || "none"}`);
    const index = resolved.layer.index;
    const text = [`# ${group}`, "", ...entry.blocks.map((block) => {
      const page = index ? findPage(index, block.page) : null;
      const full = page ? findBlock(page, block.id) : null;
      const markdown = block.markdown ?? (full ? blockToMarkdown(full) : `## ${block.title}\n`);
      return `${markdown.trimEnd()}\n\n<!-- source: ${block.page} · block: ${block.id} -->\n`;
    })].join("\n");
    return { contents: [{ uri: uri.href, mimeType: "text/markdown", text }] };
  });

  return server;
}

// ---------------------------------------------------------------------------
// Local server

async function packageVersion() {
  try {
    const manifest = JSON.parse(await fs.readFile(new URL("../package.json", import.meta.url), "utf8"));
    return String(manifest.version || "0.0.0");
  } catch {
    return "0.0.0";
  }
}

function checkVersion(layer, version) {
  if (version && layer.system?.version && version !== layer.system.version) {
    throw new Error(`Only version ${layer.system.version} is available here; ${version} was requested`);
  }
}

/**
 * An McpServer named `timds-design-system-read` serving one system: the
 * current checkout's derived layer and media catalog, or, with `published`,
 * the derived layer at a published base URL.
 */
export async function createDesignSystemReadMcpServer({ root = process.cwd(), published = null, fetchImpl = fetch } = {}) {
  const server = new McpServer({ name: DESIGN_SYSTEM_READ_MCP_SERVER_NAME, version: await packageVersion() });
  if (published) {
    // Fail fast on a base that publishes nothing.
    await fetchDerivedLayer(published, { fetchImpl });
    registerDesignSystemReadTools(server, {
      resolveSystem: async ({ version } = {}) => {
        const layer = await fetchDerivedLayer(published, { fetchImpl });
        checkVersion(layer, version);
        return { layer, media: null, published: layer.system?.version ?? null, pinned: null };
      },
      hooks: { remote: false },
    });
    return server;
  }
  const repoRoot = await findRepositoryRoot(root);
  await loadWorkspace(repoRoot);
  registerDesignSystemReadTools(server, {
    resolveSystem: async ({ version } = {}) => {
      const workspace = await loadWorkspace(repoRoot);
      const layer = await readDerivedLayer(workspace.designSystemRoot, workspace.manifest);
      if (!layer.derived) throw new Error("Nothing has been derived yet; run timds check first");
      checkVersion(layer, version);
      const { catalog } = await readMediaCatalog(workspace.designSystemRoot);
      return { layer, media: catalog, published: null, pinned: null };
    },
    hooks: { remote: false },
  });
  return server;
}

/** `timds mcp read`: serve the read tools over stdio. stdout carries only the protocol. */
export async function runDesignSystemReadMcp({ root = process.cwd(), published = null } = {}) {
  setOutputStream(process.stderr);
  const server = await createDesignSystemReadMcpServer({ root, published });
  const transport = new StdioServerTransport();
  const closed = new Promise((resolve) => {
    transport.onclose = resolve;
  });
  await server.connect(transport);
  const where = published ? published : await findRepositoryRoot(root);
  process.stderr.write(`TimDS MCP server ${DESIGN_SYSTEM_READ_MCP_SERVER_NAME} ready on stdio for ${where}\n`);
  await closed;
}
