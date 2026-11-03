// Real-browser verification of the packaged brand-kit vocabulary. Fixtures and
// source files live in a temporary directory; this never publishes a system.
// Run after npm ci. Remotion reuses its installed browser, downloading it only
// when missing; TIMDS_BROWSER_EXECUTABLE can select an existing Chrome.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {openBrowser} from '@remotion/renderer';
import {brandKitPages, brandKitSlots, brandKitTreatments} from '../src/brand-kit.mjs';
import {checkWorkspace, createPreviewServer, initializeRepository, runWithOutputSink} from '../src/core.mjs';
import {resolveBrowserExecutable} from '../src/consumer-browser.mjs';
import {syncContractViews, writeGroupedMedia} from '../src/contract-groups.mjs';

const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'timds-brand-kit-rendering-'));
const root = path.join(scratch, 'system');
const output = path.resolve(process.env.TIMDS_VISUAL_OUTPUT || path.join(os.tmpdir(), 'timds-brand-kit-visuals'));
const readJson = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const writeJson = async (file, value) => fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
const sourcePath = id => `src/pages/${id === 'index' ? 'index' : id.includes('/') ? id : `${id}/index`}.html`;
const urlPath = id => id === 'index' ? '/' : `/${id}/`;
const invertedColors = {
  canvas: '#14212d', surface: '#1b2c3b', ink: '#f5f7fa', muted: '#bdcbd8', line: '#607589',
  accent: '#f0ce70', 'accent-ink': '#17202a', 'accent-soft': '#34423e', 'accent-2': '#c8b4ff',
  'ink-ground': '#e9eef2', 'ink-ground-text': '#17202a',
};
const results = {scenarios: [], errors: []};
let browser, server;

