import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkWorkspace, initializeRepository, runCli, runWithOutputSink, syncStarterWorkspace } from './core.mjs';
import { brandKitStockPaths, brandKitViews } from './brand-kit.mjs';
import { loadOffshootSource, shootOffshoot } from './offshoots.mjs';
import { readStarterRecord, starterFragments, starterPaths, starterPlumbingFiles, stockTemplatePath, syncStarter } from './starter.mjs';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const version = JSON.parse(await fs.readFile(path.join(packageRoot, 'package.json'), 'utf8')).version;
const json = value => `${JSON.stringify(value, null, 2)}\n`;
const hash = text => createHash('sha256').update(text).digest('hex');
const git = (root, ...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();
const quiet = task => runWithOutputSink(() => {}, task);

async function fixture(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'timds-brand-kit-sync-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'source');
  await fs.mkdir(root);
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'config', 'user.email', 'test@example.com');
  await quiet(() => initializeRepository(root, { standalone: true, starter: 'brand-kit', systemId: 'example/kit', ...options }));
  git(root, 'add', '--all'); git(root, 'commit', '-qm', 'Initial scaffold');
  const read = relative => fs.readFile(path.join(root, relative), 'utf8');
  const write = (relative, content) => fs.writeFile(path.join(root, relative), content);
  return { directory, root, read, write };
}

test('starter selection rejects unknown names before writes and cannot replace an existing scaffold', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'timds-starter-choice-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const missing = path.join(directory, 'must-stay-absent');
  for (const starter of ['../starter', 'missing', '', null]) {
    await assert.rejects(initializeRepository(missing, { standalone: true, starter }), /Unknown starter/);
    await assert.rejects(fs.access(missing), { code: 'ENOENT' });
  }
  await assert.rejects(quiet(() => runCli(['init', '--root', missing, '--starter', 'missing'])), /Unknown starter/);
  await assert.rejects(fs.access(missing), { code: 'ENOENT' });
  const { root, read } = await fixture(t);
  const before = await read('.timds/starter.json');
  await assert.rejects(initializeRepository(root, { standalone: true, starter: 'starter', force: true }), /never replaces authored source/);
  assert.equal(await read('.timds/starter.json'), before);
  const existing = await quiet(() => initializeRepository(root, { standalone: true }));
  assert.equal(existing.starter, 'brand-kit', 'an omitted init choice preserves the existing kind');
  assert.equal(await read('.timds/starter.json'), before);
  assert.equal(git(root, 'status', '--porcelain'), '');
});

test('the CLI selects the brand-kit overlay for a hosted scaffold before dependencies are installed', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'timds-brand-kit-cli-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'hosted');
  const result = await quiet(() => runCli(['init', '--standalone', '--starter', 'brand-kit', '--provider', 'hosted', '--portal-url', 'https://host.example', '--root', root, '--system-id', 'example/hosted-kit']));
  assert.equal(result.starter, 'brand-kit');
  assert.equal(result.manifest.provider.kind, 'hosted');
  assert.equal((await readStarterRecord(root)).starter, 'brand-kit');
  await fs.access(path.join(root, 'dist/social/posts/index.html'));
  await fs.access(path.join(root, 'wrangler.jsonc'));
  await assert.rejects(fs.access(path.join(root, 'node_modules')), { code: 'ENOENT' });
  await assert.rejects(fs.access(path.join(root, '.github/workflows')), { code: 'ENOENT' });
});

