import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { initializeRepository, checkWorkspace } from './core.mjs';
import { brandKitCopySamples } from './brand-kit.mjs';

const json = value => `${JSON.stringify(value, null, 2)}\n`;
const asset = (key, extra = {}) => ({ key, id: `asset_${key}`, filename: `${key}.svg`, title: key, contentType: 'image/svg+xml', kind: 'image', bytes: 46, sha256: 'a'.repeat(64), publicUrl: `https://assets.example.test/${key}.svg`, tags: [], ...extra });

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'timds-viewer-slots-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await initializeRepository(root, { standalone: true });
  const read = file => fs.readFile(path.join(root, file), 'utf8');
  const write = async (file, text) => { await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true }); await fs.writeFile(path.join(root, file), text); };
  const fragment = await read('src/pages/brand/color.html');
  const page = text => write('src/pages/brand/color.html', `${fragment}\n<section class="block" id="slot-fixture"><h2>Slot fixture</h2><figure>${text}</figure></section>\n`);
  const run = () => execFileSync(process.execPath, ['scripts/build.mjs'], { cwd: root, encoding: 'utf8', stdio: 'pipe' });
  return { root, read, write, page, run };
}

test('copy and media placeholders preserve ordinary starters and render escaped grouped data', async t => {
  const { root, read, write, page, run } = await fixture(t);
  await assert.rejects(fs.access(path.join(root, 'src/copy.json')), { code: 'ENOENT' });
  assert.equal((await checkWorkspace(root)).machine.warnings.length, 2);
  await write('src/copy.json', json({ name: '<Brand & "words">', tagline: '', custom: 'A custom sample' }));
  await write('src/assets/logo.svg', '<svg xmlns="http://www.w3.org/2000/svg"></svg>');
  await write('media/assets.json', json({ logo: asset('logo', { path: 'src/assets/logo.svg', label: 'observed' }) }));
  // The grouped map is authoritative even before the aggregate is regenerated.
  await write('media.json', json({ schemaVersion: 2, assets: [asset('stale')] }));
  await page('<p>{{copy:name}} / {{copy:copy.custom}} / {{copy:tagline}}</p><img src="{{media:logo}}" alt="Mark"><span>{{media:photo-1}}</span>');
  const log = run(), html = await read('dist/brand/color/index.html');
  assert.match(html, /&lt;Brand &amp; &quot;words&quot;&gt; \/ A custom sample/);
  assert.ok(html.includes(brandKitCopySamples.tagline));
  assert.match(html, /src="\/assets\/logo\.svg"/);
  assert.match(log, /Stock samples used for unfilled slots: copy\.tagline, media\.photo-1/);
  assert.equal(await read('dist/assets/logo.svg'), await read('src/assets/logo.svg'));
  await write('src/copy.json', json({ name: ['not a string'] }));
  assert.throws(run, /src\/copy.json must be an object of string values/);
});

test('unfilled slots use stock samples and unknown keys fail clearly', async t => {
  const { page, run, read, write } = await fixture(t);
  await page('<p>{{copy:name}}</p><img src="{{media:logo}}" alt="Sample mark">');
  assert.match(run(), /copy\.name, media\.logo/);
  assert.ok((await read('dist/brand/color/index.html')).includes(brandKitCopySamples.name));
  await write('src/copy.json', json({ headlines: 'First & only' }));
  await page('<p>{{copy:headlines.0}}</p><p>{{copy:headlines.1}}</p>');
  assert.match(run(), /copy\.headlines\.1/);
  assert.match(await read('dist/brand/color/index.html'), /<p>First &amp; only<\/p><p>One useful idea at a time\.<\/p>/);
  await page('{{copy:typo}}');
  assert.throws(run, /Unknown copy slot typo/);
  await page('{{media:typo}}');
  assert.throws(run, /Unknown media slot typo/);
  await page('{{copy:constructor}}');
  assert.throws(run, /Unknown copy slot constructor/);
});

test('media slot paths refuse traversal, missing files and symlinks', async t => {
  const { root, write, page, run } = await fixture(t);
  await page('<img src="{{media:logo}}" alt="Mark">');
  for (const local of ['../secret.svg', 'src/assets/../secret.svg', '/assets/logo.svg', 'https://assets.example.test/logo.svg']) {
    await write('media/assets.json', json({ logo: asset('logo', { path: local }) }));
    assert.throws(run, /exact file under src\/assets/);
  }
  await write('media/assets.json', json({ logo: asset('logo', { path: 'src/assets/missing.svg' }) }));
  assert.throws(run, /missing local asset/);
  await write('src/assets/logo.svg', '<svg></svg>');
  await fs.symlink('logo.svg', path.join(root, 'src/assets/link.svg'));
  await write('media/assets.json', json({ logo: asset('logo', { path: 'src/assets/link.svg' }) }));
  assert.throws(run, /without symbolic links/);
  await fs.symlink('assets', path.join(root, 'src/linked-assets'));
  await write('media/assets.json', json({ logo: asset('logo', { path: 'src/linked-assets/logo.svg' }) }));
  assert.throws(run, /exact file under src\/assets/);
});

test('slot guidance renders the contract and retained provenance labels', async t => {
  const { read, write, page, run } = await fixture(t);
  const colors = JSON.parse(await read('tokens/color.json'));
  colors.canvas.label = 'confirmed';
  await write('tokens/color.json', json(colors));
  await page('{{slots:color.canvas}}');
  run();
  assert.match(await read('dist/brand/color/index.html'), /data-slot="color\.canvas"[\s\S]*?<td>confirmed<\/td>/);
  colors.canvas.label = 'invented';
  await write('tokens/color.json', json(colors));
  assert.throws(run, /invalid label/);
});
