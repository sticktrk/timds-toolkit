// Prose contract: the mechanical half of keeping the instructions the toolkit
// ships in step with the toolkit. The skills, the scaffolded agent and human
// docs, the EmDash site docs, the README, and the toolkit's own agent
// instructions all make concrete claims (a `timds` command and its flags, a
// placeholder a renderer fills, a file path in a scaffold, an MCP tool name,
// a skill name) that the source makes true or false. This module reads both
// sides and reports every claim the source no longer backs, every command
// the source accepts that no instruction surface teaches, and every place
// the usage texts disagree with each other.
//
// It is run by `src/prose-contract.test.mjs` (so `npm test` and CI fail on
// drift) and by `scripts/check-prose-impact.mjs` (which, for a pull request,
// names the prose surfaces that describe a changed module). The sources of
// truth are read, never restated here: every `Usage:` block in `src/*.mjs`
// (the `--help` text in `src/core.mjs` is the public one the others must
// agree with), the placeholder lists the renderers fill, the tool
// registrations in `src/mcp.mjs` and `src/mcp-read.mjs`, the skill name
// lists in `src/core.mjs` and `src/consumer-init.mjs`, the `.timds/` files
// the source names, and the scaffold under `templates/`. What cannot be read
// from source is declared once in `proseAllowances` with the reason, so a new
// allowance is a reviewed change.
//
// Boundary: this module checks prose against the toolkit; it never edits
// prose and never runs in a client repository. Semantic drift (a paragraph
// that describes an old behaviour with the right command names) is the
// reviewer's; `scripts/check-prose-impact.mjs` tells the reviewer which
// surfaces to read, and `docs/prose-contract.md` is the procedure.

import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CONSUMER_SKILL_NAMES } from "./consumer-init.mjs";
import { designSystemSkillNames, helpText } from "./core.mjs";
import { registerDesignSystemReadTools } from "./mcp-read.mjs";
import { registerDesignSystemTools, registerHostedSessionTools } from "./mcp.mjs";
import { HOSTED_SKILL_TEMPLATE, hostedSkillPlaceholders } from "./skills-install.mjs";

export const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Every instruction surface the toolkit ships or scaffolds, with who reads it
 * and which repository its relative paths resolve in. `toolkit` surfaces
 * describe this repository (and, where they explain a client repository, the
 * scaffold); `scaffold` surfaces are copied into a Design System and name its
 * files; `consumer` surfaces are rendered into a product repository, whose
 * own source is the product's; `hosted` is rendered for a hosted system's
 * local workspace.
 */
export const proseSurfaces = Object.freeze([
  { file: "README.md", kind: "toolkit" },
  { file: "AGENTS.md", kind: "toolkit" },
  { file: "CLAUDE.md", kind: "toolkit" },
  { file: "docs/binary-installation.md", kind: "toolkit" },
  { file: "docs/binary-packaging.md", kind: "toolkit" },
  { file: "docs/brand-kit.md", kind: "toolkit" },
  { file: "docs/offshoots.md", kind: "toolkit" },
  { file: "docs/prose-contract.md", kind: "toolkit" },
  { file: "templates/design-system-AGENTS.md", kind: "scaffold" },
  { file: "templates/design-system-CLAUDE.md", kind: "scaffold" },
  { file: "templates/design-system-README.md", kind: "scaffold" },
  { file: "templates/media-local-README.md", kind: "scaffold" },
  { file: "templates/emdash/AGENTS-design-system.md", kind: "consumer" },
  { file: "templates/emdash/DESIGN_SYSTEM.md", kind: "consumer" },
  { file: "skills/timds-edit-design-system/SKILL.md", kind: "scaffold" },
  { file: "skills/timds-create-video/SKILL.md", kind: "scaffold" },
  { file: "skills/timds-create-video/references/vertical-crops.md", kind: "scaffold" },
  { file: "skills/design-start/SKILL.md", kind: "scaffold" },
  { file: "skills/design-media/SKILL.md", kind: "scaffold" },
  { file: "skills/design-ship/SKILL.md", kind: "scaffold" },
  { file: "skills/design-handoff/SKILL.md", kind: "scaffold" },
  { file: "skills/timds-consume-design-system/SKILL.md", kind: "consumer" },
  { file: "skills/timds-update-design-system/SKILL.md", kind: "consumer" },
  { file: "skills/timds-hosted-design-system/SKILL.md", kind: "hosted" },
]);

