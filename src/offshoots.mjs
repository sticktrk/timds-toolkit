// Local offshoot creation mirrors the host's version-1 source transform.
// Source is an immutable release or Git tree; writing is confined to a new,
// empty destination. Host provisioning, grants and catalog lineage stay there.
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { cleanPortalUrl, resolveAccessToken, savedPortalUrl } from './auth.mjs';
import { createHostProvider } from './hosted.mjs';
import { readParentRecord, validateParentRecord, validateStockRecord } from './offshoot-contract.mjs';
import { readBlobs } from './git-blobs.mjs';

const exec = promisify(execFile);
const json = value => `${JSON.stringify(value, null, 2)}\n`;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const MAX_FILE = 10 * 1024 * 1024, MAX_SOURCE = 50 * 1024 * 1024, MAX_FILES = 4000;
const plumbingPath = file => /^(?:scripts\/[a-z0-9.-]+\.mjs|src\/styles\/(?:viewer|canvas)\.css)$/.test(file);
const encode = (file, bytes, mode = '100644') => ({path: file, mode, encoding: 'base64', content: Buffer.from(bytes).toString('base64')});

function sourcePath(file) {
  if (typeof file !== 'string' || !file || file.includes('\\') || /[\x00-\x1f\x7f]/.test(file) || path.posix.isAbsolute(file) || /^[a-z]:/i.test(file) || file.split('/').some(part => !part || part === '.' || part === '..' || ['.git', 'node_modules', 'dist'].includes(part.toLowerCase()) || (/^\.env(?:\.|$)/i.test(part) && part !== '.env.example')) || /^\.timds\/(?:session|auth|start)(?:[./]|$)/i.test(file) || /\.(pem|key|p12|pfx)$/i.test(file)) throw new Error(`Unsafe offshoot source path: ${file}`);
  return file;
}

