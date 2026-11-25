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
// against the current checkout's `dist/`, a published base URL, or a named
// draft snapshot, and a host registers the same tools on its own server,
// resolving each call's `systemId` and `version` or `draft` to a derived
// layer.
//
// The definitions live in `read-tools.mjs`, which imports no Node builtin
// and no MCP SDK so a host on another runtime can bundle it
// (`scripts/check-read-tools.mjs` enforces that). This module is the Node
// entry: `registerDesignSystemReadTools` registers those definitions with the
// MCP SDK and the toolkit's Zod, and the stdio server is the only part that
// touches the workspace, the filesystem or the network.

import { promises as fs } from "node:fs";
import process from "node:process";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";
import { findRepositoryRoot, loadWorkspace, setOutputStream } from "./core.mjs";
import { fetchDerivedLayer, readDerivedLayer } from "./derived.mjs";
import { readMediaCatalog } from "./media.mjs";

import { designSystemReadTools, DESIGN_SYSTEM_READ_MCP_SERVER_NAME } from "./read-tools.mjs";
export { DESIGN_SYSTEM_READ_MCP_SERVER_NAME, CONSUMER_GUIDE_URI, GAP_KINDS, consumerGuideText, searchBlocks, resolveRoles } from "./read-tools.mjs";

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

/** Register the neutral read surface with the Node MCP SDK. */
export function registerDesignSystemReadTools(server, options) {
  const { tools, resources } = designSystemReadTools({ ...options, z });
  for (const { name, handler, ...config } of tools) {
    server.registerTool(name, config, async args => {
      try { return toolResult(await handler(args ?? {})); }
      catch (error) { return toolError(error); }
    });
  }
  for (const { name, uri, handler, ...config } of resources) {
    const reference = typeof uri === "string" ? uri : new ResourceTemplate(uri.template, { list: uri.list });
    server.registerResource(name, reference, config, handler);
  }
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

// An unversioned layer cannot confirm a requested label (its host owns
// labels), so only a layer that names a different version refuses one.
function checkVersion(layer, version) {
  if (version && layer.system?.version && version !== layer.system.version) {
    throw new Error(`Only version ${layer.system.version} is available here; ${version} was requested`);
  }
}

/**
 * An McpServer named `timds-design-system-read` serving one system: the
 * current checkout's derived layer and media catalog, or, with `published`,
 * the derived layer at a published base URL, or, with `draft`, a checked
 * hosted draft snapshot refreshed when its revision changes.
 */
export async function createDesignSystemReadMcpServer({ root = process.cwd(), published = null, draft = null, systemId, portalUrl, token, credentialsPath, fetchImpl = fetch, build } = {}) {
  const server = new McpServer({ name: DESIGN_SYSTEM_READ_MCP_SERVER_NAME, version: await packageVersion() });
  if (draft) {
    if (published) throw new Error("Choose --published or --draft");
    const { prepareDraftSource } = await import("./draft-source.mjs");
    let prepared = null;
    let reading = Promise.resolve();
    registerDesignSystemReadTools(server, {
      resolveSystem: ({ version, draft: requested } = {}) => reading = reading.catch(() => {}).then(async () => {
        if (version) throw new Error("A draft cannot select a published version");
        if (requested && requested !== draft) throw new Error(`This read server serves draft ${draft}`);
        const next = await prepareDraftSource({ systemId, draft, portalUrl, token, credentialsPath, fetchImpl, build, previous: prepared });
        if (prepared && next !== prepared) await prepared.dispose();
        prepared = next;
        const workspace = await loadWorkspace(prepared.root, { allowNpm: Boolean(prepared.binaryStock) });
        const layer = await readDerivedLayer(prepared.root, workspace.manifest, {parentRecord: workspace.parentRecord});
        layer.source = { kind: "draft", draft, revision: prepared.snapshot.session.baseRevision };
        const { catalog } = await readMediaCatalog(prepared.root);
        return { layer, media: catalog, published: null, pinned: null };
      }), hooks: { remote: false },
    });
    const close = server.close.bind(server);
    server.close = async () => { try { await close(); } finally { if (prepared) await prepared.dispose(); } };
    return server;
  }
  if (published) {
    // Fail fast on a base that publishes nothing.
    await fetchDerivedLayer(published, { fetchImpl, documents: [] });
    registerDesignSystemReadTools(server, {
      // `documents` keeps reads that need no concepts from requesting concepts.json.
      resolveSystem: async ({ version, draft: requestedDraft } = {}, documents) => {
        if (requestedDraft) throw new Error("Start the read server with --draft NAME --system-id ID to read a draft");
        const layer = await fetchDerivedLayer(published, { fetchImpl, documents });
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
    resolveSystem: async ({ version, draft: requestedDraft } = {}) => {
        if (requestedDraft) throw new Error("Start the read server with --draft NAME --system-id ID to read a draft");
      const workspace = await loadWorkspace(repoRoot);
      const layer = await readDerivedLayer(workspace.designSystemRoot, workspace.manifest, {parentRecord: workspace.parentRecord});
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
export async function runDesignSystemReadMcp({ root = process.cwd(), published = null, draft = null, systemId, portalUrl } = {}) {
  setOutputStream(process.stderr);
  const server = await createDesignSystemReadMcpServer({ root, published, draft, systemId, portalUrl });
  const transport = new StdioServerTransport();
  const closed = new Promise((resolve) => {
    transport.onclose = resolve;
  });
  await server.connect(transport);
  const where = published ? published : await findRepositoryRoot(root);
  process.stderr.write(`TimDS MCP server ${DESIGN_SYSTEM_READ_MCP_SERVER_NAME} ready on stdio for ${where}\n`);
  await closed;
}
