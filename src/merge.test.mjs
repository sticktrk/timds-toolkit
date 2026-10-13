import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeFileTrees, mergeContractValues, parseSessionResolution } from './merge.mjs';
import { prepareMergeRelease } from '../templates/starter/scripts/prepare-merge-release.mjs';
const file = (path, content, mode = '100644') => ({ path, encoding: 'base64', content: Buffer.from(content).toString('base64'), mode });
const json = (value, name = 'tokens/color.brand.json') => [file(name, JSON.stringify(value))];
const value = (result, name = 'tokens/color.brand.json') => JSON.parse(Buffer.from(result.files.find(file => file.path === name).content, 'base64'));
const clean = result => { assert.deepEqual(result.conflicts, []); return result; };

test('different keys merge without mutating input file trees, with stable receipts', () => {
  const base = json({ 600: { value: 'blue' }, 700: { value: 'navy' } });
  const mine = json({ 600: { value: 'teal' }, 700: { value: 'navy' } });
  const theirs = json({ 600: { value: 'blue' }, 700: { value: 'black' } });
  const before = JSON.stringify([base, mine, theirs]);
  const result = clean(mergeFileTrees(base, mine, theirs));
  assert.deepEqual(value(result), { 600: { value: 'teal' }, 700: { value: 'black' } });
  assert.deepEqual(result.mergedKeys, [{ path: 'tokens/color.brand.json', key: '600' }]);
  assert.equal(JSON.stringify([base, mine, theirs]), before);
});
test('same-key conflicts contain the exact values, dotted and pointer choices resolve one key', () => {
  const base = json({ brand: { value: 'blue', description: 'Old' } });
  const mine = json({ brand: { value: 'teal', description: 'Mine' } });
  const theirs = json({ brand: { value: 'navy', description: 'Old' } });
  const conflict = { path: 'tokens/color.brand.json', key: 'brand.value', base: 'blue', mine: 'teal', theirs: 'navy' };
  assert.deepEqual(mergeFileTrees(base, mine, theirs).conflicts, [conflict]);
  for (const key of ['brand.value', '/brand/value']) {
    const result = clean(mergeFileTrees(base, mine, theirs, { resolvedPaths: [`tokens/color.brand.json#${key}=theirs`] }));
    assert.deepEqual(value(result), { brand: { value: 'navy', description: 'Mine' } });
    assert.deepEqual(result.conflictedKeys, [conflict]);
  }
  const mineResult = clean(mergeFileTrees(base, mine, theirs, { resolvedPaths: ['tokens/color.brand.json'] }));
  assert.equal(value(mineResult).brand.value, 'teal');
});
test('JSON types, arrays, null, add/add, delete/change, and identical changes have three-way semantics', () => {
  for (const [base, mine, theirs] of [[1, 2, 3], [false, true, null], ['a', null, false], [[1], [1, 2], [1, 3]], [{ a: 1 }, 2, { a: 3 }]]) {
    const result = mergeFileTrees(json({ key: base }), json({ key: mine }), json({ key: theirs }));
    assert.deepEqual(result.conflicts, [{ path: 'tokens/color.brand.json', key: 'key', base, mine, theirs }]);
  }
  assert.deepEqual(value(clean(mergeFileTrees(json({ old: 'x', kept: true }), json({ kept: true }), json({ old: 'x', kept: false })))), { kept: false });
  assert.deepEqual(mergeFileTrees(json({ old: 'x' }), json({}), json({ old: 'y' })).conflicts, [{ path: 'tokens/color.brand.json', key: 'old', base: 'x', mine: null, theirs: 'y' }]);
  assert.deepEqual(value(clean(mergeFileTrees([], json({ a: 1 }), json({ b: 2 })))), { a: 1, b: 2 });
  assert.deepEqual(value(clean(mergeFileTrees(json({}), json({ key: null }), json({ key: null })))), { key: null });
  assert.deepEqual(value(clean(mergeFileTrees(json({ x: 1 }), json({ x: 2 }), json({ x: 2 })))), { x: 2 });
});
test('semantic object equality ignores property order, preserves array ordering and unsafe-looking literal keys', () => {
  const result = mergeContractValues('tokens/a.json', { metadata: { a: 1, b: 2 }, x: 0 }, { metadata: { b: 2, a: 1 }, x: 0 }, { metadata: { a: 3, b: 2 }, x: 1 });
  assert.deepEqual(result.conflicts, []);
  assert.equal(result.value.metadata.a, 3);
  const base = json(JSON.parse('{"__proto__":{"value":"a"},"x/y":{"~value":"b"}}'));
  const mine = json(JSON.parse('{"__proto__":{"value":"mine"},"x/y":{"~value":"mine"}}'));
  const theirs = json(JSON.parse('{"__proto__":{"value":"theirs"},"x/y":{"~value":"theirs"}}'));
  const merged = clean(mergeFileTrees(base, mine, theirs, { resolvedPaths: ['tokens/color.brand.json#/__proto__/value=mine', 'tokens/color.brand.json#/x~1y/~0value=theirs'] }));
  assert.equal(value(merged)['__proto__'].value, 'mine');
  assert.equal(value(merged)['x/y']['~value'], 'theirs');
  assert.equal({}.value, undefined);
});
test('only selected manifest keys merge deeply; arrays and artifact configuration remain atomic', () => {
  const base = { tokens: { a: 1, b: 1 }, artifact: { entry: 'index.html', publishRef: 'published' } };
  const mine = { tokens: { a: 2, b: 1 }, artifact: { entry: 'web/index.html', publishRef: 'published' } };
  const theirs = { tokens: { a: 1, b: 2 }, artifact: { entry: 'index.html', publishRef: 'release' } };
  const result = mergeFileTrees(json(base, 'timds.json'), json(mine, 'timds.json'), json(theirs, 'timds.json'));
  assert.deepEqual(value(result, 'timds.json').tokens, { a: 2, b: 2 });
  assert.equal(result.conflicts.length, 1); assert.equal(result.conflicts[0].key, 'artifact');
});
test('ordinary files, malformed JSON, root arrays and symlinks stay file-level; bytes and modes survive', () => {
  for (const [name, mode] of [['src/card.ts', '100644'], ['tokens/broken.json', '100644'], ['media/link.json', '120000']]) {
    const result = mergeFileTrees([file(name, 'base', mode)], [file(name, 'mine', mode)], [file(name, 'theirs', mode)]);
    assert.deepEqual(result.conflicts, [{ path: name, base: 'base', mine: 'mine', theirs: 'theirs' }]);
    const chosen = clean(mergeFileTrees([file(name, 'base', mode)], [file(name, 'mine', mode)], [file(name, 'theirs', mode)], { resolvedPaths: [name] }));
    assert.deepEqual(chosen.files, [file(name, 'mine', mode)]);
  }
  assert.equal(mergeFileTrees(json([1]), json([2]), json([3])).conflicts[0].key, undefined);
  const bytes = Buffer.from([0, 255, 2, 128]);
  assert.deepEqual(clean(mergeFileTrees([], [file('asset.bin', bytes)], [])).files, [file('asset.bin', bytes)]);
  const modeConflict = mergeFileTrees([file('run', 'old')], [file('run', 'old', '100755')], [file('run', 'new')]);
  assert.equal(modeConflict.conflicts.length, 1);
});
test('file deletion versus edit conflicts and independent deletion work without resurrection', () => {
  assert.deepEqual(clean(mergeFileTrees([file('a', 'old')], [], [file('a', 'old')])).files, []);
  const conflict = mergeFileTrees([file('a', 'old')], [], [file('a', 'new')]);
  assert.deepEqual(conflict.conflicts, [{ path: 'a', base: 'old', mine: null, theirs: 'new' }]);
  assert.deepEqual(clean(mergeFileTrees([file('a', 'old')], [], [file('a', 'new')], { resolvedPaths: ['a'] })).files, []);
});
test('grouped source regenerates compatibility aggregates rather than conflicting on generated bytes', () => {
  const record = file('.timds/contract-layout.json', '{"schemaVersion":1,"mediaSchemaVersion":2}');
  const trees = [1, 2, 3].map(number => [record, file('tokens.json', String(number)), file('media.json', String(number)), ...json({ a: number === 2 ? 2 : 1, b: number === 3 ? 3 : 1 }), ...json({ 'logo.mark': { key: 'logo.mark', id: 'logo' } }, 'media/logo.json')]);
  const result = clean(mergeFileTrees(...trees));
  assert.deepEqual(value(result, 'tokens.json'), { 'color.brand': { a: 2, b: 3 } });
  assert.deepEqual(value(result, 'media.json'), { schemaVersion: 2, assets: [{ key: 'logo.mark', id: 'logo' }] });
});
test('rejects invalid trees and unused/duplicate resolutions; reports cross-tree path collisions', () => {
  assert.throws(() => mergeFileTrees([], [file('../outside', 'x')], []), /path/);
  assert.throws(() => mergeFileTrees([], [file('a', '1'), file('A', '2')], []), /colliding/);
  assert.throws(() => mergeFileTrees([], [{ path: 'x', encoding: 'base64', content: '!!!!' }], []), /base64/);
  assert.throws(() => mergeFileTrees([], [], [], { resolvedPaths: ['x'] }), /current conflict/);
  assert.throws(() => mergeFileTrees([], [], [], { resolvedPaths: ['x', 'x'] }), /duplicate/);
  assert.deepEqual(parseSessionResolution('tokens/a.json#/brand~1a/value=theirs'), { path: 'tokens/a.json', key: '/brand~1a/value', choice: 'theirs', raw: 'tokens/a.json#/brand~1a/value=theirs' });
  assert.equal(mergeFileTrees([], [file('src', 'file')], [file('src/a', 'child')]).conflicts[0].path, 'src');
});


