import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { checkWorkspace, initializeRepository, loadWorkspace } from "./core.mjs";
import { readDerivedLayer } from "./derived.mjs";
import {
  CONSUMER_GUIDE_URI,
  GAP_KINDS,
  consumerGuideText,
  createDesignSystemReadMcpServer,
  registerDesignSystemReadTools,
  resolveRoles,
  searchBlocks,
} from "./mcp-read.mjs";

async function temporaryDirectory(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "timds-mcp-read-"));
  t.after(() => fs.rm(directory, { force: true, recursive: true, maxRetries: 5, retryDelay: 50 }));
  return fs.realpath(directory);
}

function gitInit(repoRoot) {
  execFileSync("git", ["init", "-b", "main"], { cwd: repoRoot, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "timds-test@example.com"], { cwd: repoRoot });
  execFileSync("git", ["config", "user.name", "TimDS Test"], { cwd: repoRoot });
}

// One checked standalone system shared by the tests: `check` builds the
// starter and derives its layer once.
let sharedRepo = null;
async function checkedRepo(t) {
  if (sharedRepo) return sharedRepo;
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "timds-mcp-read-shared-"));
  gitInit(repoRoot);
  await initializeRepository(repoRoot, { standalone: true });
  await checkWorkspace(repoRoot);
  sharedRepo = await fs.realpath(repoRoot);
  return sharedRepo;
}
test.after(async () => {
  if (sharedRepo) await fs.rm(sharedRepo, { force: true, recursive: true, maxRetries: 5, retryDelay: 50 });
});

async function connect(server) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "timds-read-test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

async function call(client, name, args = {}) {
  return client.callTool({ name, arguments: args });
}

async function ok(client, name, args = {}) {
  const result = await call(client, name, args);
  assert.ok(!result.isError, `${name} failed: ${result.content?.[0]?.text}`);
  return result.structuredContent;
}

async function layerOf(repoRoot) {
  const workspace = await loadWorkspace(repoRoot);
  return readDerivedLayer(workspace.designSystemRoot, workspace.manifest);
}

