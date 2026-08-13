import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { promises as fs } from "node:fs";
import http from "node:http";
import { fileURLToPath } from "node:url";
import path from "node:path";
import process from "node:process";
import {
  addMediaFile,
  backfillMediaMetadata,
  publishStagedMedia,
  pullMediaAsset,
  readMediaCatalog,
} from "./media.mjs";
import {
  loginWithDevice,
  readCredentials,
  removeAccessToken,
  saveAccessToken,
} from "./auth.mjs";
import { publishExtractedIndex } from "./artifact.mjs";
import { extractArtifact, normalizeMachineConfig } from "./extract.mjs";

const MAX_ARTIFACT_FILE_BYTES = 12_000_000;
const MAX_ARTIFACT_FILES = 2_000;
const MAX_ARTIFACT_TOTAL_BYTES = 80_000_000;
const MAX_DIRECTORY_DEPTH = 20;
const MAX_SCANNED_ENTRIES = 5_000;
const supportedSchemaVersions = new Set([1, 2]);
const workspaceCommandNames = ["install", "dev", "build", "check"];
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const toolkitPackageName = "@dtconcepts/timds";

const contentTypes = {
  ".avif": "image/avif",
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".mp4": "video/mp4",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ttf": "font/ttf",
  ".webm": "video/webm",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function output(message = "") {
  process.stdout.write(`${message}\n`);
}

function commandError(command, code, stderr) {
  const detail = String(stderr || "").trim();
  return new Error(`${command.join(" ")} failed with exit code ${code}${detail ? `: ${detail}` : ""}`);
}

export function execute(command, options = {}) {
  if (!Array.isArray(command) || !command.length || command.some((part) => typeof part !== "string" || !part)) {
    throw new Error("Workspace commands must be non-empty string arrays");
  }
  return new Promise((resolve, reject) => {
    const child = spawn(command[0], command.slice(1), {
      cwd: options.cwd,
      env: options.env || process.env,
      shell: false,
      stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
    });
    let stdout = "";
    let stderr = "";
    if (options.capture) {
      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", (chunk) => { stdout += chunk; });
      child.stderr?.on("data", (chunk) => { stderr += chunk; });
    }
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0 && !options.allowFailure) {
        reject(commandError(command, code, stderr));
        return;
      }
      resolve({ code: Number(code || 0), stderr, stdout });
    });
  });
}

async function git(args, repoRoot, options = {}) {
  return execute(["git", ...args], { capture: true, cwd: repoRoot, ...options });
}

export async function findRepositoryRoot(start = process.cwd()) {
  const resolved = path.resolve(start);
  const result = await execute(["git", "rev-parse", "--show-toplevel"], {
    allowFailure: true,
    capture: true,
    cwd: resolved,
  });
  if (result.code === 0 && result.stdout.trim()) return path.resolve(result.stdout.trim());
  let current = resolved;
  while (true) {
    if (existsSync(path.join(current, "timds.json")) || existsSync(path.join(current, "design-system", "timds.json"))) return current;
    const parent = path.dirname(current);
    if (parent === current) return resolved;
    current = parent;
  }
}

function resolveDesignSystemRoot(repoRoot) {
  if (existsSync(path.join(repoRoot, "timds.json"))) {
    return { designSystemRoot: repoRoot, layout: "standalone", scopePath: "." };
  }
  return {
    designSystemRoot: path.join(repoRoot, "design-system"),
    layout: "embedded",
    scopePath: "design-system",
  };
}

function safeArtifactPath(value, label = "artifact path") {
  const normalized = String(value || "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/{2,}/g, "/");
  if (
    !normalized
    || normalized.length > 1_000
    || normalized.includes("\0")
    || normalized.split("/").some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new Error(`${label} must stay inside design-system/dist`);
  }
  return normalized;
}

function objectValue(value, label) {
  if (!value || Array.isArray(value) || typeof value !== "object") throw new Error(`${label} must be a JSON object`);
  return value;
}

function normalizeWorkspaceCommand(value, label) {
  if (value === undefined) return null;
  if (!Array.isArray(value) || !value.length || value.some((part) => typeof part !== "string" || !part.trim())) {
    throw new Error(`timds.json workspace.${label} must be a non-empty string array`);
  }
  return value.map((part) => part.trim());
}

function normalizeConsumer(value) {
  if (value === undefined || value === null) return null;
  const consumer = objectValue(value, "timds.json consumer");
  const repository = String(consumer.repository || "").trim();
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error("timds.json consumer.repository must be a GitHub OWNER/REPOSITORY name");
  }
  const branch = String(consumer.branch || "main").trim();
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(branch)
    || branch.includes("..")
    || branch.includes("//")
    || branch.endsWith("/")
  ) {
    throw new Error("timds.json consumer.branch must be a safe Git branch name");
  }
  const submodulePath = String(consumer.path || "design-system").trim().replace(/\\/g, "/");
  if (
    !submodulePath
    || submodulePath.startsWith("/")
    || submodulePath.endsWith("/")
    || submodulePath.split("/").some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new Error("timds.json consumer.path must be a relative repository path");
  }
  return { branch, path: submodulePath, repository };
}