test('brand-kit init seeds every stock page once and records plumbing only, and its first sync is a no-op', async t => {
  const { root, read } = await fixture(t);
  const record = await readStarterRecord(root);
  assert.equal(record.starter, 'brand-kit');
  assert.deepEqual(record.baseline.site, { views: brandKitViews });
  assert.deepEqual(JSON.parse(await read('src/site.json')), record.baseline.site);
  assert.equal(JSON.parse(await read('src/site.json')).home, undefined);
  assert.deepEqual(starterFragments('brand-kit'), [], 'the kit manages no fragment');
  assert.deepEqual(Object.keys(record.files).sort(), starterPlumbingFiles.map(([relative]) => relative).sort());
  for (const relative of brandKitStockPaths) {
    assert.equal(await read(relative), await fs.readFile(path.join(packageRoot, 'templates/brand-kit', relative), 'utf8'), `init seeds ${relative}`);
  }
  await fs.access(path.join(root, 'src/pages/brand/evidence.html'));
  assert.ok(!Object.hasOwn(record.files, 'src/copy.json'));
  assert.ok(!Object.keys(record.files).some(relative => relative.startsWith('src/pages/')));
  assert.equal(await read('scripts/brand-kit.mjs'), await fs.readFile(path.join(packageRoot, 'src/brand-kit.mjs'), 'utf8'));
  for (const relative of ['src/pages/digital', 'src/designs/website', 'src/pages/print/letterheads.html']) {
    await assert.rejects(fs.access(path.join(root, relative)), { code: 'ENOENT' });
  }
  assert.deepEqual(await fs.readdir(path.join(root, 'src/designs')), ['.gitkeep']);
  const before = await read('.timds/starter.json');
  const synced = await quiet(() => syncStarterWorkspace(root));
  assert.deepEqual(synced.written, []);
  assert.equal(synced.recordWritten, false);
  assert.equal(synced.starter, 'brand-kit');
  assert.deepEqual(synced.files.filter(file => file.path.startsWith('src/pages/')), []);
  assert.equal(await read('.timds/starter.json'), before);
  assert.equal(git(root, 'status', '--porcelain'), '');
  assert.throws(() => stockTemplatePath('src/pages/index.html', 'brand-kit'), /is not a starter file the toolkit writes/);
  assert.equal(stockTemplatePath('scripts/brand-kit.mjs', 'brand-kit'), path.join(packageRoot, 'src/brand-kit.mjs'));
});

test('a fresh brand kit passes check, and neither starter sync nor upgrade writes or reports a kit page', async t => {
  const { root, read } = await fixture(t);
  await quiet(() => checkWorkspace(root));
  assert.equal(git(root, 'status', '--porcelain'), '', 'check leaves the tracked scaffold untouched');
  const before = await read('.timds/starter.json');
  const synced = await quiet(() => syncStarterWorkspace(root));
  assert.deepEqual(synced.written, []);
  assert.equal(synced.recordWritten, false);
  assert.deepEqual(synced.files.filter(file => file.path.startsWith('src/pages/')), []);
  assert.equal(git(root, 'status', '--porcelain'), '');
  const lines = [];
  await runWithOutputSink(line => lines.push(line), () => runCli(['upgrade', '--root', root, '--json']));
  const report = JSON.parse(lines.join('\n'));
  assert.equal(report.ok, true);
  assert.equal(report.toolkit.selected, version);
  assert.equal(report.starter.starter, 'brand-kit');
  assert.equal(report.starter.state, 'current');
  assert.deepEqual(report.starter.written, []);
  assert.equal(report.starter.recordWritten, false);
  assert.deepEqual(report.starter.files.filter(file => file.path.startsWith('src/pages/')), []);
  assert.deepEqual(report.starter.files.map(file => file.path).sort(), [...starterPlumbingFiles.map(([relative]) => relative), 'src/formats.json', 'src/layout.html', 'src/site.json'].sort());
  assert.equal(await read('.timds/starter.json'), before);
  assert.equal(git(root, 'status', '--porcelain'), '', 'upgrade writes nothing on a fresh scaffold');
});

