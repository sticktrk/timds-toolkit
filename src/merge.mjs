/** Pure three-way source merge. No repository, filesystem, transport or host state. */
const fail = message => Object.assign(new Error(message), { statusCode: 400 });
const MISSING = Symbol('missing');
const object = value => value !== MISSING && value !== null && typeof value === 'object' && !Array.isArray(value);
const manifestMergeKeys = new Set(['tokens', 'media', 'components', 'patterns', 'typography', 'icons', 'fonts', 'metadata', 'description']);
const encoder = new TextEncoder(), decoder = new TextDecoder();
const order = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const sameFile = (a, b) => a === undefined ? b === undefined : b !== undefined && a.mode === b.mode && a.content === b.content;
const exposed = value => value === MISSING ? null : value;

export function mergeFilePath(value) {
  if (typeof value !== 'string' || !value || value.length > 500 || /[\\\x00-\x1f\x7f]/.test(value) || value.startsWith('/') || /^[A-Za-z]:/.test(value) || value.split('/').some(part => !part || ['.', '..'].includes(part))) throw fail('Invalid merge file path');
  return value;
}

function encode(bytes) {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(binary);
}
function decode(content) {
  let binary;
  try { binary = atob(content); } catch { throw fail('Merge files require canonical base64 bytes'); }
  const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
  if (encode(bytes) !== content) throw fail('Merge files require canonical base64 bytes');
  return bytes;
}
const fileText = file => file === undefined ? null : decoder.decode(decode(file.content));
const jsonFile = (name, value, mode = '100644') => ({ path: name, encoding: 'base64', content: encode(encoder.encode(`${JSON.stringify(value, null, 2)}\n`)), mode });

function equal(a, b) {
  if (a === MISSING || b === MISSING) return a === b;
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, index) => equal(value, b[index]));
  if (!object(a) || !object(b)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && equal(a[key], b[key]));
}