/**
 * Which prose surfaces describe each source module, for the impact check in
 * `scripts/check-prose-impact.mjs`. A module absent here is covered by the
 * contract test alone. Keys are repository paths or directory prefixes.
 */
export const proseOwnership = Object.freeze({
  "src/core.mjs": ["README.md", "CLAUDE.md", "templates/design-system-AGENTS.md", "templates/design-system-README.md", "skills/timds-edit-design-system/SKILL.md"],
  "src/hosted.mjs": ["README.md", "skills/timds-hosted-design-system/SKILL.md", "skills/timds-edit-design-system/SKILL.md"],
  "src/auth.mjs": ["README.md", "skills/timds-hosted-design-system/SKILL.md", "skills/design-start/SKILL.md"],
  "src/oauth.mjs": ["README.md", "skills/timds-hosted-design-system/SKILL.md"],
  "src/skills-install.mjs": ["README.md", "CLAUDE.md", "skills/timds-hosted-design-system/SKILL.md"],
  "src/media.mjs": ["README.md", "skills/design-media/SKILL.md", "skills/timds-edit-design-system/SKILL.md", "templates/design-system-AGENTS.md", "templates/media-local-README.md"],
  "src/brand.mjs": ["README.md", "skills/design-media/SKILL.md", "skills/timds-edit-design-system/SKILL.md", "templates/design-system-AGENTS.md"],
  "src/changelog.mjs": ["README.md", "CLAUDE.md", "skills/design-ship/SKILL.md", "skills/design-handoff/SKILL.md", "skills/timds-edit-design-system/SKILL.md", "templates/design-system-AGENTS.md"],
  "src/designs.mjs": ["README.md", "CLAUDE.md", "skills/design-handoff/SKILL.md", "skills/timds-edit-design-system/SKILL.md", "skills/timds-update-design-system/SKILL.md", "templates/design-system-AGENTS.md"],
  "src/starter.mjs": ["README.md", "CLAUDE.md", "skills/timds-edit-design-system/SKILL.md", "templates/design-system-AGENTS.md"],
  "src/brand-kit.mjs": ["docs/brand-kit.md", "CLAUDE.md", "skills/timds-edit-design-system/SKILL.md"],
  "src/extract.mjs": ["README.md", "CLAUDE.md", "templates/design-system-AGENTS.md", "skills/timds-consume-design-system/SKILL.md"],
  "src/bundle.mjs": ["README.md", "CLAUDE.md", "skills/timds-consume-design-system/SKILL.md", "skills/timds-update-design-system/SKILL.md"],
  "src/derived.mjs": ["README.md", "CLAUDE.md", "skills/timds-consume-design-system/SKILL.md"],
  "src/mcp.mjs": ["README.md", "CLAUDE.md", "skills/timds-edit-design-system/SKILL.md"],
  "src/mcp-read.mjs": ["README.md", "CLAUDE.md", "skills/timds-consume-design-system/SKILL.md", "skills/timds-update-design-system/SKILL.md"],
  "src/consumer.mjs": ["README.md", "skills/timds-consume-design-system/SKILL.md", "skills/timds-update-design-system/SKILL.md"],
  "src/consumer-init.mjs": ["README.md", "CLAUDE.md", "skills/timds-consume-design-system/SKILL.md", "skills/timds-update-design-system/SKILL.md"],
  "src/consumer-sync.mjs": ["README.md", "CLAUDE.md", "skills/timds-consume-design-system/SKILL.md", "skills/timds-update-design-system/SKILL.md"],
  "src/consumer-migrate.mjs": ["README.md", "CLAUDE.md", "skills/timds-update-design-system/SKILL.md"],
  "src/consumer-install.mjs": ["README.md", "CLAUDE.md", "docs/binary-installation.md"],
  "src/consumer-preview.mjs": ["README.md", "skills/timds-consume-design-system/SKILL.md", "skills/timds-update-design-system/SKILL.md"],
  "src/consumer-draft-preview.mjs": ["README.md", "skills/timds-consume-design-system/SKILL.md"],
  "src/consumer-notes.mjs": ["README.md", "skills/timds-consume-design-system/SKILL.md"],
  "src/consumer-scaffold.mjs": ["README.md", "templates/emdash/AGENTS-design-system.md", "templates/emdash/DESIGN_SYSTEM.md"],
  "src/offshoots.mjs": ["README.md", "docs/offshoots.md", "CLAUDE.md"],
  "src/offshoot-contract.mjs": ["README.md", "docs/offshoots.md", "CLAUDE.md"],
  "src/feed.mjs": ["README.md", "docs/offshoots.md", "CLAUDE.md"],
  "src/defaults.mjs": ["README.md", "CLAUDE.md", "AGENTS.md"],
  "src/binary-installation.mjs": ["docs/binary-installation.md", "CLAUDE.md"],
  "src/executable.mjs": ["docs/binary-installation.md", "docs/binary-packaging.md", "CLAUDE.md"],
  "src/video.mjs": ["README.md", "CLAUDE.md", "skills/timds-create-video/SKILL.md"],
  "src/video-producer.mjs": ["README.md", "CLAUDE.md", "skills/timds-create-video/SKILL.md"],
  "src/video-boards.mjs": ["README.md", "CLAUDE.md", "skills/timds-create-video/SKILL.md"],
  "src/video-lab-server.mjs": ["README.md", "CLAUDE.md", "skills/timds-create-video/SKILL.md"],
  "src/video-migration.mjs": ["README.md", "skills/timds-create-video/SKILL.md"],
  "video/footage.mjs": ["README.md", "CLAUDE.md", "skills/timds-create-video/SKILL.md"],
  "video/boards.mjs": ["README.md", "CLAUDE.md", "skills/timds-create-video/SKILL.md"],
  "video/remotion.tsx": ["README.md", "CLAUDE.md", "skills/timds-create-video/SKILL.md"],
  "templates/starter/": ["README.md", "CLAUDE.md", "skills/timds-edit-design-system/SKILL.md", "templates/design-system-AGENTS.md", "templates/design-system-README.md"],
  "templates/brand-kit/": ["docs/brand-kit.md", "CLAUDE.md", "skills/timds-edit-design-system/SKILL.md"],
  "templates/video/": ["README.md", "skills/timds-create-video/SKILL.md"],
  "templates/emdash/": ["README.md", "templates/emdash/AGENTS-design-system.md", "templates/emdash/DESIGN_SYSTEM.md"],
  ".github/workflows/": ["CLAUDE.md"],
});

