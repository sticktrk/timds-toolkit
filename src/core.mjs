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
  pullMediaAsset,
  readMediaCatalog,
} from "./media.mjs";

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
  return {
    artifact: { entry: artifactEntry, publishRef: artifactPublishRef },
    description: String(manifest.description || "").trim(),
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

export async function checkWorkspace(repoRootInput, options = {}) {
  const workspace = await loadWorkspace(repoRootInput);
  if (!options.skipBuild) {
    await runWorkspaceCommand(workspace, "check");
    await runWorkspaceCommand(workspace, "build");
  }
  const artifact = await validateArtifact(workspace.designSystemRoot, workspace.manifest);
  if (options.requireCleanDist) await verifyCleanDist(workspace);
  return { ...workspace, artifact };
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

async function copyDirectory(source, destination, { overwrite = false } = {}) {
  if (path.resolve(source) === path.resolve(destination)) return;
  await fs.mkdir(destination, { recursive: true });
  for (const entry of await fs.readdir(source, { withFileTypes: true })) {
    const sourcePath = path.join(source, entry.name);
    const destinationPath = path.join(destination, entry.name);
    if (entry.isDirectory()) {
      await copyDirectory(sourcePath, destinationPath, { overwrite });
      continue;
    }
    if (!entry.isFile()) continue;
    if (!overwrite && existsSync(destinationPath)) continue;
    await fs.mkdir(path.dirname(destinationPath), { recursive: true });
    await fs.copyFile(sourcePath, destinationPath);
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

async function configurePackageManifest(repoRoot, identity, { force = false } = {}) {
  const packagePath = path.join(repoRoot, "package.json");
  const packageJson = await readJsonObject(packagePath, "repository package.json", { required: false });
  if (!Object.keys(packageJson).length) {
    packageJson.name = slug(path.basename(repoRoot));
    packageJson.version = "0.0.0";
    packageJson.private = true;
  }
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
  packageJson.devDependencies = { ...(packageJson.devDependencies || {}), [identity.name]: releaseRange };
  await fs.writeFile(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`, "utf8");
  return packagePath;
}

async function requirePinnedToolkitDependency(repoRoot, identity) {
  const packageJson = await readJsonObject(path.join(repoRoot, "package.json"), "repository package.json");
  const selectedVersion = packageJson.devDependencies?.[identity.name] ?? packageJson.dependencies?.[identity.name];
  const releaseRange = toolkitReleaseRange(identity);
  if (selectedVersion !== releaseRange) {
    throw new Error(`package.json must select the ${releaseRange} ${identity.name} release line; run npm install --save-dev ${identity.name}@${releaseRange}`);
  }
  if (packageJson.scripts?.timds !== "timds") {
    throw new Error('package.json scripts.timds must be exactly "timds"');
  }
}

export async function initializeRepository(repoRootInput, { force = false, standalone = false } = {}) {
  const repoRoot = await findRepositoryRoot(repoRootInput);
  const designSystemRoot = standalone ? repoRoot : path.join(repoRoot, "design-system");
  const created = [];
  const identity = await toolkitPackageIdentity();
  const packagePath = await configurePackageManifest(repoRoot, identity, { force });
  created.push(packagePath);
  await fs.mkdir(designSystemRoot, { recursive: true });
  const repoSlug = slug(path.basename(repoRoot));
  await writeIfMissing(
    path.join(designSystemRoot, "timds.json"),
    (await template("timds.json"))
      .replaceAll("__SYSTEM_ID__", `${repoSlug}/core`)
      .replaceAll("__NAME__", path.basename(repoRoot))
      .replaceAll("__PUBLISH_REF__", standalone ? ',\n    "publishRef": "timds-published"' : ""),
    created,
  );
  await writeIfMissing(path.join(designSystemRoot, "tokens.json"), await template("tokens.json"), created);
  await writeIfMissing(path.join(designSystemRoot, "media.json"), await template("media.json"), created);
  await ensureGitignoreLine(
    path.join(designSystemRoot, ".gitignore"),
    (await template("design-system-gitignore")).trim(),
    created,
  );
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
  await writeIfMissing(
    path.join(repoRoot, ".github", "workflows", "timds-design-system.yml"),
    await template(standalone ? "timds-standalone.yml" : "timds-design-system.yml"),
    created,
  );

  const installed = await installManagedToolkit({ designSystemRoot, repoRoot, replace: force });
  return { created, designSystemRoot, repoRoot, ...installed };
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
    if (["dryRun", "force", "help", "noBuild", "noOpen", "noPr", "noPush", "requireCleanDist", "skipBuild", "standalone"].includes(name)) {
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
  if (options.dryRun) return { baseBranch, branch: plannedBranch, commands, dryRun: true };
  for (const command of commands) await execute(command, { cwd: checked.repoRoot });
  branch = plannedBranch;
  return { baseBranch, branch, commands, dryRun: false };
}

function helpText() {
  return `TimDS local design-system workflow\n\nUsage:\n  timds init [--root PATH] [--standalone] [--force]\n  timds upgrade [--root PATH] [--force]\n  timds doctor [--root PATH]\n  timds dev [--root PATH]\n  timds check [--root PATH] [--skip-build] [--require-clean-dist]\n  timds preview [--root PATH] [--port 4400] [--no-build]\n  timds diff [--root PATH] [--base origin/main]\n  timds assets list [--root PATH]\n  timds assets add FILE --rights STATUS [--visibility private|public] [--title TEXT] [--tags a,b]\n  timds assets pull ASSET_ID [--output PATH]\n  timds submit --message "Change summary" [--dry-run] [--no-push] [--no-pr]\n\nInstall or upgrade with an explicitly selected @dtconcepts/timds package version. Large media is stored outside Git. The live TimDS version is never changed by this CLI. Submit creates a review branch and draft pull request.`;
}

export async function runCli(argv) {
  const [command = "help", ...rest] = argv;
  const { options, positional } = parseArguments(rest);
  if (options.help || ["help", "--help", "-h"].includes(command)) {
    output(helpText());
    return;
  }
  const root = options.root || process.cwd();
  if (command === "init") {
    const result = await initializeRepository(root, { force: options.force, standalone: options.standalone });
    output(`TimDS tooling installed for ${result.repoRoot}`);
    output(`Design system: ${result.designSystemRoot}`);
    output(`Agent skill: ${result.skillDestination}`);
    output(`Toolkit: ${result.package.name}@${result.package.version}`);
    if (result.created.length) output(`Created ${result.created.length} contract files.`);
    output("Run npm install, then npm run timds -- doctor.");
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
          output(`${asset.id}\t${asset.visibility}\t${asset.kind}\t${asset.bytes}\t${asset.title}`);
        }
      }
      return workspace.mediaCatalog;
    }
    if (mediaCommand === "add") {
      if (!mediaArgument) throw new Error("assets add requires a file path");
      const result = await addMediaFile(workspace, mediaArgument, options);
      output(`${result.reused ? "Reused" : "Uploaded"} media asset ${result.asset.id}: ${result.asset.title}`);
      output(`Catalog: ${result.catalogPath}`);
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
