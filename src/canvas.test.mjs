import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {checkWorkspace, initializeRepository} from './core.mjs';

const json = value => `${JSON.stringify(value, null, 2)}\n`;

test('shared canvas pieces build with the original starter tokens and catalog geometry', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'timds-canvas-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  await initializeRepository(root, {standalone: true});
  const site = JSON.parse(await fs.readFile(path.join(root, 'src/site.json'), 'utf8'));
  site.views.find(view => view.id === 'web').pages.push({slug: 'canvas-pieces', title: 'Canvas pieces'});
  await fs.writeFile(path.join(root, 'src/site.json'), json(site));
  const formats = JSON.parse(await fs.readFile(path.join(root, 'src/formats.json'), 'utf8'));
  formats.print.formats['fixture-name-badge'] = {name: 'Name badge', width: 3, height: 4, safe: 0.125, bleed: 0.125, page: 'web/canvas-pieces'};
  await fs.writeFile(path.join(root, 'src/formats.json'), json(formats));
  await fs.mkdir(path.join(root, 'src/assets'), {recursive: true});
  await fs.writeFile(path.join(root, 'src/assets/fixture-mark.svg'), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 24"><text x="0" y="18" fill="currentColor">Sample</text></svg>');
  const content = treatment => `<div class="canvas canvas--${treatment}" data-logo="dark">
    <img class="canvas-photo canvas-photo--background" src="/assets/fixture-mark.svg" alt="Sample artwork">
    <div class="canvas-safe">
      <div><img class="canvas-logo" src="/assets/fixture-mark.svg" alt="Sample mark"><img class="canvas-logo" data-on-dark src="/assets/fixture-mark.svg" alt="Sample mark on dark"></div>
      <span class="canvas-eyebrow">Sample topic</span><p class="canvas-display">One <em>clear</em> thought</p>
      <p class="canvas-body">One supporting sentence.</p><span class="canvas-badge">Sample label</span><span class="canvas-rule"></span>
      <span class="canvas-button">Learn more</span><div class="canvas-foot"><span>Sample</span><span class="canvas-count">2 / 5</span></div>
    </div>
  </div>`;
  await fs.writeFile(path.join(root, 'src/pages/web/canvas-pieces.html'), `<h1 class="page-title">Canvas pieces</h1>
<section class="block" id="previews"><h2 class="h2">Previews</h2><p>The catalog owns each frame's dimensions.</p>
<div class="canvas-deck-grid">${['minimal', 'accent', 'bold', 'photo'].map(treatment => `<figure><div class="canvas-frame" style="{{canvas:web-1920x1080}}">${content(treatment)}</div><figcaption>${treatment}</figcaption></figure>`).join('\n')}</div>
<figure><div class="canvas-frame canvas-frame--business-card" style="{{canvas:business-card}}"><div class="canvas canvas--print canvas--minimal"><div class="canvas-safe"><span class="canvas-mark">Sample</span><span class="canvas-count">Contact</span></div></div></div></figure>
<figure><div class="canvas-frame canvas-frame--name-badge" style="{{canvas:fixture-name-badge}}"><div class="canvas canvas--print canvas--accent"><div class="canvas-safe"><span class="canvas-mark">Sample</span><span class="canvas-badge">Guest</span></div></div></div></figure>
</section>\n`);
  const checked = await checkWorkspace(root);
  assert.equal(checked.machine.counts.untyped, 0);
  assert.ok(checked.machine.pages.some(page => page.id === 'web/canvas-pieces'));
  const page = await fs.readFile(path.join(root, 'dist/web/canvas-pieces/index.html'), 'utf8');
  assert.doesNotMatch(page, /\{\{(?:canvas|media|copy):/);
  assert.match(page, /--cw:3\.5;--ch:2;--safe:0\.125;--bleed:0\.125/);
  assert.match(page, /--cw:3;--ch:4;--safe:0\.125;--bleed:0\.125/);
  assert.equal((page.match(/class="canvas canvas--(?:minimal|accent|bold|photo)"/g) || []).length, 4);
});
