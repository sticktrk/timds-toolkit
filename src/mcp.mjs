// The Design System editing tools as an MCP surface.
//
// One tool surface, two transports: `timds mcp` serves these tools over stdio
// against the current checkout, and a host that manages remote drafts registers
// the same tools on its own server with `registerDesignSystemTools`, resolving
// each call's `draftId` to a workspace. The toolkit owns the tool definitions,
// the authored-surface guard, and the check; the host owns transport,
// identity, draft lifecycle, and what happens after a write.

import { randomBytes, createHash } from "node:crypto";
import { lstatSync, promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";
import {
  brandReport,
  checkWorkspace,
  execute,
  findRepositoryRoot,
  loadWorkspace,
  runWithOutputSink,
  setOutputStream,
} from "./core.mjs";
import { readDerivedLayer, summarizeBrandKit } from "./derived.mjs";
import { readMediaCatalog } from "./media.mjs";

export const DESIGN_SYSTEM_MCP_SERVER_NAME = "timds-design-system";
export const EDITING_GUIDE_URI = "timds://guide";

const MAX_TEXT_BYTES = 2_000_000;
const MAX_BINARY_READ_BYTES = 256_000;
const MAX_WRITE_BYTES = 2_000_000;
const MAX_LISTED_FILES = 2_000;
const MAX_LOG_LINES = 200;

// Protected relative to the Design System root. Directories protect
// everything beneath them; files protect exactly that path.
const PROTECTED_DIRECTORIES = [".git", ".timds", ".agents", ".github", "node_modules", "dist", "media-local", "video-local"];
const PROTECTED_FILES = ["package.json", "package-lock.json", "timds.json", "media.json", ".gitignore"];
// Protected wherever they appear.
const PROTECTED_SEGMENTS = new Set([".git", "node_modules"]);
const PROTECTED_BASENAMES = new Set([".gitignore"]);

const DIRECTORY_PURPOSES = {
  assets: "Lightweight tracked assets: optimized logos, icons, fonts",
  brand: "Brand guidance pages such as voice and compliance",
  components: "Reusable viewer components",
  docs: "Prose documentation and guidance pages",
  pages: "Viewer pages",
  public: "Static files copied into the built artifact",
  scripts: "Workspace scripts that timds.json runs for build, dev, and check",
  src: "Authored viewer source: pages, components, styles, and lightweight assets",
  styles: "Stylesheets and CSS custom properties",
  video: "Video contract, asset map, and productions",
};

// ---------------------------------------------------------------------------
// Editing guide

// Mirrors skills/timds-edit-design-system/SKILL.md for an agent that edits
// through these tools and never has a checkout: the authored-surface,
// protected-tooling, brand-role, media, video, verification, and submission
// rules stay; clone, install, local servers, and branch handling belong to the
// host and are left out.
const EDITING_GUIDE = `# Edit a TimDS Design System through MCP

You are editing a client's repository-owned TimDS Design System through the
\`timds-design-system\` tools. You have no checkout: every read, write, and
check goes through these tools, and the host records each write as a reviewed
change. Work only in the Design System the user gave you.

## Start

1. Call \`describe_workspace\` for the system, its layout, the authored
   directories, the protected paths, and the brand kit report.
2. Read the Design System's \`AGENTS.md\` and \`README.md\` with \`read_file\`
   when they exist, then read the authored source you are about to change
   completely. Follow client-specific instructions.
3. Use \`list_files\` with a \`path\` prefix or \`glob\` to find files rather than
   guessing names.

## Stay on the authored surface

- In a standalone Design System the repository is the authored surface. In an
  embedded one it is \`design-system/**\` only.
- Protected tooling and generated paths are refused, not merely discouraged:
  \`.git/\`, \`.timds/\`, \`.agents/\`, \`.github/\`, \`package.json\`,
  \`package-lock.json\`, \`node_modules/\`, \`dist/\`, \`timds.json\`,
  \`media.json\`, \`.gitignore\`, \`media-local/\`, \`video-local/\`, and any
  symbolic link. The TimDS release line, lockfile, installation record, agent
  skills, workspace commands, and workflows change only when the operator
  updates TimDS. When a change needs a protected file, say so in your hand-off
  instead of working around it.
- Edit authored tokens, source, documentation, components, navigation, and
  lightweight assets. Preserve the framework and visual language unless the
  user asks for a migration or redesign.
- Never hand-edit \`dist/\`: \`run_check\` builds it from source.
- Use genuine licensed assets. Never invent client marks or usage rights.
- Give every \`write_file\` and \`delete_file\` a short \`note\` that says what
  changed and why; it becomes the change description.

## Brand roles and the derived layer

- \`run_check\` derives \`tokens.json\` from the built stylesheets and fills the
  brand roles (\`color.accent\`, \`font.display\`, ...) by convention. When a
  role is unfilled, the fix is a \`timds.json\` \`brand.roles\` mapping to the
  system's existing token name, never a copied value; \`timds.json\` is
  protected here, so report the mapping you recommend.
- \`brand.json\` comes from assets annotated \`data-timds-role\`: annotate the
  logo images on the page that presents them with \`logo\` (and \`logo primary\`
  on the default variant), and reusable imagery with \`photo\`,
  \`illustration\`, \`graphic\`, \`icon\`, or \`pattern\`. Do not list them
  elsewhere.
- Voice and compliance guidance reach the kit from \`brand/voice\` and
  \`*/compliance\` pages by convention.
- Use \`read_derived\` (\`brand\`, \`tokens\`, \`index\`) after a check to see
  exactly what consumers of the system will read.

## Media

- Full-resolution images, video masters, B-roll, and source audio never enter
  the repository or \`dist/\`. They live in the published media catalog.
- \`list_media\` shows the catalog. Reference assets in source by their stable
  logical key; never paste an expiring signed URL or a credential.
- Keep originals and display images separate: a key used for page display or
  a thumbnail must resolve to an optimized derivative, never a large original.
  CSS sizing does not reduce downloaded bytes.
- Small optimized logos, icons, and fonts may be written as authored files
  when the client contract allows it. Adding or replacing catalog media is not
  available through these tools yet: describe what is needed in the hand-off.
- Shared brand imagery belongs to the Design System; consumers use its
  reviewed asset URLs or media keys.

## Video

- A video-enabled system keeps its contract, asset map, and productions under
  the video paths \`describe_workspace\` reports. Client copy, source
  authorization, compliance, and asset selection stay in those files; follow
  the client contract when editing them.
- When registering B-roll framing, include the configured vertical metadata
  records; wide subject-side labels do not replace reviewed vertical framing.
  Preserve the client's approved derivatives.
- \`run_check\` validates the video contract and productions with the rest of
  the system.

## Verify

- Run \`run_check\` after a meaningful set of changes. \`failed\` means the
  system does not build or validate: fix every error before handing off.
  \`warnings\` still produces a previewable build; resolve what you can and
  mention the rest.
- Confirm the requested change in the derived layer and, when the host offers
  one, the preview: navigation, local assets, typography, contrast, overflow,
  and mobile layout.

## Submit only when asked

Changes stay a draft until the designer asks to hand them off. Hand off only
when asked and only with a passing or warnings-only check. Do not merge,
publish, deploy, upgrade tooling, or roll back without separate authorization.

## Report the result

Lead with what changed. Include the check status, remaining warnings, and
anything that needs the operator: protected-file changes, brand role mappings,
or new media.
`;

/** The remote editing guide: the Design System editing rules without the local-only steps. */
export function editingGuideText() {
  return EDITING_GUIDE;
}

// ---------------------------------------------------------------------------
// Authored surface guard

function toPosix(value) {
  return value.split(path.sep).join("/");
}

/** Repository-relative root of the authored surface: "." for standalone, "design-system" for embedded. */
export function authoredSurfaceRoot(workspace) {
  const relative = toPosix(path.relative(workspace.repoRoot, workspace.designSystemRoot));
  return relative || ".";
}

function videoLocalDirectory(workspace) {
  const local = workspace.manifest?.video?.local;
  return local ? String(local).replace(/^\.\/+/, "").replace(/\/+$/, "") : null;
}

/**
 * Normalize a repository-relative path from a tool call. Returns null for
 * anything that is not a plain relative path: absolute paths, drive letters,
 * NUL bytes, `..` segments.
 */
function normalizeRelativePath(input) {
  if (typeof input !== "string") return null;
  const raw = input.trim().replace(/\\/g, "/");
  if (!raw || raw.length > 1_000 || raw.includes("\0")) return null;
  if (raw.startsWith("/") || /^[A-Za-z]:/.test(raw) || raw.startsWith("~")) return null;
  const segments = raw.split("/").filter((segment) => segment && segment !== ".");
  if (!segments.length || segments.some((segment) => segment === "..")) return null;
  return segments.join("/");
}

function designSystemRelative(workspace, repoRelative) {
  const surface = authoredSurfaceRoot(workspace);
  if (surface === ".") return repoRelative;
  if (repoRelative === surface) return "";
  if (!repoRelative.startsWith(`${surface}/`)) return null;
  return repoRelative.slice(surface.length + 1);
}

function protectedByPattern(workspace, dsRelative) {
  if (!dsRelative) return true; // the Design System root itself is not a file
  const segments = dsRelative.split("/");
  if (segments.some((segment) => PROTECTED_SEGMENTS.has(segment))) return true;
  if (PROTECTED_BASENAMES.has(segments.at(-1))) return true;
  if (PROTECTED_DIRECTORIES.includes(segments[0])) return true;
  if (PROTECTED_FILES.includes(dsRelative)) return true;
  const videoLocal = videoLocalDirectory(workspace);
  if (videoLocal && (dsRelative === videoLocal || dsRelative.startsWith(`${videoLocal}/`))) return true;
  return false;
}

function containsSymlink(root, relative) {
  let current = root;
  for (const segment of relative.split("/")) {
    current = path.join(current, segment);
    let info;
    try {
      info = lstatSync(current);
    } catch (caught) {
      if (caught?.code === "ENOENT" || caught?.code === "ENOTDIR") return false;
      throw caught;
    }
    if (info.isSymbolicLink()) return true;
  }
  return false;
}

/**
 * Whether a repository-relative path is off limits to the editing tools:
 * outside the authored surface, a protected tooling or generated path, not a
 * plain relative path, or reached through a symbolic link.
 */
export function isProtectedPath(workspace, relativePath) {
  const repoRelative = normalizeRelativePath(relativePath);
  if (!repoRelative) return true;
  if (PROTECTED_SEGMENTS.has(repoRelative.split("/")[0])) return true;
  const dsRelative = designSystemRelative(workspace, repoRelative);
  if (dsRelative === null) return true;
  if (protectedByPattern(workspace, dsRelative)) return true;
  return containsSymlink(workspace.repoRoot, repoRelative);
}

async function resolveAuthoredPath(workspace, relativePath) {
  const repoRelative = normalizeRelativePath(relativePath);
  if (!repoRelative) {
    throw new Error(`${JSON.stringify(String(relativePath ?? ""))} is not a relative path inside the Design System`);
  }
  if (designSystemRelative(workspace, repoRelative) === null) {
    throw new Error(`${repoRelative} is outside the authored surface (${authoredSurfaceRoot(workspace)}/**)`);
  }
  if (isProtectedPath(workspace, repoRelative)) {
    throw new Error(`${repoRelative} is protected; the editing tools cannot read or change it`);
  }
  const absolutePath = path.join(workspace.repoRoot, ...repoRelative.split("/"));
  // Belt and braces: the deepest existing ancestor must resolve inside the
  // real Design System root even if the root itself sits behind a link.
  const realRoot = await fs.realpath(workspace.designSystemRoot);
  let probe = path.dirname(absolutePath);
  while (true) {
    try {
      const realProbe = await fs.realpath(probe);
      const inside = path.relative(realRoot, realProbe);
      if (inside.startsWith("..") || path.isAbsolute(inside)) {
        throw new Error(`${repoRelative} resolves outside the Design System`);
      }
      break;
    } catch (caught) {
      if (caught?.code !== "ENOENT") throw caught;
      const parent = path.dirname(probe);
      if (parent === probe) break;
      probe = parent;
    }
  }
  return { absolutePath, repoRelative };
}

// ---------------------------------------------------------------------------
// Workspace helpers

function globToRegExp(glob) {
  let pattern = "";
  for (let index = 0; index < glob.length; index += 1) {
    const character = glob[index];
    if (character === "*") {
      if (glob[index + 1] === "*") {
        index += 1;
        if (glob[index + 1] === "/") {
          index += 1;
          pattern += "(?:.*/)?";
        } else {
          pattern += ".*";
        }
      } else {
        pattern += "[^/]*";
      }
    } else if (character === "?") {
      pattern += "[^/]";
    } else if (character === "{") {
      const end = glob.indexOf("}", index);
      if (end === -1) {
        pattern += "\\{";
      } else {
        pattern += `(?:${glob.slice(index + 1, end).split(",").map((part) => part.replace(/[.+^$()|[\]\\]/g, "\\$&")).join("|")})`;
        index = end;
      }
    } else {
      pattern += character.replace(/[.+^$()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${pattern}$`);
}

async function walkFiles(root, prefix = "") {
  const files = [];
  const walk = async (directory, relative) => {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const entryRelative = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (PROTECTED_SEGMENTS.has(entry.name)) continue;
        await walk(path.join(directory, entry.name), entryRelative);
      } else if (entry.isFile()) {
        files.push(entryRelative);
      }
    }
  };
  await walk(root, prefix);
  return files;
}

/** Repository-relative files on the authored surface, honoring .gitignore when the workspace is a Git checkout. */
async function authoredFiles(workspace) {
  const surface = authoredSurfaceRoot(workspace);
  let candidates;
  const listed = await execute(
    ["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", surface === "." ? "." : surface],
    { allowFailure: true, capture: true, cwd: workspace.repoRoot },
  ).catch(() => ({ code: 1, stdout: "" }));
  if (listed.code === 0) {
    candidates = [...new Set(listed.stdout.split("\0").filter(Boolean))];
  } else {
    candidates = await walkFiles(workspace.designSystemRoot, surface === "." ? "" : surface);
  }
  const files = [];
  for (const candidate of candidates.sort()) {
    if (isProtectedPath(workspace, candidate)) continue;
    let info;
    try {
      info = await fs.lstat(path.join(workspace.repoRoot, ...candidate.split("/")));
    } catch (caught) {
      if (caught?.code === "ENOENT") continue; // deleted in the working tree
      throw caught;
    }
    if (!info.isFile()) continue;
    files.push({ path: candidate, bytes: info.size });
  }
  return files;
}

function isBinary(buffer) {
  if (buffer.includes(0)) return true;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    return false;
  } catch {
    return true;
  }
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

async function atomicWrite(absolutePath, buffer) {
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  const temporary = path.join(
    path.dirname(absolutePath),
    `.${path.basename(absolutePath)}.timds-${process.pid}-${randomBytes(6).toString("hex")}.tmp`,
  );
  try {
    await fs.writeFile(temporary, buffer, { flag: "wx" });
    await fs.rename(temporary, absolutePath);
  } catch (caught) {
    await fs.rm(temporary, { force: true }).catch(() => {});
    throw caught;
  }
}

function brandGaps(derived) {
  const kit = derived.brand;
  if (!kit) {
    return { derived: false, stale: false, missingRoles: [], logos: 0, primaryLogo: null, missingGuidance: [], gaps: ["Brand kit not derived: the check did not produce brand.json."] };
  }
  const summary = summarizeBrandKit(kit);
  const missingGuidance = ["voice", "compliance"].filter((group) => !kit.guidance?.[group]);
  const gaps = [];
  for (const role of summary.roles.missing) gaps.push(`Brand role ${role} is unfilled; it needs a timds.json brand.roles mapping to an existing token.`);
  if (!summary.logos) gaps.push('No logos: annotate the logo images on the page that presents them with data-timds-role="logo" ("logo primary" on the default).');
  else if (!summary.primaryLogo) gaps.push('No primary logo: mark the default logo variant with data-timds-role="logo primary".');
  if (missingGuidance.includes("voice")) gaps.push("No voice guidance: write the brand/voice page.");
  return {
    derived: true,
    stale: derived.stale,
    missingRoles: summary.roles.missing,
    logos: summary.logos,
    primaryLogo: summary.primaryLogo,
    imagery: summary.imagery,
    missingGuidance,
    gaps,
  };
}

// One check at a time per Design System: builds write the same dist/.
const checkQueues = new Map();
function serialized(key, task) {
  const previous = checkQueues.get(key) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(task);
  const settled = next.catch(() => {});
  checkQueues.set(key, settled);
  settled.then(() => { if (checkQueues.get(key) === settled) checkQueues.delete(key); });
  return next;
}

/** Run `checkWorkspace` and report structured findings instead of printing or throwing. */
export async function runStructuredCheck(workspace) {
  return serialized(workspace.designSystemRoot, async () => {
    const log = [];
    const sink = (line) => {
      log.push(line);
      if (log.length > MAX_LOG_LINES) log.shift();
    };
    let checked = null;
    const errors = [];
    try {
      checked = await runWithOutputSink(sink, () => checkWorkspace(workspace.repoRoot));
    } catch (caught) {
      errors.push(caught instanceof Error ? caught.message : String(caught));
    }
    const warnings = [...(checked?.machine?.warnings ?? []), ...(checked?.video?.warnings ?? [])];
    const derived = await readDerivedLayer(workspace.designSystemRoot, checked?.manifest ?? workspace.manifest)
      .catch(() => ({ brand: null, stale: false }));
    return {
      status: errors.length ? "failed" : warnings.length ? "warnings" : "passed",
      errors,
      warnings,
      artifact: checked
        ? { fileCount: checked.artifact.fileCount, totalBytes: checked.artifact.totalBytes, entryPath: checked.artifact.entryPath }
        : null,
      machine: checked?.machine?.enabled ? { counts: checked.machine.counts } : null,
      video: checked?.video ? { productionCount: checked.video.productionCount } : null,
      brand: errors.length ? null : brandGaps(derived),
      log,
    };
  });
}

async function describe(workspace) {
  const files = await authoredFiles(workspace);
  const surface = authoredSurfaceRoot(workspace);
  const directories = new Map();
  const topFiles = [];
  for (const file of files) {
    const dsRelative = designSystemRelative(workspace, file.path);
    const [first, ...rest] = dsRelative.split("/");
    if (rest.length) directories.set(first, (directories.get(first) ?? 0) + 1);
    else topFiles.push(file.path);
  }
  const video = workspace.manifest.video;
  const purpose = (name) => {
    if (video) {
      for (const [key, label] of [["productions", "Video productions"], ["lab", "Video lab previews"], ["components", "Client-owned video components"]]) {
        if (video[key] && video[key].split("/")[0] === name && name !== "video") return label;
      }
    }
    return DIRECTORY_PURPOSES[name] ?? "Authored files";
  };
  const prefix = surface === "." ? "" : `${surface}/`;
  const derived = await readDerivedLayer(workspace.designSystemRoot, workspace.manifest);
  return {
    systemId: workspace.manifest.systemId,
    name: workspace.manifest.name,
    description: workspace.manifest.description || null,
    version: workspace.manifest.version,
    layout: workspace.layout,
    authoredSurface: surface === "." ? "**" : `${surface}/**`,
    authoredDirectories: [...directories.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([name, fileCount]) => ({
      path: `${prefix}${name}`,
      purpose: purpose(name),
      fileCount,
    })),
    authoredFiles: topFiles,
    protectedPaths: [
      ...PROTECTED_DIRECTORIES.map((name) => `${prefix}${name}/**`),
      ...PROTECTED_FILES.map((name) => `${prefix}${name}`),
      ...(videoLocalDirectory(workspace) && !PROTECTED_DIRECTORIES.includes(videoLocalDirectory(workspace)) ? [`${prefix}${videoLocalDirectory(workspace)}/**`] : []),
      "**/.git/**",
      "**/node_modules/**",
      "**/.gitignore",
      "any symbolic link",
      ...(surface === "." ? [] : [`everything outside ${surface}/`]),
    ],
    workspaceCommands: Object.fromEntries(Object.entries(workspace.manifest.workspace).filter(([, command]) => command)),
    artifact: { entry: workspace.manifest.artifact.entry, publishRef: workspace.manifest.artifact.publishRef || null },
    brandConfig: workspace.manifest.brand,
    video: video ? Object.fromEntries(Object.entries(video).filter(([, value]) => value).map(([key, value]) => [key, `${prefix}${value}`])) : null,
    mediaAssets: workspace.mediaCatalog?.assets?.length ?? 0,
    brandKit: {
      summary: summarizeBrandKit(derived.brand),
      stale: derived.stale,
      report: brandReport(workspace, derived).join("\n"),
    },
  };
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
    content: [{ type: "text", text: caught instanceof Error ? caught.message : String(caught || "Design System tool failed") }],
    isError: true,
  };
}

const READ_ONLY = { destructiveHint: false, idempotentHint: true, openWorldHint: false, readOnlyHint: true };

/**
 * Register the Design System editing tools on an McpServer.
 *
 * `resolveWorkspace({ draftId })` returns a loaded workspace (see
 * `loadWorkspace`). With `hooks.remote` every tool takes a required `draftId`
 * that is passed through; otherwise there is no `draftId` and the resolver is
 * called with no draft. `hooks.afterWrite(workspace, { paths, note })` runs
 * after every successful write or delete; a non-undefined return value is
 * reported to the agent as `hook`.
 */
export function registerDesignSystemTools(server, { resolveWorkspace, hooks = {} } = {}) {
  if (typeof resolveWorkspace !== "function") throw new Error("registerDesignSystemTools requires resolveWorkspace");
  const remote = Boolean(hooks.remote);
  const draftShape = remote
    ? { draftId: z.string().min(1).max(200).describe("Draft identifier returned when the draft was opened") }
    : {};
  const workspaceFor = async (args) => {
    const workspace = await (remote ? resolveWorkspace({ draftId: args.draftId }) : resolveWorkspace());
    if (!workspace?.repoRoot || !workspace?.designSystemRoot || !workspace?.manifest) {
      throw new Error("The Design System workspace could not be resolved");
    }
    return workspace;
  };
  const afterWrite = async (workspace, change) => (typeof hooks.afterWrite === "function" ? hooks.afterWrite(workspace, change) : undefined);
  const tool = (name, config, handler) => {
    server.registerTool(name, { ...config, inputSchema: { ...draftShape, ...(config.inputSchema ?? {}) } }, async (args) => {
      try {
        return toolResult(await handler(args ?? {}));
      } catch (caught) {
        return toolError(caught);
      }
    });
  };

  tool("get_editing_guide", {
    title: "Editing guide",
    annotations: READ_ONLY,
    description: "Read the rules for editing this TimDS Design System through these tools: the authored surface, protected paths, brand roles, media and video, verification, and when to hand off. Read it before the first change.",
  }, async () => ({ uri: EDITING_GUIDE_URI, guide: editingGuideText() }));

  tool("describe_workspace", {
    title: "Describe the Design System",
    annotations: READ_ONLY,
    description: "Describe the Design System: systemId, name, version, layout, authored directories with their purpose, protected paths, workspace commands, video paths, and the brand kit report with a fix for every gap.",
  }, async (args) => describe(await workspaceFor(args)));

  tool("list_files", {
    title: "List authored files",
    annotations: READ_ONLY,
    description: "List files on the authored surface with their sizes. Protected and ignored paths are never listed. Paths are repository-relative and are what read_file and write_file accept.",
    inputSchema: {
      path: z.string().max(1_000).optional().describe("Only files under this repository-relative directory or exactly this file"),
      glob: z.string().max(300).optional().describe("Only files whose repository-relative path matches this glob, e.g. **/*.css or src/pages/*.{html,md}"),
    },
  }, async (args) => {
    const workspace = await workspaceFor(args);
    let files = await authoredFiles(workspace);
    if (args.path) {
      const prefix = normalizeRelativePath(args.path);
      if (!prefix) throw new Error(`${JSON.stringify(args.path)} is not a relative path inside the Design System`);
      files = files.filter((file) => file.path === prefix || file.path.startsWith(`${prefix}/`));
    }
    if (args.glob) {
      const matcher = globToRegExp(args.glob.trim().replace(/^\.\//, ""));
      files = files.filter((file) => matcher.test(file.path));
    }
    return {
      authoredSurface: authoredSurfaceRoot(workspace) === "." ? "**" : `${authoredSurfaceRoot(workspace)}/**`,
      total: files.length,
      truncated: files.length > MAX_LISTED_FILES,
      files: files.slice(0, MAX_LISTED_FILES),
    };
  });

  tool("read_file", {
    title: "Read an authored file",
    annotations: READ_ONLY,
    description: `Read one authored file as UTF-8 text. Small binary files (up to ${MAX_BINARY_READ_BYTES} bytes) come back base64-encoded; larger binaries and protected paths are refused.`,
    inputSchema: {
      path: z.string().min(1).max(1_000).describe("Repository-relative file path"),
    },
  }, async (args) => {
    const workspace = await workspaceFor(args);
    const { absolutePath, repoRelative } = await resolveAuthoredPath(workspace, args.path);
    let info;
    try {
      info = await fs.lstat(absolutePath);
    } catch (caught) {
      if (caught?.code === "ENOENT") throw new Error(`${repoRelative} does not exist`);
      throw caught;
    }
    if (!info.isFile()) throw new Error(`${repoRelative} is not a regular file`);
    if (info.size > MAX_TEXT_BYTES) throw new Error(`${repoRelative} is ${info.size} bytes; the limit is ${MAX_TEXT_BYTES}`);
    const buffer = await fs.readFile(absolutePath);
    const binary = isBinary(buffer);
    if (binary && buffer.length > MAX_BINARY_READ_BYTES) {
      throw new Error(`${repoRelative} is a ${buffer.length}-byte binary file; only binaries up to ${MAX_BINARY_READ_BYTES} bytes can be read`);
    }
    return {
      path: repoRelative,
      bytes: buffer.length,
      sha256: sha256(buffer),
      encoding: binary ? "base64" : "utf8",
      content: binary ? buffer.toString("base64") : buffer.toString("utf8"),
    };
  });

  tool("write_file", {
    title: "Write an authored file",
    annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false, readOnlyHint: false },
    description: "Create or replace one authored file atomically, creating parent directories. Protected paths, symbolic links, and paths outside the authored surface are refused. The note becomes the change description.",
    inputSchema: {
      path: z.string().min(1).max(1_000).describe("Repository-relative file path"),
      content: z.string().describe("Complete new file content"),
      encoding: z.enum(["utf8", "base64"]).optional().describe("Content encoding; base64 for a small binary asset. Defaults to utf8"),
      note: z.string().max(500).optional().describe("One-line description of the change"),
    },
  }, async (args) => {
    const workspace = await workspaceFor(args);
    const { absolutePath, repoRelative } = await resolveAuthoredPath(workspace, args.path);
    const buffer = Buffer.from(args.content, args.encoding === "base64" ? "base64" : "utf8");
    if (buffer.length > MAX_WRITE_BYTES) {
      throw new Error(`Content is ${buffer.length} bytes; the limit is ${MAX_WRITE_BYTES}. Large media belongs in the media catalog, not the repository`);
    }
    let created = true;
    try {
      const info = await fs.lstat(absolutePath);
      if (!info.isFile()) throw new Error(`${repoRelative} exists and is not a regular file`);
      created = false;
    } catch (caught) {
      if (caught?.code !== "ENOENT") throw caught;
    }
    await atomicWrite(absolutePath, buffer);
    const note = args.note?.trim() || undefined;
    const hook = await afterWrite(workspace, { paths: [repoRelative], note });
    return {
      path: repoRelative,
      created,
      bytes: buffer.length,
      sha256: sha256(buffer),
      ...(hook === undefined ? {} : { hook }),
    };
  });

  tool("delete_file", {
    title: "Delete an authored file",
    annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: false, readOnlyHint: false },
    description: "Remove one authored file. Protected paths, symbolic links, directories, and paths outside the authored surface are refused. The note becomes the change description.",
    inputSchema: {
      path: z.string().min(1).max(1_000).describe("Repository-relative file path"),
      note: z.string().max(500).optional().describe("One-line description of the change"),
    },
  }, async (args) => {
    const workspace = await workspaceFor(args);
    const { absolutePath, repoRelative } = await resolveAuthoredPath(workspace, args.path);
    let info;
    try {
      info = await fs.lstat(absolutePath);
    } catch (caught) {
      if (caught?.code === "ENOENT") throw new Error(`${repoRelative} does not exist`);
      throw caught;
    }
    if (!info.isFile()) throw new Error(`${repoRelative} is not a regular file`);
    await fs.unlink(absolutePath);
    const note = args.note?.trim() || undefined;
    const hook = await afterWrite(workspace, { paths: [repoRelative], note });
    return { path: repoRelative, deleted: true, ...(hook === undefined ? {} : { hook }) };
  });

  tool("run_check", {
    title: "Check the Design System",
    annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false, readOnlyHint: false },
    description: "Build, validate, and derive the Design System (timds check). Returns status passed, warnings, or failed with errors, warnings, artifact counts, brand kit gaps, and the tail of the build log. Regenerates dist/ and the derived layer.",
  }, async (args) => runStructuredCheck(await workspaceFor(args)));

  tool("read_derived", {
    title: "Read the derived layer",
    annotations: READ_ONLY,
    description: "Read what consumers of the system see, as written by the last run_check: brand (brand kit), tokens (resolved CSS custom properties and roles), or index (every page as structured blocks).",
    inputSchema: {
      name: z.enum(["brand", "tokens", "index"]).describe("Which derived document to read"),
    },
  }, async (args) => {
    const workspace = await workspaceFor(args);
    const derived = await readDerivedLayer(workspace.designSystemRoot, workspace.manifest);
    const content = derived[args.name];
    if (content === null || content === undefined) throw new Error(`${args.name} has not been derived yet; call run_check first`);
    return { name: args.name, system: derived.system, stale: derived.stale, content };
  });

  tool("list_media", {
    title: "List catalog media",
    annotations: READ_ONLY,
    description: "List the published media catalog (media.json): logical keys, titles, kinds, tags, stable public URLs, sizes, and measured dimensions or durations. Reference assets in source by key.",
    inputSchema: {
      tag: z.string().min(1).max(100).optional().describe("Only assets carrying this tag"),
    },
  }, async (args) => {
    const workspace = await workspaceFor(args);
    const { catalog } = await readMediaCatalog(workspace.designSystemRoot);
    const tag = args.tag?.trim().toLowerCase();
    const assets = tag ? catalog.assets.filter((asset) => asset.tags.some((entry) => entry.toLowerCase() === tag)) : catalog.assets;
    return { total: assets.length, tag: tag ?? null, assets };
  });

  server.registerResource("editing-guide", EDITING_GUIDE_URI, {
    title: "TimDS Design System editing guide",
    description: "Rules for editing a TimDS Design System through the timds-design-system tools.",
    mimeType: "text/markdown",
  }, async (uri) => ({
    contents: [{ uri: uri.href, mimeType: "text/markdown", text: editingGuideText() }],
  }));

  return server;
}

async function packageVersion() {
  try {
    const manifest = JSON.parse(await fs.readFile(new URL("../package.json", import.meta.url), "utf8"));
    return String(manifest.version || "0.0.0");
  } catch {
    return "0.0.0";
  }
}

/** An McpServer named `timds-design-system` serving the editing tools for one local checkout. */
export async function createDesignSystemMcpServer({ root = process.cwd(), hooks = {} } = {}) {
  const repoRoot = await findRepositoryRoot(root);
  // Fail fast on a directory that is not a Design System.
  await loadWorkspace(repoRoot);
  const server = new McpServer({ name: DESIGN_SYSTEM_MCP_SERVER_NAME, version: await packageVersion() });
  registerDesignSystemTools(server, {
    resolveWorkspace: () => loadWorkspace(repoRoot),
    hooks: { ...hooks, remote: false },
  });
  return server;
}

/** `timds mcp`: serve the editing tools over stdio. stdout carries only the protocol. */
export async function runDesignSystemMcp({ root = process.cwd(), hooks = {} } = {}) {
  setOutputStream(process.stderr);
  const server = await createDesignSystemMcpServer({ root, hooks });
  const transport = new StdioServerTransport();
  const closed = new Promise((resolve) => {
    transport.onclose = resolve;
  });
  await server.connect(transport);
  process.stderr.write(`TimDS MCP server ${DESIGN_SYSTEM_MCP_SERVER_NAME} ready on stdio for ${await findRepositoryRoot(root)}\n`);
  await closed;
}