/**
 * Facts the source cannot be read for, each with its reason. Adding an entry
 * is the reviewed way to accept a claim; removing a stale one is expected.
 */
export const proseAllowances = Object.freeze({
  // Files the toolkit writes into a client repository at run time that are
  // neither a `templates/` copy, a `.timds/` record named in the source, nor
  // a workflow with a template of the same name.
  runtimeFiles: [
    ".claude/launch.json", // consumer init renders templates/consumer-launch.json here
    "scripts/brand-kit.mjs", // init and starter sync copy src/brand-kit.mjs here
  ],
  // A bare family name (`timds consumer`, `timds assets`) is a mention of the
  // group, not an invocation; it needs no usage line of its own.
  commandFamilies: ["consumer", "draft", "assets", "auth", "video", "mcp", "skills", "designs", "starter", "sessions", "installation", "dependencies"],
  // Usage-text commands no instruction surface needs to teach.
  uncoveredCommands: [
    "run", // timds-cli run: binary re-entry for scripts (docs/binary-installation.md covers the mode)
  ],
  // Commands the dispatcher in src/core.mjs accepts that the usage text does
  // not list. Each is a known gap or a deliberate alias; a new entry here is
  // a decision, not a default.
  undocumentedCommands: [
    "media", // alias of `assets`, kept for older scripts
    "artifact", // `timds artifact publish` publishes the portal release ref; never documented (audit 2026-11-06)
  ],
});