export function validateManifest(input) {
  const manifest = objectValue(input, "timds.json");
  const schemaVersion = Number(manifest.schemaVersion ?? manifest.schema_version ?? 1);
  if (!Number.isInteger(schemaVersion) || !supportedSchemaVersions.has(schemaVersion)) {
    throw new Error(`timds.json schemaVersion ${String(manifest.schemaVersion ?? "")} is unsupported`);
  }
  const systemId = String(manifest.systemId || manifest.system_id || manifest.client || "").trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]{1,159}$/.test(systemId)) {
    throw new Error("timds.json systemId must use letters, numbers, dots, slashes, underscores, or hyphens");
  }
  const name = String(manifest.name || "").trim();
  if (!name) throw new Error("timds.json name is required");
  const version = String(manifest.version || "").trim();
  if (!version) throw new Error("timds.json version is required");
  const artifactEntry = safeArtifactPath(manifest.artifact?.entry || "index.html", "timds.json artifact.entry");
  const artifactPublishRef = String(manifest.artifact?.publishRef || "").trim();
  if (
    artifactPublishRef
    && (
      !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(artifactPublishRef)
      || artifactPublishRef.includes("..")
      || artifactPublishRef.includes("//")
      || artifactPublishRef.endsWith("/")
    )
  ) {
    throw new Error("timds.json artifact.publishRef must be a safe Git ref");
  }
  const workspace = objectValue(manifest.workspace || {}, "timds.json workspace");
  const media = objectValue(manifest.media || {}, "timds.json media");
  const mediaPortalUrl = String(media.portalUrl || "").trim();
  if (mediaPortalUrl) {
    let parsedPortalUrl;
    try {
      parsedPortalUrl = new URL(mediaPortalUrl);
    } catch {
      throw new Error("timds.json media.portalUrl must be an HTTP or HTTPS URL");
    }
    if (!["http:", "https:"].includes(parsedPortalUrl.protocol) || parsedPortalUrl.username || parsedPortalUrl.password) {
      throw new Error("timds.json media.portalUrl must be an HTTP or HTTPS URL without credentials");
    }
  }
  const commands = Object.fromEntries(
    workspaceCommandNames.map((commandName) => [commandName, normalizeWorkspaceCommand(workspace[commandName], commandName)]),
  );
  // Validated with the contract so an unusable selector fails `doctor`/`check`
  // immediately rather than part-way through a build.
  const machine = normalizeMachineConfig(manifest.machine);
  return {
    artifact: { entry: artifactEntry, publishRef: artifactPublishRef },
    consumer: normalizeConsumer(manifest.consumer),
    description: String(manifest.description || "").trim(),
    machine,
    name,
    media: { portalUrl: mediaPortalUrl },
    schemaVersion,
    systemId,
    version,
    workspace: commands,
  };
}

async function readJsonObject(filePath, label, { required = true } = {}) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return objectValue(JSON.parse(raw), label);
  } catch (caught) {
    if (!required && caught?.code === "ENOENT") return {};
    if (caught instanceof SyntaxError) throw new Error(`${label} is invalid JSON: ${caught.message}`);
    if (caught?.code === "ENOENT") throw new Error(`${label} is required`);
    throw caught;
  }
}

export async function loadWorkspace(repoRootInput = process.cwd()) {
  const repoRoot = await findRepositoryRoot(repoRootInput);
  const { designSystemRoot, layout, scopePath } = resolveDesignSystemRoot(repoRoot);
  const manifestPath = path.join(designSystemRoot, "timds.json");
  const manifest = validateManifest(await readJsonObject(manifestPath, "timds.json"));
  await readJsonObject(path.join(designSystemRoot, "tokens.json"), "tokens.json");
  const { catalog: mediaCatalog, catalogPath: mediaCatalogPath } = await readMediaCatalog(designSystemRoot);
  return { designSystemRoot, layout, manifest, manifestPath, mediaCatalog, mediaCatalogPath, repoRoot, scopePath };
}

