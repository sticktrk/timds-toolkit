import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { cleanPortalUrl, resolveAccessToken } from "./auth.mjs";
import { detectSourceCommit } from "./artifact.mjs";
import { publicationDigest } from "./publication-snapshot.mjs";

export const PUBLICATION_STAMP = ".timds/cache/.timds-artifact.json";
const stampFields = ["systemId", "version", "sourceCommit", "contentDigest"];
const git = (root, args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 20_000_000, timeout: 15_000 });

async function readObject(file) {
  const value = JSON.parse(await fs.readFile(file, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path.basename(file)} must contain an object`);
  return value;
}

async function artifactFiles(root) {
  const files = [];
  let totalBytes = 0;
  async function walk(directory, prefix = "", depth = 0) {
    const info = await fs.lstat(directory);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("Artifact must contain real directories");
    if (depth > 20) throw new Error("Artifact directory depth exceeds 20");
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const relative = `${prefix}${entry.name}`;
      if (relative === ".timds-artifact.json") throw new Error("The root .timds-artifact.json is reserved for publication metadata; remove it from dist");
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error("Artifact cannot contain symbolic links");
      if (entry.isDirectory()) await walk(absolute, `${relative}/`, depth + 1);
      else if (entry.isFile()) {
        const info = await fs.stat(absolute);
        totalBytes += info.size;
        if (info.size > 12_000_000 || totalBytes > 80_000_000 || files.length >= 2_000) throw new Error("Artifact exceeds publication limits");
        files.push({ path: relative, content: await fs.readFile(absolute) });
      } else throw new Error("Artifact contains an unsupported file");
    }
  }
  await walk(root);
  return files;
}

export async function createPublicationStamp(workspace) {
  const { repoRoot, designSystemRoot } = workspace;
  const sourceCommit = detectSourceCommit(repoRoot);
  if (!/^[a-f0-9]{40}$/.test(sourceCommit)) throw new Error("Publication requires a committed Git checkout");
  const relativeRoot = path.relative(repoRoot, designSystemRoot).split(path.sep).join("/");
  const prefix = relativeRoot ? `${relativeRoot}/` : "";
  const contractPaths = ["timds.json", "tokens.json", "media.json", "docs", "components", "assets"].map((name) => `${prefix}${name}`);
  if (git(repoRoot, ["diff", "--name-only", sourceCommit, "--", ...contractPaths]).trim() || git(repoRoot, ["ls-files", "--others", "--exclude-standard", "--", ...contractPaths]).trim()) {
    throw new Error("Commit the source contract before publishing; the artifact must match its source commit");
  }
  const sourceFiles = [];
  // Git's recursive tree order matches the release source, including asset
  // ordering. Ignore symlinks and gitlinks, as publication discovery does.
  for (const record of git(repoRoot, ["ls-tree", "-rz", "--full-tree", sourceCommit, "--", ...contractPaths]).split("\0").filter(Boolean)) {
    const [header, filePath] = record.split(/\t(.*)/s);
    if (!/^100(?:644|755) blob /.test(header)) continue;
    const relative = filePath.slice(prefix.length);
    const absolute = path.join(repoRoot, filePath);
    const info = await fs.lstat(absolute);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Source contract must contain real files: ${relative}`);
    // Only textual contract files are read; asset bytes are hashed in dist.
    const readable = ["timds.json", "tokens.json", "media.json"].includes(relative) || /^(docs\/.*\.(md|mdx)|components\/.*\.(json|md|mdx))$/i.test(relative);
    if (readable && info.size > 1_000_000) throw new Error(`Source contract file is too large: ${relative}`);
    sourceFiles.push({ path: relative, bytes: info.size, content: readable ? await fs.readFile(absolute, "utf8") : undefined });
  }
  const sourceByPath = new Map(sourceFiles.map((file) => [file.path, file]));
  if (!sourceByPath.has("timds.json") || !sourceByPath.has("tokens.json")) throw new Error("Publication requires tracked timds.json and tokens.json");
  const manifest = JSON.parse(sourceByPath.get("timds.json").content);
  const tokens = JSON.parse(sourceByPath.get("tokens.json").content);
  const media = sourceByPath.has("media.json") ? JSON.parse(sourceByPath.get("media.json").content) : null;
  const contentDigest = publicationDigest({ manifest, tokens, media, sourceFiles, artifactFiles: await artifactFiles(path.join(designSystemRoot, "dist")) });
  const stamp = { schemaVersion: 1, systemId: workspace.manifest.systemId, version: workspace.manifest.version, sourceCommit, contentDigest };
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]{1,159}$/.test(stamp.systemId) || !/^[a-zA-Z0-9][a-zA-Z0-9._+-]{0,99}$/.test(stamp.version)) throw new Error("Publication requires a safe system identity and version label");
  return stamp;
}

