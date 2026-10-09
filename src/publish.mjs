// Release publication. Three steps share one stamp: `createPublicationStamp`
// hashes the committed source contract and the local build exactly as the
// portal recomputes them from the pushed ref and the default-branch commit;
// `publishArtifactRef` pushes that build to `artifact.publishRef` (no portal
// write) and only then saves the stamp under .timds/cache, outside dist;
// `publishRelease` sends the stamp's identity to the portal and verifies the
// public root anonymously. Boundary rules: contract bytes come from Git blobs,
// never the checkout (no eol/LFS filters); every dist file is pushed, ignore
// rules notwithstanding; the ref is replaced only when the checkout is the
// remote default-branch head and the target is a separate branch; the operator
// bearer reaches the portal alone.
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { cleanPortalUrl, resolveAccessToken } from "./auth.mjs";
import { detectSourceCommit } from "./artifact.mjs";
import { collectArtifactFiles } from "./artifact-files.mjs";
import { publicationDigest } from "./publication-snapshot.mjs";

export const PUBLICATION_STAMP = ".timds/cache/.timds-artifact.json";
const stampFields = ["systemId", "version", "sourceCommit", "contentDigest"];
const versionedUrlFields = ["root", "llmsTxt", "bundleJson", "artifact"];
const git = (root, args, options = {}) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 20_000_000, timeout: 15_000, ...options });