/** The top-level commands the dispatcher in src/core.mjs accepts, read from its branches. */
export async function dispatchedCommands(root = packageRoot) {
  const source = await fs.readFile(path.join(root, "src", "core.mjs"), "utf8");
  // Version and help switches are not commands.
  const names = new Set([...source.matchAll(/command === "([a-z-]+)"/g)].map((match) => match[1]).filter((name) => !["help", "version"].includes(name)));
  for (const match of source.matchAll(/\[((?:"[a-z-]+",?\s*)+)\]\.includes\(command\)/g)) for (const name of match[1].matchAll(/"([a-z-]+)"/g)) names.add(name[1]);
  for (const name of names) if (name.startsWith("-") || ["help", "version"].includes(name)) names.delete(name);
  return names;
}

const PROGRAM_PREFIX = /(?:^|[\s;&|(`])(?:npx\s+(?:--yes\s+)?@dtconcepts\/timds(?:@[\w.-]+)?\s+|npm\s+run\s+timds\s+--\s+|__TIMDS_CLI__\s+|timds-cli\s+|timds\s+)/g;
const PATH_TOKEN = /^[a-z][a-z-]*$/;

/** Parse usage lines (`timds ...`) into command paths and their flags. */
export function parseUsageGrammar(text) {
  const grammar = new Map();
  const add = (pathTokens, flags) => {
    const key = pathTokens.join(" ");
    const entry = grammar.get(key) ?? { path: pathTokens, flags: new Set() };
    for (const flag of flags) entry.flags.add(flag);
    grammar.set(key, entry);
  };
  for (const raw of text.split("\n")) {
    const line = raw.trim().replace(/['")]+$/, "");
    if (!/^(timds|timds-cli)\s/.test(line)) continue;
    const tokens = line.split(/\s+/).slice(1);
    const flags = [...line.matchAll(/--[a-z][a-z-]*/g)].map((match) => match[0]);
    let paths = [[]];
    for (const token of tokens) {
      const optionalLiteral = /^\[([a-z][a-z-]*)\]$/.exec(token);
      if (optionalLiteral) {
        // `mcp [edit]`: the shorter path is valid, and so is the longer one.
        paths = paths.flatMap((prefix) => [prefix, [...prefix, optionalLiteral[1]]]);
        continue;
      }
      if (!/^[a-z][a-z-]*(\|[a-z][a-z-]*)*$/.test(token)) break;
      const alternatives = token.split("|");
      paths = paths.flatMap((prefix) => alternatives.map((alternative) => [...prefix, alternative]));
    }
    for (const pathTokens of paths) if (pathTokens.length) add(pathTokens, flags);
  }
  return grammar;
}

/** Every `Usage:` block a source module carries, by module. */
export async function usageTexts(root = packageRoot) {
  const texts = new Map();
  for (const name of (await fs.readdir(path.join(root, "src"))).filter((entry) => entry.endsWith(".mjs") && !entry.endsWith(".test.mjs")).sort()) {
    const source = await fs.readFile(path.join(root, "src", name), "utf8");
    const lines = [];
    for (const match of source.matchAll(/Usage:(?:\\n)?\s*([\s\S]*?)(?:`|"\s*[,;)])/g)) {
      for (const line of match[1].split(/\\n|\n/)) {
        if (/^\s*(timds|timds-cli)\s/.test(line)) lines.push(line.trim());
        else if (/^\s+\[?--/.test(line) && lines.length) lines[lines.length - 1] += ` ${line.trim()}`; // a wrapped usage line continues the one above
      }
    }
    if (lines.length) texts.set(`src/${name}`, lines.join("\n"));
  }
  return texts;
}

/** The toolkit's command grammar: every usage text in the source, merged. */
export async function commandGrammar(root = packageRoot) {
  const grammar = parseUsageGrammar(helpText());
  for (const [, text] of await usageTexts(root)) {
    for (const [key, entry] of parseUsageGrammar(text)) {
      const existing = grammar.get(key);
      if (existing) for (const flag of entry.flags) existing.flags.add(flag);
      else grammar.set(key, entry);
    }
  }
  return grammar;
}

/**
 * Where a module's own usage text and the public `--help` in src/core.mjs
 * disagree: a command or flag one lists and the other does not. Both are
 * printed to people, so both must say the same thing.
 */
export async function usageDisagreements(root = packageRoot) {
  const problems = [];
  const reference = parseUsageGrammar(helpText());
  // `timds video --help` delegates: that family's usage lives in its module.
  const delegated = [...reference.values()].filter((entry) => entry.path.length === 1 && entry.flags.has("--help")).map((entry) => entry.path[0]);
  for (const [module, text] of await usageTexts(root)) {
    if (module === "src/core.mjs") continue;
    for (const [key, entry] of parseUsageGrammar(text)) {
      if (delegated.some((family) => key === family || key.startsWith(`${family} `))) continue;
      const published = reference.get(key);
      if (!published) {
        problems.push({ surface: module, line: 0, kind: "usage", message: `usage text lists \`timds ${key}\`, which the --help text in src/core.mjs does not` });
        continue;
      }
      for (const flag of entry.flags) if (!published.flags.has(flag)) problems.push({ surface: module, line: 0, kind: "usage", message: `usage text gives \`timds ${key}\` ${flag}, which the --help text in src/core.mjs does not list` });
      for (const flag of published.flags) if (!entry.flags.has(flag)) problems.push({ surface: "src/core.mjs", line: 0, kind: "usage", message: `--help gives \`timds ${key}\` ${flag}, which the usage text in ${module} does not list` });
    }
  }
  return problems;
}

/** Inline code spans and fenced blocks, with the line each starts on. */
export function codeSpans(markdown) {
  const spans = [];
  const lines = markdown.split("\n");
  let fence = null;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const fenceMatch = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (fenceMatch && fenceMatch[1][0] === fence.marker[0] && fenceMatch[1].length >= fence.marker.length) {
        spans.push({ text: fence.lines.join("\n"), line: fence.line + 1, fenced: true });
        fence = null;
      } else fence.lines.push(line);
      continue;
    }
    if (fenceMatch) {
      fence = { marker: fenceMatch[1], line: index + 1, lines: [] };
      continue;
    }
    for (const match of line.matchAll(/`([^`\n]+)`/g)) spans.push({ text: match[1], line: index + 1, fenced: false });
  }
  return spans;
}

/** Every `timds ...` invocation inside code, with its leading words and flags. */
export function commandMentions(markdown) {
  const mentions = [];
  for (const span of codeSpans(markdown)) {
    span.text.split("\n").forEach((spanLine, offset) => {
      const line = span.line + offset;
      for (const match of spanLine.matchAll(PROGRAM_PREFIX)) {
        const rest = spanLine.slice(match.index + match[0].length);
        // One invocation ends at a shell separator or a comment.
        const invocation = rest.split(/\s*(?:&&|\|\||;|\|(?!\|)|#|\)|`)\s*/)[0].trim();
        const tokens = invocation.split(/\s+/).filter(Boolean);
        const pathTokens = [];
        for (const token of tokens) {
          if (!PATH_TOKEN.test(token)) break;
          pathTokens.push(token);
        }
        const flags = [...invocation.matchAll(/(?:^|\s)(--[a-z][a-z-]*)/g)].map((flagMatch) => flagMatch[1]);
        mentions.push({ line, invocation, pathTokens, flags, fenced: span.fenced });
      }
    });
  }
  return mentions;
}

