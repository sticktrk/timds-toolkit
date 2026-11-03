import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { initializeRepository, checkWorkspace } from './core.mjs';
import { readDerivedLayer } from './derived.mjs';
import { createPublicationStampFromFiles } from './publication-snapshot.mjs';
import { isDesignerRecordPath, isLineagePath, isPlumbingPath, parentLineage, readParentRecord, readStockRecord, regularPath, unresolvedTokenWarnings, validateOffshootRecords, validateParentRecord, validateStockRecord } from './offshoot-contract.mjs';

const parent = () => ({ schemaVersion: 1, systemId: 'example/core', sourceId: '00000000-0000-4000-8000-000000000001', version: '2026.10.29-1', commit: 'a'.repeat(40), mode: 'structure', baseline: { site: { views: [{ id: 'brand', label: 'Brand', pages: [{ slug: '', title: 'Overview', planned: true }] }] }, formats: null } });
const json = value => `${JSON.stringify(value, null, 2)}\n`;
async function root(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'timds-offshoot-contract-'));
  t.after(() => fs.rm(directory, { force: true, recursive: true }));
  await fs.mkdir(path.join(directory, '.timds'));
  return directory;
}
async function write(directory, file, content) { await fs.mkdir(path.dirname(path.join(directory, file)), { recursive: true }); await fs.writeFile(path.join(directory, file), content); }

test('record paths classify portable aliases and plumbing has one shared grammar', () => {
  for (const file of ['.timds/parent.json', '.TIMDS/parent.json', '.timds/PARENT.JSON']) assert.equal(isLineagePath(file), true, file);
  for (const file of ['.timds/stock.json', '.TIMDS/stock.json', '.timds/STOCK.JSON']) assert.equal(isDesignerRecordPath(file), true, file);
  for (const file of [null, '.timds/parent.json/child', 'src/.timds/parent.json', '.timds/stock.json']) assert.equal(isLineagePath(file), false, String(file));
  for (const file of [null, '.timds/stock.json/child', '.timds/parent.json']) assert.equal(isDesignerRecordPath(file), false, String(file));
  for (const file of ['scripts/build.mjs', 'scripts/custom-engine.mjs', 'src/scripts/compose.js', 'src/styles/viewer.css', 'src/styles/canvas.css']) assert.equal(isPlumbingPath(file), true, file);
  for (const file of [null, 'scripts/../build.mjs', 'scripts/nested/build.mjs', 'src/scripts/custom.js', 'src/scripts/nested/compose.js', 'src/scripts/../compose.js', 'src/styles/system.css', 'src/layout.html']) assert.equal(isPlumbingPath(file), false, String(file));
});

test('shared regular-file resolution checks the root and ancestors before optional writes', async t => {
  const directory = await root(t);
  await write(directory, 'src/file.json', '{}');
  assert.equal(await regularPath(directory, 'src/file.json'), path.join(directory, 'src/file.json'));
  assert.equal(await regularPath(directory, 'src/missing.json', { optional: true }), null);
  assert.equal(await regularPath(directory, 'missing/file.json', { optional: true }), null);
  for (const relative of ['../outside.json', '/outside.json', 'C:/outside.json']) await assert.rejects(regularPath(directory, relative, { optional: true }), /relative without traversal/);
  await assert.rejects(regularPath(directory, 'src/file.json/child', { optional: true }), /regular file without symbolic links/);
  const linked = path.join(directory, 'linked-root');
  await fs.symlink(directory, linked);
  await assert.rejects(regularPath(linked, 'src/file.json', { optional: true }), /regular file without symbolic links/);
});

test('parent records retain the host baseline and expose only public lineage', async t => {
  const directory = await root(t);
  assert.equal(await readParentRecord(directory), null);
  const record = parent();
  assert.equal(validateParentRecord(record), record);
  await write(directory, '.timds/parent.json', json(record));
  assert.deepEqual(await readParentRecord(directory), record);
  assert.deepEqual(parentLineage(record), { systemId: record.systemId, sourceId: record.sourceId, version: record.version, commit: record.commit, mode: record.mode });
  assert.equal(parentLineage(null), null);
  assert.equal(await fs.readFile(path.join(directory, '.timds/parent.json'), 'utf8'), json(record));
});