async function readObject(file) {
  const value = JSON.parse(await fs.readFile(file, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path.basename(file)} must contain an object`);
  return value;
}

/** Committed blob bytes in one git process; checkout filters never apply. */
function readBlobs(root, shas) {
  const blobs = new Map();
  const wanted = [...new Set(shas)];
  if (!wanted.length) return blobs;
  const out = execFileSync("git", ["cat-file", "--batch"], { cwd: root, input: `${wanted.join("\n")}\n`, stdio: ["pipe", "pipe", "pipe"], maxBuffer: 200_000_000, timeout: 30_000 });
  for (let offset = 0; offset < out.length;) {
    const end = out.indexOf(10, offset);
    const header = end === -1 ? null : /^([0-9a-f]{40}) blob (\d+)$/.exec(out.subarray(offset, end).toString("utf8"));
    if (!header) throw new Error("Source contract blobs could not be read from the source commit");
    const size = Number(header[2]);
    blobs.set(header[1], out.subarray(end + 1, end + 1 + size));
    offset = end + 1 + size + 1;
  }
  return blobs;
}

async function artifactFiles(workspace) {
  // checkWorkspace walks dist after every derived write; reuse that walk.
  let files = workspace.artifact?.files;
  if (!files) {
    const root = path.join(workspace.designSystemRoot, "dist");
    const info = await fs.lstat(root).catch((error) => { throw error.code === "ENOENT" ? new Error("design-system/dist is required; run the design-system build first") : error; });
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("design-system/dist must be a real directory");
    files = (await collectArtifactFiles(root)).files;
  }
  if (files.some((file) => file.path === ".timds-artifact.json")) throw new Error("The root .timds-artifact.json is reserved for publication metadata; remove it from dist");
  return files;
}

export async function createPublicationStamp(workspace) {
  const { repoRoot, designSystemRoot } = workspace;
  const sourceCommit = detectSourceCommit(repoRoot);
  if (!/^[a-f0-9]{40}$/.test(sourceCommit)) throw new Error("Publication requires a committed Git checkout");
  const relativeRoot = path.relative(repoRoot, designSystemRoot).split(path.sep).join("/");
  const prefix = relativeRoot ? `${relativeRoot}/` : "";
  const contractPaths = ["timds.json", "tokens.json", "media.json", "docs", "components", "assets"].map((name) => `${prefix}${name}`);
  // The build must come from the committed contract, which is what is hashed.
  if (git(repoRoot, ["diff", "--name-only", sourceCommit, "--", ...contractPaths]).trim() || git(repoRoot, ["ls-files", "--others", "--exclude-standard", "--", ...contractPaths]).trim()) {
    throw new Error("Commit the source contract before publishing; the artifact must match its source commit");
  }
  // Git's recursive tree order matches the release source, including asset
  // ordering. Blob sizes come from the tree and bytes from the objects, so a
  // checkout filter cannot change the digest. Symlinks and gitlinks are
  // ignored, as publication discovery does.
  const readable = (relative) => ["timds.json", "tokens.json", "media.json"].includes(relative) || /^(docs\/.*\.(md|mdx)|components\/.*\.(json|md|mdx))$/i.test(relative);
  const records = [];
  for (const record of git(repoRoot, ["ls-tree", "-rzl", "--full-tree", sourceCommit, "--", ...contractPaths]).split("\0").filter(Boolean)) {
    const [header, filePath] = record.split(/\t(.*)/s);
    const match = /^100(?:644|755) blob ([0-9a-f]{40}) +(\d+)$/.exec(header);
    if (!match) continue;
    const relative = filePath.slice(prefix.length);
    const bytes = Number(match[2]);
    // Only textual contract files are read; asset bytes are hashed in dist.
    if (readable(relative) && bytes > 1_000_000) throw new Error(`Source contract file is too large: ${relative}`);
    records.push({ bytes, path: relative, sha: match[1] });
  }
  const blobs = readBlobs(repoRoot, records.filter((record) => readable(record.path)).map((record) => record.sha));
  const sourceFiles = records.map((record) => ({ path: record.path, bytes: record.bytes, content: readable(record.path) ? blobs.get(record.sha)?.toString("utf8") : undefined }));
  if (sourceFiles.some((file) => readable(file.path) && file.content === undefined)) throw new Error("Source contract blobs could not be read from the source commit");
  const sourceByPath = new Map(sourceFiles.map((file) => [file.path, file]));
  if (!sourceByPath.has("timds.json") || !sourceByPath.has("tokens.json")) throw new Error("Publication requires tracked timds.json and tokens.json");
  const manifest = JSON.parse(sourceByPath.get("timds.json").content);
  const tokens = JSON.parse(sourceByPath.get("tokens.json").content);
  const media = sourceByPath.has("media.json") ? JSON.parse(sourceByPath.get("media.json").content) : null;
  const contentDigest = publicationDigest({ manifest, tokens, media, sourceFiles, artifactFiles: await artifactFiles(workspace) });
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

/** Resolve the remote default branch's full ref and commit together. */
function remoteDefaultHead(root, remote) {
  const output = git(root, ["ls-remote", "--symref", remote, "HEAD"], { timeout: 60_000 });
  return {
    ref: /^ref: (refs\/heads\/[^\s]+)\tHEAD$/m.exec(output)?.[1] ?? null,
    sha: /^([0-9a-f]{40})\tHEAD$/m.exec(output)?.[1] ?? null,
  };
}

/** Push the exact local build to the declared artifact ref. No portal write. */
export async function publishArtifactRef(workspace, { repository = process.env.GITHUB_REPOSITORY, remoteHead = remoteDefaultHead, run = (command, args, cwd) => execFileSync(command, args, { cwd, stdio: "inherit", timeout: 120_000 }) } = {}) {
  const publishRef = workspace.manifest.artifact?.publishRef;
  if (!publishRef || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(publishRef) || /\.\.|\/\/|\/$/.test(publishRef)) throw new Error("Publication requires a safe artifact.publishRef");
  let remote;
  if (repository) {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error("GITHUB_REPOSITORY must be OWNER/REPO");
    remote = `https://github.com/${repository}.git`;
  } else {
    remote = git(workspace.repoRoot, ["remote", "get-url", "origin"]).trim();
    if (!/^(https:\/\/github\.com\/|git@github\.com:)[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?\/?$/.test(remote)) throw new Error(`Publication requires a GitHub origin without embedded credentials; origin is ${JSON.stringify(remote)}`);
  }
  const stamp = await createPublicationStamp(workspace);
  // The portal promotes a stamp only for the default-branch head, and the push
  // below replaces the live ref with an orphan commit. The artifact ref must
  // never be the source branch, even when its commit matches the checkout.
  const defaultBranch = await remoteHead(workspace.repoRoot, remote);
  if (!defaultBranch?.ref?.startsWith("refs/heads/")) {
    throw new Error(`Cannot resolve the remote default branch of ${remote}; refusing to replace an artifact ref`);
  }
  if (defaultBranch.ref === `refs/heads/${publishRef}`) {
    throw new Error(`artifact.publishRef ${publishRef} is the remote default branch; choose a separate artifact branch (for example timds-published) before publishing`);
  }
  const head = defaultBranch.sha;
  if (head !== stamp.sourceCommit) {
    throw new Error(`Checkout ${stamp.sourceCommit.slice(0, 12)} is not the default-branch head of ${remote}${head ? ` (${head.slice(0, 12)})` : ""}; push the source commit to the default branch before publishing`);
  }
  const stage = await fs.mkdtemp(path.join(os.tmpdir(), "timds-publish-"));
  try {
    await fs.cp(path.join(workspace.designSystemRoot, "dist"), stage, { recursive: true });
    await fs.writeFile(path.join(stage, ".timds-artifact.json"), `${JSON.stringify(stamp, null, 2)}\n`);
    // Quiet git keeps `publish --json` stdout parseable. The stamp hashed every
    // byte of dist, so the stage commits ignored files unchanged: --force
    // defeats global excludes and any .gitignore the build emitted, and the
    // local autocrlf setting stops line-ending conversion on add.
    run("git", ["init", "-q", "-b", publishRef], stage);
    run("git", ["config", "user.name", "TimDS Publisher"], stage);
    run("git", ["config", "user.email", "41898282+github-actions[bot]@users.noreply.github.com"], stage);
    run("git", ["config", "core.autocrlf", "false"], stage);
    run("git", ["add", "--all", "--force"], stage);
    run("git", ["commit", "-q", "-m", `Publish TimDS ${stamp.version} from ${stamp.sourceCommit.slice(0, 12)}`], stage);
    run("git", ["remote", "add", "origin", remote], stage);
    run("git", ["push", "-q", "--force", "origin", `HEAD:refs/heads/${publishRef}`], stage);
    await writePublicationStamp(workspace, stamp);
    return stamp;
  } finally {
    await fs.rm(stage, { force: true, recursive: true });
  }
}

function matchesStamp(actual, expected) {
  return stampFields.every((field) => actual?.[field] === expected[field]);
}

/** The public stamp URL `publishRelease` verifies for a published root. */
export function publicStampUrl(publicRoot) {
  const root = new URL(publicRoot);
  if (root.protocol !== "https:" || root.username || root.password || root.search || root.hash) throw new Error("Invalid public root URL");
  return new URL(".timds-artifact.json", root).toString();
}

export async function publishRelease(workspace, options = {}) {
  // A ref push that just ran hands over its stamp; otherwise recompute it.
  const current = options.stamp ?? await createPublicationStamp(workspace);
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
  const urlsValid = versionedUrlFields.every((field) => typeof result.versionedUrls?.[field] === "string" && result.versionedUrls[field]);
  if (!["published", "awaiting-operator"].includes(result.status) || result.systemId !== stamp.systemId || result.version !== stamp.version || typeof result.publicRoot !== "string" || !urlsValid) throw new Error("Invalid TimDS publication response");
  if (result.status === "awaiting-operator") {
    if (!matchesStamp({ ...result.candidate, systemId: result.systemId }, stamp) || !result.operatorUrl) throw new Error("Invalid waiting-candidate response");
    return result;
  }
  // Workflow success means the root already serves these bytes. Never send
  // the operator bearer to a public root or another response-supplied host.
  const publicResponse = await fetchImpl(publicStampUrl(result.publicRoot), { cache: "no-store", headers: { "Cache-Control": "no-cache" }, signal: AbortSignal.timeout(30_000) });
  const publicStamp = await publicResponse.json().catch(() => ({}));
  if (!publicResponse.ok || !matchesStamp(publicStamp, stamp)) throw new Error("Publication completed but the public root does not serve the requested stamp; retry timds publish --skip-build --skip-push");
  return result;
}