test('brand-kit sync merges its own catalog history, appends added pages as planned, and never touches a kit page', async t => {
  const { root, read, write } = await fixture(t);
  const historical = JSON.parse(await fs.readFile(path.join(packageRoot, 'templates/starter-history/brand-kit/site-1.json'), 'utf8'));
  const current = structuredClone(historical);
  current.views = current.views.filter(view => view.id !== 'decks');
  historical.views.find(view => view.id === 'ads').blurb = 'Earlier ad catalog';
  current.views.find(view => view.id === 'ads').blurb = 'Earlier ad catalog';
  current.views.find(view => view.id === 'social').blurb = 'Our social catalog';
  await write('src/site.json', json(current));
  await fs.rm(path.join(root, 'src/pages/decks'), { recursive: true });
  const record = JSON.parse(await read('.timds/starter.json'));
  record.baseline.site = historical;
  const oldPage = '<span class="eyebrow">Ads</span><h1 class="page-title">Earlier overview</h1>\n';
  await write('src/pages/ads/index.html', oldPage);
  record.files['src/pages/ads/index.html'] = hash(oldPage);
  await write('.timds/starter.json', json(record));
  const authored = {
    'src/copy.json': json({ name: 'The chosen name' }),
    'src/pages/brand/evidence.html': `${await read('src/pages/brand/evidence.html')}\n<!-- captured evidence -->\n`,
    'src/pages/index.html': `${await read('src/pages/index.html')}\n<!-- authored coverage guidance -->\n`,
    'src/styles/system.css': `${await read('src/styles/system.css')}\n/* authored style choice */\n`,
  };
  for (const [relative, content] of Object.entries(authored)) await write(relative, content);
  const synced = await syncStarter({ designSystemRoot: root, version });
  assert.deepEqual(synced.site.addedViews, ['decks']);
  assert.ok(synced.site.advanced.includes('ads.blurb'));
  const after = JSON.parse(await read('src/site.json'));
  assert.equal(after.views.find(view => view.id === 'social').blurb, 'Our social catalog');
  assert.ok(!after.views.some(view => view.id === 'digital'), 'the original starter catalog never enters a kit');
  const decks = after.views.find(view => view.id === 'decks');
  assert.ok(decks.pages.length > 0);
  for (const page of decks.pages) assert.equal(page.planned, true, `decks/${page.slug ?? ''} is appended as planned`);
  await assert.rejects(fs.access(path.join(root, 'src/pages/decks')), { code: 'ENOENT' }, 'no fragment is written for an added kit page');
  assert.equal(await read('src/pages/ads/index.html'), oldPage, 'a stock page at an older text is not refreshed');
  assert.deepEqual(synced.files.filter(file => file.path.startsWith('src/pages/')), [], 'no kit page appears in the files report');
  assert.ok(!synced.written.some(relative => relative.startsWith('src/pages/')));
  for (const [relative, content] of Object.entries(authored)) assert.equal(await read(relative), content, relative);
  const nextRecord = JSON.parse(await read('.timds/starter.json'));
  assert.deepEqual(Object.keys(nextRecord.files).sort(), starterPlumbingFiles.map(([relative]) => relative).sort(), 'a stale page hash drops out of the record');
  assert.deepEqual((await syncStarter({ designSystemRoot: root, version })).written, []);
});

test('a kit record that still lists page hashes loses them on its next sync and no page is written', async t => {
  const { root, read, write } = await fixture(t);
  const record = JSON.parse(await read('.timds/starter.json'));
  const pages = brandKitStockPaths.filter(relative => relative.startsWith('src/pages/'));
  for (const relative of pages) record.files[relative] = hash(await fs.readFile(path.join(packageRoot, 'templates/brand-kit', relative), 'utf8'));
  record.files['src/pages/social/posts.html'] = hash('an earlier stock text\n');
  await write('.timds/starter.json', json(record));
  const changed = `${await read('src/pages/social/posts.html')}\n<!-- authored on the parent -->\n`;
  await write('src/pages/social/posts.html', changed);
  const synced = await syncStarter({ designSystemRoot: root, version });
  assert.equal(synced.recordWritten, true);
  assert.deepEqual(synced.written, []);
  assert.deepEqual(synced.files.filter(file => file.path.startsWith('src/pages/')), []);
  assert.equal(await read('src/pages/social/posts.html'), changed);
  assert.deepEqual(Object.keys(JSON.parse(await read('.timds/starter.json')).files).sort(), starterPlumbingFiles.map(([relative]) => relative).sort());
});