/** Decode and bound untrusted host exports before using any of their paths. */
export function decodeOffshootSource(source) {
  if (!source || !Array.isArray(source.files) || source.files.length > MAX_FILES) throw new Error('Invalid offshoot source snapshot');
  const files = new Map(), portable = new Set();
  let total = 0;
  for (const file of source.files) {
    const name = sourcePath(file.path), folded = name.normalize('NFC').toLowerCase();
    if (portable.has(folded) || file.encoding !== 'base64' || typeof file.content !== 'string' || file.content.length > Math.ceil(MAX_FILE / 3) * 4 || !['100644', '100755', '120000'].includes(file.mode)) throw new Error(`Invalid or colliding offshoot source file: ${name}`);
    const bytes = Buffer.from(file.content, 'base64');
    total += bytes.length;
    if (bytes.toString('base64') !== file.content || bytes.length > MAX_FILE || total > MAX_SOURCE) throw new Error('Offshoot source exceeds file limits or has invalid encoding');
    bytes.mode = file.mode;
    portable.add(folded); files.set(name, bytes);
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

function parse(files, file, required = true) {
  const bytes = files.get(file);
  if (!bytes) { if (!required) return null; throw new Error(`Offshoot source requires ${file}`); }
  if (bytes.mode === '120000') throw new Error(`Offshoot catalog cannot be a symbolic link: ${file}`);
  let value;
  try { value = JSON.parse(bytes.toString('utf8')); } catch { throw new Error(`Invalid offshoot source JSON: ${file}`); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Offshoot source needs an object: ${file}`);
  return value;
}

/** The host's structure baseline deliberately contains no authored summaries. */
export function structureSite(site) {
  return {views: (site.views || []).map(view => ({id: view.id, label: view.label, pages: (view.pages || []).map(page => ({slug: page.slug || '', title: page.title, ...(page.group ? {group: page.group} : {}), planned: true}))}))};
}
function placeholderTokens(tokens) {
  return Object.fromEntries(Object.entries(tokens).filter(([, value]) => value && typeof value === 'object' && !Array.isArray(value)).map(([key, value]) => [key, Object.hasOwn(value, 'value') || Object.hasOwn(value, '$value') ? {value: 'initial'} : placeholderTokens(value)]));
}
const neutralLayout = '<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>{{title}} · {{name}}</title><link rel="stylesheet" href="/tokens.css"><link rel="stylesheet" href="/styles/system.css"><link rel="stylesheet" href="/styles/viewer.css"></head><body><header><a href="/">{{name}}</a><nav>{{views}}</nav></header><nav>{{sidenav}}</nav><main>{{content}}{{pagenav}}</main></body></html>\n';

/** Pure transform, keeping full and structure creation testable without a host. */
export async function transformOffshoot(source, {mode = 'full', systemId, name} = {}) {
  if (!['full', 'structure'].includes(mode)) throw new Error('Offshoot mode must be full or structure');
  if (typeof systemId !== 'string' || !/^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*$/.test(systemId) || systemId.length > 160 || systemId === source.parent?.systemId) throw new Error('Choose a new, lowercase URL-safe --system-id of at most 160 characters for the offshoot');
  if (name !== undefined && (typeof name !== 'string' || !name.trim() || name.length > 200)) throw new Error('Offshoot name must be between 1 and 200 characters');
  const original = decodeOffshootSource(source), manifest = parse(original, 'timds.json');
  const site = parse(original, 'src/site.json'), formats = parse(original, 'src/formats.json', false);
  const baseline = {site: mode === 'structure' ? structureSite(site) : site, formats};
  const parent = validateParentRecord({schemaVersion: 1, ...source.parent, mode, baseline});
  if (manifest.systemId !== parent.systemId || manifest.version !== parent.version) throw new Error('The parent source identity or version disagrees with its release');
  const stock = parse(original, '.timds/stock.json', false);
  if (stock) {
    await validateStockRecord(stock);
    for (const file of stock.paths) if (!original.has(file) || original.get(file).mode === '120000') throw new Error(`Stock must name an existing regular source file: ${file}`);
  }
  let result = new Map(original);
  const set = (file, bytes) => { const content = Buffer.from(bytes); content.mode = '100644'; result.set(file, content); };
  if (mode === 'structure') {
    const starter = parse(original, '.timds/starter.json');
    if (starter.schemaVersion !== 1 || starter.plumbing !== 'toolkit' || !starter.files || typeof starter.files !== 'object' || Array.isArray(starter.files)) throw new Error('Structure offshoots require recorded toolkit plumbing');
    result = new Map();
    for (const [file, digest] of Object.entries(starter.files)) {
      if (!plumbingPath(file)) continue;
      const bytes = original.get(file);
      if (!bytes || bytes.mode === '120000' || sha256(bytes) !== digest) throw new Error(`The parent has customized toolkit plumbing: ${file}`);
      result.set(file, bytes);
    }
    for (const file of ['scripts/build.mjs', 'scripts/check.mjs', 'scripts/dev.mjs', 'scripts/viewer.mjs']) if (!result.has(file)) throw new Error(`Structure offshoots require recorded ${file}`);
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
    set('.timds/starter.json', json({...starter, baseline: {site: planned, formats}}));
    set('timds.json', json({schemaVersion: manifest.schemaVersion, systemId, name: name || `${manifest.name} offshoot`, description: 'Design System structure with placeholder foundations.', version: manifest.version, artifact: manifest.artifact, workspace: {dev: ['node', 'scripts/dev.mjs'], build: ['node', 'scripts/build.mjs'], check: ['node', 'scripts/check.mjs']}, bundle: {include: ['dist/tokens.css', 'dist/styles/system.css']}, brand: {roles: manifest.brand?.roles || {}}}));
  }
  const current = parse(result, 'timds.json');
  current.systemId = systemId; current.name = name || `${manifest.name} offshoot`; current.provider = {kind: 'local'};
  delete current.sourceId;
  set('timds.json', json(current));
  const packageName = systemId.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  for (const file of ['package.json', 'package-lock.json']) {
    const pkg = parse(result, file);
    pkg.name = packageName; if (file === 'package-lock.json' && pkg.packages?.['']) pkg.packages[''].name = packageName;
    if (mode === 'structure' && file === 'package.json') {
      for (const key of Object.keys(pkg)) if (!['name', 'version', 'type', 'private', 'dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'peerDependenciesMeta', 'overrides', 'engines'].includes(key)) delete pkg[key];
      pkg.private = true; pkg.scripts = {timds: 'timds', 'build:preview': 'npm run timds -- check'};
    }
    set(file, json(pkg));
  }
  if (result.has('cloudflare.config.ts')) set('cloudflare.config.ts', result.get('cloudflare.config.ts').toString('utf8').replace(/name\s*:\s*["'][^"']+["']/, `name:${JSON.stringify(packageName)}`));
  set('.timds/parent.json', json(parent));
  const files = [...result].map(([file, bytes]) => encode(file, bytes, bytes.mode));
  decodeOffshootSource({files});
  return {parent, files};
}

/** Read exact Git bytes; a dirty worktree cannot change the chosen parent. */
async function localSource(directory, options) {
  const git = async args => (await exec('git', ['-C', directory, ...args], {encoding: 'buffer', maxBuffer: MAX_SOURCE * 2})).stdout;
  const commit = (await git(['rev-parse', '--verify', `${options.ref || 'HEAD'}^{commit}`])).toString().trim();
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
  const files = records.map(({file, hash, mode, size}) => {
    const bytes = blobs.get(hash);
    if (!bytes || bytes.length !== size) throw new Error(`Offshoot source blob disagrees with its tree: ${file}`);
    return encode(file, bytes, mode);
  });
  const manifest = parse(decodeOffshootSource({files}), 'timds.json');
  if (options.version && options.version !== 'latest' && options.version !== manifest.version) throw new Error('The local Git revision does not declare the requested version; select it with --ref');
  if (!options.sourceId && !manifest.sourceId) throw new Error('A local parent needs --source-id UUID (the source identity); --ref selects its immutable Git revision');
  return {parent: {systemId: manifest.systemId, sourceId: options.sourceId || manifest.sourceId, version: manifest.version, commit}, files};
}

export async function loadOffshootSource(systemOrPath, options = {}) {
  if (typeof systemOrPath !== 'string' || !systemOrPath) throw new Error('Choose a parent system or local Git path');
  const local = options.local === true || path.isAbsolute(systemOrPath) || /^\.{1,2}(?:[\\/]|$)/.test(systemOrPath);
  if (local) {
    const directory = path.resolve(systemOrPath), info = await fs.stat(directory).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (!info?.isDirectory()) throw new Error(`Local parent must be an existing Git directory: ${systemOrPath}`);
    return localSource(directory, options);
  }
  if (options.ref) throw new Error('--ref applies only to a local parent Git checkout');
  const portalUrl = cleanPortalUrl(options.portalUrl || await savedPortalUrl(options));
  const provider = createHostProvider({url: portalUrl, resolveToken: context => resolveAccessToken(portalUrl, {...options, ...context}), fetchImpl: options.fetchImpl});
  const source = await provider.releaseSource(systemOrPath, options.version || 'latest');
  if (source.parent?.systemId !== systemOrPath || (options.version && options.version !== 'latest' && source.parent?.version !== options.version)) throw new Error('The host returned a different parent release');
  decodeOffshootSource(source);
  return {parent: source.parent, files: source.files};
}

/** Create all files only after validation, and remove the new tree on failure. */
export async function shootOffshoot({destination, source, mode = 'full', systemId, name, check}) {
  const target = path.resolve(destination);
  const existing = await fs.lstat(target).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (existing && (!existing.isDirectory() || existing.isSymbolicLink() || (await fs.readdir(target)).length)) throw new Error('Shoot requires a new or empty --root destination');
  const transformed = await transformOffshoot(source, {mode, systemId, name});
  await fs.mkdir(target, {recursive: true});
  try {
    for (const [file, bytes] of decodeOffshootSource(transformed)) {
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
  return {designSystemRoot: target, parent: transformed.parent, files: transformed.files.map(file => file.path)};
}

export async function severOffshoot(root, {confirmed = false} = {}) {
  const parent = await readParentRecord(root);
  if (!parent) throw new Error('This system has no parent to sever');
  if (await fs.lstat(path.join(root, '.timds/session.json')).catch(error => { if (error.code === 'ENOENT') return null; throw error; })) throw new Error('Offshoot lineage cannot be severed in a hosted session');
  if (!confirmed) throw new Error('Sever permanently removes the parent feed baseline. Confirm with timds sever --yes');
  await fs.unlink(path.join(root, '.timds/parent.json'));
  return {parent, severed: true};
}
