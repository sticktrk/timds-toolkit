// Local offshoot creation mirrors the host's version-1 source transform.
// Source is an immutable release or Git tree; writing is confined to a new,
// empty destination. Host provisioning, grants and catalog lineage stay
// there. A parent's workspace site (site/) is never carried: it is the
// parent's own website, not part of the system; nor is the guidance its
// scaffold wrote outside site/ (the root consumer skills and the AGENTS.md
// section), removed by the site's record while unedited and otherwise kept
// and reported, since it names the parent's system.
// The parent record names the stock the release shipped, by hash, so feed can
// later refresh it while the child's own edits (grafts) stay. The child keeps
// its parent's toolkit pin, and a CLI older than the running release rejects
// the hashed record: when the child's selected toolkit predates this release,
// shoot omits `files`, leaving a pre-hash record that feed adopts once the
// child is upgraded.
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { cleanPortalUrl, resolveAccessToken, savedPortalUrl } from './auth.mjs';
import { createHostProvider } from './hosted.mjs';
import { isPlumbingPath, readParentRecord, validateParentRecord, validateStockRecord } from './offshoot-contract.mjs';
import { readBlobs } from './git-blobs.mjs';
import { compareDesignSystemVersions } from './changelog.mjs';
import { runtimeIdentity } from './runtime.mjs';
import { belowFloorError, starterBelowFloor } from './starter.mjs';
import {WORKSPACE_SITE_DIRECTORY, WORKSPACE_SITE_MANIFEST, WORKSPACE_SITE_RECORD, WORKSPACE_SITE_SKILL_NAMES, isWorkspaceDesignSystem, WORKSPACE_SITE_AGENTS_MARKER} from './workspace-site.mjs';

const exec = promisify(execFile);
const json = value => `${JSON.stringify(value, null, 2)}\n`;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const MAX_FILE = 10 * 1024 * 1024, MAX_SOURCE = 50 * 1024 * 1024, MAX_FILES = 4000;
const encode = (file, bytes, mode = '100644') => ({path: file, mode, encoding: 'base64', content: Buffer.from(bytes).toString('base64')});
// The marker of the site's section in the system's AGENTS.md, shared with the
// scaffold that writes it (workspace-site.mjs).
const SITE_AGENTS_MARKER = WORKSPACE_SITE_AGENTS_MARKER;
const SITE_AGENTS_FILE = 'AGENTS.md';
const SCAFFOLD_COMMAND = 'timds consumer scaffold emdash --workspace';

/** The site's section in `text` as `[start, end)`, by the scaffold's rule
 * (`agentsSection` in consumer-scaffold-workspace.mjs): from the opening
 * marker through the closing one and its newline, or to the end of the text
 * when it is not closed. Null when there is none. */
function siteSectionRange(text) {
  const start = text.indexOf(`<!-- ${SITE_AGENTS_MARKER} -->`);
  if (start === -1) return null;
  const closing = `<!-- /${SITE_AGENTS_MARKER} -->`, end = text.indexOf(closing, start);
  if (end === -1) return [start, text.length];
  const after = end + closing.length;
  return [start, text[after] === '\n' ? after + 1 : after];
}

/** `text` without `[start, end)` and the blank lines the scaffold put before
 * it; empty when the section was all there was. */
function withoutSiteSection(text, [start, end]) {
  const before = text.slice(0, start).replace(/\n+$/, ''), after = text.slice(end).replace(/^\n+/, '');
  if (!before) return after;
  return after ? `${before}\n\n${after}` : `${before}\n`;
}

/**
 * Remove from `result` the guidance a dropped workspace site's scaffold wrote
 * outside `site/`: the two consumer skills at the repository root and the
 * site's section of the system's AGENTS.md, rendered for the parent's system.
 * The site's record (`site/.timds/emdash.json`, `mode: "workspace"`) names
 * them with their hashes: a skill file whose parent bytes still hash to the
 * recorded value is removed, and the section is cut out while its bytes still
 * match. An edited file or section, a file the record does not list, and any
 * guidance a missing or foreign record cannot vouch for are kept and
 * reported, since the child's scaffold refuses a skill folder it did not
 * write. Record paths are relative to the repository root; the source is the
 * Design System root, so the section's recorded path gives the prefix
 * between them (`design-system/` when embedded), and a path outside the
 * system (the root skills of an embedded system) is not in the source.
 */
