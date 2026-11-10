import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import {
  brandKitCopySamples, brandKitFoundationTokens, brandKitLabels, brandKitPages,
  brandKitSlots, brandKitStockPaths, brandKitTreatments, brandKitViews,
} from './brand-kit.mjs';
import { checkWorkspace, initializeRepository, runWithOutputSink } from './core.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const overlay = path.join(root, 'templates/brand-kit');
const read = relative => fs.readFile(path.join(overlay, relative), 'utf8');
const json = async relative => JSON.parse(await read(relative));
const fragment = id => `src/pages/${id === 'index' ? 'index' : id.includes('/') ? id : `${id}/index`}.html`;
const escapeHtml = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');

test('the brand-kit slot export owns the exact foundation, copy, page and stock vocabulary', async () => {
  assert.equal(brandKitSlots.length, 75);
  assert.equal(new Set(brandKitSlots.map(slot => slot.key)).size, brandKitSlots.length);
  assert.deepEqual(brandKitLabels, ['confirmed', 'observed', 'assumed', 'unresolved']);
  const expectedGroups = {
    color: ['canvas', 'surface', 'ink', 'muted', 'line', 'accent', 'accent-ink', 'accent-soft', 'accent-2', 'ink-ground', 'ink-ground-text'],
    font: ['display', 'body', 'mono', 'display-weight', 'body-weight'],
    type: ['display', 'title', 'lead', 'body', 'small', 'label', 'display-tracking', 'display-case', 'display-leading', 'body-leading'],
    radius: ['control', 'card', 'media'], line: ['width'], shadow: ['card'],
    space: ['1', '2', '3', '4', '6', '8', '12', 'density'], motion: ['fast'],
  };
  assert.deepEqual(Object.keys(brandKitFoundationTokens), Object.keys(expectedGroups));
  for (const [group, keys] of Object.entries(expectedGroups)) assert.deepEqual(Object.keys(brandKitFoundationTokens[group]), keys);
  for (const slot of brandKitSlots) {
    for (const field of ['key', 'group', 'kind', 'source', 'assumption', 'guidance', 'page']) assert.ok(typeof slot[field] === 'string' && slot[field], `${slot.key}.${field}`);
    assert.equal(typeof slot.sample, 'string');
    assert.ok(brandKitLabels.includes(slot.label), slot.key);
    assert.ok(brandKitPages.authored.includes(slot.page), slot.page);
    assert.ok(Object.isFrozen(slot), slot.key);
  }
  assert.deepEqual(await json('tokens.json'), brandKitFoundationTokens);
  // A stock parent reads like the ordinary starter: its foundation samples are the starter's own.
  const stock = JSON.parse(await fs.readFile(path.join(root, 'templates/tokens.json'), 'utf8'));
  for (const [kit, starter] of [['color.canvas', 'color.canvas'], ['color.surface', 'color.surface'], ['color.ink', 'color.ink'], ['color.accent', 'color.accent'], ['font.display', 'font.serif'], ['font.body', 'font.sans'], ['font.mono', 'font.mono']]) {
    const [group, key] = kit.split('.');
    const [stockGroup, stockKey] = starter.split('.');
    assert.equal(brandKitFoundationTokens[group][key].value, stock[stockGroup][stockKey].value, kit);
  }
  assert.deepEqual(await json('src/copy.json'), brandKitCopySamples);
  assert.ok(Object.values(await json('src/copy.json')).every(value => typeof value === 'string'));
  assert.deepEqual(await json('src/site.json'), {home: 'use', views: brandKitViews});
  assert.deepEqual(await json('.timds/stock.json'), {schemaVersion: 1, paths: brandKitStockPaths});
  assert.deepEqual(brandKitViews.map(view => view.id), ['brand', 'web', 'social', 'ads', 'email', 'print', 'events', 'decks', 'use']);
  assert.deepEqual(brandKitPages.builderOwned, ['brand/evidence']);
  assert.equal(brandKitPages.authored.length, 34);
  assert.equal(brandKitPages.planned.length, 24);
  assert.ok(!brandKitStockPaths.includes('src/pages/brand/evidence.html'));
  assert.ok(brandKitStockPaths.includes('src/copy.json'));
  for (const id of brandKitPages.authored) {
    const html = await read(fragment(id));
    assert.equal((html.match(/<h1[\s>]/gi) || []).length, 1, id);
    assert.equal(brandKitStockPaths.includes(fragment(id)), !brandKitPages.builderOwned.includes(id), id);
  }
  for (const id of brandKitPages.planned) await assert.rejects(fs.access(path.join(overlay, fragment(id))), {code: 'ENOENT'});
  for (const file of brandKitStockPaths) assert.ok((await fs.lstat(path.join(overlay, file))).isFile(), file);
  assert.deepEqual(await fs.readdir(path.join(overlay, 'src/designs')), ['.gitkeep']);
  const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.exports['./brand-kit'], './src/brand-kit.mjs');
  for (const file of ['src/brand-kit.mjs', 'src/brand-kit.d.mts', 'templates']) assert.ok(pkg.files.includes(file), file);
});