test('a kit record without a site baseline bootstraps only from its own kind history', async t => {
  const { root, read, write } = await fixture(t);
  const record = JSON.parse(await read('.timds/starter.json'));
  delete record.baseline.site;
  await write('.timds/starter.json', json(record));
  const site = JSON.parse(await read('src/site.json'));
  site.views.find(view => view.id === 'decks').pages = site.views.find(view => view.id === 'decks').pages.filter(page => page.slug !== 'templates');
  await write('src/site.json', json(site));
  const synced = await syncStarter({ designSystemRoot: root, version });
  assert.deepEqual(synced.site.addedPages, ['decks/templates']);
  assert.deepEqual(synced.site.addedViews, []);
  assert.deepEqual(synced.site.kept, []);
  assert.equal(JSON.parse(await read('.timds/starter.json')).starter, 'brand-kit');
});

test('kit pages and builder-owned data stay outside the dirty guard; plumbing, catalogs, layout and record stay inside', async t => {
  const { root, read, write } = await fixture(t);
  const page = 'src/pages/social/posts.html';
  const before = await read(page);
  await write(page, `${before}\n<!-- draft change -->\n`);
  await write('src/copy.json', json({ name: 'A draft name' }));
  await fs.appendFile(path.join(root, 'src/pages/brand/evidence.html'), '\n<!-- draft evidence -->\n');
  const synced = await quiet(() => syncStarterWorkspace(root));
  assert.deepEqual(synced.written, []);
  assert.equal(await read(page), `${before}\n<!-- draft change -->\n`);
  const paths = starterPaths('brand-kit');
  assert.deepEqual(paths.filter(relative => relative.startsWith('src/pages/')), []);
  assert.deepEqual(paths.sort(), [...starterPlumbingFiles.map(([relative]) => relative), 'src/site.json', 'src/formats.json', 'src/layout.html', '.timds/starter.json'].sort());
  assert.ok(!paths.includes('src/copy.json'));
  await write(page, before);
  await fs.appendFile(path.join(root, 'src/layout.html'), '\n<!-- draft layout -->\n');
  await assert.rejects(quiet(() => syncStarterWorkspace(root)), /Starter sync refuses[\s\S]*src\/layout\.html/);
});

test('a failed brand-kit sync restores its shared modules and record together and never recreates a removed kit page', async t => {
  const { root, read, write } = await fixture(t);
  const record = JSON.parse(await read('.timds/starter.json'));
  const oldModule = '// earlier shared slot module\n';
  await write('scripts/brand-kit.mjs', oldModule);
  record.files['scripts/brand-kit.mjs'] = hash(oldModule);
  await write('.timds/starter.json', json(record));
  const originalRecord = await read('.timds/starter.json');
  await fs.rm(path.join(root, 'src/pages/index.html'));
  await assert.rejects(syncStarter({ designSystemRoot: root, version, check: async () => { throw new Error('fixture check failed'); } }), /rolled back.*fixture check failed/);
  assert.equal(await read('scripts/brand-kit.mjs'), oldModule);
  assert.equal(await read('.timds/starter.json'), originalRecord);
  await assert.rejects(fs.access(path.join(root, 'src/pages/index.html')), { code: 'ENOENT' });
  const synced = await syncStarter({ designSystemRoot: root, version });
  assert.deepEqual(synced.written, ['scripts/brand-kit.mjs']);
  await assert.rejects(fs.access(path.join(root, 'src/pages/index.html')), { code: 'ENOENT' }, 'sync never recreates a removed kit page');
});