/** PATH chooses the complete local file; PATH#key=mine|theirs chooses one key. */
export function parseSessionResolution(value) {
  if (typeof value !== 'string') throw fail('Invalid conflict resolution');
  const match = value.match(/^(.*?)#(.+)=(mine|theirs)$/);
  if (!match) return { path: mergeFilePath(value), key: null, choice: 'mine', raw: value };
  if (match[2].length > 1000 || /[\x00-\x1f\x7f]/.test(match[2])) throw fail('Invalid conflict key');
  return { path: mergeFilePath(match[1]), key: match[2], choice: match[3], raw: value };
}

/** JSON objects merge by leaf; arrays and unselected manifest fields are atomic. */
export function mergeContractValues(path, base, mine, theirs, resolutions = []) {
  mergeFilePath(path);
  const conflicts = [], mergedKeys = [], detected = [], used = new Set();
  const choices = resolutions.map(parseSessionResolution).filter(item => item.path === path);
  const visit = (b, a, c, segments = []) => {
    const key = segments.join('.');
    const pointer = '/' + segments.map(part => part.replaceAll('~', '~0').replaceAll('/', '~1')).join('/');
    if (equal(a, b)) return c;
    if (equal(c, b) || equal(a, c)) { if (segments.length) mergedKeys.push({ path, key }); return a; }
    const canRecurse = object(a) && object(c) && (object(b) || b === MISSING) && (path !== 'timds.json' || !segments.length || manifestMergeKeys.has(segments[0]));
    if (canRecurse) {
      const result = Object.create(null);
      for (const name of new Set([...Object.keys(b === MISSING ? {} : b), ...Object.keys(a), ...Object.keys(c)])) {
        const value = visit(b !== MISSING && Object.hasOwn(b, name) ? b[name] : MISSING, Object.hasOwn(a, name) ? a[name] : MISSING, Object.hasOwn(c, name) ? c[name] : MISSING, [...segments, name]);
        if (value !== MISSING) result[name] = value;
      }
      return result;
    }
    const receipt = { path, ...(key ? { key } : {}), base: exposed(b), mine: exposed(a), theirs: exposed(c) };
    detected.push(receipt);
    const choice = choices.find(item => item.key === key || item.key === pointer) || choices.find(item => item.key === null);
    if (choice) { used.add(choice.raw); return choice.choice === 'theirs' ? c : a; }
    conflicts.push(receipt); return a;
  };
  const value = visit(base, mine, theirs);
  return { value, conflicts, mergedKeys, detected, used: [...used] };
}

function fileTree(files, label) {
  if (!Array.isArray(files) || files.length > 4000) throw fail(`${label} must be a file tree with at most 4000 files`);
  const result = new Map(), portable = new Set();
  let bytes = 0;
  for (const input of files) {
    const name = mergeFilePath(input?.path), mode = input.mode || '100644';
    const normalized = name.normalize('NFC').toLowerCase();
    if (portable.has(normalized)) throw fail(`Duplicate or colliding merge path: ${name}`);
    portable.add(normalized);
    if (!['100644', '100755', '120000'].includes(mode) || input.encoding !== 'base64' || typeof input.content !== 'string') throw fail(`Invalid merge file: ${name}`);
    if (input.content.length > Math.ceil(10 * 1024 * 1024 / 3) * 4) throw fail('Merge file exceeds 10 MiB');
    const decoded = decode(input.content);
    bytes += decoded.length;
    if (decoded.length > 10 * 1024 * 1024 || bytes > 50 * 1024 * 1024) throw fail('Merge tree exceeds 50 MiB or 10 MiB per file');
    result.set(name, { path: name, encoding: 'base64', content: input.content, mode });
  }
  for (const name of result.keys()) {
    const parts = name.normalize('NFC').toLowerCase().split('/');
    while (parts.length > 1) { parts.pop(); if (portable.has(parts.join('/'))) throw fail(`Conflicting file and directory paths: ${name}`); }
  }
  return result;
}

function grouped(tree) {
  try { return JSON.parse(fileText(tree.get('.timds/contract-layout.json')))?.schemaVersion === 1; } catch { return false; }
}

// Generated aggregates cannot create conflicts between edits to independent
// groups. If group JSON is invalid, leave the old view for the later contract
// check to reject; merging never executes or validates a build.
function regenerateViews(tree) {
  if (!grouped(tree)) return;
  const tokens = Object.create(null), assets = [];
  try {
    for (const [name, file] of [...tree].sort(([a], [b]) => order(a, b))) {
      if (!/^(tokens|media)\/.+\.json$/.test(name)) continue;
      if (file.mode === '120000') return;
      const value = JSON.parse(fileText(file));
      if (!object(value)) return;
      if (name.startsWith('tokens/')) {
        const group = name.slice(7, -5).replaceAll('/', '.');
        if (Object.hasOwn(tokens, group)) return;
        tokens[group] = value;
      } else assets.push(...Object.values(value));
    }
    if (!Object.keys(tokens).length) return;
    const record = JSON.parse(fileText(tree.get('.timds/contract-layout.json')));
    tree.set('tokens.json', jsonFile('tokens.json', tokens));
    tree.set('media.json', jsonFile('media.json', { schemaVersion: record.mediaSchemaVersion || 2, assets }));
  } catch { /* Invalid source will fail the separate contract check. */ }
}

// Notes are indivisible Markdown entries: a bullet and its continuation lines,
// or a paragraph. Editing an existing entry is never an append-only change.
function changelogNotes(body) {
  const notes = [], lines = body.split('\n');
  let start = 0, end = lines.length;
  while (start < end && !lines[start].trim()) start++;
  while (end > start && !lines[end - 1].trim()) end--;
  let current = [];
  const finish = () => {
    while (current.length && !current.at(-1).trim()) current.pop();
    if (current.length) notes.push(current.join('\n'));
    current = [];
  };
  for (let index = start; index < end; index++) {
    const line = lines[index];
    if (current.length && (/^[-*] +\S/.test(line) || (/^\S/.test(line) && !current.at(-1).trim()))) finish();
    current.push(line);
  }
  finish();
  return notes;
}

function changelogParts(text) {
  if (typeof text !== 'string' || /[\r\0\ufffd]/.test(text)) return null;
  const headings = [...text.matchAll(/^## (.*)$/gm)];
  if (!headings.length || headings[0][1] !== 'Unreleased' || text[headings[0].index + headings[0][0].length] !== '\n') return null;
  const versions = new Set();
  for (const heading of headings.slice(1)) {
    if (!/^(?:\d{4}\.\d{2}\.\d{2}-[1-9]\d*|\d+\.\d+\.\d+)$/.test(heading[1]) || versions.has(heading[1])) return null;
    versions.add(heading[1]);
  }
  const bodyStart = headings[0].index + headings[0][0].length + 1;
  const historyStart = headings[1]?.index ?? text.length;
  const sections = headings.slice(1).map((heading, index) => {
    const end = headings[index + 2]?.index ?? text.length;
    return { raw: text.slice(heading.index, end), notes: changelogNotes(text.slice(heading.index + heading[0].length, end)) };
  });
  return { prefix: text.slice(0, bodyStart), notes: changelogNotes(text.slice(bodyStart, historyStart)), history: text.slice(historyStart), sections };
}

const notePrefix = (notes, prefix) => notes.length >= prefix.length && prefix.every((note, index) => note === notes[index]);

function changelogChanges(base, branch) {
  if (branch.prefix !== base.prefix) return null;
  if (branch.history === base.history) return notePrefix(branch.notes, base.notes) ? { added: branch.notes.slice(base.notes.length), released: [] } : null;
  // A release can only prepend complete sections, leaving every previous byte
  // intact. The oldest new release must contain the old Unreleased entries.
  const count = branch.sections.length - base.sections.length;
  if (count <= 0 || branch.sections.slice(count).map(section => section.raw).join('') !== base.history) return null;
  const releases = branch.sections.slice(0, count);
  if (!notePrefix(releases.at(-1).notes, base.notes)) return null;
  return { added: branch.notes, released: releases.flatMap(section => section.notes) };
}

function mergeChangelog(baseText, mineText, theirText) {
  const base = changelogParts(baseText), mine = changelogParts(mineText), theirs = changelogParts(theirText);
  if (!base || !mine || !theirs) return null;
  const ours = changelogChanges(base, mine), incoming = changelogChanges(base, theirs);
  if (!ours || !incoming) return null;
  // Two different rewritten release histories still require human resolution.
  // Matching histories, or one history extending the other, are safe to keep.
  const target = mine.history.length > theirs.history.length ? mine : theirs;
  const other = target === mine ? theirs : mine;
  const extra = target.sections.length - other.sections.length;
  if (extra < 0 || target.sections.slice(extra).map(section => section.raw).join('') !== other.history) return null;
  const released = new Set([...ours.released, ...incoming.released]);
  const notes = released.size || target.history !== base.history ? [] : [...base.notes];
  const seen = new Set(notes);
  for (const note of [...incoming.added, ...ours.added]) {
    if (!released.has(note) && !seen.has(note)) { notes.push(note); seen.add(note); }
  }
  return `${base.prefix}\n${notes.length ? `${notes.join('\n\n')}\n\n` : ''}${target.history}`;
}

/**
 * Inputs: three complete arrays of {path,encoding:'base64',content,mode?}.
 * Returns a candidate tree even with conflicts; callers MUST NOT commit that
 * tree until conflicts is empty. Unresolved conflicting paths keep mine.
 * Inputs are never mutated. Output file order and conflict order are stable.
 */
export function mergeFileTrees(baseFiles, mineFiles, theirFiles, { resolvedPaths = [] } = {}) {
  if (!Array.isArray(resolvedPaths) || resolvedPaths.length > 4000 || new Set(resolvedPaths).size !== resolvedPaths.length) throw fail('Invalid or duplicate conflict resolutions');
  const before = fileTree(baseFiles, 'base'), ours = fileTree(mineFiles, 'mine'), theirs = fileTree(theirFiles, 'theirs');
  const merged = new Map(), conflicts = [], mergedKeys = [], detected = [], used = new Set();
  const resolutions = resolvedPaths.map(parseSessionResolution);
  if (resolutions.some(item => item.key === null && resolutions.some(other => other.path === item.path && other.key !== null))) throw fail('Do not mix whole-file and key resolutions for one path');
  const generated = grouped(ours) || grouped(theirs);
  for (const path of [...new Set([...before.keys(), ...ours.keys(), ...theirs.keys()])].sort(order)) {
    const b = before.get(path), a = ours.get(path), c = theirs.get(path);
    if (generated && ['tokens.json', 'media.json'].includes(path)) { const entry = c || a; if (entry) merged.set(path, entry); continue; }
    if (!sameFile(a, b) && !sameFile(c, b) && !sameFile(a, c)) {
      const values = [fileText(b), fileText(a), fileText(c)];
      if (path === 'CHANGELOG.md' && b && a && c && a.mode === b.mode && c.mode === b.mode && b.mode !== '120000') {
        const changelog = mergeChangelog(...values);
        if (changelog !== null) {
          merged.set(path, { ...a, content: encode(encoder.encode(changelog)) });
          mergedKeys.push({ path, key: 'Unreleased' });
          continue;
        }
      }
      if ((/^(tokens|media)\/.+\.json$/.test(path) || path === 'timds.json') && a && c && a.mode === c.mode && a.mode !== '120000' && (!b || b.mode === a.mode)) {
        let parsed;
        try { parsed = values.map((value, index) => index === 0 && !b ? MISSING : JSON.parse(value)); } catch { /* Invalid JSON is an atomic file conflict. */ }
        if (parsed && object(parsed[1]) && object(parsed[2])) {
          const result = mergeContractValues(path, ...parsed, resolvedPaths);
          conflicts.push(...result.conflicts); mergedKeys.push(...result.mergedKeys); detected.push(...result.detected); result.used.forEach(item => used.add(item));
          const wholeFile = resolutions.find(item => item.path === path && item.key === null && result.used.includes(item.raw));
          merged.set(path, wholeFile ? a : jsonFile(path, result.value, a.mode)); continue;
        }
      }
      const receipt = { path, base: values[0], mine: values[1], theirs: values[2] };
      detected.push(receipt);
      const resolution = resolutions.find(item => item.path === path && item.key === null);
      if (!resolution) conflicts.push(receipt);
      else used.add(resolution.raw);
      if (a) merged.set(path, a);
      continue;
    }
    const entry = sameFile(a, b) ? c : a;
    if (entry) merged.set(path, entry);
  }
  regenerateViews(merged);
  // Combining valid trees can create portable-name or file/directory collisions.
  // A whole-path resolution selects the local entries across that collision.
  const portable = new Map(), neighbors = new Map();
  const connect = (a, b) => {
    if (!neighbors.has(a)) neighbors.set(a, new Set());
    if (!neighbors.has(b)) neighbors.set(b, new Set());
    neighbors.get(a).add(b); neighbors.get(b).add(a);
  };
  for (const name of merged.keys()) {
    const key = name.normalize('NFC').toLowerCase();
    if (portable.has(key)) connect(name, portable.get(key));
    else portable.set(key, name);
  }
  for (const name of merged.keys()) {
    const parts = name.normalize('NFC').toLowerCase().split('/');
    while (parts.length > 1) { parts.pop(); const parent = portable.get(parts.join('/')); if (parent) connect(name, parent); }
  }
  const visited = new Set();
  for (const name of [...neighbors.keys()].sort(order)) {
    if (visited.has(name)) continue;
    const group = [], pending = [name];
    while (pending.length) {
      const current = pending.pop(); if (visited.has(current)) continue;
      visited.add(current); group.push(current); pending.push(...neighbors.get(current));
    }
    const choices = resolutions.filter(item => item.key === null && group.includes(item.path));
    for (const path of group.sort(order)) {
      const receipt = { path, base: fileText(before.get(path)), mine: fileText(ours.get(path)), theirs: fileText(theirs.get(path)) };
      detected.push(receipt);
      if (!choices.length) { if (!conflicts.some(item => item.path === path)) conflicts.push(receipt); }
      else {
        if (ours.has(path)) merged.set(path, ours.get(path)); else merged.delete(path);
        for (let index = conflicts.length - 1; index >= 0; index--) if (conflicts[index].path === path) conflicts.splice(index, 1);
      }
    }
    choices.forEach(item => used.add(item.raw));
  }
  if (resolvedPaths.some(value => !used.has(value))) throw fail('A resolution must name a current conflict');
  const files = [...merged.values()].sort((a, b) => order(a.path, b.path));
  if (!conflicts.length) fileTree(files, 'merged');
  conflicts.sort((a, b) => order(`${a.path}#${a.key || ''}`, `${b.path}#${b.key || ''}`));
  return { files, conflicts, mergedKeys, conflictedKeys: detected };
}