test("the local read server describes, resolves roles, lists tokens and pages, and reads guidance", async (t) => {
  const repoRoot = await checkedRepo(t);
  const client = await connect(await createDesignSystemReadMcpServer({ root: repoRoot }));

  const { tools } = await client.listTools();
  const names = tools.map((tool) => tool.name).sort();
  assert.deepEqual(names, [
    "describe_system", "get_brand", "get_consumer_guide", "get_tokens", "list_design_systems", "list_designs", "list_media",
    "list_pages", "read_design", "read_page", "report_gap", "resolve_role", "search_guidance",
  ]);
  for (const tool of tools) {
    assert.equal(tool.annotations.readOnlyHint, tool.name !== "report_gap", tool.name);
    assert.ok(!("systemId" in (tool.inputSchema.properties ?? {})), `${tool.name} takes no systemId locally`);
  }

  const systems = await ok(client, "list_design_systems", {});
  assert.equal(systems.total, 1);
  assert.match(systems.systems[0].systemId, /\/core$/);
  assert.equal(systems.systems[0].source, "local");

  const described = await ok(client, "describe_system", {});
  assert.equal(described.system.id, systems.systems[0].systemId);
  assert.equal(described.system.source, "local");
  assert.equal(described.system.pinned, null);
  assert.ok(described.pages.length > 0);
  assert.ok(described.tokens.count > 0);
  assert.ok(described.brand.summary.roles.filled > 0);
  assert.ok(typeof described.llms === "string");
  assert.equal(described.video, null, "a system without a board catalog lists no boards");
  assert.deepEqual(described.designs, { count: 1, pages: 2, states: 3, designs: [{ id: "website", title: "Marketing site", pageCount: 2 }] });

  // The website designs are whole pages: the directory names routes and states, and a read returns the HTML as authored.
  const designs = await ok(client, "list_designs", {});
  assert.equal(designs.total, 1);
  assert.equal(designs.base, null, "nothing is published locally");
  assert.deepEqual(designs.designs[0].pages.map((page) => [page.route, page.states]), [["/", ["default"]], ["/contact", ["default", "sent"]]]);
  const sent = await ok(client, "read_design", { design: "website", route: "/contact", state: "sent" });
  assert.deepEqual([sent.design.id, sent.page.route, sent.state, sent.url], ["website", "/contact", "sent", "/designs/website/contact/sent.html"]);
  assert.match(sent.html, /<div class="notice">/);
  assert.deepEqual(sent.references, ["/styles/system.css", "/tokens.css"]);
  const home = await ok(client, "read_design", { design: "website", route: "/" });
  assert.equal(home.title, "Home");
  assert.match(home.html, /<form|<section class="hero">/);
  const missingRoute = await call(client, "read_design", { design: "website", route: "/nope" });
  assert.ok(missingRoute.isError);
  assert.match(missingRoute.content[0].text, /has no route "\/nope"; routes: \/, \/contact/);
  const missingState = await call(client, "read_design", { design: "website", route: "/contact", state: "empty" });
  assert.match(missingState.content[0].text, /has no state "empty"; states: default, sent/);

  const roles = await ok(client, "resolve_role", { roles: ["color.accent", "font.display", "color.nonsense"] });
  assert.equal(roles.roles["color.accent"].filled, true);
  assert.match(roles.roles["color.accent"].token, /^--/);
  assert.equal(roles.roles["color.accent"].kind, "color");
  assert.equal(roles.roles["font.display"].filled, true);
  assert.equal(roles.roles["color.nonsense"].filled, false);
  assert.equal(roles.roles["color.nonsense"].known, false);
  assert.match(roles.roles["color.nonsense"].hint, /Known roles/);
  assert.equal((await call(client, "resolve_role", {})).isError, true);

  const tokens = await ok(client, "get_tokens", { kind: "color", baseOnly: true, limit: 5 });
  assert.ok(tokens.total > 0);
  assert.ok(tokens.returned <= 5);
  assert.equal(tokens.truncated, tokens.total > 5);
  for (const token of tokens.tokens) {
    assert.equal(token.kind, "color");
    assert.equal(token.base, true);
    assert.ok(token.resolved);
  }
  const accentToken = roles.roles["color.accent"].token;
  const byName = await ok(client, "get_tokens", { query: accentToken.slice(2) });
  assert.ok(byName.tokens.some((token) => token.name === accentToken));

  const pages = await ok(client, "list_pages", {});
  assert.equal(pages.total, described.pages.length);
  const first = pages.pages[0];
  const asMarkdown = await ok(client, "read_page", { page: first.id });
  assert.equal(asMarkdown.format, "markdown");
  assert.match(asMarkdown.markdown, new RegExp(`^# ${first.title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  const byUrl = await ok(client, "read_page", { page: first.url, format: "blocks" });
  assert.equal(byUrl.page.id, first.id);
  assert.ok(Array.isArray(byUrl.blocks));
  if (byUrl.blocks.length) {
    const block = byUrl.blocks[0];
    const anchor = block.id.slice(block.id.indexOf("#") + 1);
    const single = await ok(client, "read_page", { page: first.id, block: anchor });
    assert.equal(single.block, block.id);
    assert.match(single.markdown, /^## /);
  }
  assert.equal((await call(client, "read_page", { page: "no/such/page" })).isError, true);

  const brand = await ok(client, "get_brand", {});
  assert.ok(Object.keys(brand.roles).length > 0);
  assert.ok(Array.isArray(brand.logos));
  assert.ok(brand.guidance && typeof brand.guidance === "object");

  const media = await ok(client, "list_media", {});
  assert.equal(media.catalog, true);
  assert.equal(media.total, 0);

  const guide = await ok(client, "get_consumer_guide", {});
  assert.equal(guide.guide, consumerGuideText());
  assert.equal(guide.uri, CONSUMER_GUIDE_URI);
  const resource = await client.readResource({ uri: CONSUMER_GUIDE_URI });
  assert.equal(resource.contents[0].text, consumerGuideText());

  for (const [uri, mimeType] of [["timds://brand.json", "application/json"], ["timds://tokens.json", "application/json"], ["timds://index.json", "application/json"], ["timds://llms.txt", "text/plain"]]) {
    const read = await client.readResource({ uri });
    assert.equal(read.contents[0].mimeType, mimeType, uri);
    if (mimeType === "application/json") assert.ok(JSON.parse(read.contents[0].text).system.version, uri);
  }
  const groups = Object.keys(brand.guidance);
  if (groups.length) {
    const listed = await client.listResources();
    assert.ok(listed.resources.some((entry) => entry.uri === `timds://guidance/${groups[0]}`));
    const guidance = await client.readResource({ uri: `timds://guidance/${groups[0]}` });
    assert.match(guidance.contents[0].text, new RegExp(`^# ${groups[0]}`));
    assert.match(guidance.contents[0].text, /<!-- source: /);
  }
  await assert.rejects(client.readResource({ uri: "timds://guidance/no-such-group" }), /No guidance group/);

  // Without a gap intake the tool says so instead of pretending to file.
  const gap = await ok(client, "report_gap", { kind: "missing-role", title: "No muted color", detail: "color.muted is unfilled." });
  assert.equal(gap.filed, false);
  assert.equal(gap.gap.observedVersion, described.system.version);
  assert.match(gap.message, /No gap intake/);

  const wrongVersion = await call(client, "describe_system", { version: "0.0.0-nope" });
  assert.equal(wrongVersion.isError, true);
  assert.match(wrongVersion.content[0].text, /Only version/);
});

test("search_guidance requires every term, ranks guidance groups first, and cites blocks", async (t) => {
  const repoRoot = await checkedRepo(t);
  const layer = await layerOf(repoRoot);
  const client = await connect(await createDesignSystemReadMcpServer({ root: repoRoot }));

  // A term from the first block title of the first page is always findable.
  const page = layer.index.pages.find((entry) => entry.blocks.some((block) => block.title));
  const block = page.blocks.find((entry) => entry.title);
  const term = block.title.split(/\s+/).find((word) => word.length >= 3).replace(/[^\p{L}\p{N}-]/gu, "");
  const found = await ok(client, "search_guidance", { query: term });
  assert.ok(found.total > 0, term);
  assert.ok(found.results.some((result) => result.block === block.id), `${term} finds ${block.id}`);
  for (const result of found.results) {
    assert.ok(result.page && result.url && result.block, "citation");
    assert.match(result.markdown, /^## /);
  }
  const nothing = await ok(client, "search_guidance", { query: "zzqx-unlikely-term-99" });
  assert.equal(nothing.total, 0);
  assert.equal((await call(client, "search_guidance", { query: term, group: "no-such-group" })).isError, true);

  // Ranking is a pure function of the layer: a guidance block outranks the
  // same score elsewhere, and title hits outrank body hits.
  const index = {
    pages: [
      { id: "brand/voice", title: "Voice", url: "/brand/voice", blocks: [
        { id: "brand/voice#tone", title: "Tone", prose: [{ id: "p1", text: "Speak plainly to clients." }] },
      ] },
      { id: "docs/faq", title: "FAQ", url: "/docs/faq", blocks: [
        { id: "docs/faq#clients", title: "Clients", prose: [{ id: "p2", text: "Speak plainly." }] },
        { id: "docs/faq#other", title: "Other", prose: [{ id: "p3", text: "Nothing relevant." }] },
      ] },
    ],
  };
  const brand = { guidance: { voice: { source: "convention", blocks: [{ id: "brand/voice#tone", page: "brand/voice", title: "Tone" }] } } };
  const ranked = searchBlocks({ index, brand, query: "speak plainly" });
  assert.deepEqual(ranked.map((result) => result.block), ["brand/voice#tone", "docs/faq#clients"]);
  assert.deepEqual(ranked[0].groups, ["voice"]);
  const titled = searchBlocks({ index, brand, query: "clients" });
  assert.equal(titled[0].block, "docs/faq#clients");
  assert.deepEqual(searchBlocks({ index, brand, query: "speak plainly", group: "voice" }).map((result) => result.block), ["brand/voice#tone"]);
  assert.deepEqual(searchBlocks({ index, brand, query: "speak nothing" }), [], "every term must match one block");
});

test("resolveRoles reports filled roles and distinguishes unfilled from unknown", () => {
  const tokens = {
    roles: { "color.accent": { token: "--accent", value: "#c9a227", kind: "color", source: "convention" } },
    missingRoles: ["color.muted"],
  };
  const resolved = resolveRoles(tokens, ["color.accent", "color.muted", "font.ui", "color.custom"]);
  assert.deepEqual(resolved["color.accent"], { filled: true, token: "--accent", value: "#c9a227", kind: "color", source: "convention" });
  assert.equal(resolved["color.muted"].filled, false);
  assert.equal(resolved["color.muted"].known, true);
  assert.ok(resolved["color.muted"].conventionalTokens.includes("--color-muted"));
  assert.match(resolved["color.muted"].hint, /gap/);
  assert.equal(resolved["font.ui"].known, true);
  assert.equal(resolved["color.custom"].known, false);
});

test("remote mode takes systemId and version, serves the host's media and pins, files gaps, and exposes per-system resources", async (t) => {
  const repoRoot = await checkedRepo(t);
  const layer = await layerOf(repoRoot);
  const systemId = layer.system.id;
  const calls = [];
  const filed = [];
  const server = new McpServer({ name: "host", version: "0.0.0" });
  registerDesignSystemReadTools(server, {
    listSystems: async () => [{ systemId, name: layer.system.name, publishedVersion: "9.9.9", pinnedVersion: layer.system.version }],
    resolveSystem: async ({ systemId: requested, version }) => {
      calls.push({ systemId: requested, version });
      if (requested && requested !== systemId) throw new Error(`design system ${requested} not found`);
      if (version && version !== layer.system.version) throw new Error(`version ${version} not found`);
      return {
        layer,
        media: { assets: [
          { key: "hero-wide", title: "Hero", kind: "video", tags: ["b-roll", "hero"], publicUrl: "https://cdn.example/hero.mp4" },
          { key: "office", title: "Office", kind: "image", tags: ["photo"], publicUrl: "https://cdn.example/office.jpg" },
        ] },
        published: "9.9.9",
        pinned: layer.system.version,
      };
    },
    hooks: {
      remote: true,
      fileGap: async ({ system, gap }) => {
        filed.push({ system, gap });
        return { reviewItemId: "review-1", url: "https://portal.example/review/review-1" };
      },
    },
  });
  const client = await connect(server);

  const { tools } = await client.listTools();
  for (const tool of tools) {
    if (["get_consumer_guide", "list_design_systems"].includes(tool.name)) continue;
    assert.ok("systemId" in tool.inputSchema.properties, `${tool.name} takes systemId`);
    assert.ok("version" in tool.inputSchema.properties, `${tool.name} takes version`);
    assert.ok(!tool.inputSchema.required?.includes("systemId"), `${tool.name} systemId is optional`);
  }

  const systems = await ok(client, "list_design_systems", {});
  assert.deepEqual(systems.systems[0], { systemId, name: layer.system.name, publishedVersion: "9.9.9", pinnedVersion: layer.system.version });

  const described = await ok(client, "describe_system", { systemId });
  assert.equal(described.system.version, layer.system.version);
  assert.equal(described.system.pinned, layer.system.version);
  assert.equal(described.system.published, "9.9.9");
  assert.deepEqual(calls.at(-1), { systemId, version: undefined });
  await ok(client, "describe_system", {});
  assert.deepEqual(calls.at(-1), { systemId: undefined, version: undefined });
  await ok(client, "describe_system", { systemId, version: layer.system.version });
  assert.deepEqual(calls.at(-1), { systemId, version: layer.system.version });
  const missing = await call(client, "describe_system", { systemId: "other/system" });
  // A published index with a board catalog lists the kinds a producer may draw.
  const boards = { schemaVersion: 1, formats: { longform: true, short: false }, cadence: { maxBoardWords: 28 }, kinds: [{ id: "cards", label: "Cards", use: "A list.", avoid: "A rule.", overFootage: "optional", once: false }] };
  layer.index = { ...layer.index, video: { boards } };
  const withBoards = await ok(client, "describe_system", { systemId });
  assert.deepEqual(withBoards.video, { boards: boards.kinds, cadence: boards.cadence, formats: boards.formats });
  assert.equal(missing.isError, true);
  assert.match(missing.content[0].text, /not found/);

  const media = await ok(client, "list_media", { systemId, tag: "B-Roll" });
  assert.equal(media.catalog, true);
  assert.equal(media.total, 1);
  assert.equal(media.assets[0].key, "hero-wide");
  assert.equal((await ok(client, "list_media", { systemId, kind: "image" })).assets[0].key, "office");
  assert.equal((await ok(client, "list_media", { systemId })).total, 2);

  const gap = await ok(client, "report_gap", { systemId, kind: "missing-guidance", title: "No tagline guidance", detail: "Nothing says how to write the tagline.", reference: "brand/voice" });
  assert.equal(gap.filed, true);
  assert.equal(gap.reviewItemId, "review-1");
  assert.equal(filed.length, 1);
  assert.equal(filed[0].system.id, systemId);
  assert.equal(filed[0].system.pinned, layer.system.version);
  assert.deepEqual(filed[0].gap, { kind: "missing-guidance", title: "No tagline guidance", detail: "Nothing says how to write the tagline.", reference: "brand/voice", observedVersion: layer.system.version });
  assert.equal((await call(client, "report_gap", { systemId, kind: "not-a-kind", title: "x y z", detail: "d" })).isError, true);
  assert.ok(GAP_KINDS.includes("missing-guidance"));

  const encoded = encodeURIComponent(systemId);
  assert.ok(encoded.includes("%2F"), "a hierarchical id is one encoded segment");
  const brand = await client.readResource({ uri: `timds://systems/${encoded}/brand.json` });
  assert.equal(JSON.parse(brand.contents[0].text).system.id, systemId);
  assert.deepEqual(calls.at(-1), { systemId, version: undefined });
  const llms = await client.readResource({ uri: `timds://systems/${encoded}/llms.txt` });
  assert.equal(llms.contents[0].mimeType, "text/plain");
  const { resourceTemplates } = await client.listResourceTemplates();
  const templates = resourceTemplates.map((entry) => entry.uriTemplate).sort();
  assert.ok(templates.includes("timds://systems/{system}/brand.json"), templates.join(", "));
  assert.ok(templates.includes("timds://systems/{system}/guidance/{group}"), templates.join(", "));
  await assert.rejects(client.readResource({ uri: `timds://systems/${encodeURIComponent("other/system")}/brand.json` }), /not found/);
});

test("a published base serves the layer the CDN holds", async (t) => {
  const repoRoot = await checkedRepo(t);
  const workspace = await loadWorkspace(repoRoot);
  const layer = await layerOf(repoRoot);
  const base = "https://design-systems.example/client/core/artifact";
  const files = {
    ".timds-artifact.json": JSON.stringify({ schemaVersion: 1, sourceCommit: "abc123", version: layer.system.version, systemId: layer.system.id, entry: workspace.manifest.artifact.entry, files: { index: "index.json", tokens: "tokens.json", brand: "brand.json", llms: "llms.txt" } }),
    "index.json": JSON.stringify(layer.index),
    "tokens.json": JSON.stringify(layer.tokens),
    "brand.json": JSON.stringify(layer.brand),
    "llms.txt": layer.llms,
  };
  const requested = [];
  const fetchImpl = async (url) => {
    requested.push(url);
    const relative = url.startsWith(`${base}/`) ? url.slice(base.length + 1) : null;
    const body = relative === null ? undefined : files[relative];
    return body === undefined
      ? { ok: false, status: 404, text: async () => "" }
      : { ok: true, status: 200, text: async () => body };
  };
  const client = await connect(await createDesignSystemReadMcpServer({ published: base, fetchImpl }));
  const described = await ok(client, "describe_system", {});
  assert.equal(described.system.source, "published");
  assert.equal(described.system.published, layer.system.version);
  assert.equal(described.provenance.sourceCommit, "abc123");
  assert.equal(described.media.catalog, false);
  const media = await ok(client, "list_media", {});
  assert.equal(media.catalog, false);
  assert.match(media.note, /No media catalog/);
  assert.ok(requested.some((url) => url.endsWith("/.timds-artifact.json")));
  await assert.rejects(createDesignSystemReadMcpServer({ published: "https://design-systems.example/nothing", fetchImpl }), /404/);
});

test("the read server refuses a checkout with nothing derived", async (t) => {
  const repoRoot = await temporaryDirectory(t);
  gitInit(repoRoot);
  await initializeRepository(repoRoot, { standalone: true });
  await fs.rm(path.join(repoRoot, "dist"), { recursive: true, force: true });
  const client = await connect(await createDesignSystemReadMcpServer({ root: repoRoot }));
  const result = await call(client, "describe_system", {});
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /timds check/);
});

test("the consumer guide teaches roles, media, guidance, versions, and gaps without editing steps", () => {
  const guide = consumerGuideText();
  for (const rule of ["resolve_role", "get_tokens", "get_brand", "list_media", "search_guidance", "read_page", "report_gap", "pinned", "Compliance guidance is binding"]) {
    assert.ok(guide.includes(rule), rule);
  }
  for (const editing of ["write_file", "run_check", "hand-off", "npm ci", "git clone"]) {
    assert.ok(!guide.includes(editing), editing);
  }
});