test('malformed lineage and structural baselines fail with the record path', async t => {
  const invalid = [null, {}, { ...parent(), schemaVersion: 2 }, { ...parent(), systemId: '' }, { ...parent(), sourceId: '../source' }, { ...parent(), version: '' }, { ...parent(), commit: 'main' }, { ...parent(), mode: 'seed' }, { ...parent(), baseline: {} }, { ...parent(), baseline: { site: {}, formats: null } }, { ...parent(), baseline: { site: parent().baseline.site, formats: [] } }, { ...parent(), unknown: true }];
  for (const record of invalid) assert.throws(() => validateParentRecord(record), /\.timds\/parent.json/);
  const duplicate = parent(); duplicate.baseline.site.views[0].pages.push({ slug: '', title: 'Again' });
  assert.throws(() => validateParentRecord(duplicate), /duplicate page/);
  for (const site of [
    { views: {} }, { views: [null] }, { views: [{ id: 42, pages: [] }] },
    { views: [{ id: 'web', pages: {} }] }, { views: [{ id: 'web', label: [], pages: [] }] },
    { views: [{ id: 'web', pages: [null] }] }, { views: [{ id: 'web', pages: [{ slug: {} }] }] },
    { views: [{ id: 'web', pages: [{ title: [] }] }] }, { views: [{ id: 'web', pages: [{ planned: 'yes' }] }] },
    { views: [{ id: 'web', pages: [] }, { id: 'web', pages: [] }] },
  ]) assert.throws(() => validateParentRecord({ ...parent(), baseline: { site, formats: null } }), /baseline.site/);
  const directory = await root(t);
  await write(directory, '.timds/parent.json', 'null\n');
  await assert.rejects(readParentRecord(directory), /schemaVersion 1/);
});

test('parent baselines preserve custom-renderer catalogs without imposing starter presentation rules', async t => {
  const directory = await root(t);
  const sites = [
    { views: [] },
    { views: [{ id: 'empty_view', pages: [] }] },
    { views: [{ id: 'Web_View', pages: [{ slug: 'web_components' }, { slug: 'index' }, {}] }] },
    { views: [{ id: 'custom', label: '', pages: [{ slug: 'nested/path.with_underscore', title: '' }] }] },
  ];
  for (const site of sites) {
    const record = { ...parent(), mode: 'full', baseline: { site, formats: null } };
    const before = structuredClone(record);
    assert.equal(validateParentRecord(record), record);
    assert.deepEqual(record, before);
    await write(directory, '.timds/parent.json', json(record));
    assert.deepEqual(await readParentRecord(directory), record);
    const derived = await readDerivedLayer(directory, { systemId: 'example/child', version: '1.0.0' });
    assert.deepEqual(derived.lineage, parentLineage(record));
    const stamp = createPublicationStampFromFiles({
      sourceCommit: 'b'.repeat(40),
      sourceFiles: [
        { path: 'timds.json', content: json({ systemId: 'example/child', name: 'Example', version: '1.0.0', artifact: { entry: 'index.html' } }) },
        { path: 'tokens.json', content: '{}' }, { path: '.timds/parent.json', content: json(record) },
      ],
      artifactFiles: [{ path: 'index.html', content: '<h1>Example</h1>' }],
    });
    assert.deepEqual(stamp.lineage, parentLineage(record));
    assert.equal(await fs.readFile(path.join(directory, '.timds/parent.json'), 'utf8'), json(record));
  }
});

