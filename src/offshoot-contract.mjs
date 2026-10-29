// The public records shared by host provisioning, local offshoot operations,
// checking and readers. The parent record is lineage, never an authored edit;
// stock is an explicit designer declaration, never inferred from content.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { normalizeFormatCatalog } from './formats.mjs';

export const PARENT_RECORD_FILE = '.timds/parent.json';
export const STOCK_RECORD_FILE = '.timds/stock.json';
const object = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const onlyKeys = (value, keys) => Object.keys(value).every(key => keys.includes(key));

function validateBaselineSite(site) {
  const at = `${PARENT_RECORD_FILE} baseline.site`;
  // This is passive merge data from a published parent, which may use a
  // custom renderer. The stock viewer owns its stricter labels and route
  // grammar; readers must not apply those presentation rules to every parent.
  if (!object(site) || !Array.isArray(site.views)) throw new Error(`${at} must declare a views array`);
  const views = new Set();
  for (const view of site.views) {
    if (!object(view) || typeof view.id !== 'string' || !view.id || views.has(view.id) || (view.label !== undefined && typeof view.label !== 'string') || !Array.isArray(view.pages)) throw new Error(`${at} has an invalid or duplicate view`);
    views.add(view.id);
    const pages = new Set();
    for (const page of view.pages) {
      const name = page?.slug ?? '';
      if (!object(page) || typeof name !== 'string' || pages.has(name) || (page.title !== undefined && typeof page.title !== 'string') || (page.planned !== undefined && typeof page.planned !== 'boolean')) throw new Error(`${at} view ${view.id} has an invalid or duplicate page`);
      pages.add(name);
    }
  }
}

/** Validate the version-1 host/local lineage record without rewriting it. */
export function validateParentRecord(value) {
  const at = PARENT_RECORD_FILE;
  if (!object(value) || value.schemaVersion !== 1 || !onlyKeys(value, ['schemaVersion', 'systemId', 'sourceId', 'version', 'commit', 'mode', 'baseline'])) throw new Error(`${at} must be a schemaVersion 1 parent record`);
  parentLineage(value);
  if (!object(value.baseline) || !onlyKeys(value.baseline, ['site', 'formats']) || !Object.hasOwn(value.baseline, 'formats')) throw new Error(`${at} needs baseline.site and baseline.formats`);
  validateBaselineSite(value.baseline.site);
  if (value.baseline.formats !== null) normalizeFormatCatalog(value.baseline.formats, { where: `${at} baseline.formats` });
  return value;
}

/** Public ancestry omits the structural baseline and any host authority. */
export function parentLineage(record) {
  if (record === null || record === undefined) return null;
  const at = PARENT_RECORD_FILE;
  if (!object(record)) throw new Error(`${at} lineage must be an object`);
  const { systemId, sourceId, version, commit, mode } = record;
  if (typeof systemId !== 'string' || !systemId.trim() || systemId.length > 300 || /[\x00-\x1f\x7f]/.test(systemId)) throw new Error(`${at} needs a parent systemId`);
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(sourceId || '')) throw new Error(`${at} sourceId must be a UUID`);
  if (typeof version !== 'string' || !version.trim() || version.length > 100 || /[\x00-\x1f\x7f]/.test(version)) throw new Error(`${at} needs a parent version`);
  if (!/^[a-f0-9]{40}$/.test(commit || '')) throw new Error(`${at} commit must be a source commit SHA`);
  if (!['full', 'structure'].includes(mode)) throw new Error(`${at} mode must be full or structure`);
  return { systemId, sourceId, version, commit, mode };
}

async function regularPath(root, relative, { optional = false } = {}) {
  let current = root;
  const parts = relative.split('/');
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part);
    let info;
    try { info = await fs.lstat(current); }
    catch (error) { if (optional && error.code === 'ENOENT') return null; throw error; }
    if (info.isSymbolicLink() || (index === parts.length - 1 ? !info.isFile() : !info.isDirectory())) throw new Error(`${relative} must be an existing regular file without symbolic links`);
  }
  return current;
}

async function readRecord(root, relative) {
  const file = await regularPath(root, relative, { optional: true });
  if (!file) return undefined;
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) { if (error instanceof SyntaxError) throw new Error(`${relative} is invalid JSON: ${error.message}`); throw error; }
}

export async function readParentRecord(root) {
  const value = await readRecord(root, PARENT_RECORD_FILE);
  return value === undefined ? null : validateParentRecord(value);
}

/** Stock names exact source files. Globs, links and other authored layers are refused. */
export async function validateStockRecord(value, root) {
  const at = STOCK_RECORD_FILE;
  if (!object(value) || value.schemaVersion !== 1 || !onlyKeys(value, ['schemaVersion', 'paths']) || !Array.isArray(value.paths) || value.paths.length > 4000) throw new Error(`${at} must contain schemaVersion 1 and up to 4000 paths`);
  const seen = new Set();
  for (const file of value.paths) {
    if (typeof file !== 'string' || !/^src\/(?:pages\/.+\.html|styles\/.+\.css|layout\.html)$/.test(file) || /[\x00-\x1f\x7f\\*?\[\]{}]/.test(file) || file.split('/').some(part => !part || part === '.' || part === '..') || seen.has(file)) throw new Error(`${at} must name unique exact src/pages HTML files, src/styles CSS files or src/layout.html`);
    seen.add(file);
    if (root) {
      try { await regularPath(root, file); }
      catch (error) { if (error.code === 'ENOENT') throw new Error(`${at} names a missing file: ${file}`); throw error; }
    }
  }
  return value;
}

export async function readStockRecord(root) {
  const value = await readRecord(root, STOCK_RECORD_FILE);
  return value === undefined ? null : validateStockRecord(value, root);
}

/** CSS initial is a valid structure placeholder, with an actionable check warning. */
export function unresolvedTokenWarnings(tokens) {
  const warnings = [];
  function visit(value, names) {
    if (!object(value)) return;
    if (Object.hasOwn(value, 'value') || Object.hasOwn(value, '$value')) {
      if (String(value.value ?? value.$value).trim().toLowerCase() === 'initial') warnings.push(`Token ${names.join('.')} is unresolved (initial); replace the structure placeholder with a design value`);
      return;
    }
    for (const [name, entry] of Object.entries(value)) visit(entry, [...names, name]);
  }
  visit(tokens, []);
  return warnings;
}

export async function validateOffshootRecords(root, { parentRecord = undefined } = {}) {
  const parent = parentRecord === undefined ? await readParentRecord(root) : parentRecord;
  const stock = await readStockRecord(root);
  const tokens = JSON.parse(await fs.readFile(path.join(root, 'tokens.json'), 'utf8'));
  return { parent, stock, warnings: unresolvedTokenWarnings(tokens) };
}
