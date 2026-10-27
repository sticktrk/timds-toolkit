// Register the current product with the selected TimDS host. Durable
// registration identity lives in git metadata, outside the tracked product.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { resolveAccessToken, savedPortalUrl } from "./auth.mjs";
import { createHostProvider } from "./hosted.mjs";
import { CONSUMER_MANIFEST_FILE, loadConsumer } from "./consumer.mjs";

const execute = promisify(execFile);
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const HELP = `Usage:
  timds consumer register [--portal-url URL] [--repository OWNER/REPO] [--base-branch REF] [--delivery auto|approve] [--notify] [--surface PATH]... [--root PATH] [--json]
  timds consumer updates [LABEL] [--portal-url URL] [--consumer-id UUID] [--root PATH] [--json]

Register the current timds.consumer.json with a host, then complete its GitHub
App installation. The host opens a pull request for review after publication
or rollback; it never merges or deploys. Hosted mode needs a fixed published
pin and a product CLI supporting consumer check --allow-pin-update LABEL.
--notify dispatches an existing repository workflow instead of running an agent.
--surface supplies narrower repository path prefixes when manifest globs have
no safe prefix. The immutable base manifest still limits the agent's changes.
updates reads the same retained receipts as Studio and authenticated MCP.
The host is selected by --portal-url, TIMDS_PORTAL_URL, or the saved selected
login, in that order. If no saved host is unambiguous, pass --portal-url.
The consumer manifest must be at the Git repository root. Surface prefixes
are limited to 100 including timds.consumer.json.`;