async function collectArtifactFiles(root) {
  const files = [];
  let scannedEntries = 0;
  let totalBytes = 0;
  const walk = async (directory, depth) => {
    if (depth > MAX_DIRECTORY_DEPTH) throw new Error("design-system/dist exceeds the directory depth limit");
    const entries = (await fs.readdir(directory, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      scannedEntries += 1;
      if (scannedEntries > MAX_SCANNED_ENTRIES) throw new Error("design-system/dist contains too many entries");
      const absolutePath = path.join(directory, entry.name);
      const info = await fs.lstat(absolutePath);
      if (info.isSymbolicLink()) throw new Error("design-system/dist cannot contain symbolic links");
      if (info.isDirectory()) {
        await walk(absolutePath, depth + 1);
        continue;
      }
      if (!info.isFile()) continue;
      if (info.size > MAX_ARTIFACT_FILE_BYTES) {
        throw new Error(`${path.relative(root, absolutePath)} exceeds the ${MAX_ARTIFACT_FILE_BYTES}-byte artifact file limit`);
      }
      totalBytes += info.size;
      if (totalBytes > MAX_ARTIFACT_TOTAL_BYTES) {
        throw new Error(`design-system/dist exceeds the ${MAX_ARTIFACT_TOTAL_BYTES}-byte total limit`);
      }
      if (files.length >= MAX_ARTIFACT_FILES) {
        throw new Error(`design-system/dist contains more than ${MAX_ARTIFACT_FILES} files`);
      }
      const content = await fs.readFile(absolutePath);
      files.push({
        absolutePath,
        bytes: info.size,
        content,
        path: path.relative(root, absolutePath).split(path.sep).join("/"),
        sha256: createHash("sha256").update(content).digest("hex"),
      });
    }
  };
  await walk(root, 0);
  return { files, totalBytes };
}

function externalReference(value) {
  return /^(?:[a-z][a-z0-9+.-]*:|#|\/\/)/i.test(value);
}

function referenceCandidates(reference, sourcePath, entryPath) {
  const withoutQuery = reference.split(/[?#]/, 1)[0];
  if (!withoutQuery) return [];
  let decoded;
  try {
    decoded = decodeURIComponent(withoutQuery);
  } catch {
    return [];
  }
  const unresolvedBase = decoded.startsWith("/")
    ? decoded.replace(/^\/+/, "")
    : path.posix.normalize(path.posix.join(path.posix.dirname(sourcePath), decoded));
  const base = unresolvedBase.replace(/\/+$/, "");
  if (!base || base === ".") return [entryPath];
  if (base.startsWith("../") || base === "..") return [];
  const candidates = [base];
  if (!path.posix.extname(base)) candidates.push(`${base}.html`, `${base}/index.html`);
  return candidates;
}

function artifactReferences(file) {
  const extension = path.posix.extname(file.path).toLowerCase();
  if (![".css", ".html"].includes(extension)) return [];
  const content = file.content.toString("utf8");
  const references = [];
  const patterns = extension === ".html"
    ? [/(?:href|src|action|poster)\s*=\s*["']([^"']+)["']/gi, /url\(\s*["']?([^)'"\s]+)["']?\s*\)/gi]
    : [/url\(\s*["']?([^)'"\s]+)["']?\s*\)/gi, /@import\s+["']([^"']+)["']/gi];
  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern)) references.push(match[1]);
  }
  return references;
}

export async function validateArtifact(designSystemRoot, manifest) {
  const artifactRoot = path.join(designSystemRoot, "dist");
  let rootInfo;
  try {
    rootInfo = await fs.lstat(artifactRoot);
  } catch (caught) {
    if (caught?.code === "ENOENT") throw new Error("design-system/dist is required; run the design-system build first");
    throw caught;
  }
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw new Error("design-system/dist must be a real directory");
  const artifact = await collectArtifactFiles(artifactRoot);
  const paths = new Set(artifact.files.map((file) => file.path));
  if (!paths.has(manifest.artifact.entry)) {
    throw new Error(`design-system/dist is missing artifact entry ${manifest.artifact.entry}`);
  }
  const broken = [];
  for (const file of artifact.files) {
    for (const reference of artifactReferences(file)) {
      if (!reference || externalReference(reference)) continue;
      const candidates = referenceCandidates(reference, file.path, manifest.artifact.entry);
      if (candidates.length && !candidates.some((candidate) => paths.has(candidate))) {
        broken.push(`${file.path} -> ${reference}`);
      }
    }
  }
  if (broken.length) {
    throw new Error(`design-system/dist contains broken local references:\n${broken.slice(0, 20).map((entry) => `- ${entry}`).join("\n")}`);
  }
  return {
    entryPath: manifest.artifact.entry,
    fileCount: artifact.files.length,
    files: artifact.files,
    totalBytes: artifact.totalBytes,
  };
}

async function runWorkspaceCommand(workspace, commandName) {
  const command = workspace.manifest.workspace[commandName];
  if (!command) return false;
  output(`Running ${commandName}: ${command.join(" ")}`);
  await execute(command, { cwd: workspace.designSystemRoot });
  return true;
}

async function verifyCleanDist(workspace) {
  const distPath = workspace.layout === "standalone" ? "dist" : "design-system/dist";
  const tracked = await git(["diff", "--exit-code", "--", distPath], workspace.repoRoot, { allowFailure: true });
  const status = await git(["status", "--porcelain", "--untracked-files=all", "--", distPath], workspace.repoRoot);
  if (tracked.code !== 0 || status.stdout.trim()) {
    throw new Error(`${distPath} does not match the committed artifact; rebuild and commit it`);
  }
}

/** Harvest the built artifact into its machine-readable companions. */
export async function extractWorkspace(workspace, { write = true } = {}) {
  return extractArtifact({
    artifactRoot: path.join(workspace.designSystemRoot, "dist"),
    manifest: workspace.manifest,
    mediaCatalog: workspace.mediaCatalog,
    write,
  });
}

export async function checkWorkspace(repoRootInput, options = {}) {
  const workspace = await loadWorkspace(repoRootInput);
  if (!options.skipBuild) {
    await runWorkspaceCommand(workspace, "build");
    await runWorkspaceCommand(workspace, "check");
  }
  // Machine artifacts are part of the published artifact, so they are written
  // before validation counts and links the files.
  const machine = await extractWorkspace(workspace);
  const artifact = await validateArtifact(workspace.designSystemRoot, workspace.manifest);
  if (options.requireCleanDist) await verifyCleanDist(workspace);
  return { ...workspace, artifact, machine };
}

async function resolvePreviewFile(artifactRoot, entryPath, requestPath) {
  let pathname;
  try {
    pathname = decodeURIComponent(requestPath.split("?", 1)[0]);
  } catch {
    return null;
  }
  const normalized = pathname.replace(/^\/+/, "");
  const base = normalized || entryPath;
  if (base.split("/").some((segment) => segment === "..")) return null;
  const candidates = [base];
  if (!path.posix.extname(base)) candidates.push(`${base}.html`, `${base}/index.html`);
  for (const candidate of candidates) {
    const absolutePath = path.join(artifactRoot, candidate);
    try {
      const info = await fs.stat(absolutePath);
      if (info.isFile() && info.size <= MAX_ARTIFACT_FILE_BYTES) return { absolutePath, relativePath: candidate };
    } catch {
      // Try the next static-route candidate.
    }
  }
  return null;
}

export function createPreviewServer({ artifactRoot, entryPath }) {
  return http.createServer(async (request, response) => {
    const resolved = await resolvePreviewFile(artifactRoot, entryPath, request.url || "/");
    if (!resolved) {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Not found");
      return;
    }
    response.writeHead(200, {
      "Cache-Control": "no-store",
      "Content-Type": contentTypes[path.extname(resolved.relativePath).toLowerCase()] || "application/octet-stream",
      "X-Content-Type-Options": "nosniff",
    });
    createReadStream(resolved.absolutePath).pipe(response);
  });
}

function slug(value) {
  return String(value || "update")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "update";
}

async function writeIfMissing(filePath, content, created) {
  try {
    await fs.access(filePath);
  } catch {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content, "utf8");
    created.push(filePath);
  }
}

async function ensureGitignoreLine(filePath, line, created) {
  let existing = "";
  try {
    existing = await fs.readFile(filePath, "utf8");
  } catch (caught) {
    if (caught?.code !== "ENOENT") throw caught;
  }
  if (existing.split(/\r?\n/).some((entry) => entry.trim() === line)) return;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const prefix = existing && !existing.endsWith("\n") ? "\n" : "";
  await fs.writeFile(filePath, `${existing}${prefix}${line}\n`, "utf8");
  created.push(filePath);
}

async function copyDirectory(source, destination, { created = null, overwrite = false } = {}) {
  if (path.resolve(source) === path.resolve(destination)) return;
  await fs.mkdir(destination, { recursive: true });
  for (const entry of await fs.readdir(source, { withFileTypes: true })) {
    const sourcePath = path.join(source, entry.name);
    const destinationPath = path.join(destination, entry.name);
    if (entry.isDirectory()) {
      await copyDirectory(sourcePath, destinationPath, { created, overwrite });
      continue;
    }
    if (!entry.isFile()) continue;
    if (!overwrite && existsSync(destinationPath)) continue;
    await fs.mkdir(path.dirname(destinationPath), { recursive: true });
    await fs.copyFile(sourcePath, destinationPath);
    created?.push(destinationPath);
  }
}

async function template(name) {
  return fs.readFile(path.join(packageRoot, "templates", name), "utf8");
}

async function toolkitPackageIdentity(root = packageRoot) {
  const metadata = await readJsonObject(path.join(root, "package.json"), "TimDS package.json");
  const name = String(metadata.name || "").trim();
  const version = String(metadata.version || "").trim();
  if (name !== toolkitPackageName) throw new Error(`Unexpected TimDS package name ${name || "<missing>"}`);
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error("TimDS package version is invalid");
  return { name, version };
}

function toolkitReleaseRange(identity) {
  const [major, minor] = identity.version.split(".");
  return `${major}.${minor}.x`;
}

function acceptsToolkitReleaseRange(selectedVersion, identity) {
  const releaseRange = toolkitReleaseRange(identity);
  if (selectedVersion === releaseRange) return true;
  const [major, minor, patch] = identity.version.split(".").map(Number);
  if (major !== 0) return false;
  const npmCaret = String(selectedVersion || "").match(/^\^0\.(\d+)\.(\d+)$/);
  return Boolean(npmCaret && Number(npmCaret[1]) === minor && Number(npmCaret[2]) <= patch);
}

function managedToolkitPaths(repoRoot, designSystemRoot) {
  return {
    installationPath: path.join(designSystemRoot, ".timds", "installation.json"),
    legacyVendoredCliRoot: path.join(designSystemRoot, ".timds", "cli"),
    skillDestination: path.join(repoRoot, ".agents", "skills", "timds-edit-design-system"),
  };
}

async function readInstalledToolkitVersion(designSystemRoot) {
  for (const candidate of [
    path.join(designSystemRoot, ".timds", "installation.json"),
    path.join(designSystemRoot, ".timds", "cli", "package.json"),
  ]) {
    try {
      const metadata = JSON.parse(await fs.readFile(candidate, "utf8"));
      const version = String(metadata.version || "").trim();
      if (version) return version;
    } catch (caught) {
      if (caught?.code !== "ENOENT" && !(caught instanceof SyntaxError)) throw caught;
    }
  }
  return "unknown";
}

async function installManagedToolkit({ designSystemRoot, repoRoot, replace = false }) {
  const installedIdentity = await toolkitPackageIdentity();
  const paths = managedToolkitPaths(repoRoot, designSystemRoot);
  if (replace) await fs.rm(paths.legacyVendoredCliRoot, { force: true, recursive: true });
  if (replace) await fs.rm(paths.skillDestination, { force: true, recursive: true });
  await copyDirectory(
    path.join(packageRoot, "skills", "timds-edit-design-system"),
    paths.skillDestination,
    { overwrite: replace },
  );
  await fs.mkdir(path.dirname(paths.installationPath), { recursive: true });
  await fs.writeFile(
    paths.installationPath,
    `${JSON.stringify({ name: installedIdentity.name, schemaVersion: 1, version: installedIdentity.version }, null, 2)}\n`,
    "utf8",
  );
  return { ...paths, package: installedIdentity };
}

async function configurePackageManifest(repoRoot, identity, { force = false, initializeRelease = false } = {}) {
  const packagePath = path.join(repoRoot, "package.json");
  const packageJson = await readJsonObject(packagePath, "repository package.json", { required: false });
  if (!Object.keys(packageJson).length) {
    packageJson.name = slug(path.basename(repoRoot));
    packageJson.version = initializeRelease ? "0.1.0" : "0.0.0";
    packageJson.private = true;
  }
  if (initializeRelease) packageJson.version = "0.1.0";
  const releaseRange = toolkitReleaseRange(identity);
  const currentDependency = packageJson.devDependencies?.[identity.name] ?? packageJson.dependencies?.[identity.name];
  const currentScript = packageJson.scripts?.timds;
  if (!force && currentDependency && currentDependency !== releaseRange) {
    throw new Error(`${identity.name} is already declared as ${currentDependency}; rerun init with --force to select ${releaseRange}`);
  }
  if (!force && currentScript && currentScript !== "timds") {
    throw new Error(`package.json scripts.timds is already ${JSON.stringify(currentScript)}; rerun init with --force to replace it`);
  }
  if (packageJson.dependencies?.[identity.name]) {
    delete packageJson.dependencies[identity.name];
    if (!Object.keys(packageJson.dependencies).length) delete packageJson.dependencies;
  }
  packageJson.scripts = { ...(packageJson.scripts || {}), timds: "timds" };
  if (initializeRelease) {
    packageJson.scripts["check:versions"] = "node scripts/check-versions.mjs";
    packageJson.scripts.release = "node scripts/release.mjs";
  }
  packageJson.devDependencies = { ...(packageJson.devDependencies || {}), [identity.name]: releaseRange };
  await fs.writeFile(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`, "utf8");
  return packagePath;
}

async function requirePinnedToolkitDependency(repoRoot, identity) {
  const packageJson = await readJsonObject(path.join(repoRoot, "package.json"), "repository package.json");
  const selectedVersion = packageJson.devDependencies?.[identity.name] ?? packageJson.dependencies?.[identity.name];
  const releaseRange = toolkitReleaseRange(identity);
  if (!acceptsToolkitReleaseRange(selectedVersion, identity)) {
    throw new Error(`package.json must select the ${releaseRange} ${identity.name} release line; keep devDependencies[${JSON.stringify(identity.name)}] at ${JSON.stringify(releaseRange)} and run npm update ${identity.name}`);
  }
  if (packageJson.scripts?.timds !== "timds") {
    throw new Error('package.json scripts.timds must be exactly "timds"');
  }
}

export async function initializeRepository(repoRootInput, {
  consumerBranch = "main",
  consumerPath = "design-system",
  consumerRepository = "",
  force = false,
  standalone = false,
} = {}) {
  const repoRoot = await findRepositoryRoot(repoRootInput);
  const designSystemRoot = standalone ? repoRoot : path.join(repoRoot, "design-system");
  const manifestPath = path.join(designSystemRoot, "timds.json");
  const createsContract = !existsSync(manifestPath);
  const created = [];
  const identity = await toolkitPackageIdentity();
  if (consumerRepository && !standalone) {
    throw new Error("--consumer-repository is only supported with --standalone");
  }
  if (!consumerRepository && (consumerBranch !== "main" || consumerPath !== "design-system")) {
    throw new Error("--consumer-branch and --consumer-path require --consumer-repository");
  }
  const packagePath = await configurePackageManifest(repoRoot, identity, {
    force,
    initializeRelease: standalone && createsContract,
  });
  created.push(packagePath);
  await fs.mkdir(designSystemRoot, { recursive: true });
  const repoSlug = slug(path.basename(repoRoot));
  const consumer = consumerRepository
    ? normalizeConsumer({
      branch: consumerBranch,
      path: consumerPath,
      repository: consumerRepository,
    })
    : null;
  const consumerConfig = consumer
    ? `,\n  "consumer": ${JSON.stringify(consumer, null, 2).replaceAll("\n", "\n  ")}`
    : "";
  await writeIfMissing(
    manifestPath,
    (await template("timds.json"))
      .replaceAll("__SYSTEM_ID__", `${repoSlug}/core`)
      .replaceAll("__NAME__", path.basename(repoRoot))
      .replaceAll("__PUBLISH_REF__", standalone ? ',\n    "publishRef": "timds-published"' : "")
      .replaceAll("__CONSUMER__", consumerConfig),
    created,
  );
  await writeIfMissing(path.join(designSystemRoot, "tokens.json"), await template("tokens.json"), created);
  await writeIfMissing(path.join(designSystemRoot, "media.json"), await template("media.json"), created);
  await writeIfMissing(path.join(designSystemRoot, "media-local", "README.md"), await template("media-local-README.md"), created);
  for (const line of (await template("design-system-gitignore")).split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean)) {
    await ensureGitignoreLine(path.join(designSystemRoot, ".gitignore"), line, created);
  }
  await ensureGitignoreLine(path.join(repoRoot, ".gitignore"), "node_modules/", created);
  if (standalone) await ensureGitignoreLine(path.join(designSystemRoot, ".gitignore"), "dist/", created);
  const cliCommand = "npm run timds --";
  const contractDescription = standalone
    ? "This repository is the editable source and static publication contract for TimDS."
    : "This root `design-system/` directory is the editable source and static publication contract for TimDS.";
  const renderTemplate = (content) => content
    .replaceAll("__TIMDS_CLI__", cliCommand)
    .replaceAll("__CONTRACT_DESCRIPTION__", contractDescription)
    .replaceAll("__DIST_PATH__", standalone ? "dist/" : "design-system/dist/");
  await writeIfMissing(path.join(designSystemRoot, "AGENTS.md"), renderTemplate(await template("design-system-AGENTS.md")), created);
  await writeIfMissing(path.join(designSystemRoot, "README.md"), renderTemplate(await template("design-system-README.md")), created);
  await writeIfMissing(path.join(designSystemRoot, "CHANGELOG.md"), await template("CHANGELOG.md"), created);
  if (createsContract) {
    await copyDirectory(path.join(packageRoot, "templates", "starter"), designSystemRoot, { created });
  }
  await writeIfMissing(
    path.join(repoRoot, ".github", "workflows", "timds-design-system.yml"),
    await template(standalone ? "timds-standalone.yml" : "timds-design-system.yml"),
    created,
  );
  if (standalone) {
    await writeIfMissing(
      path.join(repoRoot, ".github", "workflows", "update-consumer-submodule.yml"),
      await template("update-consumer-submodule.yml"),
      created,
    );
  }

  const installed = await installManagedToolkit({ designSystemRoot, repoRoot, replace: force });
  const initializedArtifact = createsContract ? (await checkWorkspace(repoRoot)).artifact : null;
  return { consumer, created, designSystemRoot, initializedArtifact, repoRoot, ...installed };
}

export async function upgradeRepository(repoRootInput, { force = false } = {}) {
  const workspace = await loadWorkspace(repoRootInput);
  const identity = await toolkitPackageIdentity();
  await requirePinnedToolkitDependency(workspace.repoRoot, identity);
  const paths = managedToolkitPaths(workspace.repoRoot, workspace.designSystemRoot);
  if (!force) {
    const pathspecs = [paths.legacyVendoredCliRoot, paths.installationPath, paths.skillDestination]
      .map((filePath) => path.relative(workspace.repoRoot, filePath).split(path.sep).join("/"));
    const status = await git(["status", "--porcelain", "--untracked-files=all", "--", ...pathspecs], workspace.repoRoot);
    if (status.stdout.trim()) {
      throw new Error(`Refusing to replace locally modified TimDS tooling:\n${status.stdout.trim()}\nCommit or restore it, or rerun with --force`);
    }
  }
  const previousVersion = await readInstalledToolkitVersion(workspace.designSystemRoot);
  const installed = await installManagedToolkit({
    designSystemRoot: workspace.designSystemRoot,
    repoRoot: workspace.repoRoot,
    replace: true,
  });
  return { ...workspace, ...installed, previousVersion };
}

function parseArguments(argv) {
  const options = {};
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith("-")) {
      positional.push(value);
      continue;
    }
    const [rawName, inlineValue] = value.replace(/^--?/, "").split("=", 2);
    const name = ({ m: "message", p: "port" })[rawName] || rawName.replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
    if (["dryRun", "force", "help", "noBuild", "noOpen", "noPr", "noPush", "publish", "requireCleanDist", "skipBuild", "standalone"].includes(name)) {
      options[name] = true;
      continue;
    }
    const next = inlineValue ?? argv[index + 1];
    if (next === undefined || String(next).startsWith("-")) throw new Error(`--${rawName} requires a value`);
    options[name] = next;
    if (inlineValue === undefined) index += 1;
  }
  return { options, positional };
}

async function currentBranch(repoRoot) {
  const result = await git(["branch", "--show-current"], repoRoot);
  return result.stdout.trim();
}

async function defaultBranch(repoRoot) {
  const symbolic = await git(["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], repoRoot, { allowFailure: true });
  if (symbolic.code === 0 && symbolic.stdout.trim()) return symbolic.stdout.trim().replace(/^origin\//, "");
  for (const candidate of ["main", "master"]) {
    const result = await git(["show-ref", "--verify", `refs/heads/${candidate}`], repoRoot, { allowFailure: true });
    if (result.code === 0) return candidate;
  }
  return "main";
}

function statusPath(line) {
  const value = line.slice(3).trim();
  return value.includes(" -> ") ? value.split(" -> ").at(-1) : value;
}

function allowedSubmitPath(filePath, layout) {
  if (layout === "standalone") return filePath !== ".git" && !filePath.startsWith(".git/");
  return filePath === "design-system"
    || filePath.startsWith("design-system/")
    || filePath.startsWith(".agents/skills/timds-edit-design-system/")
    || filePath === ".github/workflows/timds-design-system.yml";
}

export async function submitWorkspace(repoRootInput, message, options = {}) {
  const workspace = await loadWorkspace(repoRootInput);
  const preflightStatus = await git(["status", "--porcelain", "--untracked-files=all"], workspace.repoRoot);
  const preflightChangedPaths = preflightStatus.stdout.split("\n").filter(Boolean).map(statusPath);
  const preflightOutside = preflightChangedPaths.filter((filePath) => !allowedSubmitPath(filePath, workspace.layout));
  if (preflightOutside.length) {
    throw new Error(`Refusing to submit with changes outside the TimDS scope:\n${preflightOutside.map((filePath) => `- ${filePath}`).join("\n")}`);
  }
  const preflightBaseBranch = await defaultBranch(workspace.repoRoot);
  const preflightBranch = await currentBranch(workspace.repoRoot);
  if (preflightBranch && preflightBranch !== preflightBaseBranch) {
    const remoteBase = await git(["show-ref", "--verify", `refs/remotes/origin/${preflightBaseBranch}`], workspace.repoRoot, { allowFailure: true });
    const baseRef = remoteBase.code === 0 ? `origin/${preflightBaseBranch}` : preflightBaseBranch;
    const committed = await git(["diff", "--name-only", `${baseRef}...HEAD`], workspace.repoRoot);
    const outsideCommittedScope = committed.stdout
      .split("\n")
      .filter(Boolean)
      .filter((filePath) => !allowedSubmitPath(filePath, workspace.layout));
    if (outsideCommittedScope.length) {
      throw new Error(`Refusing to submit a branch containing committed changes outside the TimDS scope:\n${outsideCommittedScope.map((filePath) => `- ${filePath}`).join("\n")}`);
    }
  }
  const media = options.dryRun
    ? { published: [], staged: 0, unchanged: [] }
    : await publishStagedMedia(workspace, options);
  const checked = await checkWorkspace(repoRootInput, { skipBuild: options.noBuild });
  const status = await git(["status", "--porcelain", "--untracked-files=all"], checked.repoRoot);
  const changedPaths = status.stdout.split("\n").filter(Boolean).map(statusPath);
  const outside = changedPaths.filter((filePath) => !allowedSubmitPath(filePath, checked.layout));
  if (outside.length) {
    throw new Error(`Refusing to submit with changes outside the TimDS scope:\n${outside.map((filePath) => `- ${filePath}`).join("\n")}`);
  }
  if (!changedPaths.length) throw new Error("There are no TimDS changes to submit");

  const baseBranch = await defaultBranch(checked.repoRoot);
  let branch = await currentBranch(checked.repoRoot);
  if (branch && branch !== baseBranch) {
    const remoteBase = await git(["show-ref", "--verify", `refs/remotes/origin/${baseBranch}`], checked.repoRoot, { allowFailure: true });
    const baseRef = remoteBase.code === 0 ? `origin/${baseBranch}` : baseBranch;
    const committed = await git(["diff", "--name-only", `${baseRef}...HEAD`], checked.repoRoot);
    const outsideCommittedScope = committed.stdout
      .split("\n")
      .filter(Boolean)
      .filter((filePath) => !allowedSubmitPath(filePath, checked.layout));
    if (outsideCommittedScope.length) {
      throw new Error(`Refusing to submit a branch containing committed changes outside the TimDS scope:\n${outsideCommittedScope.map((filePath) => `- ${filePath}`).join("\n")}`);
    }
  }
  const plannedBranch = branch && branch !== baseBranch ? branch : `design-system/${slug(message)}`;
  const commands = [];
  if (!branch || branch === baseBranch) commands.push(["git", "switch", "-c", plannedBranch]);
  commands.push(checked.layout === "standalone"
    ? ["git", "add", "--all"]
    : ["git", "add", "--", "design-system", ".agents/skills/timds-edit-design-system", ".github/workflows/timds-design-system.yml"]);
  commands.push(["git", "commit", "-m", message]);
  if (!options.noPush) commands.push(["git", "push", "--set-upstream", "origin", plannedBranch]);
  if (!options.noPr && !options.noPush) {
    commands.push([
      "gh", "pr", "create", "--draft", "--base", baseBranch, "--head", plannedBranch,
      "--title", message,
      "--body", `## TimDS design-system change\n\n${message}\n\n- Version: ${checked.manifest.version}\n- Artifact files: ${checked.artifact.fileCount}\n- Artifact bytes: ${checked.artifact.totalBytes}\n- Local TimDS validation: passed`,
    ]);
  }
  if (options.dryRun) return { baseBranch, branch: plannedBranch, commands, dryRun: true, media };
  for (const command of commands) await execute(command, { cwd: checked.repoRoot });
  branch = plannedBranch;
  return { baseBranch, branch, commands, dryRun: false, media };
}

function machineSummary({ counts }) {
  const parts = [
    `${counts.blocks} blocks`,
    `${counts.rules} rules`,
    `${counts.notes} notes`,
    `${counts.assets} assets (${counts.linkedAssets} joined to media)`,
  ];
  const untyped = counts.untyped ? ` · ${counts.untyped} untyped prose records` : "";
  return `Machine artifacts: ${parts.join(", ")}${untyped}`;
}

function helpText() {
  return `TimDS local design-system workflow\n\nUsage:\n  timds init [--root PATH] [--standalone] [--consumer-repository OWNER/REPO] [--consumer-branch BRANCH] [--consumer-path PATH] [--force]\n  timds upgrade [--root PATH] [--force]\n  timds auth login [--token TOKEN] [--portal-url URL]\n  timds auth status [--portal-url URL]\n  timds auth logout [--portal-url URL]\n  timds doctor [--root PATH]\n  timds dev [--root PATH]\n  timds check [--root PATH] [--skip-build] [--require-clean-dist]\n  timds extract [--root PATH] [--skip-build] [--publish]\n  timds preview [--root PATH] [--port 4400] [--no-build]\n  timds diff [--root PATH] [--base origin/main]\n  timds assets list [--root PATH]\n  timds assets add FILE [--key LOGICAL_KEY] [--title TEXT] [--tags a,b]\n  timds assets backfill-metadata [--root PATH] [--force]\n  timds assets publish [--root PATH]\n  timds assets pull KEY [--output PATH] [--force]\n  timds submit --message "Change summary" [--dry-run] [--no-push] [--no-pr]\n\nCheck and extract derive index.json, llms.txt, and per-page Markdown from the built artifact so agents and pipelines can read the system without scraping HTML. Extract --publish uploads the index, llms.txt, the per-page Markdown mirrors, a .timds-artifact.json provenance stamp, and the artifact files the index references to the system's stable CDN prefix through the portal, so pipelines and agents consume the system from one stable URL. Large public media is copied into ignored media-local/ for authoring. assets add measures timed-media duration and dimensions before upload; backfill-metadata repairs older catalogs from their stable public URLs. assets publish and submit upload changed media and commit only stable CDN records. Submit creates a review branch and draft pull request.`;
}

export async function runCli(argv) {
  const [command = "help", ...rest] = argv;
  const { options, positional } = parseArguments(rest);
  if (options.help || ["help", "--help", "-h"].includes(command)) {
    output(helpText());
    return;
  }
  const root = options.root || process.cwd();
  if (command === "auth") {
    const [authCommand = "status"] = positional;
    const portalUrl = options.portalUrl || process.env.TIMDS_PORTAL_URL || "https://timds.com";
    if (authCommand === "login") {
      if (options.token) {
        const result = await saveAccessToken(portalUrl, options.token, options);
        output(`TimDS access token saved for ${result.portal}.`);
        return result;
      }
      const result = await loginWithDevice(portalUrl, {
        ...options,
        onAuthorization(authorization) {
          output(`Open ${authorization.verificationUrl}`);
          output(`Enter code: ${authorization.userCode}`);
          output("Waiting for operator approval...");
        },
      });
      output(`TimDS authorization saved for ${result.portal}.`);
      return result;
    }
    if (authCommand === "status") {
      const credentials = await readCredentials(options);
      const portal = new URL(portalUrl).origin;
      const signedIn = Boolean(credentials.portals[portal]?.accessToken);
      output(`${portal}: ${signedIn ? "signed in" : "not signed in"}`);
      return { portal, signedIn };
    }
    if (authCommand === "logout") {
      const result = await removeAccessToken(portalUrl, options);
      output(`${result.portal}: ${result.removed ? "signed out" : "no saved authorization"}`);
      return result;
    }
    throw new Error(`Unknown auth command ${authCommand}`);
  }
  if (command === "init") {
    const result = await initializeRepository(root, {
      consumerBranch: options.consumerBranch,
      consumerPath: options.consumerPath,
      consumerRepository: options.consumerRepository,
      force: options.force,
      standalone: options.standalone,
    });
    output(`TimDS tooling installed for ${result.repoRoot}`);
    output(`Design system: ${result.designSystemRoot}`);
    output(`Agent skill: ${result.skillDestination}`);
    output(`Toolkit: ${result.package.name}@${result.package.version}`);
    if (result.consumer) {
      output(`Consumer: ${result.consumer.repository}@${result.consumer.branch}:${result.consumer.path}`);
      output("Configure TIMDS_CONSUMER_TOKEN in the Design System repository before releasing.");
    }
    if (result.created.length) output(`Created ${result.created.length} contract files.`);
    if (result.initializedArtifact) {
      output(`Starter artifact: ${result.initializedArtifact.fileCount} files, ${result.initializedArtifact.totalBytes} bytes.`);
    }
    output("Run npm install to create the lockfile, then git add --all and commit the validated contract.");
    return result;
  }
  if (command === "upgrade") {
    const result = await upgradeRepository(root, { force: options.force });
    output(`TimDS tooling upgraded for ${result.repoRoot}`);
    output(`Toolkit: ${result.previousVersion} -> ${result.package.version}`);
    output(`Agent skill: ${result.skillDestination}`);
    return result;
  }
  if (command === "doctor") {
    const workspace = await loadWorkspace(root);
    const branch = await currentBranch(workspace.repoRoot);
    output(`Repository: ${workspace.repoRoot}`);
    output(`Design system: ${workspace.designSystemRoot}`);
    output(`System: ${workspace.manifest.name} (${workspace.manifest.systemId})`);
    output(`Version: ${workspace.manifest.version}`);
    output(`Toolkit: ${await readInstalledToolkitVersion(workspace.designSystemRoot)}`);
    output(`Media assets: ${workspace.mediaCatalog.assets.length}`);
    if (workspace.manifest.consumer) {
      output(`Consumer: ${workspace.manifest.consumer.repository}@${workspace.manifest.consumer.branch}:${workspace.manifest.consumer.path}`);
    }
    output(`Branch: ${branch || "detached"}`);
    output("Contract: valid");
    return workspace;
  }
  if (command === "check") {
    const result = await checkWorkspace(root, {
      requireCleanDist: options.requireCleanDist,
      skipBuild: options.skipBuild,
    });
    output(`TimDS check passed: ${result.artifact.fileCount} files, ${result.artifact.totalBytes} bytes, entry ${result.artifact.entryPath}`);
    if (result.machine?.enabled) output(machineSummary(result.machine));
    return result;
  }
  if (command === "extract") {
    const workspace = await loadWorkspace(root);
    if (!options.skipBuild) await runWorkspaceCommand(workspace, "build");
    const result = await extractWorkspace(workspace);
    if (!result.enabled) {
      if (options.publish) throw new Error("Cannot publish the machine index: extraction is disabled by timds.json machine.enabled");
      output("Machine extraction is disabled by timds.json machine.enabled.");
      return result;
    }
    output(machineSummary(result));
    output(`Wrote ${result.written.length} machine-readable files into the artifact.`);
    if (options.publish) {
      const published = await publishExtractedIndex(workspace, {
        portalUrl: options.portalUrl,
        sourceCommit: options.sourceCommit,
        token: options.token,
      });
      output(`Published machine index: ${published.indexUrl} (${published.uploaded} uploaded, ${published.skipped} unchanged)`);
      if (published.llmsUrl) output(`Published agent docs: ${published.llmsUrl} (+${published.docCount} page mirrors)`);
      return { ...result, published };
    }
    return result;
  }
  if (command === "preview") {
    const checked = await checkWorkspace(root, { skipBuild: options.noBuild });
    const port = Number(options.port || 4400);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("Preview port must be between 1 and 65535");
    const server = createPreviewServer({
      artifactRoot: path.join(checked.designSystemRoot, "dist"),
      entryPath: checked.manifest.artifact.entry,
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", resolve);
    });
    output(`TimDS preview: http://127.0.0.1:${port}/`);
    return new Promise((resolve) => {
      const close = () => server.close(resolve);
      process.once("SIGINT", close);
      process.once("SIGTERM", close);
    });
  }
  if (command === "dev") {
    const workspace = await loadWorkspace(root);
    if (workspace.manifest.workspace.dev) {
      await runWorkspaceCommand(workspace, "dev");
      return;
    }
    return runCli(["preview", "--root", workspace.repoRoot, "--no-build", ...(options.port ? ["--port", String(options.port)] : [])]);
  }
  if (command === "diff") {
    const workspace = await loadWorkspace(root);
    const base = options.base || `origin/${await defaultBranch(workspace.repoRoot)}`;
    const pathspec = workspace.layout === "standalone" ? "." : "design-system";
    const result = await git(["diff", "--stat", base, "--", pathspec], workspace.repoRoot, { allowFailure: true });
    const status = await git(["status", "--short", "--", pathspec], workspace.repoRoot);
    output(`TimDS diff against ${base}:`);
    output(result.stdout.trim() || "No committed design-system differences.");
    if (status.stdout.trim()) {
      output("\nWorking tree:");
      output(status.stdout.trim());
    }
    return { base, diff: result.stdout, status: status.stdout };
  }
  if (["assets", "media"].includes(command)) {
    const [mediaCommand = "list", mediaArgument = ""] = positional;
    const workspace = await loadWorkspace(root);
    if (mediaCommand === "list") {
      if (!workspace.mediaCatalog.assets.length) {
        output("No TimDS media assets are registered.");
      } else {
        for (const asset of workspace.mediaCatalog.assets) {
          output(`${asset.key}\t${asset.kind}\t${asset.bytes}\t${asset.publicUrl}\t${asset.title}`);
        }
      }
      return workspace.mediaCatalog;
    }
    if (["add", "stage"].includes(mediaCommand)) {
      if (!mediaArgument) throw new Error("assets add requires a file path");
      const result = await addMediaFile(workspace, mediaArgument, options);
      output(`Staged public media ${result.asset.key}: ${result.asset.title}`);
      output(`Local source: ${result.asset.path}`);
      return result;
    }
    if (mediaCommand === "publish") {
      const result = await publishStagedMedia(workspace, options);
      for (const published of result.published) {
        output(`${published.reused ? "Reused" : "Uploaded"} ${published.asset.key}: ${published.asset.publicUrl}`);
      }
      output(`Media publication complete: ${result.published.length} changed, ${result.unchanged.length} unchanged.`);
      return result;
    }
    if (mediaCommand === "backfill-metadata") {
      const result = await backfillMediaMetadata(workspace, options);
      for (const asset of result.updated) {
        output(`Measured ${asset.key}: ${asset.durationSeconds}s${asset.width && asset.height ? ` · ${asset.width}x${asset.height}` : ""}`);
      }
      output(`Media metadata backfill complete: ${result.updated.length} updated, ${result.unchanged.length} unchanged.`);
      return result;
    }
    if (mediaCommand === "pull") {
      if (!mediaArgument) throw new Error("assets pull requires an asset id");
      const result = await pullMediaAsset(workspace, mediaArgument, options);
      output(`Downloaded ${result.asset.id} to ${result.destination}`);
      return result;
    }
    throw new Error(`Unknown assets command ${mediaCommand}`);
  }
  if (command === "submit") {
    const message = String(options.message || positional.join(" ")).trim();
    if (!message) throw new Error("submit requires --message \"Change summary\"");
    const result = await submitWorkspace(root, message, options);
    if (result.dryRun) {
      output(`Dry run: would submit branch ${result.branch}`);
      for (const planned of result.commands) output(`  ${planned.join(" ")}`);
    } else {
      output(`Submitted ${result.branch} for review.`);
    }
    return result;
  }
  throw new Error(`Unknown command ${command}\n\n${helpText()}`);
}
