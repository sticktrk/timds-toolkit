// A parent supplies an offshoot's structural stock. Feeding reuses the starter's
// three-way catalog merge. The toolkit keeps code, the parent keeps design:
// feed carries no code, so it never writes plumbing (the stub scripts, the
// composer script, the viewer and canvas stylesheets); a system's code is its
// own toolkit selection, and only `upgrade` writes it. the pages, stylesheets, layout and copy the parent's
// `.timds/stock.json` declares are refreshed by the hash `.timds/parent.json`
// recorded when they were last written. A stock file the child changed or
// removed is a graft and is kept, `--force` included; a graft first met with
// no recorded hash records the parent's hash it was offered. Tokens, media,
// designs and every undeclared file remain the child's and are never copied.
// Feed writes the hashed record, so it refuses a child whose selected toolkit
// predates the running release (that older CLI could not read the record).
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { isPlumbingPath, readParentRecord, regularPath, validateParentRecord } from "./offshoot-contract.mjs";
import { requireCleanPaths } from "./clean-tree.mjs";
import { declaredStock, decodeOffshootSource, predatesRunningToolkit, selectedToolkitVersionIn, stockHashes, structureSite } from "./offshoots.mjs";
import { runtimeIdentity } from "./runtime.mjs";
import { compareDesignSystemVersions, parseDesignSystemVersion } from "./changelog.mjs";
import {
  STARTER_RECORD_FILE, STARTER_SITE_FILE, STARTER_FORMATS_FILE,
  belowFloorError, declaredPageIds, describeStarterSync, formatFormatsJson, formatSiteJson,
  mergeFormatCatalog, mergeSiteModel, readStarterRecord, starterBelowFloor,
} from "./starter.mjs";

const PARENT_FILE = ".timds/parent.json";
const cleanTreeMessage = "Feed refuses to run over uncommitted changes to the files it writes";
const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