async function assertPortableSource() {
  const literal = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|oklch|oklab)\(/i;
  for (const relative of ['src/layout.html', ...brandKitPages.authored.map(sourcePath)]) {
    const source = await fs.readFile(path.join(root, relative), 'utf8');
    for (const [, reference] of source.matchAll(/\b(?:href|src)\s*=\s*["']([^"']*)["']/gi)) {
      assert.ok(!reference || /^(?:\/|#|\{\{|https?:|mailto:|tel:|data:)/.test(reference), `${relative} has a relative reference: ${reference}`);
    }
    for (const [, style] of source.matchAll(/\bstyle\s*=\s*"([^"]*)"/gi)) assert.ok(!literal.test(style), `${relative} has a color literal in a style attribute`);
    for (const [, css] of source.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) assert.ok(!literal.test(css), `${relative} has a color literal in a style block`);
  }
}

async function populateMedia(colors) {
  const images = [];
  const svg = (key, fill) => key.startsWith('photo-') || key === 'illustration'
    ? '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800" viewBox="0 0 1200 800"><rect width="600" height="800" fill="#ffffff"/><rect x="600" width="600" height="800" fill="#000000"/><circle cx="600" cy="400" r="240" fill="#d98748"/></svg>'
    : `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="64" viewBox="0 0 240 64"><rect x="4" y="12" width="36" height="36" rx="8" fill="${fill}"/><text x="52" y="44" font-family="sans-serif" font-size="38" fill="${fill}">Sample</text></svg>`;
  await fs.mkdir(path.join(root, 'src/assets'), {recursive: true});
  for (const slot of brandKitSlots.filter(slot => slot.kind === 'media' && slot.key !== 'media.icon-family')) {
    const key = slot.key.slice(6), filename = `fixture-${key}.svg`;
    const bytes = Buffer.from(svg(key, key === 'logo-on-dark' ? colors['ink-ground-text'] : colors.ink));
    await fs.writeFile(path.join(root, 'src/assets', filename), bytes);
    images.push({key, id: `fixture_${key.replaceAll('-', '_')}`, title: `Sample ${key}`, filename,
      contentType: 'image/svg+xml', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
      publicUrl: `https://example.invalid/assets/${filename}`, path: `src/assets/${filename}`, label: 'observed'});
  }
  await writeGroupedMedia(root, {schemaVersion: 2, assets: images});
}

// This function runs in Chrome. It resolves colors through CSS (including
// aliases and color-mix), composites ancestor grounds, and checks actual text
// and treatment pairings. No source color is inferred from a class name.
function inspectPage(treatments, {accentOnly = false, expectedAccentLogo = null} = {}) {
  const failures = [], pairs = [], count = {canvas: 0, text: 0, image: 0};
  const probe = document.createElement('span');
  probe.style.cssText = 'position:absolute;visibility:hidden;transition:none !important';
  document.body.append(probe);
  const rgba = value => {
    probe.style.color = value;
    const normalized = getComputedStyle(probe).color;
    const values = normalized.match(/[\d.]+/g)?.map(Number) || [];
    if (/^color\(srgb /.test(normalized)) return [values[0] * 255, values[1] * 255, values[2] * 255, values[3] ?? 1];
    return [values[0] || 0, values[1] || 0, values[2] || 0, values[3] ?? 1];
  };
  const over = (foreground, background) => [...foreground.slice(0, 3).map((channel, index) => channel * foreground[3] + background[index] * (1 - foreground[3])), 1];
  const luminance = color => color.slice(0, 3).map(channel => channel / 255).map(channel => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4).reduce((total, channel, index) => total + channel * [0.2126, 0.7152, 0.0722][index], 0);
  const contrast = (a, b) => (Math.max(luminance(a), luminance(b)) + 0.05) / (Math.min(luminance(a), luminance(b)) + 0.05);
  const visible = element => {
    const style = getComputedStyle(element), rect = element.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
  };
  const describe = element => `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ''}${element.className && typeof element.className === 'string' ? `.${element.className.trim().replaceAll(/\s+/g, '.')}` : ''}`;
  const grounds = element => {
    const ancestors = [];
    for (let cursor = element; cursor; cursor = cursor.parentElement) ancestors.unshift(cursor);
    let backgrounds = [[255, 255, 255, 1]];
    for (const ancestor of ancestors) {
      const style = getComputedStyle(ancestor), background = rgba(style.backgroundColor);
      backgrounds = backgrounds.map(current => over(background, current));
      if (ancestor.classList.contains('canvas--photo') && ancestor.querySelector('.canvas-photo[src]:not([src=""])')) {
        // A scrim has to work over both the lightest and darkest source pixel.
        const scrim = rgba(getComputedStyle(ancestor, '::before').backgroundColor);
        backgrounds = [[0, 0, 0, 1], [255, 255, 255, 1]].map(pixel => over(scrim, pixel));
      }
    }
    return backgrounds;
  };
  const checkPair = (element, background, ink, name) => {
    const groundValue = rgba(getComputedStyle(element).backgroundColor), inkValue = rgba(getComputedStyle(element).color);
    const expectedGround = rgba(`var(--${background.replaceAll('.', '-')})`), expectedInk = rgba(`var(--${ink.replaceAll('.', '-')})`);
    const same = (a, b) => a.every((channel, index) => Math.abs(channel - b[index]) < 0.6);
    if (!same(groundValue, expectedGround) || !same(inkValue, expectedInk)) failures.push(`${name} does not use ${background} / ${ink}`);
    pairs.push({name, ground: groundValue, ink: inkValue, contrast: contrast(groundValue, inkValue)});
    if (contrast(groundValue, inkValue) < 4.5) failures.push(`${name} pair has contrast ${contrast(groundValue, inkValue).toFixed(2)} (<4.5)`);
  };
  if (!accentOnly) checkPair(document.body, 'color.canvas', 'color.ink', 'body');
  const dark = matchMedia('(prefers-color-scheme: dark)').matches;
  for (const chrome of accentOnly ? [] : document.querySelectorAll('.appbar, .sidenav')) checkPair(chrome, dark ? 'color.ink-ground' : 'color.surface', dark ? 'color.ink-ground-text' : 'color.ink', describe(chrome));
  for (const canvas of document.querySelectorAll(accentOnly ? '.canvas--accent' : '.canvas')) {
    const treatment = treatments.find(item => canvas.classList.contains(`canvas--${item.id}`) || (item.id === 'bold' && canvas.classList.contains('canvas--ink')));
    if (canvas.classList.contains('compose__canvas')) checkPair(canvas, 'color.surface', 'color.ink', 'composer');
    else if (!treatment) failures.push(`${describe(canvas)} does not declare a treatment`);
    else checkPair(canvas, treatment.ground, treatment.ink, treatment.id);
    count.canvas++;
    const frame = canvas.closest('.canvas-frame');
    if (frame) {
      const style = getComputedStyle(frame), width = Number(style.getPropertyValue('--cw')), height = Number(style.getPropertyValue('--ch'));
      const actual = canvas.getBoundingClientRect();
      if (!(width > 0 && height > 0 && actual.width > 0 && actual.height > 0) || Math.abs(actual.width / actual.height - width / height) > 0.02) failures.push(`${describe(canvas)} lost its catalog aspect ratio`);
    }
    const logos = [...canvas.querySelectorAll('.canvas-logo')].filter(visible);
    if (logos.length > 1) failures.push(`${describe(canvas)} displays both logo variants`);
    if (canvas.classList.contains('canvas--accent') && canvas.hasAttribute('data-logo-auto')) {
      const expected = expectedAccentLogo || (luminance(rgba(getComputedStyle(canvas).color)) > 0.179 ? 'dark' : 'light');
      if (canvas.dataset.logo !== expected) failures.push(`${describe(canvas)} did not select its logo from the computed ink`);
      const alternate = canvas.querySelector('.canvas-logo[data-on-dark][src]:not([src=""])');
      const primary = canvas.querySelector('.canvas-logo:not([data-on-dark])[src]:not([src=""])');
      if (primary && alternate && (logos.length !== 1 || logos[0].hasAttribute('data-on-dark') !== (expected === 'dark'))) failures.push(`${describe(canvas)} selected an unreadable logo variant`);
    }
  }
  const textSelector = '.canvas *, .button, .field label, .field input, .field small, .card *, .badge, .site-nav a, .site-footer, .site-footer *, .appbar *, .sidenav *';
  for (const element of accentOnly ? [] : new Set(document.querySelectorAll(textSelector))) {
    if (!visible(element) || ![...element.childNodes].some(node => node.nodeType === Node.TEXT_NODE && node.textContent.trim())) continue;
    const style = getComputedStyle(element), ink = rgba(style.color);
    const ratio = Math.min(...grounds(element).map(ground => contrast(over(ink, ground), ground)));
    const size = Number.parseFloat(style.fontSize), weight = Number.parseFloat(style.fontWeight);
    const required = size >= 24 || (size >= 18.66 && weight >= 700) ? 3 : 4.5;
    if (ratio + 0.01 < required) failures.push(`${describe(element)} text contrast ${ratio.toFixed(2)} (<${required})`);
    const canvas = element.closest('.canvas');
    if (canvas && !canvas.classList.contains('compose__canvas')) {
      const parent = canvas.getBoundingClientRect(), child = element.getBoundingClientRect();
      if (child.left < parent.left - 1 || child.top < parent.top - 1 || child.right > parent.right + 1 || child.bottom > parent.bottom + 1) failures.push(`${describe(element)} overflows its canvas`);
    }
    count.text++;
  }
  for (const image of document.images) {
    if ((accentOnly && !image.closest('.canvas--accent')) || !visible(image) || !(image.getAttribute('src') || '').trim()) continue;
    count.image++;
    if (!image.complete || !image.naturalWidth) failures.push(`${describe(image)} did not load ${image.getAttribute('src')}`);
  }
  probe.remove();
  return {failures, pairs, count};
}

// Inspect the actual rendered fallback, including the 0.1.485 authored overlay
// that upgrades retain. The available media alone does not identify which logo
// a treatment displays: light treatments cannot use an on-dark-only mark.
function inspectLogoFallbacks() {
  const probe = document.createElement('span');
  probe.style.cssText = 'background:var(--color-surface);transition:none !important';
  document.body.append(probe);
  const surface = getComputedStyle(probe).backgroundColor;
  probe.remove();
  const visible = element => {
    const style = getComputedStyle(element), rect = element.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
  };
  return ['minimal', 'accent', 'bold', 'photo'].map(treatment => {
    const canvas = document.querySelector(`.canvas--${treatment}`);
    const primary = canvas.querySelector('.kit-brand .canvas-logo:not([data-on-dark])');
    const alternate = canvas.querySelector('.kit-brand .canvas-logo[data-on-dark]');
    const mark = canvas.querySelector('.kit-brand .canvas-mark');
    return {
      treatment, selection: canvas.dataset.logo,
      visible: Object.entries({primary, alternate, mark}).filter(([, node]) => visible(node)).map(([name]) => name),
      plate: getComputedStyle(primary).backgroundColor, surface,
    };
  });
}

try {
  await fs.mkdir(output, {recursive: true});
  await runWithOutputSink(() => {}, () => initializeRepository(root, {standalone: true, starter: 'brand-kit', name: 'Brand kit fixture', systemId: 'example/brand-kit'}));
  await assertPortableSource();
  const colorFile = path.join(root, 'tokens/color.json');
  const stock = await readJson(colorFile);
  server = createPreviewServer({artifactRoot: path.join(root, 'dist'), entryPath: 'index.html'});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await openBrowser('chrome', {browserExecutable: await resolveBrowserExecutable(), logLevel: 'error'});
  const page = await browser.newPage({context: () => null, logLevel: 'error', indent: false, pageIndex: 0, onBrowserLog: null, onLog: () => {}});
  await page.setViewport({width: 1440, height: 1050, deviceScaleFactor: 1});
  await page._client().send('Emulation.setEmulatedMedia', {features: [{name: 'prefers-reduced-motion', value: 'reduce'}]});
  for (const scenario of ['stock', 'inverted', 'inverted-dark', 'media', 'media-light-accent']) {
    await page._client().send('Emulation.setEmulatedMedia', {features: [{name: 'prefers-reduced-motion', value: 'reduce'}, {name: 'prefers-color-scheme', value: scenario === 'inverted-dark' ? 'dark' : 'light'}]});
    const colors = structuredClone(stock);
    if (scenario.startsWith('inverted')) for (const [key, value] of Object.entries(invertedColors)) colors[key].value = value;
    if (scenario === 'media-light-accent') { colors.accent.value = '#f0ce70'; colors['accent-ink'].value = '#17202a'; }
    await writeJson(colorFile, colors);
    if (scenario === 'media') await populateMedia({ink: '#17202a', 'ink-ground-text': '#ffffff'});
    await syncContractViews(root);
    const checked = await runWithOutputSink(() => {}, () => checkWorkspace(root));
    if (checked.machine.counts.untyped) results.errors.push(`${scenario} has ${checked.machine.counts.untyped} untyped prose entries: ${checked.machine.pages.flatMap(page => (page.blocks || []).flatMap(block => (block.prose || []).map(prose => `${page.id}#${block.id}: ${JSON.stringify(prose)}`))).join('; ')}`);
    const current = {name: scenario, pages: [], warnings: checked.machine.warnings};
    results.scenarios.push(current);
    const directory = path.join(output, scenario);
    await fs.mkdir(directory, {recursive: true});
    for (const id of brandKitPages.authored) {
      const response = await page.goto({url: `${origin}${urlPath(id)}`, timeout: 15_000});
      assert.equal(response?.status(), 200, `${scenario} ${id} did not render`);
      await page.evaluate(async () => {
        await document.fonts.ready;
        await Promise.all([...document.images].filter(image => image.getAttribute('src')).map(image => image.decode().catch(() => {})));
      });
      // Changing just the accent pair is deliberately a partial palette: it
      // cannot validate accent-colored text on other grounds. This regression
      // isolates the Accent treatment's pair and actual logo selection.
      const accentOnly = scenario === 'media-light-accent';
      const result = await page.evaluate(inspectPage, brandKitTreatments, {accentOnly, expectedAccentLogo: scenario === 'media' ? 'dark' : accentOnly ? 'light' : null});
      current.pages.push({id, ...result});
      results.errors.push(...result.failures.map(failure => `${scenario} ${id}: ${failure}`));
      // Every authored page is inspected; screenshots concentrate on previews
      // plus the overview/component/layout pages so artifacts stay reviewable.
      if (result.count.canvas || ['index', 'web/components', 'web/layout'].includes(id)) {
        const clips = await page.evaluate(accentOnly => {
          const selectors = accentOnly ? ['.canvas--accent'] : ['.canvas--minimal', '.canvas--accent', '.canvas--bold, .canvas--ink', '.canvas--photo'];
          const canvases = selectors.map(selector => document.querySelector(selector)).filter(Boolean);
          const elements = canvases.length ? canvases : [document.querySelector('.canvas-frame') || document.querySelector('main') || document.body];
          return elements.map((element, index) => {
            const first = element.closest('.canvas-frame') || element, rect = first.getBoundingClientRect();
            return {name: canvases.length ? (accentOnly ? 'accent' : ['minimal', 'accent', 'bold', 'photo'][index]) : 'page', clip: {x: Math.max(0, rect.x + scrollX - 24), y: Math.max(0, rect.y + scrollY - 24), width: Math.min(1360, Math.max(600, rect.width + 48)), height: Math.min(1400, Math.max(400, rect.height + 48)), scale: 1}};
          });
        }, accentOnly);
        for (const {name, clip} of clips) {
          const screenshot = await page._client().send('Page.captureScreenshot', {format: 'png', captureBeyondViewport: true, clip});
          await fs.writeFile(path.join(directory, `${id.replaceAll('/', '-')}-${name}.png`), Buffer.from(screenshot.value.data, 'base64'));
        }
      }
    }
    console.log(`Brand kit ${scenario}: checked ${current.pages.length} pages, ${current.pages.reduce((total, result) => total + result.count.canvas, 0)} canvases and ${current.pages.reduce((total, result) => total + result.count.text, 0)} text pairs`);
  }
  await writeJson(path.join(output, 'report.json'), results);
  // The automatic marker survives selection, so a theme change can select
  // the other variant without an authored HTML edit or a page reload.
  await page.goto({url: `${origin}/social/posts/`, timeout: 15_000});
  await page.evaluate(() => {
    const style = document.createElement('style');
    style.id = 'fixture-accent-theme';
    style.textContent = '@media (prefers-color-scheme: dark) { .canvas--accent { color: color(srgb 1 1 1); } }';
    document.head.append(style);
  });
  const settleTheme = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve)))));
  await page._client().send('Emulation.setEmulatedMedia', {features: [{name: 'prefers-color-scheme', value: 'dark'}]});
  await settleTheme();
  const themedLogos = await page.evaluate(() => [...document.querySelectorAll('.canvas--accent')].map(node => [node.hasAttribute('data-logo-auto'), node.dataset.logo]));
  assert.ok(themedLogos.length > 0 && themedLogos.every(([automatic, variant]) => automatic && variant === 'dark'), 'a theme change reselects automatic logos from the new ink');
  await page._client().send('Emulation.setEmulatedMedia', {features: [{name: 'prefers-color-scheme', value: 'light'}]});
  await settleTheme();
  assert.ok((await page.evaluate(() => [...document.querySelectorAll('.canvas--accent')].map(node => node.dataset.logo))).every(value => value === 'light'), 'switching back restores the primary logo');
  // Every partial catalog must show exactly the usable logo or its wordmark.
  // Existing kits keep their authored system.css, including the old blanket
  // hide rule, so verify the managed canvas CSS repairs that version too.
  const media = await readJson(path.join(root, 'media.json'));
  results.logoFallbacks = [];
  for (const [name, keys] of [['none', []], ['primary-only', ['logo']], ['alternate-only', ['logo-on-dark']], ['both', ['logo', 'logo-on-dark']]]) {
    await writeGroupedMedia(root, {...media, assets: media.assets.filter(asset => !['logo', 'logo-on-dark'].includes(asset.key) || keys.includes(asset.key))});
    for (const accent of ['light', 'dark']) {
      const colors = structuredClone(stock);
      if (accent === 'light') { colors.accent.value = '#f0ce70'; colors['accent-ink'].value = '#17202a'; }
      await writeJson(colorFile, colors);
      await runWithOutputSink(() => {}, () => checkWorkspace(root));
      await page.goto({url: `${origin}/social/posts/`, timeout: 15_000});
      await page.evaluate(async () => { await Promise.all([...document.images].filter(image => image.getAttribute('src')).map(image => image.decode().catch(() => {}))); });
      for (const overlay of ['current', '0.1.485']) {
        if (overlay === '0.1.485') await page.evaluate(() => {
          const style = document.createElement('style');
          style.textContent = '.kit-brand:has(.canvas-logo[src]:not([src=""])) .canvas-mark { display: none; }';
          document.head.append(style);
        });
        const canvases = await page.evaluate(inspectLogoFallbacks);
        for (const canvas of canvases) {
          const label = `${name}, ${accent} Accent, ${overlay} overlay, ${canvas.treatment}`;
          const dark = canvas.treatment === 'bold' || canvas.treatment === 'photo' || (canvas.treatment === 'accent' && accent === 'dark');
          const expected = dark && keys.includes('logo-on-dark') ? 'alternate' : keys.includes('logo') ? 'primary' : 'mark';
          if (canvas.treatment === 'accent') assert.equal(canvas.selection, accent, `${label}: automatic logo selection`);
          assert.deepEqual(canvas.visible, [expected], `${label}: show exactly the usable logo or wordmark`);
          if (dark && expected === 'primary') assert.equal(canvas.plate, canvas.surface, `${label}: primary fallback receives its surface plate`);
        }
        results.logoFallbacks.push({name, accent, overlay, canvases});
      }
    }
  }
  console.log(`Brand kit logo fallbacks: checked ${results.logoFallbacks.reduce((total, result) => total + result.canvases.length, 0)} treatment/media combinations across current and retained 0.1.485 overlays`);
  const focal = await page.evaluate(() => {
    const photo = document.querySelector('.canvas-photo');
    photo.style.setProperty('transition', 'none', 'important');
    photo.style.setProperty('--focal-position', '20% 30%');
    return getComputedStyle(photo).objectPosition;
  });
  assert.equal(focal, '20% 30%', 'photos read the focal custom property');
  await writeJson(path.join(output, 'report.json'), results);
  assert.equal(results.errors.length, 0, `Brand-kit rendering failed:\n${results.errors.join('\n')}`);
  console.log(`Brand-kit visual evidence: ${output}`);
} finally {
  if (browser) await browser.close({silent: true});
  if (server) await new Promise(resolve => server.close(resolve));
  await fs.rm(scratch, {recursive: true, force: true});
}