export async function writePublicationStamp(workspace, stamp = null) {
  stamp ??= await createPublicationStamp(workspace);
  const file = path.join(workspace.designSystemRoot, PUBLICATION_STAMP);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(stamp, null, 2)}\n`);
  return stamp;
}

/** Push the exact local build to the declared artifact ref. No portal write. */
export async function publishArtifactRef(workspace, { repository = process.env.GITHUB_REPOSITORY, run = (command, args, cwd) => execFileSync(command, args, { cwd, stdio: "inherit", timeout: 120_000 }) } = {}) {
  const publishRef = workspace.manifest.artifact?.publishRef;
  if (!publishRef || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(publishRef) || /\.\.|\/\/|\/$/.test(publishRef)) throw new Error("Publication requires a safe artifact.publishRef");
  let remote;
  if (repository) {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error("GITHUB_REPOSITORY must be OWNER/REPO");
    remote = `https://github.com/${repository}.git`;
  } else {
    remote = git(workspace.repoRoot, ["remote", "get-url", "origin"]).trim();
    if (!/^(https:\/\/github\.com\/|git@github\.com:)[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/.test(remote)) throw new Error("Publication requires a GitHub origin without embedded credentials");
  }
  const stamp = await createPublicationStamp(workspace);
  const stage = await fs.mkdtemp(path.join(os.tmpdir(), "timds-publish-"));
  try {
    await fs.cp(path.join(workspace.designSystemRoot, "dist"), stage, { recursive: true });
    await fs.writeFile(path.join(stage, ".timds-artifact.json"), `${JSON.stringify(stamp, null, 2)}\n`);
    run("git", ["init", "-b", publishRef], stage);
    run("git", ["config", "user.name", "TimDS Publisher"], stage);
    run("git", ["config", "user.email", "41898282+github-actions[bot]@users.noreply.github.com"], stage);
    run("git", ["add", "--all"], stage);
    run("git", ["commit", "-m", `Publish TimDS ${stamp.version} from ${stamp.sourceCommit.slice(0, 12)}`], stage);
    run("git", ["remote", "add", "origin", remote], stage);
    run("git", ["push", "--force", "origin", `HEAD:refs/heads/${publishRef}`], stage);
    await writePublicationStamp(workspace, stamp);
    return stamp;
  } finally {
    await fs.rm(stage, { force: true, recursive: true });
  }
}

function matchesStamp(actual, expected) {
  return stampFields.every((field) => actual?.[field] === expected[field]);
}

export async function publishRelease(workspace, options = {}) {
  const current = await createPublicationStamp(workspace);
  const file = path.join(workspace.designSystemRoot, PUBLICATION_STAMP);
  const stamp = await readObject(file).catch((error) => {
    if (error.code === "ENOENT") throw new Error("No local .timds-artifact.json stamp; push the artifact with timds publish first");
    throw error;
  });
  if (stamp.schemaVersion !== 1 || !matchesStamp(stamp, current)) throw new Error("The publication stamp differs from the local build or source commit; rebuild and push with timds publish");
  const portal = cleanPortalUrl(options.portalUrl || workspace.manifest.media?.portalUrl || process.env.TIMDS_PORTAL_URL);
  const token = await resolveAccessToken(portal, options);
  if (!token) throw new Error("Publication requires an operator token: run timds auth login or set TIMDS_ACCESS_TOKEN in CI");
  const fetchImpl = options.fetchImpl || fetch;
  const response = await fetchImpl(new URL("/api/timds/publish", portal).toString(), {
    method: "POST", signal: AbortSignal.timeout(130_000),
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(Object.fromEntries(stampFields.map((field) => [field, stamp[field]]))),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`TimDS publication returned ${response.status}: ${String(result.error || result.message || "request rejected")}`);
  if (!["published", "awaiting-operator"].includes(result.status) || result.systemId !== stamp.systemId || result.version !== stamp.version || !result.publicRoot || !result.versionedUrls?.root) throw new Error("Invalid TimDS publication response");
  if (result.status === "awaiting-operator") {
    if (!matchesStamp({ ...result.candidate, systemId: result.systemId }, stamp) || !result.operatorUrl) throw new Error("Invalid waiting-candidate response");
    return result;
  }
  // Workflow success means the root already serves these bytes. Never send
  // the operator bearer to a public root or another response-supplied host.
  const publicRoot = new URL(result.publicRoot);
  if (publicRoot.protocol !== "https:" || publicRoot.username || publicRoot.password || publicRoot.search || publicRoot.hash) throw new Error("Invalid public root URL");
  const publicResponse = await fetchImpl(new URL(".timds-artifact.json", publicRoot).toString(), { cache: "no-store", headers: { "Cache-Control": "no-cache" }, signal: AbortSignal.timeout(30_000) });
  const publicStamp = await publicResponse.json().catch(() => ({}));
  if (!publicResponse.ok || !matchesStamp(publicStamp, stamp)) throw new Error("Publication completed but the public root does not serve the requested stamp; retry timds publish --skip-build --skip-push");
  return result;
}
