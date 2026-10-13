// Source maps are mergeable by key; the two aggregate files stay byte-shape
// compatible with existing builds and published consumer bundles.
import { promises as fs } from 'node:fs';
import path from 'node:path';

export const CONTRACT_LAYOUT_FILE = '.timds/contract-layout.json';
const json = value => `${JSON.stringify(value, null, 2)}\n`;
const object = (value, label) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be a key map`);
  return value;
};
const safeGroup = name => {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name) || ['__proto__', 'prototype', 'constructor'].includes(name)) throw new Error(`Unsafe contract group: ${name}`);
  return name;
};
async function read(file) { return JSON.parse(await fs.readFile(file, 'utf8')); }
export async function hasContractGroups(root) {
  try { const record = await read(path.join(root, CONTRACT_LAYOUT_FILE)); if (record.schemaVersion !== 1) throw new Error('Unsupported contract group layout'); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
async function groupFiles(root, type) {
  const result = [];
  async function walk(directory, prefix = '') {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error(`${type}/${prefix}${entry.name} cannot be a symbolic link`);
      if (entry.isDirectory()) await walk(path.join(directory, entry.name), `${prefix}${safeGroup(entry.name)}.`);
      else if (entry.isFile() && entry.name.endsWith('.json')) result.push({ group: safeGroup(`${prefix}${entry.name.slice(0, -5)}`), file: path.join(directory, entry.name) });
      else throw new Error(`Only JSON group files belong under ${type}/: ${entry.name}`);
    }
  }
  await walk(path.join(root, type));
  return result.sort((a, b) => a.group.localeCompare(b.group));
}
export async function readContractGroups(root) {
  const tokens = Object.create(null), assets = [], seenMedia = new Set();
  for (const { group, file } of await groupFiles(root, 'tokens')) {
    if (Object.hasOwn(tokens, group)) throw new Error(`Duplicate token group ${group}`);
    tokens[group] = object(await read(file), `tokens/${group}.json`);
    for (const [name, token] of Object.entries(tokens[group])) {
      safeGroup(name); object(token, `Token ${group}.${name}`);
      if (typeof token.value !== 'string' || !token.value.trim()) throw new Error(`Token ${group}.${name} needs a string value`);
    }
  }
  if (!Object.keys(tokens).length) throw new Error('tokens/ must contain at least one JSON group');
  for (const { group, file } of await groupFiles(root, 'media')) {
    for (const [key, asset] of Object.entries(object(await read(file), `media/${group}.json`))) {
      object(asset, `Media ${key}`);
      if (key !== asset.key || seenMedia.has(key)) throw new Error(`Duplicate or mismatched media key ${key}`);
      seenMedia.add(key); assets.push(asset);
    }
  }
  const references = new Map();
  const cssNames = new Map();
  for (const [group, entries] of Object.entries(tokens)) for (const [key, token] of Object.entries(entries)) {
    const name = `${group}.${key}`, css = `--${group}-${key}`.replace(/[^a-z0-9-]/gi, '-').toLowerCase();
    if (cssNames.has(css)) throw new Error(`Token CSS name collision: ${css}`);
    cssNames.set(css, name);
    references.set(name, [...token.value.matchAll(/\{([a-zA-Z0-9_.-]+)\}/g)].map(match => match[1]));
    if (token.$ref) references.get(name).push(String(token.$ref).replace(/^tokens\//, '').replaceAll('/', '.'));
  }
  for (const [group, entries] of Object.entries(tokens)) for (const [key, token] of Object.entries(entries)) {
    for (const match of token.value.matchAll(/var\(\s*(--[a-zA-Z0-9_-]+)/g)) {
      if (!cssNames.has(match[1])) throw new Error(`Unknown token reference ${match[1]}`);
      references.get(`${group}.${key}`).push(cssNames.get(match[1]));
    }
  }
  const visited = new Set(), pending = new Set();
  function visit(name) {
    if (!references.has(name)) throw new Error(`Unknown token reference ${name}`);
    if (pending.has(name)) throw new Error(`Cyclic token reference ${name}`);
    if (visited.has(name)) return;
    pending.add(name); for (const target of references.get(name)) visit(target); pending.delete(name); visited.add(name);
  }
  for (const name of references.keys()) visit(name);
  for (const entries of Object.values(tokens)) for (const token of Object.values(entries)) {
    for (const match of token.value.matchAll(/var\(\s*(--[a-zA-Z0-9_-]+)\s*\)/g)) if (!cssNames.has(match[1])) throw new Error(`Unknown token reference ${match[1]}`);
    if (token.media && !seenMedia.has(token.media)) throw new Error(`Unknown media reference ${token.media}`);
  }
  const record = await read(path.join(root, CONTRACT_LAYOUT_FILE));
  return { tokens, media: { schemaVersion: record.mediaSchemaVersion || 2, assets } };
}
export async function syncContractViews(root) {
  if (!await hasContractGroups(root)) return null;
  const groups = await readContractGroups(root);
  for (const [name, value] of [['tokens.json', groups.tokens], ['media.json', groups.media]]) {
    const target = path.join(root, name), content = json(value);
    if ((await fs.lstat(target).catch(() => null))?.isSymbolicLink()) throw new Error(`${name} cannot be a symbolic link`);
    if (await fs.readFile(target, 'utf8').catch(() => null) !== content) await fs.writeFile(target, content);
  }
  return groups;
}
export async function migrateContractGroups(root) {
  if (await hasContractGroups(root)) return { migrated: false, ...(await syncContractViews(root)) };
  const tokens = object(await read(path.join(root, 'tokens.json')), 'tokens.json');
  if (!Object.keys(tokens).length) return { migrated: false, reason: 'No authored token groups to migrate' };
  const media = await read(path.join(root, 'media.json')).catch(error => { if (error.code === 'ENOENT') return { schemaVersion: 2, assets: [] }; throw error; });
  const writes = [];
  for (const [group, entries] of Object.entries(tokens)) writes.push([`tokens/${safeGroup(group)}.json`, json(object(entries, `Token group ${group}`))]);
  const mediaGroups = new Map();
  for (const asset of media.assets || []) {
    const group = safeGroup(String(asset.key).split(/[./]/)[0] || 'assets');
    if (!mediaGroups.has(group)) mediaGroups.set(group, Object.create(null));
    if (Object.hasOwn(mediaGroups.get(group), asset.key)) throw new Error(`Duplicate media key ${asset.key}`);
    mediaGroups.get(group)[asset.key] = asset;
  }
  if (!mediaGroups.size) mediaGroups.set('assets', {});
  for (const [group, entries] of mediaGroups) writes.push([`media/${group}.json`, json(entries)]);
  for (const [relative, content] of writes) {
    const existing = await fs.readFile(path.join(root, relative), 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (existing !== null && existing !== content) throw new Error(`Contract migration would overwrite ${relative}; reconcile that group first`);
  }
  for (const [relative, content] of writes) { await fs.mkdir(path.dirname(path.join(root, relative)), { recursive: true }); await fs.writeFile(path.join(root, relative), content); }
  await fs.mkdir(path.join(root, '.timds'), { recursive: true });
  await fs.writeFile(path.join(root, CONTRACT_LAYOUT_FILE), json({ schemaVersion: 1, mediaSchemaVersion: media.schemaVersion || 2, tokens: 'tokens/**/*.json', media: 'media/**/*.json', generated: ['tokens.json', 'media.json'] }));
  return { migrated: true, ...(await syncContractViews(root)) };
}
export async function writeGroupedMedia(root, catalog) {
  if (!await hasContractGroups(root)) { await fs.writeFile(path.join(root, 'media.json'), json(catalog)); return; }
  const groups = await groupFiles(root, 'media'), pending = new Map(catalog.assets.map(asset => [asset.key, asset]));
  for (const { file } of groups) {
    const existing = await read(file), next = Object.create(null);
    for (const key of Object.keys(existing)) if (pending.has(key)) { next[key] = pending.get(key); pending.delete(key); }
    await fs.writeFile(file, json(next));
  }
  for (const [key, asset] of pending) {
    const group = safeGroup(String(key).split(/[./]/)[0] || 'assets'), file = path.join(root, 'media', `${group}.json`);
    const current = await read(file).catch(error => { if (error.code === 'ENOENT') return {}; throw error; });
    await fs.writeFile(file, json({ ...current, [key]: asset }));
  }
  await syncContractViews(root);
}