test('cross-tree portable collisions require a local whole-path choice and preserve valid local structure', () => {
  for (const [mine, theirs] of [
    [[file('src', 'file')], [file('src/a', 'child')]],
    [[file('src/a', 'child')], [file('src', 'file')]],
    [[file('Icon.svg', 'mine')], [file('icon.svg', 'theirs')]],
    [[file('CAFÉ', 'mine')], [file('cafe\u0301', 'theirs')]],
    [[file('Assets/icon', 'mine')], [file('assets', 'theirs')]],
  ]) {
    assert.ok(mergeFileTrees([], mine, theirs).conflicts.length > 0);
    for (const path of [mine[0].path, theirs[0].path]) {
      const resolved = clean(mergeFileTrees([], mine, theirs, { resolvedPaths: [path] }));
      assert.deepEqual(resolved.files, mine);
      assert.ok(resolved.conflictedKeys.length > 0);
    }
  }
});


test('whole-path JSON resolutions retain the exact local file and cannot mix with key choices', () => {
  const base = json({ x: 1, y: 1 }), mine = json({ x: 2, y: 1 }), theirs = json({ x: 3, y: 2 });
  const result = clean(mergeFileTrees(base, mine, theirs, { resolvedPaths: ['tokens/color.brand.json'] }));
  assert.deepEqual(result.files, mine);
  assert.throws(() => mergeFileTrees(base, mine, theirs, { resolvedPaths: ['tokens/color.brand.json', 'tokens/color.brand.json#x=theirs'] }), /mix whole-file and key/);
});

