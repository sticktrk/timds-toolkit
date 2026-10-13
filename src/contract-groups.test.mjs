import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import test from 'node:test';
import { migrateContractGroups, syncContractViews, writeGroupedMedia } from './contract-groups.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'timds-groups-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const tokens = { 'color.brand': { 600: { value: '#123456' }, 700: { value: '#112233' } }, radius: { button: { value: '4px' } } };
  const media = { schemaVersion: 2, assets: [{ key: 'brand.logo', id: 'logo', title: 'Logo' }] };
  await fs.writeFile(path.join(root, 'tokens.json'), JSON.stringify(tokens));
  await fs.writeFile(path.join(root, 'media.json'), JSON.stringify(media));
  return { root, tokens, media };
}
test('migration preserves aggregate contract shapes, edits group keys and is idempotent', async t => {
  const { root, tokens, media } = await fixture(t);
  assert.equal((await migrateContractGroups(root)).migrated, true);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(root, 'tokens.json'))), tokens);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(root, 'media.json'))), media);
  assert.equal((await migrateContractGroups(root)).migrated, false);
  tokens['color.brand']['600'].value = '#abcdef';
  await fs.writeFile(path.join(root, 'tokens/color.brand.json'), JSON.stringify(tokens['color.brand']));
  await syncContractViews(root);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(root, 'tokens.json'))), tokens);
  await writeGroupedMedia(root, { ...media, assets: [{ ...media.assets[0], title: 'Updated' }] });
  assert.equal(JSON.parse(await fs.readFile(path.join(root, 'media/brand.json')))['brand.logo'].title, 'Updated');
});
test('check rejects missing references, cycles, media key mismatch and symlinked groups', async t => {
  const { root } = await fixture(t);
  await migrateContractGroups(root);
  const tokenPath = path.join(root, 'tokens/radius.json');
  await fs.writeFile(tokenPath, JSON.stringify({ button: { value: '{radius.missing}' } }));
  await assert.rejects(syncContractViews(root), /Unknown token reference radius.missing/);
  await fs.writeFile(tokenPath, JSON.stringify({ button: { value: '{radius.button}' } }));
  await assert.rejects(syncContractViews(root), /Cyclic token reference/);
  await fs.writeFile(tokenPath, JSON.stringify({ button: { value: '4px', media: 'missing' } }));
  await assert.rejects(syncContractViews(root), /Unknown media reference/);
  await fs.rm(tokenPath); await fs.symlink('../tokens.json', tokenPath);
  await assert.rejects(syncContractViews(root), /symbolic link/);
});
test('migration refuses an existing authored group before writing a layout record', async t => {
  const { root } = await fixture(t);
  await fs.mkdir(path.join(root, 'tokens')); await fs.writeFile(path.join(root, 'tokens/color.brand.json'), '{}');
  await assert.rejects(migrateContractGroups(root), /would overwrite/);
  await assert.rejects(fs.access(path.join(root, '.timds/contract-layout.json')));
});

test('migration preserves the consumer bundle bytes of an unchanged legacy system', async t => {
  const { initializeRepository, checkWorkspace } = await import('./core.mjs');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'timds-group-bundle-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await initializeRepository(root, { standalone: true });
  await fs.rm(path.join(root, '.timds/contract-layout.json'));
  await fs.rm(path.join(root, 'tokens'), { recursive: true });
  await fs.rm(path.join(root, 'media'), { recursive: true });
  await checkWorkspace(root);
  const before = JSON.parse(await fs.readFile(path.join(root, 'dist/bundle.json'))).files;
  await migrateContractGroups(root);
  await checkWorkspace(root);
  const after = JSON.parse(await fs.readFile(path.join(root, 'dist/bundle.json'))).files;
  assert.deepEqual(after, before);
});
