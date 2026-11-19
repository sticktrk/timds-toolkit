// Smoke check of the blog posting template through the public workflow: a
// fresh system of each starter carries the stock template, shows it on its
// Components page with the system's own styles, and publishes it in the
// consumer bundle; a new block is reported until a stylesheet styles it; an
// unknown key is named and ignored; a broken file stops the check. Fixtures
// live in a temporary directory; this never publishes a system.
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {checkWorkspace, initializeRepository, runWithOutputSink} from '../src/core.mjs';
import {POSTING_SOURCE_FILE} from '../src/posting.mjs';

const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'timds-posting-template-'));
const quiet = task => runWithOutputSink(() => {}, task);
const postingWarnings = checked => (checked.machine?.warnings ?? []).filter(warning => warning.includes(POSTING_SOURCE_FILE));

try {
  for (const starter of ['starter', 'brand-kit']) {
    const root = path.join(scratch, starter);
    await quiet(() => initializeRepository(root, {standalone: true, starter, name: 'Posting fixture', systemId: `example/${starter}`}));
    const templatePath = path.join(root, ...POSTING_SOURCE_FILE.split('/'));
    const stock = JSON.parse(await fs.readFile(templatePath, 'utf8'));
    assert.deepEqual(stock.blocks.map(block => block.id), ['answer-box', 'detailed-answer', 'clock-to-watch', 'cta', 'disclaimer'], `${starter}: the stock blocks`);

    // As scaffolded: valid, every block styled, published, and nothing to report.
    let checked = await quiet(() => checkWorkspace(root));
    assert.deepEqual(postingWarnings(checked), [], `${starter}: a fresh system has no template warning`);
    const bundle = JSON.parse(await fs.readFile(path.join(root, 'dist', 'bundle.json'), 'utf8'));
    const published = bundle.files.find(file => file.path === POSTING_SOURCE_FILE);
    assert.ok(published, `${starter}: the bundle carries the template without a pattern naming it`);
    assert.equal(await fs.readFile(path.join(root, 'dist', 'bundle', ...POSTING_SOURCE_FILE.split('/')), 'utf8'), await fs.readFile(templatePath, 'utf8'));
    const page = await fs.readFile(path.join(root, 'dist', 'web', 'components', 'index.html'), 'utf8');
    for (const block of stock.blocks) assert.ok(page.includes(`<${block.element} id="${block.id}">`), `${starter}: the Components page previews #${block.id}`);
    assert.ok(page.includes('<div class="prose">') && page.includes('<td><code>#clock-to-watch</code></td><td><code>aside</code></td>'), `${starter}: preview wrapper and spec table`);

    // A new block and a misspelt key: both are reported, neither stops the check.
    const edited = structuredClone(stock);
    edited.blocks.splice(1, 0, {id: 'what-changes-this', heading: 'What changes this answer', required: true, requried: true, write: 'Facts about the reader that would change the answer.'});
    await fs.writeFile(templatePath, `${JSON.stringify(edited, null, 2)}\n`);
    checked = await quiet(() => checkWorkspace(root));
    let warnings = postingWarnings(checked);
    assert.equal(warnings.length, 2, `${starter}: ${JSON.stringify(warnings)}`);
    assert.ok(warnings.some(warning => warning.includes('blocks.what-changes-this.requried')), 'the unknown key is named');
    assert.ok(warnings.some(warning => warning.includes('no stylesheet styles (#what-changes-this)')), 'the unstyled block is named');

    // Styling the id in the system's stylesheet settles it.
    delete edited.blocks[1].requried;
    await fs.writeFile(templatePath, `${JSON.stringify(edited, null, 2)}\n`);
    await fs.appendFile(path.join(root, 'src', 'styles', 'system.css'), '\n.prose #what-changes-this { padding: var(--space-4); border: var(--size-line) solid var(--color-line); }\n');
    checked = await quiet(() => checkWorkspace(root));
    assert.deepEqual(postingWarnings(checked), [], `${starter}: a styled block is not reported`);
    assert.ok((await fs.readFile(path.join(root, 'dist', 'web', 'components', 'index.html'), 'utf8')).includes('<section id="what-changes-this">\n  <h2>What changes this answer</h2>'));

    // A file a reader could not use stops the check and says where.
    edited.blocks.push({id: 'cta'});
    await fs.writeFile(templatePath, `${JSON.stringify(edited, null, 2)}\n`);
    await assert.rejects(quiet(() => checkWorkspace(root)), /declares the block cta twice/);

    // A system without the file has no template and no warning.
    await fs.rm(templatePath);
    checked = await quiet(() => checkWorkspace(root));
    assert.deepEqual(postingWarnings(checked), []);
    assert.ok(!JSON.parse(await fs.readFile(path.join(root, 'dist', 'bundle.json'), 'utf8')).files.some(file => file.path === POSTING_SOURCE_FILE));
    assert.ok((await fs.readFile(path.join(root, 'dist', 'web', 'components', 'index.html'), 'utf8')).includes('This system keeps no blog template yet.'));
    console.log(`PASS posting template (${starter}): scaffolded, previewed, published, style and spelling reported, invalid file refused`);
  }
} finally {
  await fs.rm(scratch, {recursive: true, force: true});
}