const changelogHeader = '# Design System Changelog\n\nClient-owned release notes.\n\n## Unreleased\n';
const changelogHistory = '## 2026.10.12-1\n\n- Initial release.\n';
const changelog = (notes = '', history = changelogHistory) => `${changelogHeader}\n${notes ? `${notes}\n\n` : ''}${history}`;
const textFile = (result, path = 'CHANGELOG.md') => Buffer.from(result.files.find(file => file.path === path).content, 'base64').toString();
const mergeNotes = (base, mine, theirs, options) => mergeFileTrees([file('CHANGELOG.md', base)], [file('CHANGELOG.md', mine)], [file('CHANGELOG.md', theirs)], options);

test('Unreleased notes merge append-only entries with continuations and shared additions exactly once', () => {
  const base = changelog('- Existing note.');
  const mine = changelog('- Existing note.\n\n- Shared addition.\n- Mine.\n  More context.\n\n  - A nested item.');
  const theirs = changelog('- Existing note.\n\n- Shared addition.\n\nA new paragraph note.');
  const result = clean(mergeNotes(base, mine, theirs));
  assert.equal(textFile(result), changelog('- Existing note.\n\n- Shared addition.\n\nA new paragraph note.\n\n- Mine.\n  More context.\n\n  - A nested item.'));
  assert.deepEqual(result.mergedKeys, [{ path: 'CHANGELOG.md', key: 'Unreleased' }]);
  assert.deepEqual(result.conflictedKeys, []);
});