function dropSiteGuidance(original, result, parentId) {
  const removed = [], kept = [], notes = [];
  const folders = WORKSPACE_SITE_SKILL_NAMES.map(name => `.agents/skills/${name}/`);
  const inSkillFolder = file => folders.some(folder => file.startsWith(folder));
  let record = null;
  const recordBytes = original.get(`${WORKSPACE_SITE_DIRECTORY}/${WORKSPACE_SITE_RECORD}`);
  try { record = recordBytes && recordBytes.mode !== '120000' ? JSON.parse(recordBytes.toString('utf8')) : null; } catch { record = null; }
  const isMap = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  if (!isMap(record) || record.mode !== 'workspace') {
    const present = [...result.keys()].filter(inSkillFolder);
    const agents = result.get(SITE_AGENTS_FILE);
    if (agents && agents.mode !== '120000' && siteSectionRange(agents.toString('utf8'))) present.push(SITE_AGENTS_FILE);
    for (const file of present.sort()) kept.push({path: file, reason: 'no workspace record'});
    if (present.length) notes.push(`The parent's site/ was not carried, but its record (${WORKSPACE_SITE_DIRECTORY}/${WORKSPACE_SITE_RECORD}) is missing or not a workspace record, so the site guidance outside site/ was kept: ${present.sort().join(', ')}. It may name the parent's system (${parentId}). Remove the consumer skill folders and the <!-- ${SITE_AGENTS_MARKER} --> section before running ${SCAFFOLD_COMMAND} in the offshoot, which refuses a skill folder it did not write.`);
    return {removed, kept, notes};
  }
  const sections = isMap(record.workspaceSections) ? record.workspaceSections : {};
  const agentsKey = Object.keys(sections).find(file => file === SITE_AGENTS_FILE || file.endsWith(`/${SITE_AGENTS_FILE}`));
  const prefix = agentsKey ? agentsKey.slice(0, -SITE_AGENTS_FILE.length) : '';
  const local = file => typeof file === 'string' && file.startsWith(prefix) ? file.slice(prefix.length) : null;
  const recorded = new Map();
  for (const [file, digest] of Object.entries(isMap(record.workspaceFiles) ? record.workspaceFiles : {})) {
    const key = local(file);
    if (key && inSkillFolder(key) && typeof digest === 'string') recorded.set(key, digest);
  }
  for (const [file, digest] of recorded) {
    const bytes = original.get(file);
    if (!result.has(file) || !bytes) continue;
    if (bytes.mode !== '120000' && sha256(bytes) === digest) { result.delete(file); removed.push(file); }
  }
  for (const file of [...result.keys()].filter(inSkillFolder).sort()) kept.push({path: file, reason: recorded.has(file) ? 'edited' : 'not in the record'});
  const section = agentsKey && isMap(sections[agentsKey]) ? sections[agentsKey] : null;
  const agentsFile = agentsKey && local(agentsKey), agents = agentsFile && result.get(agentsFile);
  if (section?.marker === SITE_AGENTS_MARKER && agents && agents.mode !== '120000') {
    const text = agents.toString('utf8'), range = siteSectionRange(text);
    if (range && sha256(text.slice(...range)) === section.sha256) {
      const rest = withoutSiteSection(text, range);
      if (rest) { const bytes = Buffer.from(rest); bytes.mode = agents.mode; result.set(agentsFile, bytes); }
      else result.delete(agentsFile);
      removed.push(`${agentsFile} (the <!-- ${SITE_AGENTS_MARKER} --> section)`);
    } else if (range) kept.push({path: agentsFile, reason: 'edited section'});
  }
  const files = kept.filter(entry => entry.reason !== 'edited section').map(entry => entry.path);
  if (files.length) notes.push(`The parent's site/ was not carried, but these consumer skill files its scaffold installed for ${parentId} were kept because they changed since or were added beside it: ${files.join(', ')}. Remove them (or reconcile their folders) before running ${SCAFFOLD_COMMAND} in the offshoot, which refuses a skill folder it did not write.`);
  if (kept.some(entry => entry.reason === 'edited section')) notes.push(`The parent's site/ was not carried, but the edited <!-- ${SITE_AGENTS_MARKER} --> section of ${agentsFile} was kept. ${SCAFFOLD_COMMAND} leaves an existing section as it is, so remove it (or rewrite it for the offshoot's own site) before or after scaffolding.`);
  return {removed, kept, notes};
}