test('each kit format names an authored template with all four treatments and channel stages', async () => {
  const catalog = await json('src/formats.json');
  const formats = Object.values(catalog).flatMap(group => Object.entries(group.formats));
  assert.equal(formats.length, 24);
  const ids = new Set(formats.map(([id]) => id));
  assert.equal(ids.size, formats.length);
  for (const [id, format] of formats) {
    assert.ok(brandKitPages.authored.includes(format.page), `${id}: ${format.page}`);
    const html = await read(fragment(format.page));
    for (const {id: treatment} of brandKitTreatments) {
      assert.ok(html.includes(`data-format="${id}" data-treatment="${treatment}"`), `${id}: ${treatment}`);
    }
    assert.ok(html.includes(`{{canvas:${id}}}`), id);
  }
  const carousel = await read('src/pages/social/carousel.html');
  for (const stage of ['cover', 'point', 'last']) assert.equal((carousel.match(new RegExp(`data-stage="${stage}"`, 'g')) || []).length, 4, stage);
  const deck = await read('src/pages/decks/slides.html');
  for (const stage of ['title', 'section', 'content', 'closing']) assert.equal((deck.match(new RegExp(`data-stage="${stage}"`, 'g')) || []).length, 4, stage);
  const compose = await read('src/pages/use/compose.html');
  assert.deepEqual([...compose.matchAll(/\{\{presets:([^}]+)\}\}/g)].map(match => match[1]), Object.keys(catalog));
  const landing = await read('src/pages/use/index.html');
  assert.deepEqual([...landing.matchAll(/\?format=([^"&]+)/g)].map(match => match[1]).sort(), [...ids].sort());
  assert.equal((await json('src/site.json')).home, 'use', 'the kit opens on its landing page');
});

test('the built kit quotes every slot key and its exported guidance without a preinstalled package', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'timds-kit-contract-'));
  t.after(() => fs.rm(directory, {recursive: true, force: true}));
  await runWithOutputSink(() => {}, () => initializeRepository(directory, {standalone: true, starter: 'brand-kit', name: 'Brand Kit'}));
  const {renderSite, colorLiterals} = await import('./viewer.mjs');
  await assert.rejects(fs.access(path.join(directory, 'scripts/viewer.mjs')), {code: 'ENOENT'}, 'the kit renders with the package viewer');
  const site = await renderSite(directory);
  assert.equal(site.pages, brandKitPages.authored.length);
  assert.deepEqual(site.planned, brandKitPages.planned);
  assert.equal(site.designs.length, 0);
  const html = [...site.files.values()].join('\n');
  for (const slot of brandKitSlots) {
    assert.ok(html.includes(escapeHtml(slot.key)), slot.key);
    assert.ok(html.includes(escapeHtml(slot.guidance)), `${slot.key}: guidance`);
  }
  assert.doesNotMatch(html, /\{\{(?:copy|media|slots|canvas):/);
  // Consecutive slot placeholders read as one table: one header row, every slot its own row.
  const foundation = site.files.get('brand/foundation/index.html');
  assert.equal((foundation.match(/<table class="spec slot-table">/g) || []).length, 1);
  assert.equal((foundation.match(/<tr data-slot="copy\./g) || []).length, 8);
  // The kit stylesheet never splits the chrome from the content by system preference.
  assert.doesNotMatch(await fs.readFile(path.join(directory, 'src/styles/system.css'), 'utf8'), /prefers-color-scheme/);
  assert.match(site.files.get('index.html'), /href="\/designs\/"/);
  const landing = site.files.get('index.html');
  const overview = site.files.get('overview/index.html');
  const compose = site.files.get('use/compose/index.html');
  assert.match(overview, /Coverage and assumptions/);
  assert.match(overview, /What the kit holds/);
  assert.equal(site.files.has('use/index.html'), false);
  assert.match(landing, /<div class="landing">/);
  assert.match(landing, /<nav class="sidenav" aria-label="Pages">\s*<\/nav>/);
  assert.doesNotMatch(landing, /class="pagenav"|data-compose /);
  assert.match(landing, /<a class="appbar__cta" href="\/use\/compose\/">Start making<\/a>/);
  // Every format card previews its format from the kit's slots, not a blank shape.
  const cards = [...landing.matchAll(/<a class="asset-card" href="\/use\/compose\/\?format=[^"]+"[^>]*>([\s\S]*?)<\/a>/g)].map(match => match[1]);
  assert.equal(cards.length, 24);
  for (const card of cards) assert.match(card, /aria-hidden="true"><span class="canvas [^"]*asset-card__preview[\s\S]*<span class="canvas-mark">[^<]+<\/span>[\s\S]*<span class="canvas-button">[^<]+<\/span>/);
  assert.doesNotMatch(landing, /asset-card__shape/);
  assert.match(landing, /<b>24<\/b><span>catalog formats<\/span>/);
  assert.match(landing, /<b>9<\/b><span>views, one brand<\/span>/);
  assert.match(compose, /data-compose /);
  assert.match(compose, /href="\/">the landing page<\/a>/);
  assert.match(compose, /href="\/overview\/">the overview<\/a>/);
  const formats = Object.values(await json('src/formats.json')).flatMap(group => Object.keys(group.formats));
  assert.deepEqual([...compose.matchAll(/name="preset" value="([^"]+)"/g)].map(match => match[1]), formats);
  assert.equal((compose.match(/data-prompt="[^"]+" checked/g) || []).length, 1);
  assert.match(compose, /value="business-card"[^>]+data-unit="in"/);
  assert.match(compose, /npx --yes @dtconcepts\/timds@latest consumer init --system ID/);
  for (const anchor of ['mcp', 'products', 'change']) assert.ok(site.files.get('use/install/index.html').includes(`/use/compose/#${anchor}`));
  for (const id of ['brand/color', 'brand/typography', 'web/spacing', 'web/components', 'social', 'ads', 'email', 'print', 'events', 'decks']) {
    const page = site.files.get(`${id}/index.html`);
    assert.match(page, /<figure[\s\S]*<details class="spec-drawer">\s*<summary>Spec<\/summary>/, id);
  }
  assert.deepEqual(await colorLiterals(directory), []);
  // Voice guidance is authored, but its neutral sample is not brand evidence.
  // Keep the two readiness gaps explicit instead of claiming the page is absent.
  assert.deepEqual(site.warnings, ['Brand kit voice is assumed; replace copy.voice with evidence-backed guidance before publishing.']);
  const checked = await runWithOutputSink(() => {}, () => checkWorkspace(directory));
  assert.ok(checked.machine.pages.some(page => page.id === 'overview'), 'the overview remains in the agent index');
  assert.match(await fs.readFile(path.join(directory, 'dist/llms.txt'), 'utf8'), /\/overview\/index\.md/);
  assert.equal(checked.machine.counts.untyped, 0);
  assert.deepEqual(checked.machine.warnings, ['no asset is annotated data-timds-role="logo"; the brand kit has no logo']);
  assert.deepEqual(checked.designs, { enabled: true, designCount: 0, pageCount: 0, stateCount: 0, journeyCount: 0, warnings: [] });
  const copy = JSON.parse(await fs.readFile(path.join(directory, 'src/copy.json'), 'utf8'));
  copy.voice = 'Lead with one useful fact. Show an example before a claim.';
  await fs.writeFile(path.join(directory, 'src/copy.json'), JSON.stringify(copy));
  assert.deepEqual((await renderSite(directory)).warnings, []);
});
