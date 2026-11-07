import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkWorkspace, initializeRepository, runCli, runWithOutputSink, syncStarterWorkspace, upgradeRepository } from './core.mjs';
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

test('brand-kit init selects only the overlay authored surface and its first sync is a no-op', async t => {
  const { root, read } = await fixture(t);
  const record = await readStarterRecord(root);
  assert.equal(record.starter, 'brand-kit');
  assert.deepEqual(record.baseline.site, { views: brandKitViews });
  assert.deepEqual(JSON.parse(await read('src/site.json')), record.baseline.site);
  assert.equal(JSON.parse(await read('src/site.json')).home, undefined);
  assert.deepEqual(Object.keys(record.files).sort(), [...starterPlumbingFiles, ...starterFragments('brand-kit')].map(([relative]) => relative).sort());
  assert.ok(!Object.hasOwn(record.files, 'src/copy.json'));
  assert.ok(!Object.hasOwn(record.files, 'src/pages/brand/evidence.html'));
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
  assert.equal(await read('.timds/starter.json'), before);
  assert.equal(git(root, 'status', '--porcelain'), '');
  assert.equal(stockTemplatePath('src/pages/index.html', 'brand-kit'), path.join(packageRoot, 'templates/brand-kit/src/pages/index.html'));
  assert.equal(stockTemplatePath('scripts/brand-kit.mjs', 'brand-kit'), path.join(packageRoot, 'src/brand-kit.mjs'));
});

test('brand-kit sync merges its own catalog history and keeps authored copy, evidence and changed stock pages', async t => {
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
  const oldFragment = '<span class="eyebrow">Ads</span><h1 class="page-title">Earlier overview</h1>\n';
  await write('src/pages/ads/index.html', oldFragment);
  record.files['src/pages/ads/index.html'] = hash(oldFragment);
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
  assert.equal(await read('src/pages/ads/index.html'), await fs.readFile(stockTemplatePath('src/pages/ads/index.html', 'brand-kit'), 'utf8'));
  assert.equal(synced.files.find(file => file.path === 'src/pages/index.html').status, 'customized');
  for (const [relative, content] of Object.entries(authored)) assert.equal(await read(relative), content, relative);
  for (const [relative] of starterFragments('brand-kit').filter(([relative]) => relative.startsWith('src/pages/decks/'))) await fs.access(path.join(root, relative));
  assert.deepEqual((await syncStarter({ designSystemRoot: root, version })).written, []);
});

for (const customized of [false, true]) test(`upgrade brings a pre-landing kit current and preserves ${customized ? 'authored Use content and routing' : 'its overview and an incomplete starter record'}`, async t => {
  const { root, read, write } = await fixture(t);
  const historical = JSON.parse(await fs.readFile(path.join(packageRoot, 'templates/starter-history/brand-kit/site-1.json'), 'utf8'));
  const site = structuredClone(historical);
  const record = await readStarterRecord(root);
  record.baseline.site = historical;
  // Files may lag behind the record: released hashes, not just recorded
  // hashes, must identify the stock composer and Install page.
  if (!customized) delete record.baseline.site;
  delete record.files['src/pages/use/compose.html'];
  await fs.rm(path.join(root, 'src/pages/use/compose.html'));
  const stock = JSON.parse(await read('.timds/stock.json'));
  stock.paths = stock.paths.filter(relative => relative !== 'src/pages/use/compose.html');
  await write('.timds/stock.json', json(stock));
  const oldUse = await fs.readFile(path.join(packageRoot, 'src/fixtures/brand-kit-before-landing/use.html'), 'utf8');
  const oldInstall = await fs.readFile(path.join(packageRoot, 'src/fixtures/brand-kit-before-landing/install.html'), 'utf8');
  const authoredUse = `${oldUse}\n<!-- Owner's composer guidance. -->\n`;
  if (customized) {
    site.home = 'social';
    Object.assign(site.views.find(view => view.id === 'use').pages[0], {title: 'Our studio', layout: 'page'});
  }
  await write('src/site.json', json(site));
  await write('.timds/starter.json', json(record));
  await write('src/pages/use/index.html', customized ? authoredUse : oldUse);
  await write('src/pages/use/install.html', oldInstall);
  for (const page of ['components', 'layout']) await write(`src/pages/web/${page}.html`, await fs.readFile(path.join(packageRoot, `src/fixtures/brand-kit-before-landing/${page}.html`), 'utf8'));
  const preserved = Object.fromEntries(await Promise.all(['src/copy.json', 'tokens/color.json', 'media.json', 'src/pages/brand/evidence.html', 'src/styles/system.css', 'src/layout.html', '.timds/stock.json'].map(async relative => [relative, await read(relative)])));
  git(root, 'add', '--all'); git(root, 'commit', '-qm', 'Kit before the landing split');
  await quiet(() => checkWorkspace(root));
  const upgraded = await quiet(() => upgradeRepository(root));
  assert.deepEqual(upgraded.starter.site.addedPages, ['use/compose']);
  const after = JSON.parse(await read('src/site.json'));
  const use = after.views.find(view => view.id === 'use');
  assert.deepEqual(use.pages.map(page => page.slug), ['', 'compose', 'install']);
  assert.equal(use.pages[1].promote, 'Start making');
  assert.equal(use.pages[1].planned, undefined);
  assert.equal(use.pages[0].layout, customized ? 'page' : 'landing');
  assert.equal(use.pages[0].title, customized ? 'Our studio' : 'Landing');
  assert.equal(after.home, customized ? 'social' : undefined);
  assert.equal(await read('src/pages/use/index.html'), customized ? authoredUse : await fs.readFile(stockTemplatePath('src/pages/use/index.html', 'brand-kit'), 'utf8'));
  assert.equal(upgraded.starter.files.find(file => file.path === 'src/pages/use/index.html').status, customized ? 'customized' : 'updated');
  for (const [relative, content] of Object.entries(preserved)) assert.equal(await read(relative), content, relative);
  assert.match(await read('dist/use/compose/index.html'), /data-compose /);
  assert.match(await read('dist/use/install/index.html'), /href="\/use\/compose\/#mcp"/);
  if (!customized) assert.match(await read('dist/use/index.html'), /<div class="landing">/);
  assert.equal(upgraded.starter.check.machine.counts.untyped, 0);
  git(root, 'add', '--all'); git(root, 'commit', '-qm', 'Upgrade the kit');
  const repeated = await quiet(() => upgradeRepository(root));
  assert.deepEqual(repeated.starter.written, []);
  assert.equal(repeated.starter.recordWritten, false);
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

test('kit-specific managed pages participate in dirty guards while builder-owned data does not', async t => {
  const { root, read, write } = await fixture(t);
  const page = 'src/pages/social/posts.html';
  const before = await read(page);
  await write(page, `${before}\n<!-- draft change -->\n`);
  await assert.rejects(quiet(() => syncStarterWorkspace(root)), /Starter sync refuses[\s\S]*src\/pages\/social\/posts\.html/);
  await write(page, before);
  await write('src/copy.json', json({ name: 'A draft name' }));
  await fs.appendFile(path.join(root, 'src/pages/brand/evidence.html'), '\n<!-- draft evidence -->\n');
  assert.deepEqual((await quiet(() => syncStarterWorkspace(root))).written, []);
  assert.ok(starterPaths('brand-kit').includes('src/pages/social/posts.html'));
  assert.ok(!starterPaths('brand-kit').includes('src/copy.json'));
  assert.ok(!starterPaths('brand-kit').includes('src/pages/brand/evidence.html'));
});

test('a failed brand-kit sync restores its pages, shared modules and record together', async t => {
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