function origin(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error("Select a TimDS host with --portal-url URL"); }
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash || url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) throw new Error("The TimDS host must be an HTTPS origin without credentials or a path (HTTP is allowed only on localhost)");
  return url.origin;
}
async function git(root, args) {
  try { return (await execute("git", args, { cwd: root, encoding: "utf8", maxBuffer: 1024 * 1024 })).stdout.trim(); }
  catch { throw new Error("Read-only git discovery failed; run inside the product repository or provide --repository OWNER/REPO"); }
}
function repository(value, explicit = false) {
  let name = value;
  if (!explicit) {
    const scp = /^git@github\.com:([^\s]+)$/.exec(value);
    if (scp) name = scp[1];
    else {
      let url;
      try { url = new URL(value); } catch { throw new Error("The origin remote must name a GitHub repository, or pass --repository OWNER/REPO"); }
      if (url.hostname !== "github.com" || !["https:", "ssh:"].includes(url.protocol) || url.password || url.search || url.hash || url.protocol === "https:" && url.username || url.protocol === "ssh:" && url.username !== "git") throw new Error("The origin remote must name GitHub without embedded credentials");
      name = url.pathname.replace(/^\//, "");
    }
    name = name.replace(/\.git$/, "");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/.test(name) || name.endsWith(".git") || [".", ".."].includes(name.split("/")[1])) throw new Error("Use a GitHub owner/repository locator");
  return name.toLowerCase();
}
function safePrefix(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 500 && !/[\\\u0000-\u001f*?{}\[\]]/.test(value) && !value.startsWith("/") && value.split("/").every(part => part && part !== "." && part !== ".." && part !== ".git");
}
function boundedSurface(prefixes) {
  const result = [...new Set(prefixes)].sort();
  if (result.length > 100) throw new Error("Hosted registration supports at most 100 design-surface prefixes including timds.consumer.json");
  return result;
}
export function registrationSurface(manifest, supplied) {
  if (supplied?.length) {
    if (!supplied.every(safePrefix)) throw new Error("--surface must name a safe repository file or directory prefix without globs");
    return boundedSurface([CONSUMER_MANIFEST_FILE, ...supplied]);
  }
  const prefixes = [CONSUMER_MANIFEST_FILE];
  for (const app of Object.values(manifest.apps)) for (const glob of app.designSurface) {
    const segments = glob.split("/"), wildcard = segments.findIndex(part => /[*?{}\[\]]/.test(part));
    const prefix = path.posix.join(app.cwd, ...(wildcard < 0 ? segments : segments.slice(0, wildcard)));
    if (!safePrefix(prefix)) throw new Error("A design-surface glob has no safe directory prefix; provide explicit --surface PATH values");
    prefixes.push(prefix);
  }
  return boundedSurface(prefixes);
}
async function context(root, options) {
  const consumer = await loadConsumer(root);
  const top = await fs.realpath(await git(consumer.repoRoot, ["rev-parse", "--show-toplevel"]));
  if (await fs.realpath(consumer.repoRoot) !== top) throw new Error("Hosted followers require timds.consumer.json at the Git repository root");
  const portal = origin(options.portalUrl || process.env.TIMDS_PORTAL_URL || await savedPortalUrl(options));
  const host = createHostProvider({ url: portal, resolveToken: extra => resolveAccessToken(portal, { ...options, ...extra }), fetchImpl: options.fetchImpl || fetch });
  const rows = (await host.systems()).systems?.filter(row => row.systemId === consumer.manifest.designSystem.systemId) || [];
  if (rows.length !== 1 || !uuid.test(rows[0].id)) throw new Error("The selected host does not expose exactly one accessible source matching the consumer's systemId");
  const common = path.resolve(consumer.repoRoot, await git(consumer.repoRoot, ["rev-parse", "--git-common-dir"]));
  const key = createHash("sha256").update(`${portal}\n${rows[0].id}`).digest("hex");
  return { ...consumer, host, portal, sourceId: rows[0].id, recordFile: path.join(common, "timds-consumers", `${key}.json`) };
}
async function record(file) {
  try { return JSON.parse(await fs.readFile(file, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return null; throw new Error("The local consumer registration record is unreadable"); }
}
export async function registerConsumer(root = process.cwd(), options = {}) {
  const ctx = await context(root, options), { manifest, designSystem, host, sourceId, portal, recordFile } = ctx;
  const locator = repository(options.repository || await git(ctx.repoRoot, ["remote", "get-url", "origin"]), Boolean(options.repository));
  const prior = await record(recordFile);
  if (prior && (prior.portal !== portal || prior.sourceId !== sourceId || prior.input?.locator !== locator || !uuid.test(prior.input?.id))) throw new Error("The saved registration belongs to another repository or source");
  const requestedMode = options.notify ? "notify" : "hosted";
  if (prior && prior.input.policy?.mode !== requestedMode) throw new Error("Registration already exists with a different update mode; repeat --notify for notifications or manage it in Studio");
  if (requestedMode === "hosted" && (designSystem.mode !== "published" || ["current", "latest"].includes(manifest.designSystem.version))) throw new Error("Hosted registration needs a fixed published release pin; migrate a submodule or use --notify");
  const delivery = options.delivery || "auto";
  if (!["auto", "approve"].includes(delivery)) throw new Error("--delivery must be auto or approve");
  let input = prior?.input;
  if (!input) {
    input = { id: randomUUID(), kind: "github", locator, pinPath: CONSUMER_MANIFEST_FILE, pinnedLabel: manifest.designSystem.version || "", designSurface: options.notify ? [] : registrationSurface(manifest, options.surface), policy: { mode: requestedMode, delivery }, ...(options.baseBranch ? { baseBranch: options.baseBranch } : {}) };
    await fs.mkdir(path.dirname(recordFile), { recursive: true, mode: 0o700 });
    try { await fs.writeFile(recordFile, `${JSON.stringify({ schemaVersion: 1, portal, sourceId, input }, null, 2)}\n`, { mode: 0o600, flag: "wx" }); }
    catch (error) { if (error.code !== "EEXIST") throw error; const winner = await record(recordFile); if (winner?.portal !== portal || winner.sourceId !== sourceId || winner.input?.locator !== locator || !uuid.test(winner.input?.id)) throw new Error("Another registration changed this repository; retry after inspecting its state"); input = winner.input; }
  }
  // Reuse the exact input saved before the first POST, including after a lost
  // response or a later local pin move. Changed CLI policy never creates another
  // follower silently; policy edits belong to the existing host registration.
  if (options.delivery && input.policy.delivery !== options.delivery || input.policy.mode !== requestedMode || options.baseBranch && input.baseBranch !== options.baseBranch || options.surface && JSON.stringify(input.designSurface) !== JSON.stringify(registrationSurface(manifest, options.surface))) throw new Error("Registration already exists with different policy or surface; manage it in Studio");
  const result = await host.registerConsumer(sourceId, input);
  if (result.consumer?.id !== input.id || result.consumer.sourceId !== sourceId || result.consumer.locator !== locator) throw new Error("The host returned a mismatched consumer registration");
  let installUrl;
  if (result.consumer.status === "pending_install") {
    installUrl = (await host.consumerInstall(input.id)).installUrl;
    let target; try { target = new URL(installUrl); } catch { throw new Error("The host returned no GitHub installation link"); }
    if (target.protocol !== "https:" || target.hostname !== "github.com" || target.username || target.password || !/^\/apps\/[^/]+\/installations\/new$/.test(target.pathname)) throw new Error("The host returned an invalid GitHub installation link");
  }
  return { ...result, portal, ...(installUrl ? { installUrl } : {}) };
}
export async function consumerUpdates(root = process.cwd(), options = {}) {
  const ctx = await context(root, options), prior = await record(ctx.recordFile), id = options.consumerId || prior?.input?.id;
  if (!uuid.test(id || "")) throw new Error("Run consumer register first, or pass --consumer-id UUID");
  if (options.label && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(options.label)) throw new Error("Provide a valid release label");
  return options.label ? ctx.host.consumerUpdate(ctx.sourceId, id, options.label) : ctx.host.consumerUpdates(ctx.sourceId, id);
}
export async function runConsumerRegistration(command, argv, { output = message => process.stdout.write(`${message}\n`), ...options } = {}) {
  const parsed = {};
  for (let index = 0; index < argv.length; index++) {
    const item = argv[index];
    if (item === "-h") { parsed.help = true; continue; }
    if (!item.startsWith("-")) { if (command !== "updates" || parsed.label) throw new Error(`Unexpected argument\n${HELP}`); parsed.label = item; continue; }
    const match = /^--([a-z-]+)(?:=(.*))?$/.exec(item);
    if (!match) throw new Error(`Unknown option\n${HELP}`);
    const name = match[1].replace(/-([a-z])/g, (_all, letter) => letter.toUpperCase());
    if (["json", "help", "notify"].includes(name)) { if (match[2] !== undefined || name === "notify" && command !== "register") throw new Error(`Invalid --${match[1]}\n${HELP}`); parsed[name] = true; continue; }
    const allowed = command === "register" ? ["portalUrl", "repository", "baseBranch", "delivery", "surface", "root"] : ["portalUrl", "consumerId", "root"];
    if (!allowed.includes(name)) throw new Error(`Unknown option --${match[1]}\n${HELP}`);
    const value = match[2] ?? argv[++index];
    if (!value || value.startsWith("-")) throw new Error(`--${match[1]} requires a value`);
    if (name === "surface") (parsed.surface ??= []).push(value); else parsed[name] = value;
  }
  if (parsed.help) { output(HELP); return; }
  const result = command === "register" ? await registerConsumer(parsed.root, { ...options, ...parsed }) : await consumerUpdates(parsed.root, { ...options, ...parsed });
  if (parsed.json) output(JSON.stringify(result, null, 2));
  else if (command === "register") { output(`Registered ${result.consumer.locator}: ${result.consumer.status} (${result.consumer.id})`); if (result.installUrl) output(`Complete the GitHub App installation: ${result.installUrl}`); }
  else for (const update of result.updates || [result.update]) output(`${update.label}: ${update.status}${update.rollback ? " (rollback)" : ""}${update.pullRequestUrl ? ` — ${update.pullRequestUrl}` : ""}${update.errorMessage ? ` — ${update.errorMessage}` : ""}`);
  return result;
}