test('changelog rewrites, deleted notes, reordering, malformed sections, and mode changes remain explicit conflicts', () => {
  const base = changelog('- First.\n\n- Second.');
  const incoming = changelog('- First.\n\n- Second.\n\n- Incoming.');
  for (const mine of [
    changelog('- Edited.\n\n- Second.'),
    changelog('- Second.'),
    changelog('- Second.\n\n- First.'),
    changelog('- First.\n\n- Second.\n  Changed its meaning.'),
    changelog('- First.\n\n- Second.\n\n- Mine.').replace('Initial release.', 'Edited history.'),
    changelog('- First.\n\n- Second.\n\n- Mine.').replace('Client-owned', 'Changed'),
    `${base}\n## Unreleased\n\n- Duplicate.\n`,
    base.replace('## Unreleased', '## Next'),
    base.replaceAll('\n', '\r\n'),
  ]) {
    const result = mergeNotes(base, mine, incoming);
    assert.deepEqual(result.conflicts.map(conflict => conflict.path), ['CHANGELOG.md']);
    assert.equal(textFile(clean(mergeNotes(base, mine, incoming, { resolvedPaths: ['CHANGELOG.md'] }))), mine);
  }
  const changedMode = mergeFileTrees([file('CHANGELOG.md', base)], [file('CHANGELOG.md', `${base}\n`, '100755')], [file('CHANGELOG.md', incoming)]);
  assert.equal(changedMode.conflicts.length, 1);
});

function releaseTree(files) {
  const read = path => Buffer.from(files.find(file => file.path === path).content, 'base64').toString();
  const result = prepareMergeRelease({
    timdsJson: read('timds.json'), packageJson: read('package.json'), packageLock: read('package-lock.json'),
    changelog: read('CHANGELOG.md'), previousVersion: JSON.parse(read('timds.json')).version,
    now: new Date('2026-10-12T20:00:00Z'),
  });
  return files.map(entry => Object.hasOwn(result.files, entry.path) ? file(entry.path, result.files[entry.path]) : entry);
}

test('ten stale sessions merge independent keys and notes across consecutive dated release rolls', () => {
  const version = '2026.10.12-1';
  const baseValues = Object.fromEntries(Array.from({ length: 10 }, (_, index) => [`key${index}`, 'old']));
  const base = [
    ...json(baseValues), file('CHANGELOG.md', changelog('- Previously pending note.')),
    ...json({ systemId: 'test', version }, 'timds.json'), ...json({ name: 'test', version }, 'package.json'),
    ...json({ version, packages: { '': { version } } }, 'package-lock.json'),
    file('.timds/contract-layout.json', '{"schemaVersion":1}'), ...json({}, 'tokens.json'), ...json({}, 'media.json'),
  ];
  let main = base;
  for (let index = 0; index < 10; index++) {
    const local = base.map(entry => entry.path === 'tokens/color.brand.json' ? json({ ...baseValues, [`key${index}`]: 'new' })[0]
      : entry.path === 'CHANGELOG.md' ? file(entry.path, changelog(`- Previously pending note.\n\n- Session ${index}.`)) : entry);
    const merged = clean(mergeFileTrees(base, local, main));
    const notes = textFile(merged).split('## 2026.10.12-')[0];
    assert.ok(notes.includes(`- Session ${index}.`));
    assert.equal(notes.includes('- Previously pending note.'), index === 0);
    main = releaseTree(merged.files);
    assert.equal(value({ files: main }, 'timds.json').version, `2026.10.12-${index + 2}`);
    const log = textFile({ files: main });
    assert.equal(log.match(/Previously pending note/g).length, 1);
    assert.ok(log.endsWith(changelogHistory));
    for (let previous = 0; previous <= index; previous++) {
      assert.equal(log.match(new RegExp(`Session ${previous}\\.`, 'g')).length, 1);
      assert.equal(value({ files: main })[`key${previous}`], 'new');
      assert.equal(value({ files: main }, 'tokens.json')['color.brand'][`key${previous}`], 'new');
    }
  }
});

test('release extensions must preserve old notes and history; diverging releases cannot merge', () => {
  const base = changelog('- Pending.');
  const mine = changelog('- Pending.\n\n- Mine.');
  const rolled = changelog('', `## 2026.10.12-2\n\n- Pending.\n\n- Published.\n\n${changelogHistory}`);
  assert.equal(textFile(clean(mergeNotes(base, mine, rolled))), changelog('- Mine.', rolled.slice(rolled.indexOf('## 2026.10.12-2'))));
  assert.equal(textFile(clean(mergeNotes(base, rolled, mine))), textFile(clean(mergeNotes(base, mine, rolled))));
  assert.equal(mergeNotes(base, mine, rolled.replace('- Pending.', '- Removed pending.')).conflicts.length, 1);
  assert.equal(mergeNotes(base, mine, rolled.replace('- Initial release.', '- History rewrite.')).conflicts.length, 1);
  const divergent = rolled.replace('- Published.', '- A different release.');
  assert.equal(mergeNotes(base, divergent, rolled).conflicts.length, 1);
});