function sourcePath(file) {
  if (typeof file !== 'string' || !file || file.includes('\\') || /[\x00-\x1f\x7f]/.test(file) || path.posix.isAbsolute(file) || /^[a-z]:/i.test(file) || file.split('/').some(part => !part || part === '.' || part === '..' || ['.git', 'node_modules', 'dist'].includes(part.toLowerCase()) || (/^\.env(?:\.|$)/i.test(part) && part !== '.env.example')) || /^\.timds\/(?:session|auth|start)(?:[./]|$)/i.test(file) || /\.(pem|key|p12|pfx)$/i.test(file)) throw new Error(`Unsafe offshoot source path: ${file}`);
  return file;
}

/** Validate native snapshots as well as decoded exports before using paths. */
function validateSourceFiles(files) {
  if (!(files instanceof Map) || files.size > MAX_FILES) throw new Error('Invalid offshoot source snapshot');
  const portable = new Set();
  let total = 0;
  for (const [file, bytes] of files) {
    const name = sourcePath(file), folded = name.normalize('NFC').toLowerCase();
    if (portable.has(folded) || !Buffer.isBuffer(bytes) || !['100644', '100755', '120000'].includes(bytes.mode)) throw new Error(`Invalid or colliding offshoot source file: ${name}`);
    total += bytes.length;
    if (bytes.length > MAX_FILE || total > MAX_SOURCE) throw new Error('Offshoot source exceeds file limits');
    portable.add(folded);
  }
  for (const [name, bytes] of files) {
    const segments = name.split('/');
    while (segments.length > 1) {
      segments.pop();
      if (portable.has(segments.join('/').normalize('NFC').toLowerCase())) throw new Error(`Conflicting offshoot source path: ${name}`);
    }
    if (bytes.mode !== '120000') continue;
    const target = bytes.toString('utf8');
    if (!target || target.includes('\\') || /[\x00-\x1f\x7f]/.test(target) || path.posix.isAbsolute(target) || /^[a-z]:/i.test(target)) throw new Error(`Unsafe offshoot source link: ${name}`);
    const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(name), target));
    sourcePath(resolved);
    // A symlink may reference a directory, but never another link: this keeps
    // chained and case-folded escapes out of a newly written source tree.
    const parts = resolved.split('/');
    for (let count = 1; count <= parts.length; count++) if (files.get(parts.slice(0, count).join('/'))?.mode === '120000') throw new Error(`Chained offshoot source link: ${name}`);
    if (!files.has(resolved) && ![...files.keys()].some(file => file.startsWith(`${resolved}/`))) throw new Error(`Missing offshoot source link target: ${name}`);
  }
  return files;
}

/** Decode public wire snapshots once; internal Maps still receive all guards. */
export function decodeOffshootSource(source) {
  if (source?.files instanceof Map) return validateSourceFiles(source.files);
  if (!source || !Array.isArray(source.files) || source.files.length > MAX_FILES) throw new Error('Invalid offshoot source snapshot');
  const files = new Map();
  let total = 0;
  for (const file of source.files) {
    const name = sourcePath(file.path);
    if (files.has(name) || file.encoding !== 'base64' || typeof file.content !== 'string' || file.content.length > Math.ceil(MAX_FILE / 3) * 4) throw new Error(`Invalid or colliding offshoot source file: ${name}`);
    const bytes = Buffer.from(file.content, 'base64');
    total += bytes.length;
    if (bytes.toString('base64') !== file.content || bytes.length > MAX_FILE || total > MAX_SOURCE) throw new Error('Offshoot source exceeds file limits or has invalid encoding');
    bytes.mode = file.mode;
    files.set(name, bytes);
  }
  return validateSourceFiles(files);
}

