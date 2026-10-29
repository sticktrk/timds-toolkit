// A parent supplies an offshoot's structural stock. Feeding reuses the starter's
// three-way catalog merge and plumbing ownership, and never copies authored
// source: a page, system stylesheet, layout, token or media remains the child's.
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { promisify } from "node:util";
import { readParentRecord, validateParentRecord } from "./offshoot-contract.mjs";
import { decodeOffshootSource, structureSite } from "./offshoots.mjs";
import { compareDesignSystemVersions, parseDesignSystemVersion } from "./changelog.mjs";
import {
  STARTER_RECORD_FILE, STARTER_SITE_FILE, STARTER_FORMATS_FILE,
  declaredPageIds, describeStarterSync, formatFormatsJson, formatSiteJson,
  mergeFormatCatalog, mergeSiteModel, planStockFile, readStarterRecord,
} from "./starter.mjs";

const invoke = promisify(execFile);
const PARENT_FILE = ".timds/parent.json";
const plumbingPath = (value) => /^(?:scripts\/[a-z0-9.-]+\.mjs|src\/styles\/(?:viewer|canvas)\.css)$/.test(value);
const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

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

async function safeTarget(root, relative) {
  const segments = relative.split("/");
  let current = root;
  for (const segment of ["", ...segments]) {
    if (segment) current = path.join(current, segment);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) throw new Error(`Feed cannot write through a symbolic link: ${relative}`);
      if (current === path.join(root, relative) && !stat.isFile()) throw new Error(`Feed target must be a regular file: ${relative}`);
    } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  return path.join(root, relative);
}

async function requireClean(root, relatives) {
  root = await fs.realpath(root);
  let toplevel;
  try { toplevel = (await invoke("git", ["rev-parse", "--show-toplevel"], { cwd: root })).stdout.trim(); }
  catch (error) { if (error.code === 128) return; throw error; }
  const paths = relatives.map((relative) => path.relative(toplevel, path.join(root, relative)).split(path.sep).join("/"));
  const { stdout } = await invoke("git", ["--literal-pathspecs", "status", "--porcelain", "--untracked-files=all", "--", ...paths], { cwd: toplevel });
  if (stdout.trim()) throw new Error(`Feed refuses to run over uncommitted changes to the files it writes:\n${stdout.trim()}\nCommit or stash them first`);
}

/** Feed a verified published source snapshot (the same shape as source export).
 * Only catalogs, recorded plumbing and the two bookkeeping records are written.
 * `force` names plumbing paths; it never reaches authored source. */