async function optionalBytes(file) {
  try { return await fs.readFile(file); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

/** The page a stock fragment renders: `src/pages/<view>/index.html` is the
 * view's own page and `src/pages/<view>/<slug>.html` is `<view>/<slug>`. */
function stockPageId(relative) {
  const match = /^src\/pages\/([^/]+)\/(.+)\.html$/.exec(relative);
  if (!match) return null;
  return match[2] === "index" ? match[1] : `${match[1]}/${match[2]}`;
}

function sameIdentity(left, right) {
  return ["systemId", "sourceId", "version", "commit"].filter((key) => left?.[key] !== right?.[key]);
}

async function optional(file) {
  try { return await fs.readFile(file, "utf8"); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

function sourceJson(files, name, required = true) {
  const file = files.get(name);
  if (!file) {
    if (!required) return null;
    throw new Error(`The parent source has no ${name}`);
  }
  if (file.mode === "120000") throw new Error(`The parent source ${name} must be a regular file`);
  try { return JSON.parse(file.toString("utf8")); }
  catch { throw new Error(`The parent source ${name} is invalid JSON`); }
}

async function targetPath(root, relative) {
  return (await regularPath(root, relative, { optional: true })) ?? path.join(root, relative);
}

/** Feed a verified published source snapshot (the same shape as source export).
 * Only catalogs, the parent's declared stock (while the child's copy is
 * unmodified, or absent and never written) and the parent record are
 * written; never plumbing or other authored source. A record without stock
 * hashes needs `baseline`, the release it names, to adopt them. A parent or
 * child below the starter floor is refused (`below_floor`) before anything is
 * written. `hostedRunner` lets the host's own runner feed a hosted session
 * workspace. */
export async function feedOffshoot({ designSystemRoot, source, baseline = null, check = null, hostedRunner = false }) {
  const parent = await readParentRecord(designSystemRoot);
  if (!parent) throw Object.assign(new Error("This system has no .timds/parent.json; only an offshoot can be fed"), { failureCode: "not_offshoot" });
  if (starterBelowFloor(await readStarterRecord(designSystemRoot))) throw belowFloorError("This offshoot");
  if (!hostedRunner && await optional(path.join(designSystemRoot, ".timds/session.json"))) throw new Error("Feed is not available in a hosted session; feed the source repository instead (the host's runner sets TIMDS_HOSTED_RUNNER=1 to feed its own workspace)");
  const selectedToolkit = await selectedToolkitVersionIn(designSystemRoot);
  if (predatesRunningToolkit(selectedToolkit)) throw new Error(`This system selects toolkit ${selectedToolkit}, older than the running ${runtimeIdentity.version}, and that CLI cannot read the stock hashes feed records in .timds/parent.json. Upgrade the system's toolkit first (timds upgrade --version ${runtimeIdentity.version}, or the host's upgrade), commit, then feed`);
  if (!source || !(Array.isArray(source.files) || source.files instanceof Map) || !object(source.parent)) throw new Error("Feed requires a published parent source snapshot");
  const { systemId, sourceId, version, commit } = source.parent;
  const identity = { systemId, sourceId, version, commit };
  if (identity.systemId !== parent.systemId || identity.sourceId !== parent.sourceId) throw Object.assign(new Error("The source snapshot belongs to a different parent system or source"), { failureCode: "parent_mismatch" });
  if (parseDesignSystemVersion(identity.version) && parseDesignSystemVersion(parent.version) && compareDesignSystemVersions(identity.version, parent.version) < 0) throw Object.assign(new Error(`Feed requires a parent release at or after ${parent.version}; ${identity.version} is older`), { failureCode: "parent_mismatch" });
  const sourceFiles = decodeOffshootSource(source);
  if (starterBelowFloor(sourceJson(sourceFiles, STARTER_RECORD_FILE, false))) throw belowFloorError(`The parent release ${identity.systemId} ${identity.version}`);
  // Records shot before stock hashes are adopted from the release they name:
  // a child file still equal to that release's bytes is unmodified stock.
  let recordedFiles = parent.files;
  const adopted = !object(recordedFiles);
  if (adopted) {
    if (!baseline) throw Object.assign(new Error(`.timds/parent.json predates stock hashes; feed needs the release it was shot from (${parent.systemId} ${parent.version} at ${parent.commit}) as a baseline to adopt them: pass --baseline-file with that release's source export under the host runner, or let timds feed read it from the same source`), { failureCode: "baseline_required" });
    if (!(Array.isArray(baseline.files) || baseline.files instanceof Map) || !object(baseline.parent)) throw new Error("The feed baseline must be a published parent source snapshot");
    const mismatch = sameIdentity(baseline.parent, parent);
    if (mismatch.length) throw Object.assign(new Error(`The feed baseline is not the release .timds/parent.json records (${parent.systemId} ${parent.version} at ${parent.commit}); its ${mismatch.join(", ")} differ${mismatch.length === 1 ? "s" : ""}`), { failureCode: "parent_mismatch" });
    const baselineFiles = decodeOffshootSource(baseline);
    recordedFiles = stockHashes(baselineFiles, await declaredStock(baselineFiles));
  }
  const declared = await declaredStock(sourceFiles);
  // Plumbing stays the toolkit's even where the parent also declares the path
  // as stock: the source is accepted, the path is reported, and it is never
  // written into the child or recorded as fed stock.
  const declaredPlumbing = (declared?.paths ?? []).filter((relative) => isPlumbingPath(relative));
  const stockPaths = (declared?.paths ?? []).filter((relative) => !isPlumbingPath(relative));
  const manifest = sourceJson(sourceFiles, "timds.json");
  if (manifest?.systemId !== identity.systemId || manifest?.version !== identity.version) throw Object.assign(new Error("The parent source identity or version disagrees with its release"), { failureCode: "parent_mismatch" });
  const rawSite = sourceJson(sourceFiles, STARTER_SITE_FILE);
  const formats = sourceJson(sourceFiles, STARTER_FORMATS_FILE, false);
  // Reuse the contract validator to reject malformed source identity/catalogs
  // before either the planner or a target write sees them.
  validateParentRecord({ schemaVersion: 1, ...identity, mode: parent.mode, baseline: { site: rawSite, formats } });
  const site = parent.mode === "structure" ? structureSite(rawSite) : rawSite;
  // Fed stock never includes toolkit plumbing, whatever an earlier record held.
  const nextStockFiles = Object.fromEntries(Object.entries(recordedFiles).filter(([relative]) => !isPlumbingPath(relative)));
  const nextParent = { ...parent, version: identity.version, commit: identity.commit, baseline: { site, formats }, files: nextStockFiles };
  const files = [], writes = [];
  const plan = async (relative, content, status, note, desiredMode) => {
    const file = await targetPath(designSystemRoot, relative);
    const current = await optionalBytes(file);
    const originalMode = current === null ? null : (await fs.stat(file)).mode & 0o777;
    const mode = desiredMode ?? originalMode ?? 0o644;
    const modeChanged = content !== null && mode !== originalMode;
    const changed = content !== null && (current === null || !current.equals(Buffer.from(content)) || modeChanged);
    if (!changed && status === "updated") status = "current";
    if (modeChanged && current !== null && status === "current") status = "updated";
    files.push({ path: relative, status, ...(note ? { note } : {}) });
    if (changed) writes.push({ file, relative, current, content, mode, originalMode });
  };
  // Declared stock follows the parent while the child's copy still equals the
  // bytes last written for it. Anything else is the child's graft: kept, and
  // reported as shading the parent only when the parent's bytes moved.
  const stock = [], grafts = [], createdPages = new Set();
  for (const relative of stockPaths) {
    const bytes = sourceFiles.get(relative);
    const parentHash = sha256(bytes);
    const recorded = recordedFiles[relative];
    const file = await targetPath(designSystemRoot, relative);
    const current = await optionalBytes(file);
    const shades = parentHash !== recorded;
    let status, note;
    if (current === null && recorded === undefined) {
      status = "created";
      nextStockFiles[relative] = parentHash;
      const id = stockPageId(relative);
      if (id) createdPages.add(id);
      await plan(relative, bytes, status, undefined, 0o644);
    } else if (current === null) {
      status = "customized";
      note = "removed in this system; a graft, never recreated";
      grafts.push({ path: relative, shades, removed: true, note });
      await plan(relative, null, status, note);
    } else {
      const currentHash = sha256(current);
      if (currentHash === parentHash) {
        status = "current";
        nextStockFiles[relative] = parentHash;
        await plan(relative, null, status);
      } else if (currentHash === recorded) {
        status = "updated";
        nextStockFiles[relative] = parentHash;
        await plan(relative, bytes, status);
      } else {
        status = "customized";
        note = shades ? "your graft; kept over the parent's change" : "your graft; kept";
        // A graft first met without a recorded hash (the child authored the
        // path before the parent declared it) remembers the parent's bytes it
        // was offered, so a later deletion stays a removed graft.
        if (recorded === undefined) nextStockFiles[relative] = parentHash;
        grafts.push({ path: relative, shades, note });
        await plan(relative, null, status, note);
      }
    }
    stock.push({ path: relative, status, ...(note ? { note } : {}) });
  }
  // A path the parent declares as stock that is toolkit plumbing: reported,
  // never written, never recorded.
  const plumbingNote = "toolkit plumbing: the parent declares it as stock, but feed never writes plumbing (only upgrade does), so it was not fed";
  for (const relative of declaredPlumbing) {
    const entry = { path: relative, status: "skipped", note: plumbingNote };
    stock.push(entry);
    files.push({ ...entry });
  }
  const currentSite = JSON.parse(await fs.readFile(await regularPath(designSystemRoot, STARTER_SITE_FILE), "utf8"));
  const findPage = (model, id) => {
    for (const view of Array.isArray(model?.views) ? model.views : []) {
      const page = (Array.isArray(view?.pages) ? view.pages : []).find((candidate) => (candidate?.slug ? `${view.id}/${candidate.slug}` : view.id) === id);
      if (page) return page;
    }
    return null;
  };
  // A page whose stock fragment the feed creates is authored from then on: the
  // viewer refuses a planned page whose file exists.
  const authoredPages = new Set([...createdPages].filter((id) => findPage(currentSite, id)?.planned === true));
  const merged = mergeSiteModel(currentSite, site, [parent.baseline.site], { authoredPages, fragmentExists: (id) => createdPages.has(id) });
  for (const id of createdPages) {
    // A structure parent's catalog marks every page planned, which the merge
    // copies onto a page it adds; the created fragment un-plans it here.
    const page = findPage(merged.site, id);
    if (page?.planned === true) {
      delete page.planned;
      merged.changes.advanced.push(`${id}.planned`);
    }
  }
  const currentFormatsText = await optional(await targetPath(designSystemRoot, STARTER_FORMATS_FILE));
  const currentFormats = currentFormatsText === null ? null : JSON.parse(currentFormatsText);
  const mergedFormats = formats === null
    ? { catalog: currentFormats, changes: { addedFormats: [], addedGroups: [], advanced: [], kept: [], skipped: [] } }
    : mergeFormatCatalog(currentFormats, formats, [parent.baseline.formats], declaredPageIds(merged.site));
  const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
  await plan(STARTER_SITE_FILE, same(currentSite, merged.site) ? null : formatSiteJson(merged.site), same(currentSite, merged.site) ? "current" : "updated");
  if (formats !== null) await plan(STARTER_FORMATS_FILE, same(currentFormats, mergedFormats.catalog) ? null : formatFormatsJson(mergedFormats.catalog), same(currentFormats, mergedFormats.catalog) ? "current" : currentFormats === null ? "created" : "updated");
  await plan(PARENT_FILE, json(nextParent), "updated");
  const report = { designSystemRoot, parent: nextParent, previousParent: parent, files, written: writes.map((write) => write.relative), site: merged.changes, formats: mergedFormats.changes, stock, grafts, adopted, check: null, record: path.join(designSystemRoot, PARENT_FILE), recordWritten: writes.some((write) => write.relative === PARENT_FILE) };
  if (!writes.length) return report;
  await requireCleanPaths(designSystemRoot, writes.map((write) => write.relative), { message: cleanTreeMessage });
  try {
    for (const write of writes) {
      await fs.mkdir(path.dirname(write.file), { recursive: true });
      await fs.writeFile(write.file, write.content, typeof write.content === "string" ? { encoding: "utf8", mode: write.mode } : { mode: write.mode });
      await fs.chmod(write.file, write.mode);
    }
    if (check) report.check = await check();
  } catch (error) {
    for (const write of writes) {
      if (write.current === null) await fs.rm(write.file, { force: true });
      else {
        await fs.writeFile(write.file, write.current);
        await fs.chmod(write.file, write.originalMode);
      }
    }
    throw Object.assign(new Error(`Feed was rolled back because the workspace update failed: ${error.message}`), typeof error?.failureCode === "string" ? { failureCode: error.failureCode } : {});
  }
  return report;
}

export function describeFeed(report) {
  const lines = [report.written.length ? `New growth from ${report.parent.systemId}: ${report.parent.version}` : `Parent is current: ${report.parent.systemId} ${report.parent.version}`];
  const kept = [...report.site.kept, ...report.formats.kept];
  const ordinary = describeStarterSync({ ...report, site: { ...report.site, kept: [] }, formats: { ...report.formats, kept: [] } });
  lines.push(...ordinary);
  for (const graft of kept) lines.push(`Your graft shades the parent's change at ${graft.path}; kept ${JSON.stringify(graft.current)} (parent: ${JSON.stringify(graft.stock)}). Keep your graft, or edit that field to let the parent through.`);
  for (const entry of report.stock ?? []) {
    if (entry.status === "skipped") lines.push(`Not fed: ${entry.path} is toolkit plumbing; the parent declares it as stock, but feed never writes plumbing (only upgrade does).`);
    if (entry.status !== "created") continue;
    const id = stockPageId(entry.path);
    lines.push(id ? `New stock page from the parent: ${entry.path}, catalog page ${id}.` : `New stock file from the parent: ${entry.path}.`);
  }
  for (const graft of report.grafts ?? []) {
    if (!graft.shades) continue;
    lines.push(graft.removed
      ? `Your graft shades the parent's change at ${graft.path}; removed in this system and kept removed. Accept the parent's version by restoring the file.`
      : `Your graft shades the parent's change at ${graft.path}; kept. Accept the parent's version by editing the file.`);
  }
  if (report.adopted && report.written?.length) lines.push("Adopted stock hashes from the release this system was shot from; later feeds compare against them.");
  return lines;
}