const encodedFiles = files => [...files].map(([file, bytes]) => encode(file, bytes, bytes.mode));

function parse(files, file, required = true) {
  const bytes = files.get(file);
  if (!bytes) { if (!required) return null; throw new Error(`Offshoot source requires ${file}`); }
  if (bytes.mode === '120000') throw new Error(`Offshoot catalog cannot be a symbolic link: ${file}`);
  let value;
  try { value = JSON.parse(bytes.toString('utf8')); } catch { throw new Error(`Invalid offshoot source JSON: ${file}`); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Offshoot source needs an object: ${file}`);
  return value;
}

/** A release's validated `.timds/stock.json`: exact regular files it ships. */
export async function declaredStock(files) {
  const stock = parse(files, '.timds/stock.json', false);
  if (!stock) return null;
  await validateStockRecord(stock);
  for (const file of stock.paths) if (!files.has(file) || files.get(file).mode === '120000') throw new Error(`Stock must name an existing regular source file: ${file}`);
  return stock;
}

/**
 * SHA-256 of each declared stock file's source bytes; `{}` when none is
 * declared. A declared path that is toolkit plumbing is never fed stock, so it
 * has no stock hash.
 */
export function stockHashes(files, stock) {
  return Object.fromEntries((stock?.paths || []).filter(file => !isPlumbingPath(file)).map(file => [file, sha256(files.get(file))]));
}

function toolkitVersionFrom(lockText, installationText, label) {
  const read = (text, file) => {
    if (text === null || text === undefined) return null;
    try { return JSON.parse(text); } catch { throw new Error(`${label} ${file} is invalid JSON`); }
  };
  const lock = read(lockText, 'package-lock.json');
  const locked = lock?.packages?.[`node_modules/${runtimeIdentity.name}`]?.version ?? lock?.dependencies?.[runtimeIdentity.name]?.version;
  if (locked !== undefined) return String(locked);
  const installation = read(installationText, '.timds/installation.json');
  if (installation?.version !== undefined) return String(installation.version);
  return null;
}

/** The toolkit version a source tree selects: its package-lock.json entry for
 * the toolkit, else `.timds/installation.json` `version`, else null (the
 * running release is assumed). */
export function selectedToolkitVersion(files) {
  const text = file => { const bytes = files.get(file); return bytes && bytes.mode !== '120000' ? bytes.toString('utf8') : null; };
  return toolkitVersionFrom(text('package-lock.json'), text('.timds/installation.json'), 'The offshoot source');
}

/** The same selection read from a working tree. */
export async function selectedToolkitVersionIn(directory) {
  const text = async file => {
    try { return await fs.readFile(path.join(directory, file), 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  };
  return toolkitVersionFrom(await text('package-lock.json'), await text('.timds/installation.json'), 'This system');
}

/** True when a selected toolkit version is older than the running release; an
 * unparsable version counts as older, and null (nothing selected) does not. */
export function predatesRunningToolkit(version) {
  if (version === null) return false;
  try { return compareDesignSystemVersions(version, runtimeIdentity.version) < 0; }
  catch { return true; }
}

/** The host's structure baseline deliberately contains no authored summaries. */
export function structureSite(site) {
  return {views: (site.views || []).map(view => ({id: view.id, label: view.label, pages: (view.pages || []).map(page => ({slug: page.slug || '', title: page.title, ...(page.group ? {group: page.group} : {}), ...(page.layout === 'landing' ? {layout: 'landing'} : {}), ...(typeof page.promote === 'string' || page.promote === true ? {promote: page.promote} : {}), planned: true}))}))};
}
function placeholderTokens(tokens) {
  return Object.fromEntries(Object.entries(tokens).filter(([, value]) => value && typeof value === 'object' && !Array.isArray(value)).map(([key, value]) => [key, Object.hasOwn(value, 'value') || Object.hasOwn(value, '$value') ? {value: 'initial'} : placeholderTokens(value)]));
}
const neutralLayout = '<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>{{title}} · {{name}}</title><link rel="stylesheet" href="/tokens.css"><link rel="stylesheet" href="/styles/system.css"><link rel="stylesheet" href="/styles/viewer.css"></head><body><header><a href="/">{{name}}</a><nav>{{views}}</nav></header><nav>{{sidenav}}</nav><main>{{content}}{{pagenav}}</main></body></html>\n';

/** Pure transform, keeping full and structure creation testable without a host. */
async function transformDecodedOffshoot(source, {mode = 'full', systemId, name} = {}) {
  if (!['full', 'structure'].includes(mode)) throw new Error('Offshoot mode must be full or structure');
  if (typeof systemId !== 'string' || !/^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*$/.test(systemId) || systemId.length > 160 || systemId === source.parent?.systemId) throw new Error('Choose a new, lowercase URL-safe --system-id of at most 160 characters for the offshoot');
  if (name !== undefined && (typeof name !== 'string' || !name.trim() || name.length > 200)) throw new Error('Offshoot name must be between 1 and 200 characters');
  const original = decodeOffshootSource(source), manifest = parse(original, 'timds.json');
  const site = parse(original, 'src/site.json'), formats = parse(original, 'src/formats.json', false);
  // A parent from before starter levels is regenerated first; nothing is shot from it.
  if (starterBelowFloor(parse(original, '.timds/starter.json', false))) throw belowFloorError(`The parent release ${source.parent?.systemId} ${source.parent?.version}`);
  const baseline = {site: mode === 'structure' ? structureSite(site) : site, formats};
  const {systemId: parentId, sourceId, version, commit} = source.parent || {};
  const parent = validateParentRecord({schemaVersion: 1, systemId: parentId, sourceId, version, commit, mode, baseline});
  if (manifest.systemId !== parent.systemId || manifest.version !== parent.version) throw new Error('The parent source identity or version disagrees with its release');
  const stock = await declaredStock(original);
  let result = new Map(original);
  // A workspace site (site/ with a workspace-form consumer manifest) is the
  // parent's own website, a separate package that names the parent's system:
  // an offshoot is a new system and starts without it.
  const siteManifest = original.get(`${WORKSPACE_SITE_DIRECTORY}/${WORKSPACE_SITE_MANIFEST}`);
  let parsedSiteManifest = null;
  try { parsedSiteManifest = siteManifest && siteManifest.mode !== '120000' ? JSON.parse(siteManifest.toString('utf8')) : null; } catch { parsedSiteManifest = null; }
  const dropsSite = isWorkspaceDesignSystem(parsedSiteManifest);
  if (dropsSite) for (const file of [...result.keys()]) if (file.startsWith(`${WORKSPACE_SITE_DIRECTORY}/`)) result.delete(file);
  const set = (file, bytes) => { const content = Buffer.from(bytes); content.mode = '100644'; result.set(file, content); };
  if (mode === 'structure') {
    const starter = parse(original, '.timds/starter.json');
    if (starter.schemaVersion !== 1 || starter.plumbing !== 'toolkit' || !starter.files || typeof starter.files !== 'object' || Array.isArray(starter.files)) throw new Error('Structure offshoots require recorded toolkit plumbing');
    result = new Map();
    for (const [file, digest] of Object.entries(starter.files)) {
      if (!isPlumbingPath(file)) continue;
      const bytes = original.get(file);
      if (!bytes || bytes.mode === '120000' || sha256(bytes) !== digest) throw new Error(`The parent has customized toolkit plumbing: ${file}`);
      result.set(file, bytes);
    }
    for (const file of ['scripts/build.mjs', 'scripts/check.mjs', 'scripts/dev.mjs']) if (!result.has(file)) throw new Error(`Structure offshoots require recorded ${file}`);
    for (const file of ['package.json', 'package-lock.json', '.timds/installation.json', '.timds/contract-layout.json', 'cloudflare.config.ts', 'vite.config.mjs', '.gitignore']) if (original.has(file)) result.set(file, original.get(file));
    if (original.has('.timds/installation.json')) set('.timds/installation.json', json({schemaVersion: 1, name: '@dtconcepts/timds', version: starter.version}));
    for (const file of stock?.paths || []) result.set(file, original.get(file));
    const planned = structureSite(site);
    for (const view of planned.views) for (const page of view.pages) page.planned = !result.has(`src/pages/${view.id}/${page.slug ? `${page.slug}.html` : 'index.html'}`);
    set('src/site.json', json(planned));
    if (formats) set('src/formats.json', json(formats));
    for (const file of original.keys()) if (file === 'tokens.json' || /^tokens\/.+\.json$/.test(file)) set(file, json(placeholderTokens(parse(original, file))));
    if (!result.has('tokens.json')) throw new Error('Structure offshoots require tokens.json');
    if (!result.has('src/layout.html')) set('src/layout.html', neutralLayout);
    if (!result.has('src/styles/system.css')) set('src/styles/system.css', '/* Replace placeholder tokens and author the system styles. */\n');
    if (!result.has('src/pages/index.html')) set('src/pages/index.html', '<h1>{{name}}</h1><p>Design System structure. Author the planned pages and replace placeholder tokens.</p>\n{{sitemap}}\n');
    set('media.json', '{"schemaVersion":2,"assets":[]}\n'); set('media/assets.json', '{}\n');
    set('CHANGELOG.md', `# Changelog\n\n## Unreleased\n\n## ${manifest.version}\n\n- Initial structure.\n`);
    // The toolkit and parent feed have independent three-way merge baselines.
    // Retain the toolkit baseline so severing cannot adopt parent edits as stock.
    set('.timds/starter.json', original.get('.timds/starter.json'));
    set('timds.json', json({schemaVersion: manifest.schemaVersion, systemId, name: name || `${manifest.name} offshoot`, description: 'Design System structure with placeholder foundations.', version: manifest.version, artifact: manifest.artifact, workspace: {dev: ['node', 'scripts/dev.mjs'], build: ['node', 'scripts/build.mjs'], check: ['node', 'scripts/check.mjs']}, bundle: {include: ['dist/tokens.css', 'dist/styles/system.css']}, brand: {roles: manifest.brand?.roles || {}}}));
  }
  // The site's guidance outside site/ names the parent's system too; it goes
  // with the site unless edited (structure has already left it out).
  const siteGuidance = dropsSite ? dropSiteGuidance(original, result, parent.systemId) : null;
  const current = parse(result, 'timds.json');
  current.systemId = systemId; current.name = name || `${manifest.name} offshoot`; current.provider = {kind: 'local'};
  delete current.sourceId;
  set('timds.json', json(current));
  const packageName = systemId.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  for (const file of ['package.json', 'package-lock.json']) {
    const pkg = parse(result, file, file !== 'package-lock.json');
    if (!pkg) continue;
    pkg.name = packageName; if (file === 'package-lock.json' && pkg.packages?.['']) pkg.packages[''].name = packageName;
    if (mode === 'structure' && file === 'package.json') {
      for (const key of Object.keys(pkg)) if (!['name', 'version', 'type', 'private', 'dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'peerDependenciesMeta', 'overrides', 'engines'].includes(key)) delete pkg[key];
      pkg.private = true; pkg.scripts = {timds: 'timds', 'build:preview': 'npm run timds -- check'};
    }
    set(file, json(pkg));
  }
  if (result.has('cloudflare.config.ts')) set('cloudflare.config.ts', result.get('cloudflare.config.ts').toString('utf8').replace(/name\s*:\s*["'][^"']+["']/, `name:${JSON.stringify(packageName)}`));
  // The record remembers the bytes of every stock file this release shipped, so
  // a later feed tells an unmodified copy from the child's graft. Only a child
  // whose selected toolkit reads that key receives it.
  if (!predatesRunningToolkit(selectedToolkitVersion(result))) parent.files = stockHashes(original, stock);
  set('.timds/parent.json', json(parent));
  return {parent, files: validateSourceFiles(result), ...(siteGuidance ? {siteGuidance} : {})};
}

/** Public transforms retain the wire export shape; creation keeps native bytes. */
export async function transformOffshoot(source, options = {}) {
  const result = await transformDecodedOffshoot(source, options);
  return {...result, files: encodedFiles(result.files)};
}

/** Read exact Git bytes; a dirty worktree cannot change the chosen parent. */
async function localSource(directory, options) {
  const git = async args => (await exec('git', ['-C', directory, ...args], {encoding: 'buffer', maxBuffer: MAX_SOURCE * 2})).stdout;
  const commit = (await git(['rev-parse', '--verify', '--end-of-options', `${options.ref || 'HEAD'}^{commit}`])).toString().trim();
  const tree = (await git(['ls-tree', '-rzl', '--full-tree', commit])).toString('utf8').split('\0').filter(Boolean);
  if (tree.length > MAX_FILES) throw new Error('Offshoot source has too many files');
  const records = []; let total = 0;
  for (const entry of tree) {
    const match = /^(\d+) (\w+) ([a-f0-9]{40}) +([0-9]+|-)\t([\s\S]+)$/.exec(entry);
    if (!match || match[2] !== 'blob') throw new Error('Offshoot source cannot contain submodules');
    const [, mode, , hash, sizeText, file] = match;
    sourcePath(file);
    const size = Number(sizeText);
    total += size;
    if (!Number.isSafeInteger(size) || size > MAX_FILE || total > MAX_SOURCE) throw new Error('Offshoot source exceeds file limits');
    records.push({file, hash, mode, size});
  }
  const blobs = readBlobs(directory, records.map(record => record.hash), {maxBytes: MAX_SOURCE, maxBlobBytes: MAX_FILE});
  const files = new Map(records.map(({file, hash, mode, size}) => {
    const blob = blobs.get(hash);
    if (!blob || blob.length !== size) throw new Error(`Offshoot source blob disagrees with its tree: ${file}`);
    const bytes = Buffer.from(blob); bytes.mode = mode;
    return [file, bytes];
  }));
  const manifest = parse(decodeOffshootSource({files}), 'timds.json');
  if (options.version && options.version !== 'latest' && options.version !== manifest.version) throw new Error('The local Git revision does not declare the requested version; select it with --ref');
  if (!options.sourceId && !manifest.sourceId) throw new Error('A local parent needs --source-id UUID (the source identity); --ref selects its immutable Git revision');
  return {parent: {systemId: manifest.systemId, sourceId: options.sourceId || manifest.sourceId, version: manifest.version, commit}, files};
}

/** Read a published source export (the JSON a release's source route returns)
 * that a host materialised on disk. Bounded like a fetched export; decoding
 * and path validation happen in decodeOffshootSource. */
export async function readOffshootSourceFile(file, label = '--source-file') {
  const limit = Math.ceil(MAX_SOURCE / 3) * 4 + MAX_FILES * 4096;
  const handle = await fs.open(path.resolve(file), 'r').catch(error => { if (error.code === 'ENOENT') throw new Error(`${label} names a missing file: ${file}`); throw error; });
  let text;
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error(`${label} must be a regular file: ${file}`);
    if (info.size > limit) throw new Error(`${label} exceeds the offshoot source export limit: ${file}`);
    text = await handle.readFile('utf8');
  } finally { await handle.close(); }
  let value;
  try { value = JSON.parse(text); } catch (error) { throw new Error(`${label} is invalid JSON: ${error.message}`); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must contain a source export object`);
  if (value.apiVersion !== undefined && value.apiVersion !== 1) throw new Error(`${label} has unsupported apiVersion ${JSON.stringify(value.apiVersion)}; expected 1`);
  if (!value.parent || typeof value.parent !== 'object' || Array.isArray(value.parent) || !Array.isArray(value.files)) throw new Error(`${label} must contain a parent identity and a files array`);
  const files = decodeOffshootSource(value);
  return {parent: value.parent, files};
}

/** CLI operations retain validated native bytes; public callers receive wire files. */
export async function loadOffshootSource(systemOrPath, options = {}, {decoded = false} = {}) {
  if (typeof systemOrPath !== 'string' || !systemOrPath) throw new Error('Choose a parent system or local Git path');
  const local = options.local === true || path.isAbsolute(systemOrPath) || /^\.{1,2}(?:[\\/]|$)/.test(systemOrPath);
  if (local) {
    const directory = path.resolve(systemOrPath), info = await fs.stat(directory).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (!info?.isDirectory()) throw new Error(`Local parent must be an existing Git directory: ${systemOrPath}`);
    const result = await localSource(directory, options);
    return decoded ? result : {...result, files: encodedFiles(result.files)};
  }
  if (options.ref) throw new Error('--ref applies only to a local parent Git checkout');
  const portalUrl = cleanPortalUrl(options.portalUrl || await savedPortalUrl(options));
  const provider = createHostProvider({url: portalUrl, resolveToken: context => resolveAccessToken(portalUrl, {...options, ...context}), fetchImpl: options.fetchImpl});
  const source = await provider.releaseSource(systemOrPath, options.version || 'latest');
  if (source.parent?.systemId !== systemOrPath || (options.version && options.version !== 'latest' && source.parent?.version !== options.version)) throw new Error('The host returned a different parent release');
  const files = decodeOffshootSource(source);
  return {parent: source.parent, files: decoded ? files : source.files};
}

/** Create all files only after validation, and remove the new tree on failure. */
export async function shootOffshoot({destination, source, mode = 'full', systemId, name, check, output}) {
  const target = path.resolve(destination);
  const existing = await fs.lstat(target).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (existing && (!existing.isDirectory() || existing.isSymbolicLink() || (await fs.readdir(target)).length)) throw new Error('Shoot requires a new or empty --root destination');
  const transformed = await transformDecodedOffshoot(source, {mode, systemId, name});
  await fs.mkdir(target, {recursive: true});
  try {
    for (const [file, bytes] of transformed.files) {
      const output = path.join(target, file);
      await fs.mkdir(path.dirname(output), {recursive: true});
      if (bytes.mode === '120000') await fs.symlink(bytes.toString('utf8'), output);
      else await fs.writeFile(output, bytes, {flag: 'wx', mode: bytes.mode === '100755' ? 0o755 : 0o644});
    }
    // A standalone offshoot owns its repository. This also keeps workspace
    // discovery from walking into the parent's checkout for a nested target.
    await exec('git', ['init', '-q', '-b', 'main', target]);
    if (check) await check(target);
  } catch (error) {
    await fs.rm(target, {recursive: true, force: true});
    if (existing) await fs.mkdir(target);
    throw error;
  }
  // Guidance a dropped site left behind is reported, never silently kept.
  if (output) for (const note of transformed.siteGuidance?.notes || []) output(note);
  return {designSystemRoot: target, parent: transformed.parent, files: [...transformed.files.keys()], ...(transformed.siteGuidance ? {siteGuidance: transformed.siteGuidance} : {})};
}

export async function severOffshoot(root, {confirmed = false} = {}) {
  const parent = await readParentRecord(root);
  if (!parent) throw new Error('This system has no parent to sever');
  if (await fs.lstat(path.join(root, '.timds/session.json')).catch(error => { if (error.code === 'ENOENT') return null; throw error; })) throw new Error('Offshoot lineage cannot be severed in a hosted session');
  if (!confirmed) throw new Error('Sever permanently removes the parent feed baseline. Confirm with timds sever --yes');
  await fs.unlink(path.join(root, '.timds/parent.json'));
  return {parent, severed: true};
}