/** Match a mention's leading words to the longest grammar entry they begin with. */
function resolveCommand(grammar, pathTokens) {
  for (let length = pathTokens.length; length > 0; length--) {
    const key = pathTokens.slice(0, length).join(" ");
    if (grammar.has(key)) return { key, entry: grammar.get(key) };
  }
  return null;
}

/** Tool names the MCP surfaces register, collected from the registrars themselves. */
export function registeredToolNames() {
  const names = new Set();
  const server = { registerTool: (name) => names.add(name), registerResource: () => {} };
  registerDesignSystemTools(server, { resolveWorkspace: async () => null });
  registerHostedSessionTools(server, { root: packageRoot });
  registerDesignSystemReadTools(server, { resolveSystem: async () => null });
  return names;
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/** Placeholders a surface carries, to compare with what its renderer fills. */
export function placeholders(text) {
  return [...new Set([...text.matchAll(/__[A-Z][A-Z0-9_]*__/g)].map((match) => match[0]))].sort();
}

const sourceModules = async (root) => (await fs.readdir(path.join(root, "src"))).filter((entry) => entry.endsWith(".mjs") && !entry.endsWith(".test.mjs")).map((entry) => path.join(root, "src", entry));

/** The placeholders each renderer fills, read from the renderers' own code. */
async function rendererPlaceholders(root) {
  const read = (file) => fs.readFile(path.join(root, file), "utf8");
  const filled = (source) => new Set([...source.matchAll(/(?:replace(?:All)?\(|^\s*)"?(__[A-Z][A-Z0-9_]*__)"?/gm)].map((match) => match[1]));
  return {
    consumer: filled(await read("src/consumer-init.mjs")),
    scaffold: filled(await read("src/core.mjs")),
    emdash: new Set([...filled(await read("src/consumer-scaffold.mjs")), ...filled(await read("src/consumer-init.mjs"))]),
    hosted: new Set(hostedSkillPlaceholders),
  };
}

/** Client-repository files the source writes by name: `.timds/` records, stamps, and the EmDash scaffold's files. */
async function sourceNamedFiles(root) {
  const files = new Set(proseAllowances.runtimeFiles);
  for (const module of await sourceModules(root)) {
    const source = await fs.readFile(module, "utf8");
    for (const match of source.matchAll(/["'`](\.timds(?:\/[A-Za-z0-9_.-]+)+|\.timds-[a-z-]+\.json|\.timds-[a-z-]+)["'`]/g)) files.add(match[1]);
    if (module.endsWith("consumer-scaffold.mjs")) for (const match of source.matchAll(/["'](\.?(?:src|scripts|public|\.github)\/[A-Za-z0-9_./-]+)["']/g)) files.add(match[1]);
  }
  return files;
}

const SCAFFOLD_ROOTS = ["templates/starter", "templates/brand-kit"];
const PATH_PREFIXES = ["src/", "scripts/", "templates/", "video/", "skills/", "docs/", ".github/", ".timds/", "bin/", ".agents/", ".claude/", ".cursor/"];
const CONSUMER_PREFIXES = [".timds/", ".github/", ".agents/", ".claude/", ".cursor/"];

/** Whether a client-repository path a surface names exists in what the toolkit writes. */
async function clientPathExists(root, relative, named) {
  if (named.has(relative)) return true;
  if (relative.startsWith("video/")) return exists(path.join(root, "templates", relative));
  if (relative.startsWith(".github/workflows/")) {
    const name = relative.slice(".github/workflows/".length);
    return (await exists(path.join(root, "templates", name))) || exists(path.join(root, "templates", "emdash", name));
  }
  if (/^\.(agents|claude|cursor)\/skills\//.test(relative)) {
    const [, , skill, ...rest] = relative.split("/");
    return exists(path.join(root, "skills", skill, ...rest));
  }
  for (const scaffold of SCAFFOLD_ROOTS) if (await exists(path.join(root, scaffold, relative))) return true;
  return exists(path.join(root, "templates", relative));
}

/**
 * Check every surface against the source. Returns problems as
 * `{ surface, line, kind, message }`; an empty list means the prose is in
 * contract with the toolkit.
 */
export async function checkProseContract({ root = packageRoot } = {}) {
  const problems = [...(await usageDisagreements(root))];
  const grammar = await commandGrammar(root);
  const toolNames = registeredToolNames();
  const fills = await rendererPlaceholders(root);
  const named = await sourceNamedFiles(root);
  const mentionedCommands = new Set();
  const surfaces = [];
  for (const surface of proseSurfaces) {
    const file = path.join(root, surface.file);
    if (!(await exists(file))) {
      problems.push({ surface: surface.file, line: 0, kind: "surface", message: "listed in proseSurfaces but missing" });
      continue;
    }
    surfaces.push({ ...surface, text: await fs.readFile(file, "utf8") });
  }

  for (const surface of surfaces) {
    const problem = (line, kind, message) => problems.push({ surface: surface.file, line, kind, message });
    const lineOf = (index) => surface.text.slice(0, index).split("\n").length;

    // 1. Commands and flags exist in the usage grammar.
    for (const mention of commandMentions(surface.text)) {
      if (!mention.pathTokens.length) continue;
      const resolved = resolveCommand(grammar, mention.pathTokens);
      if (!resolved) {
        if (proseAllowances.commandFamilies.includes(mention.pathTokens[0]) && mention.pathTokens.length === 1 && !mention.flags.length) continue;
        problem(mention.line, "command", `unknown command \`timds ${mention.pathTokens.join(" ")}\` (no usage text in src/ lists it)`);
        continue;
      }
      mentionedCommands.add(resolved.key);
      for (const flag of mention.flags) {
        if (resolved.entry.flags.has(flag)) continue;
        problem(mention.line, "flag", `\`timds ${resolved.key}\` does not take ${flag} (usage text lists: ${[...resolved.entry.flags].join(" ") || "no flags"})`);
      }
    }

    // 2. MCP tool names the prose cites are registered. A shell variable or a
    //    query parameter of the same shape is not a tool name.
    for (const match of surface.text.matchAll(/(?<![$?&"'])\btimds_[a-z_]+\b(?!=)/g)) {
      if (toolNames.has(match[0])) continue;
      problem(lineOf(match.index), "tool", `MCP tool \`${match[0]}\` is not registered by src/mcp.mjs or src/mcp-read.mjs`);
    }

    // 3. Placeholders match the renderer that fills the surface.
    const expected = surface.kind === "hosted" ? fills.hosted
      : surface.kind === "consumer" ? (surface.file.startsWith("templates/emdash/") ? fills.emdash : fills.consumer)
      : surface.kind === "scaffold" ? fills.scaffold
      : null;
    if (expected) {
      for (const token of placeholders(surface.text)) {
        if (expected.has(token)) continue;
        problem(lineOf(surface.text.indexOf(token)), "placeholder", `${token} is never filled by the renderer for ${surface.kind} surfaces`);
      }
    }

    // 4. Files the prose names exist where the reader will look.
    const prefixes = surface.kind === "consumer" ? CONSUMER_PREFIXES : PATH_PREFIXES;
    for (const span of codeSpans(surface.text)) {
      if (span.fenced) continue;
      const candidate = span.text.trim();
      if (!prefixes.some((prefix) => candidate.startsWith(prefix))) continue;
      if (/[<>*{}$ ]|[A-Z]{2,}|\.\.\.|\/$/.test(candidate)) continue; // a pattern or a directory, not a file claim
      if (!/\.[a-z0-9]+$/.test(candidate)) continue; // only file claims with an extension
      const found = (surface.kind === "toolkit" && await exists(path.join(root, candidate))) || await clientPathExists(root, candidate, named);
      if (!found) problem(span.line, "path", `\`${candidate}\` does not exist in ${surface.kind === "toolkit" ? "this repository, " : ""}the scaffold, or the files the source writes by name`);
    }
  }

  // 5a. Every command the dispatcher accepts has a usage line.
  for (const name of await dispatchedCommands(root)) {
    if (proseAllowances.undocumentedCommands.includes(name)) continue;
    if ([...grammar.keys()].some((key) => key === name || key.startsWith(`${name} `))) continue;
    problems.push({ surface: "src/core.mjs", line: 0, kind: "usage", message: `the dispatcher accepts \`timds ${name}\` but no usage text lists it` });
  }

  // 5. Every command the usage texts offer is taught somewhere.
  for (const [key] of grammar) {
    if (mentionedCommands.has(key)) continue;
    if (proseAllowances.uncoveredCommands.includes(key)) continue;
    if ([...mentionedCommands].some((mentioned) => mentioned.startsWith(`${key} `))) continue; // `mcp` is taught by `mcp read`
    problems.push({ surface: "(usage text)", line: 0, kind: "coverage", message: `\`timds ${key}\` is in the usage text but no instruction surface mentions it` });
  }

  // 6. The skills directory, the installer name lists, and each skill's own name agree.
  const skillDirectories = (await fs.readdir(path.join(root, "skills"), { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  const expectedSkills = [...designSystemSkillNames, ...CONSUMER_SKILL_NAMES, HOSTED_SKILL_TEMPLATE].sort();
  for (const name of skillDirectories) if (!expectedSkills.includes(name)) problems.push({ surface: `skills/${name}`, line: 0, kind: "skill", message: "skill directory is not in designSystemSkillNames, CONSUMER_SKILL_NAMES, or the hosted skill" });
  for (const name of expectedSkills) if (!skillDirectories.includes(name)) problems.push({ surface: `skills/${name}`, line: 0, kind: "skill", message: "named by an installer but the directory is missing" });
  for (const name of skillDirectories) {
    const text = await fs.readFile(path.join(root, "skills", name, "SKILL.md"), "utf8").catch(() => "");
    const declared = /^name:\s*(\S+)\s*$/m.exec(text)?.[1];
    const expectedName = name === HOSTED_SKILL_TEMPLATE ? "__SKILL_NAME__" : name;
    if (declared !== expectedName) problems.push({ surface: `skills/${name}/SKILL.md`, line: 2, kind: "skill", message: `frontmatter name is ${declared ?? "missing"}, expected ${expectedName}` });
    const manifest = await fs.readFile(path.join(root, "skills", name, "agents", "openai.yaml"), "utf8").catch(() => null);
    if (manifest === null) problems.push({ surface: `skills/${name}/agents/openai.yaml`, line: 0, kind: "skill", message: "missing agents/openai.yaml" });
    else if (name !== HOSTED_SKILL_TEMPLATE && !manifest.includes(`$${name}`)) problems.push({ surface: `skills/${name}/agents/openai.yaml`, line: 0, kind: "skill", message: `default_prompt does not invoke $${name}` });
    if (!proseSurfaces.some((surface) => surface.file === `skills/${name}/SKILL.md`)) problems.push({ surface: `skills/${name}/SKILL.md`, line: 0, kind: "surface", message: "not listed in proseSurfaces" });
  }

  // 7. Every tracked Markdown file under skills/, templates/, and docs/ is a
  //    listed surface (an untracked draft is the author's until it is added).
  const tracked = execFileSync("git", ["ls-files", "--", "skills", "templates", "docs"], { cwd: root, encoding: "utf8" }).split("\n").filter((entry) => entry.endsWith(".md"));
  for (const relative of tracked) {
    if (proseSurfaces.some((surface) => surface.file === relative)) continue;
    if (SCAFFOLD_ROOTS.some((scaffold) => relative.startsWith(`${scaffold}/`)) || relative.startsWith("templates/video/") || relative.startsWith("templates/starter-history/")) continue; // brand content and samples, not instructions
    if (relative === "templates/CHANGELOG.md") continue; // the client's own history, one placeholder
    problems.push({ surface: relative, line: 0, kind: "surface", message: "Markdown instruction file not listed in proseSurfaces (add it with its kind, or exclude it in checkProseContract with the reason)" });
  }

  return problems.sort((left, right) => left.surface.localeCompare(right.surface) || left.line - right.line);
}

/** One line per problem, the way a test or CI log reads it. */
export function formatProblems(problems) {
  return problems.map((problem) => `${problem.surface}:${problem.line} [${problem.kind}] ${problem.message}`).join("\n");
}
