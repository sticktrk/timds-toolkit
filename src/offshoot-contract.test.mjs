import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { initializeRepository, checkWorkspace } from './core.mjs';
import { parentLineage, readParentRecord, readStockRecord, unresolvedTokenWarnings, validateOffshootRecords, validateParentRecord, validateStockRecord } from './offshoot-contract.mjs';

const parent = () => ({ schemaVersion: 1, systemId: 'example/core', sourceId: '00000000-0000-4000-8000-000000000001', version: '2026.10.29-1', commit: 'a'.repeat(40), mode: 'structure', baseline: { site: { views: [{ id: 'brand', label: 'Brand', pages: [{ slug: '', title: 'Overview', planned: true }] }] }, formats: null } });
const json = value => `${JSON.stringify(value, null, 2)}\n`;
async function root(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'timds-offshoot-contract-'));
  t.after(() => fs.rm(directory, { force: true, recursive: true }));
  await fs.mkdir(path.join(directory, '.timds'));
  return directory;
}
async function write(directory, file, content) { await fs.mkdir(path.dirname(path.join(directory, file)), { recursive: true }); await fs.writeFile(path.join(directory, file), content); }

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
  const directory = await root(t);
  await write(directory, '.timds/parent.json', 'null\n');
  await assert.rejects(readParentRecord(directory), /schemaVersion 1/);
});

test('stock declarations name exact existing allowed regular source files', async t => {
  const directory = await root(t);
  const paths = ['src/pages/brand/index.html', 'src/styles/system.css', 'src/layout.html'];
  for (const file of paths) await write(directory, file, 'source');
  const record = { schemaVersion: 1, paths };
  assert.equal(await validateStockRecord(record, directory), record);
  await write(directory, '.timds/stock.json', json(record));
  assert.deepEqual(await readStockRecord(directory), record);
  for (const file of ['src/pages/**/*.html', 'src/pages/../secret.html', 'src/pages//index.html', 'src/designs/page.html', 'src/assets/image.png', 'timds.json', 'src/styles/missing.css']) await assert.rejects(validateStockRecord({ schemaVersion: 1, paths: [file] }, directory), /stock.json/);
  await assert.rejects(validateStockRecord({ schemaVersion: 1, paths: [...paths, paths[0]] }, directory), /unique exact/);
  await assert.rejects(validateStockRecord({ schemaVersion: 1, paths, automatic: true }, directory), /schemaVersion 1/);
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
  await write(directory, '.timds/stock.json', json({ schemaVersion: 1, paths: ['src/pages/*.html'] }));
  await assert.rejects(checkWorkspace(directory), /stock.json/);
});