export async function feedOffshoot({ designSystemRoot, source, check = null, force = [], decideCustomized = null }) {
  const parent = await readParentRecord(designSystemRoot);
  if (!parent) throw new Error("This system has no .timds/parent.json; only an offshoot can be fed");
  if (await optional(path.join(designSystemRoot, ".timds/session.json"))) throw new Error("Feed is not available in a hosted session; feed the source repository instead");
  if (!source || !Array.isArray(source.files) || !object(source.parent)) throw new Error("Feed requires a published parent source snapshot");
  const identity = source.parent;
  if (identity.systemId !== parent.systemId || identity.sourceId !== parent.sourceId) throw new Error("The source snapshot belongs to a different parent system or source");
  if (parseDesignSystemVersion(identity.version) && parseDesignSystemVersion(parent.version) && compareDesignSystemVersions(identity.version, parent.version) < 0) throw new Error(`Feed requires a parent release at or after ${parent.version}; ${identity.version} is older`);
  const sourceFiles = decodeOffshootSource(source);
  const manifest = sourceJson(sourceFiles, "timds.json");
  if (manifest?.systemId !== identity.systemId || manifest?.version !== identity.version) throw new Error("The parent source identity or version disagrees with its release");
  const rawSite = sourceJson(sourceFiles, STARTER_SITE_FILE);
  const formats = sourceJson(sourceFiles, STARTER_FORMATS_FILE, false);
  // Reuse the contract validator to reject malformed source identity/catalogs
  // before either the planner or a target write sees them.
  validateParentRecord({ schemaVersion: 1, ...identity, mode: parent.mode, baseline: { site: rawSite, formats } });
  const site = parent.mode === "structure" ? structureSite(rawSite) : rawSite;
  const nextParent = { ...parent, version: identity.version, commit: identity.commit, baseline: { site, formats } };
  const record = await readStarterRecord(designSystemRoot);
  const stockRecord = sourceJson(sourceFiles, STARTER_RECORD_FILE, false);
  if (parent.mode === "structure" && (stockRecord?.schemaVersion !== 1 || stockRecord.plumbing !== "toolkit" || !object(stockRecord.files))) throw new Error("Structure feed requires recorded toolkit plumbing in the parent");
  const stockFiles = object(stockRecord?.files) ? stockRecord.files : {};
  const selected = Object.keys(stockFiles).filter(plumbingPath);
  if (force.some((relative) => !selected.includes(relative))) throw new Error("Feed --force replaces only named plumbing files in the parent's recorded stock; authored content is never replaced");
  const plumbing = record?.plumbing ?? "recorded";
  const files = [], writes = [], pendingCustomized = [], nextFiles = { ...record?.files };
  const plan = async (relative, content, status, note, desiredMode) => {
    const file = await safeTarget(designSystemRoot, relative);
    const current = await optional(file);
    const originalMode = current === null ? null : (await fs.stat(file)).mode & 0o777;
    const mode = desiredMode ?? originalMode ?? 0o644;
    const modeChanged = content !== null && mode !== originalMode;
    if (modeChanged && current !== null && status === "current") status = "updated";
    const reported = { path: relative, status, ...(note ? { note } : {}) };
    const reportedIndex = files.findIndex((entry) => entry.path === relative);
    if (reportedIndex === -1) files.push(reported);
    else files[reportedIndex] = reported;
    const writeIndex = writes.findIndex((entry) => entry.relative === relative);
    if (writeIndex !== -1) writes.splice(writeIndex, 1);
    if (content !== null && (content !== current || modeChanged)) {
      writes.push({ file, relative, current, content, mode, originalMode });
    }
  };
  for (const relative of selected) {
    const entry = sourceFiles.get(relative);
    const verified = entry && ["100644", "100755"].includes(entry.mode) && sha256(entry) === stockFiles[relative];
    if (!verified) {
      if (parent.mode === "structure") throw new Error(`The parent has customized recorded plumbing: ${relative}`);
      if (force.includes(relative)) throw new Error(`Feed --force cannot replace authored parent plumbing: ${relative}; only verified stock plumbing may be copied`);
      // Full offshoots may start with an authored build engine. Its stale
      // starter hash does not turn that source back into replaceable stock,
      // and it must not prevent the parent's catalogs from feeding.
      files.push({ path: relative, status: "customized", note: "the parent's authored plumbing; never copied, --force included" });
      continue;
    }
    const bytes = entry;
    await safeTarget(designSystemRoot, relative);
    const desired = bytes.toString("utf8");
    const planned = await planStockFile(path.join(designSystemRoot, relative), desired, { force: plumbing === "toolkit" || force.includes(relative), knownHashes: [record?.files?.[relative]].filter(Boolean) });
    const note = planned.forced ? (plumbing === "toolkit" ? "the toolkit's plumbing; a local change was replaced" : "replaced with --force") : undefined;
    if (planned.status === "customized" && decideCustomized) {
      pendingCustomized.push({ relative, entry, desired, planned });
    }
    if (planned.status !== "customized") nextFiles[relative] = stockFiles[relative];
    await plan(relative, planned.write || planned.status === "current" ? desired : null, planned.status, note, entry.mode === "100755" ? 0o755 : 0o644);
  }
  const currentSite = JSON.parse(await fs.readFile(await safeTarget(designSystemRoot, STARTER_SITE_FILE), "utf8"));
  const merged = mergeSiteModel(currentSite, site, [parent.baseline.site]);
  const currentFormatsText = await optional(await safeTarget(designSystemRoot, STARTER_FORMATS_FILE));
  const currentFormats = currentFormatsText === null ? null : JSON.parse(currentFormatsText);
  const mergedFormats = formats === null
    ? { catalog: currentFormats, changes: { addedFormats: [], addedGroups: [], advanced: [], kept: [], skipped: [] } }
    : mergeFormatCatalog(currentFormats, formats, [parent.baseline.formats], declaredPageIds(merged.site));
  const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
  await plan(STARTER_SITE_FILE, same(currentSite, merged.site) ? null : formatSiteJson(merged.site), same(currentSite, merged.site) ? "current" : "updated");
  if (formats !== null) await plan(STARTER_FORMATS_FILE, same(currentFormats, mergedFormats.catalog) ? null : formatFormatsJson(mergedFormats.catalog), same(currentFormats, mergedFormats.catalog) ? "current" : currentFormats === null ? "created" : "updated");
  if (record) await plan(STARTER_RECORD_FILE, json({ ...record, files: nextFiles }), "updated");
  await plan(PARENT_FILE, json(nextParent), "updated");
  if (pendingCustomized.length) {
    // Decide only after the whole plan is known. A customized script and a
    // changed record hash are prospective writes even when the eventual
    // answer is keep; unrelated authored files are never part of this guard.
    const prospective = new Set([...writes.map((write) => write.relative), ...pendingCustomized.map(({ relative }) => relative)]);
    if (record && pendingCustomized.some(({ relative }) => nextFiles[relative] !== stockFiles[relative])) prospective.add(STARTER_RECORD_FILE);
    await requireClean(designSystemRoot, [...prospective]);
    for (const { relative, entry, desired, planned } of pendingCustomized) {
      const preview = await fs.mkdtemp(path.join(os.tmpdir(), "timds-feed-diff-"));
      const templatePath = path.join(preview, path.basename(relative));
      let choice;
      try {
        await fs.writeFile(templatePath, desired, "utf8");
        choice = await decideCustomized({ current: planned.current, desired, file: path.join(designSystemRoot, relative), path: relative, templatePath });
      } finally { await fs.rm(preview, { recursive: true, force: true }); }
      if (choice === "replace") {
        nextFiles[relative] = stockFiles[relative];
        await plan(relative, desired, "updated", "replaced at the prompt", entry.mode === "100755" ? 0o755 : 0o644);
      } else await plan(relative, null, "customized", "kept at the prompt");
    }
    if (record) await plan(STARTER_RECORD_FILE, json({ ...record, files: nextFiles }), "updated");
  }
  const report = { designSystemRoot, parent: nextParent, previousParent: parent, files, written: writes.map((write) => write.relative), site: merged.changes, formats: mergedFormats.changes, plumbing, check: null, record: path.join(designSystemRoot, PARENT_FILE), recordWritten: writes.some((write) => write.relative === PARENT_FILE) };
  if (!writes.length) return report;
  await requireClean(designSystemRoot, writes.map((write) => write.relative));
  try {
    for (const write of writes) {
      await fs.mkdir(path.dirname(write.file), { recursive: true });
      await fs.writeFile(write.file, write.content, { encoding: "utf8", mode: write.mode });
      await fs.chmod(write.file, write.mode);
    }
    if (check) report.check = await check();
  } catch (error) {
    for (const write of writes) {
      if (write.current === null) await fs.rm(write.file, { force: true });
      else {
        await fs.writeFile(write.file, write.current, "utf8");
        await fs.chmod(write.file, write.originalMode);
      }
    }
    throw new Error(`Feed was rolled back because the workspace update failed: ${error.message}`);
  }
  return report;
}

export function describeFeed(report) {
  const lines = [report.written.length ? `New growth from ${report.parent.systemId}: ${report.parent.version}` : `Parent is current: ${report.parent.systemId} ${report.parent.version}`];
  const kept = [...report.site.kept, ...report.formats.kept];
  const ordinary = describeStarterSync({ ...report, site: { ...report.site, kept: [] }, formats: { ...report.formats, kept: [] } });
  lines.push(...ordinary);
  for (const graft of kept) lines.push(`Your graft shades the parent's change at ${graft.path}; kept ${JSON.stringify(graft.current)} (parent: ${JSON.stringify(graft.stock)}). Keep your graft, or edit that field to let the parent through.`);
  return lines;
}