test('structure shoots preserve the selected brand-kit starter and its explicitly declared source', async t => {
  const { root, directory, read } = await fixture(t);
  await fs.mkdir(path.join(root, 'src/designs/parent-only/pages'), { recursive: true });
  await fs.writeFile(path.join(root, 'src/designs/parent-only/design.json'), json({ title: 'Parent design' }));
  await fs.writeFile(path.join(root, 'src/designs/parent-only/pages/index.html'), '<h1>A parent-owned page</h1>\n');
  git(root, 'add', '--all'); git(root, 'commit', '-qm', 'Authored parent design');
  const source = await loadOffshootSource(root, { sourceId: '11111111-1111-4111-8111-111111111111' });
  assert.ok(source.files.some(file => file.path === 'src/designs/parent-only/pages/index.html'));
  const child = path.join(directory, 'child');
  let checked;
  await quiet(() => shootOffshoot({ destination: child, source, mode: 'structure', systemId: 'example/child', check: async target => { checked = await checkWorkspace(target); } }));
  assert.equal((await readStarterRecord(child)).starter, 'brand-kit');
  for (const relative of brandKitStockPaths) assert.equal(await fs.readFile(path.join(child, relative), 'utf8'), await read(relative), relative);
  assert.equal(await fs.readFile(path.join(child, 'scripts/brand-kit.mjs'), 'utf8'), await read('scripts/brand-kit.mjs'));
  await assert.rejects(fs.access(path.join(child, 'src/pages/brand/evidence.html')), { code: 'ENOENT' });
  await assert.rejects(fs.access(path.join(child, 'src/designs')), { code: 'ENOENT' });
  assert.deepEqual(checked.designs, { enabled: true, designCount: 0, pageCount: 0, stateCount: 0, journeyCount: 0, warnings: [] });
  assert.match(await fs.readFile(path.join(child, 'dist/index.html'), 'utf8'), /href="\/designs\/"/);
  assert.match(await fs.readFile(path.join(child, 'dist/designs/index.html'), 'utf8'), /No website designs yet/);
  await assert.rejects(fs.access(path.join(child, 'dist/designs/parent-only')), { code: 'ENOENT' });
  const childRecordFile = path.join(child, '.timds/starter.json');
  const childRecord = JSON.parse(await fs.readFile(childRecordFile, 'utf8'));
  childRecord.files['src/pages/social/posts.html'] = hash('an earlier stock page\n');
  childRecord.files['src/pages/index.html'] = hash(await read('src/pages/index.html'));
  await fs.writeFile(childRecordFile, json(childRecord));
  const childPage = await fs.readFile(path.join(child, 'src/pages/social/posts.html'), 'utf8');
  const childSync = await syncStarter({ designSystemRoot: child, version });
  assert.deepEqual(childSync.files.filter(file => file.path.startsWith('src/pages/')), []);
  assert.deepEqual(Object.keys(JSON.parse(await fs.readFile(childRecordFile, 'utf8')).files).sort(), starterPlumbingFiles.map(([relative]) => relative).sort(), "a kit offshoot's record is plumbing-only after sync");
  assert.equal(await fs.readFile(path.join(child, 'src/pages/social/posts.html'), 'utf8'), childPage);
});

test('an old record without a starter kind continues to select the original scaffold', async t => {
  const { root, read, write } = await fixture(t, { starter: 'starter' });
  const record = JSON.parse(await read('.timds/starter.json'));
  delete record.starter;
  await write('.timds/starter.json', json(record));
  const synced = await syncStarter({ designSystemRoot: root, version });
  assert.equal(synced.starter, 'starter');
  assert.deepEqual(synced.written, []);
  assert.deepEqual(synced.site.addedViews, []);
  assert.ok(JSON.parse(await read('src/site.json')).views.some(view => view.id === 'digital'));
  record.starter = '../brand-kit';
  await write('.timds/starter.json', json(record));
  await assert.rejects(readStarterRecord(root), /Unknown starter/);
});