test('stock declarations name exact existing allowed regular source files', async t => {
  const directory = await root(t);
  const paths = ['src/pages/brand/index.html', 'src/styles/system.css', 'src/layout.html', 'src/copy.json'];
  for (const file of paths) await write(directory, file, 'source');
  const record = { schemaVersion: 1, paths };
  assert.equal(await validateStockRecord(record, directory), record);
  await write(directory, '.timds/stock.json', json(record));
  assert.deepEqual(await readStockRecord(directory), record);
  for (const file of ['src/pages/**/*.html', 'src/pages/../secret.html', 'src/pages//index.html', 'src/designs/page.html', 'src/assets/image.png', 'timds.json', 'src/styles/missing.css', 'src/copy-extra.json', 'src/nested/copy.json', 'src/copy.json/child', 'src/../copy.json', 'src/*.json']) await assert.rejects(validateStockRecord({ schemaVersion: 1, paths: [file] }, directory), /stock.json/);
  await assert.rejects(validateStockRecord({ schemaVersion: 1, paths: [...paths, paths[0]] }, directory), /unique exact/);
  await assert.rejects(validateStockRecord({ schemaVersion: 1, paths, automatic: true }, directory), /schemaVersion 1/);
  await fs.rm(path.join(directory, 'src/copy.json'));
  await assert.rejects(validateStockRecord({ schemaVersion: 1, paths: ['src/copy.json'] }, directory), /missing file/);
  await fs.symlink(path.join(directory, 'src/layout.html'), path.join(directory, 'src/copy.json'));
  await assert.rejects(validateStockRecord({ schemaVersion: 1, paths: ['src/copy.json'] }, directory), /regular file/);
  await fs.symlink(path.join(directory, 'src/styles/system.css'), path.join(directory, 'src/styles/link.css'));
  await assert.rejects(validateStockRecord({ schemaVersion: 1, paths: ['src/styles/link.css'] }, directory), /regular file/);
  await fs.symlink(path.join(directory, 'src/pages/brand'), path.join(directory, 'src/pages/linked'));
  await assert.rejects(validateStockRecord({ schemaVersion: 1, paths: ['src/pages/linked/index.html'] }, directory), /regular file/);
});

test('initial token values are unresolved warnings rather than invalid values', async t => {
  const directory = await root(t);
  const tokens = { color: { accent: { value: 'initial' }, ink: { value: '#000000' } }, font: { display: { $value: 'initial' } } };
  assert.equal(unresolvedTokenWarnings(tokens).length, 2);
  assert.match(unresolvedTokenWarnings(tokens)[0], /color.accent.*unresolved.*initial/);
  await write(directory, 'tokens.json', json(tokens));
  assert.equal((await validateOffshootRecords(directory)).warnings.length, 2);
  const record = parent();
  assert.equal((await validateOffshootRecords(directory, { parentRecord: record })).parent, record);
  assert.equal((await validateOffshootRecords(directory, { parentRecord: null })).parent, null);
});

test('check accepts host structure records and reports placeholder tokens without changing lineage', async t => {
  const directory = await root(t);
  await initializeRepository(directory, { standalone: true });
  const record = parent();
  await write(directory, '.timds/parent.json', json(record));
  await write(directory, '.timds/stock.json', json({ schemaVersion: 1, paths: ['src/styles/system.css'] }));
  const tokenFile = path.join(directory, 'tokens/color.json');
  const tokens = JSON.parse(await fs.readFile(tokenFile, 'utf8'));
  tokens.accent.value = 'initial';
  await fs.writeFile(tokenFile, json(tokens));
  const checked = await checkWorkspace(directory);
  assert.ok(checked.machine.warnings.some(message => /color.accent.*unresolved/.test(message)));
  assert.equal(await fs.readFile(path.join(directory, '.timds/parent.json'), 'utf8'), json(record));
  const customRecord = { ...record, mode: 'full', baseline: { site: { views: [{ id: 'empty_view', pages: [] }, { id: 'custom', pages: [{ slug: 'web_components' }] }] }, formats: null } };
  await write(directory, '.timds/parent.json', json(customRecord));
  assert.deepEqual((await checkWorkspace(directory)).machine.index.lineage, parentLineage(customRecord));
  assert.equal(await fs.readFile(path.join(directory, '.timds/parent.json'), 'utf8'), json(customRecord));
  await write(directory, '.timds/stock.json', json({ schemaVersion: 1, paths: ['src/pages/*.html'] }));
  await assert.rejects(checkWorkspace(directory), /stock.json/);
});
