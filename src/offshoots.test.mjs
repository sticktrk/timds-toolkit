import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { checkWorkspace, initializeRepository, runCli, runWithOutputSink, syncStarterWorkspace } from './core.mjs';
import { decodeOffshootSource, loadOffshootSource, severOffshoot, shootOffshoot, transformOffshoot } from './offshoots.mjs';
import { packageRoot } from './executable.mjs';

const sourceId = '11111111-1111-4111-8111-111111111111';
const json = value => `${JSON.stringify(value, null, 2)}\n`;
const git = (root, ...args) => execFileSync('git', ['-C', root, ...args], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}).trim();

test('binary shoot refuses before source export or destination creation with an explicit adoption path', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'timds-binary-shoot-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const destination = path.join(root, 'child');
  assert.throws(() => execFileSync(process.execPath, [path.join(packageRoot, 'bin/timds.mjs'), 'shoot', 'example/core', '--system-id', 'example/child', '--root', destination], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    env: {...process.env, TIMDS_BINARY_EXECUTABLE: '/example/timds-cli', TIMDS_RUNTIME_ROOT: root, TIMDS_RUNTIME_PACKAGE: packageRoot},
  }), error => error.status === 1 && /Local shoot currently requires the npm CLI/.test(error.stderr) && /installation adopt --binary --apply/.test(error.stderr));
  await assert.rejects(fs.access(destination), {code: 'ENOENT'});
});
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'timds-offshoot-'));
  t.after(() => fs.rm(directory, {force: true, recursive: true}));
  const root = path.join(directory, 'parent');
  await fs.mkdir(root);
  git(root, 'init', '-q', '-b', 'main'); git(root, 'config', 'user.email', 'test@example.com'); git(root, 'config', 'user.name', 'Test');
  await initializeRepository(root, {standalone: true, systemId: 'example/core', name: 'Example Core'});
  const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  await fs.writeFile(path.join(root, 'package-lock.json'), json({name: pkg.name, version: pkg.version, lockfileVersion: 3, packages: {'': {name: pkg.name, version: pkg.version}}}));
  await fs.writeFile(path.join(root, '.timds/stock.json'), json({schemaVersion: 1, paths: ['src/pages/brand/color.html', 'src/styles/system.css']}));
  git(root, 'add', '--all'); git(root, 'commit', '-qm', 'Parent release');
  return {root, directory, source: await loadOffshootSource(root, {sourceId})};
}

test('shoot creates full and structure offshoots that pass a real workspace check', async t => {
  const {root, directory, source} = await fixture(t);
  const parentBytes = await fs.readFile(path.join(root, 'src/pages/brand/color.html'));
  for (const mode of ['full', 'structure']) {
    const destination = path.join(directory, mode);
    const result = await shootOffshoot({destination, source, mode, systemId: `example/${mode}`, name: `Example ${mode}`, check: checkWorkspace});
    const checked = await checkWorkspace(destination);
    assert.equal(checked.manifest.systemId, `example/${mode}`);
    assert.deepEqual(checked.machine.index.lineage, {systemId: 'example/core', sourceId, version: source.parent.version, commit: source.parent.commit, mode});
    assert.equal(result.parent.commit, git(root, 'rev-parse', 'HEAD'));
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(destination, 'package-lock.json'), 'utf8')).packages[''].name, `example-${mode}`);
    assert.equal(git(destination, 'rev-parse', '--show-toplevel'), await fs.realpath(destination));
    if (mode === 'full') {
      assert.deepEqual(await fs.readFile(path.join(destination, 'src/pages/brand/color.html')), parentBytes);
      assert.equal(checked.machine.warnings.length, 2);
    } else {
      assert.ok(checked.machine.warnings.some(warning => warning.includes('unresolved (initial)')));
      assert.deepEqual(checked.mediaCatalog.assets, []);
      assert.deepEqual(JSON.parse(await fs.readFile(path.join(destination, 'src/formats.json'), 'utf8')), JSON.parse(await fs.readFile(path.join(root, 'src/formats.json'), 'utf8')));
      assert.ok(checked.machine.index.pages.some(page => page.id === 'brand/color'));
      await assert.rejects(fs.access(path.join(destination, 'src/pages/web/components.html')), {code: 'ENOENT'});
      await assert.rejects(fs.access(path.join(destination, 'src/designs')), {code: 'ENOENT'});
      const site = JSON.parse(await fs.readFile(path.join(destination, 'src/site.json'), 'utf8'));
      assert.equal(site.views.find(view => view.id === 'brand').pages.find(page => page.slug === 'color').planned, false);
      assert.equal(site.views.find(view => view.id === 'web').pages.find(page => page.slug === 'components').planned, true);
    }
  }
  const skeleton = path.join(directory, 'skeleton');
  await shootOffshoot({destination: skeleton, source: {...source, files: source.files.filter(file => file.path !== '.timds/stock.json')}, mode: 'structure', systemId: 'example/skeleton', check: checkWorkspace});
  assert.equal((await checkWorkspace(skeleton)).machine.index.pages.length >= 1, true);
  assert.match(await fs.readFile(path.join(skeleton, 'src/styles/system.css'), 'utf8'), /Replace placeholder tokens/);
});

test('shoot records the hash of every declared stock file in both modes, and an empty map without a declaration', async t => {
  const {root, directory, source} = await fixture(t);
  const sha256 = async relative => createHash('sha256').update(await fs.readFile(path.join(root, relative))).digest('hex');
  const expected = {'src/pages/brand/color.html': await sha256('src/pages/brand/color.html'), 'src/styles/system.css': await sha256('src/styles/system.css')};
  for (const mode of ['full', 'structure']) {
    const destination = path.join(directory, `hashed-${mode}`);
    const result = await shootOffshoot({destination, source, mode, systemId: `example/hashed-${mode}`});
    const record = JSON.parse(await fs.readFile(path.join(destination, '.timds/parent.json'), 'utf8'));
    assert.deepEqual(record.files, expected, mode);
    assert.deepEqual(result.parent.files, expected, mode);
    const checked = await checkWorkspace(destination);
    assert.deepEqual(checked.offshoot.parent.files, expected, 'check accepts the hashed record');
    assert.equal('files' in checked.machine.index.lineage, false, 'lineage never carries the hashes');
    const transformed = await transformOffshoot(source, {mode, systemId: `example/wire-${mode}`});
    assert.deepEqual(transformed.parent.files, expected);
    const bare = await transformOffshoot({...source, files: source.files.filter(file => file.path !== '.timds/stock.json')}, {mode, systemId: `example/bare-${mode}`});
    assert.deepEqual(bare.parent.files, {}, `${mode} without a stock declaration`);
    assert.deepEqual(JSON.parse(Buffer.from(bare.files.find(file => file.path === '.timds/parent.json').content, 'base64').toString('utf8')).files, {});
  }
});

test('structure shoots retain the verified composer and explicitly declared copy samples', async t => {
  const {root, directory} = await fixture(t);
  const copy = json({name: 'Sample brand', tagline: 'A useful idea, clearly expressed.'});
  await fs.writeFile(path.join(root, 'src/copy.json'), copy);
  await fs.writeFile(path.join(root, '.timds/stock.json'), json({schemaVersion: 1, paths: [
    'src/layout.html', 'src/styles/system.css', 'src/pages/use/index.html',
    'src/pages/use/compose.html', 'src/pages/use/install.html', 'src/copy.json',
  ]}));
  git(root, 'add', '--all'); git(root, 'commit', '-qm', 'Reusable composer and copy samples');
  const source = await loadOffshootSource(root, {sourceId});
  const destination = path.join(directory, 'compose-child');
  await shootOffshoot({destination, source, mode: 'structure', systemId: 'example/compose-child', check: checkWorkspace});
  const read = relative => fs.readFile(path.join(destination, relative), 'utf8');
  assert.equal(await read('src/copy.json'), copy, 'declared copy remains byte-identical');
  const script = await fs.readFile(path.join(root, 'src/scripts/compose.js'), 'utf8');
  assert.equal(await read('src/scripts/compose.js'), script);
  assert.equal(await read('dist/scripts/compose.js'), script, 'the shared viewer copies the admitted script into the artifact');
  const use = await read('dist/use/compose/index.html');
  assert.match(use, /<figure class="compose__app" data-compose/);
  assert.match(use, /<script src="\/scripts\/compose\.js" defer><\/script>/);
  assert.match(use, /<a href="\/">the overview<\/a>/, 'page placeholders follow the structure-mode route');
  assert.match(await read('dist/use/index.html'), /<a class="pill" href="\/use\/compose\/">Start making<\/a>/, 'the landing links the composer at its structure-mode route');
  assert.match(await read('dist/use/install/index.html'), /<a href="\/use\/compose\/#mcp">Compose<\/a>/);

  const customized = structuredClone(source);
  customized.files.find(file => file.path === 'src/scripts/compose.js').content = Buffer.from('// changed composer\n').toString('base64');
  await assert.rejects(transformOffshoot(customized, {mode: 'structure', systemId: 'example/customized'}), /customized toolkit plumbing: src\/scripts\/compose\.js/);
  const undeclared = structuredClone(source);
  undeclared.files.find(file => file.path === '.timds/stock.json').content = Buffer.from(json({schemaVersion: 1, paths: ['src/styles/system.css']})).toString('base64');
  const transformed = await transformOffshoot(undeclared, {mode: 'structure', systemId: 'example/undeclared'});
  assert.ok(!transformed.files.some(file => file.path === 'src/copy.json'), 'authored copy is not inferred as reusable stock');
});

test('structure keeps the toolkit baseline distinct from its parent feed through sever and sync', async t => {
  const {root, directory} = await fixture(t);
  const read = relative => fs.readFile(path.join(root, relative), 'utf8');
  const starterText = await read('.timds/starter.json');
  const site = JSON.parse(await read('src/site.json'));
  site.views.find(view => view.id === 'brand').label = 'Parent foundations';
  const formats = JSON.parse(await read('src/formats.json'));
  formats.print.formats.letterhead.name = 'Parent correspondence';
  await fs.writeFile(path.join(root, 'src/site.json'), json(site));
  await fs.writeFile(path.join(root, 'src/formats.json'), json(formats));
  git(root, 'add', '--all'); git(root, 'commit', '-qm', 'Parent catalog grafts');
  const source = await loadOffshootSource(root, {sourceId});
  const destination = path.join(directory, 'baseline-child');
  const {parent} = await shootOffshoot({destination, source, mode: 'structure', systemId: 'example/baseline-child', check: checkWorkspace});
  assert.equal(await fs.readFile(path.join(destination, '.timds/starter.json'), 'utf8'), starterText);
  assert.equal(parent.baseline.site.views.find(view => view.id === 'brand').label, 'Parent foundations');
  await severOffshoot(destination, {confirmed: true});
  git(destination, 'config', 'user.name', 'Test'); git(destination, 'config', 'user.email', 'test@example.com');
  git(destination, 'add', '--all'); git(destination, 'commit', '-qm', 'Independent child');
  await runWithOutputSink(() => {}, () => syncStarterWorkspace(destination));
  const childSite = JSON.parse(await fs.readFile(path.join(destination, 'src/site.json'), 'utf8'));
  const childFormats = JSON.parse(await fs.readFile(path.join(destination, 'src/formats.json'), 'utf8'));
  assert.equal(childSite.views.find(view => view.id === 'brand').label, 'Parent foundations');
  assert.equal(childFormats.print.formats.letterhead.name, 'Parent correspondence');
});

test('stock full and structure offshoots do not require a package lockfile', async t => {
  const {directory, source} = await fixture(t);
  source.files = source.files.filter(file => file.path !== 'package-lock.json');
  for (const mode of ['full', 'structure']) {
    const destination = path.join(directory, `unlocked-${mode}`);
    await shootOffshoot({destination, source, mode, systemId: `example/unlocked-${mode}`, check: checkWorkspace});
    assert.equal(JSON.parse(await fs.readFile(path.join(destination, 'package.json'), 'utf8')).name, `example-unlocked-${mode}`);
    await assert.rejects(fs.access(path.join(destination, 'package-lock.json')), {code: 'ENOENT'});
  }
});

test('shoot selects only parent lineage fields from extensible host export metadata', async t => {
  const {source} = await fixture(t);
  source.parent = {...source.parent, schemaVersion: 17, mode: 'export', baseline: {private: true}, exportedAt: '2026-11-03T00:00:00Z'};
  const transformed = await transformOffshoot(source, {systemId: 'example/export-child'});
  assert.deepEqual(Object.keys(transformed.parent), ['schemaVersion', 'systemId', 'sourceId', 'version', 'commit', 'mode', 'baseline', 'files']);
  assert.equal(transformed.parent.schemaVersion, 1);
  assert.equal(transformed.parent.mode, 'full');
  assert.equal(transformed.parent.commit, source.parent.commit);
});

test('local source is pinned to Git bytes and requires a truthful source identity and version', async t => {
  const {root, source} = await fixture(t);
  await fs.writeFile(path.join(root, 'src/pages/brand/color.html'), 'Uncommitted change');
  const pinned = await loadOffshootSource(root, {sourceId, ref: source.parent.commit});
  assert.deepEqual(pinned, source);
  await assert.rejects(loadOffshootSource(root), /--source-id UUID/);
  await assert.rejects(loadOffshootSource(root, {sourceId, version: 'missing'}), /requested version/);
  let request;
  const hosted = await loadOffshootSource('example/core', {version: source.parent.version, portalUrl: 'https://host.example', token: 'timds_test', fetchImpl: async (url, options) => { request = {url, options}; return new Response(json({apiVersion: 1, ...source})); }});
  assert.deepEqual(hosted, source);
  assert.equal(request.url, `https://host.example/api/timds/design-systems/example%2Fcore/releases/${source.parent.version}/source`);
  assert.equal(request.options.redirect, 'error');
  await assert.rejects(loadOffshootSource('example/other', {portalUrl: 'https://host.example', token: 'timds_test', fetchImpl: async () => new Response(json({apiVersion: 1, ...source}))}), /different parent release/);
  const withSource = structuredClone(source), manifestFile = withSource.files.find(file => file.path === 'timds.json');
  manifestFile.content = Buffer.from(json({...JSON.parse(Buffer.from(manifestFile.content, 'base64')), sourceId})).toString('base64');
  const transformed = await transformOffshoot(withSource, {systemId: 'example/no-inherited-source'});
  assert.equal(JSON.parse(Buffer.from(transformed.files.find(file => file.path === 'timds.json').content, 'base64')).sourceId, undefined);
});

test('bare system IDs stay hosted when a same-named local checkout exists', async t => {
  const {root, directory, source} = await fixture(t);
  const checkout = path.join(directory, 'example/core');
  await fs.mkdir(path.dirname(checkout));
  await fs.rename(root, checkout);
  const snapshot = path.join(directory, 'source.json');
  await fs.writeFile(snapshot, json(source));
  const script = `
    import {readFileSync} from 'node:fs';
    const {loadOffshootSource} = await import(process.argv[1]);
    const source = JSON.parse(readFileSync(process.argv[2], 'utf8'));
    let requests = 0;
    const hosted = await loadOffshootSource('example/core', {portalUrl:'https://host.example', token:'timds_test', fetchImpl:async () => {requests++; return new Response(JSON.stringify({apiVersion:1,...source}));}});
    const relative = await loadOffshootSource('./example/core', {sourceId:source.parent.sourceId});
    const explicit = await loadOffshootSource('example/core', {local:true, sourceId:source.parent.sourceId});
    console.log(JSON.stringify({requests, hosted:hosted.parent, relative:relative.parent, explicit:explicit.parent}));
  `;
  const result = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script, new URL('./offshoots.mjs', import.meta.url).href, snapshot], {cwd: directory, encoding: 'utf8'}));
  assert.deepEqual(result, {requests: 1, hosted: source.parent, relative: source.parent, explicit: source.parent});
  await assert.rejects(loadOffshootSource(path.join(directory, 'missing'), {fetchImpl: () => {throw new Error('must not contact host');}}), /Local parent must be an existing Git directory/);
});

test('local source batches Git blob reads while retaining binary bytes, executable modes and links', async t => {
  const {root, directory} = await fixture(t);
  const bytes = Buffer.from([0, 255, 10, 13, 128, 1]);
  await fs.mkdir(path.join(root, 'assets'));
  for (let index = 0; index < 64; index++) await fs.writeFile(path.join(root, 'assets', `${index}.bin`), bytes);
  await fs.writeFile(path.join(root, 'scripts/executable.mjs'), '// executable\n', {mode: 0o755});
  await fs.symlink('0.bin', path.join(root, 'assets/link.bin'));
  git(root, 'add', '--all'); git(root, 'commit', '-qm', 'Binary source');
  const trace = path.join(directory, 'git-trace');
  const script = `const {loadOffshootSource}=await import(process.argv[1]); console.log(JSON.stringify(await loadOffshootSource(process.argv[2], {sourceId:process.argv[3]})));`;
  const source = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script, new URL('./offshoots.mjs', import.meta.url).href, root, sourceId], {encoding: 'utf8', env: {...process.env, GIT_TRACE: trace}, maxBuffer: 10 * 1024 * 1024}));
  const files = decodeOffshootSource(source), calls = await fs.readFile(trace, 'utf8');
  assert.deepEqual(Buffer.from(files.get('assets/63.bin')), bytes);
  assert.equal(files.get('scripts/executable.mjs').mode, '100755');
  assert.equal(files.get('assets/link.bin').mode, '120000');
  assert.equal(files.get('assets/link.bin').toString(), '0.bin');
  assert.equal((calls.match(/built-in: git cat-file --batch/g) || []).length, 1);
  assert.doesNotMatch(calls, /cat-file (?:blob|-s)\b/);
});

test('decoded creation keeps Git and host bytes native across load, transform and write', async t => {
  const {root, directory, source} = await fixture(t);
  const from = Buffer.from, stringify = Buffer.prototype.toString;
  let decodes = 0, encodes = 0;
  t.mock.method(Buffer, 'from', function(value, encoding, ...args) {
    if (encoding === 'base64') decodes++;
    return from(value, encoding, ...args);
  });
  t.mock.method(Buffer.prototype, 'toString', function(encoding, ...args) {
    if (encoding === 'base64') encodes++;
    return stringify.call(this, encoding, ...args);
  });
  const local = await loadOffshootSource(root, {sourceId}, {decoded: true});
  assert.ok(local.files instanceof Map);
  const result = await shootOffshoot({destination: path.join(directory, 'native-local'), source: local, systemId: 'example/native-local'});
  assert.deepEqual(result.files, [...local.files.keys(), '.timds/parent.json']);
  assert.equal(decodes, 0);
  assert.equal(encodes, 0);
  const hosted = await loadOffshootSource('example/core', {portalUrl: 'https://host.example', token: 'timds_test', fetchImpl: async () => new Response(json({apiVersion: 1, ...source}))}, {decoded: true});
  await shootOffshoot({destination: path.join(directory, 'native-hosted'), source: hosted, systemId: 'example/native-hosted'});
  assert.equal(decodes, source.files.length, 'each wire file is decoded exactly once');
  assert.equal(encodes, source.files.length, 'only canonical base64 input validation re-encodes wire files');
});

test('native snapshots and caller-mutated wire snapshots retain source validation guards', async t => {
  const {root, directory, source} = await fixture(t);
  const native = await loadOffshootSource(root, {sourceId}, {decoded: true});
  const file = (content, mode = '100644') => Object.assign(Buffer.from(content), {mode});
  for (const [name, bytes] of [
    ['../escape', file('')],
    ['src/link', file('../../outside', '120000')],
    ['src/missing-link', file('missing', '120000')],
    ['src/bad-mode', file('', '100600')],
    ['src/oversize', file(Buffer.alloc(10 * 1024 * 1024 + 1))],
    ['TIMDS.JSON', file('{}')],
  ]) {
    const destination = path.join(directory, 'invalid-native');
    await assert.rejects(shootOffshoot({destination, source: {...native, files: new Map([...native.files, [name, bytes]])}, systemId: 'example/invalid-native'}), /Unsafe|Missing|Invalid|colliding|limits/);
    await assert.rejects(fs.access(destination), {code: 'ENOENT'});
  }
  source.files.push({path: '../escape', mode: '100644', encoding: 'base64', content: ''});
  await assert.rejects(shootOffshoot({destination: path.join(directory, 'invalid-wire'), source, systemId: 'example/invalid-wire'}), /Unsafe/);
});

test('local source treats option-shaped revisions as refs and ends Git option parsing', async t => {
  const {root, directory} = await fixture(t);
  const trace = path.join(directory, 'ref-trace');
  const script = `const {loadOffshootSource}=await import(process.argv[1]); try {await loadOffshootSource(process.argv[2], {sourceId:process.argv[3], ref:'--help'});} catch {process.exitCode=7;}`;
  assert.throws(() => execFileSync(process.execPath, ['--input-type=module', '-e', script, new URL('./offshoots.mjs', import.meta.url).href, root, sourceId], {encoding: 'utf8', env: {...process.env, GIT_TRACE: trace}, stdio: 'pipe'}), error => error.status === 7);
  assert.match(await fs.readFile(trace, 'utf8'), /git rev-parse --verify --end-of-options \S*--help/);
});

test('local source rejects oversize blobs and aggregate snapshots before reading their bytes', async t => {
  const {root} = await fixture(t);
  await fs.mkdir(path.join(root, 'assets'));
  await fs.writeFile(path.join(root, 'assets/oversize.bin'), Buffer.alloc(10 * 1024 * 1024 + 1));
  git(root, 'add', '--all'); git(root, 'commit', '-qm', 'Oversize blob');
  await assert.rejects(loadOffshootSource(root, {sourceId}), /Offshoot source exceeds file limits/);
  await fs.rm(path.join(root, 'assets/oversize.bin'));
  const bytes = Buffer.alloc(9 * 1024 * 1024);
  for (let index = 0; index < 6; index++) await fs.writeFile(path.join(root, 'assets', `${index}.bin`), bytes);
  git(root, 'add', '--all'); git(root, 'commit', '-qm', 'Oversize tree');
  await assert.rejects(loadOffshootSource(root, {sourceId}), /Offshoot source exceeds file limits/);
});

test('new offshoot IDs use the host lowercase rule and remain within the local manifest length', async t => {
  const {directory, source} = await fixture(t), destination = path.join(directory, 'invalid-child');
  for (const systemId of ['Example/Child', 'example/Child', `example/${'x'.repeat(153)}`]) {
    await assert.rejects(shootOffshoot({destination, source, systemId}), /lowercase URL-safe --system-id of at most 160/);
    await assert.rejects(fs.access(destination), {code: 'ENOENT'});
  }
  const result = await transformOffshoot(source, {systemId: 'example/child.with_under-score'});
  assert.equal(JSON.parse(Buffer.from(result.files.find(file => file.path === 'timds.json').content, 'base64')).systemId, 'example/child.with_under-score');
});

test('CLI full shoot installs a custom toolchain from the exact copied lock before checking', async t => {
  const {root, directory} = await fixture(t), destination = path.join(directory, 'custom-child');
  await fs.mkdir(path.join(root, 'build-tool'));
  await fs.writeFile(path.join(root, 'build-tool/package.json'), json({name: 'timds-test-build', version: '1.0.0', type: 'module', main: 'index.mjs'}));
  await fs.writeFile(path.join(root, 'build-tool/index.mjs'), 'export const ready = true;\n');
  await fs.writeFile(path.join(root, 'scripts/custom-build.mjs'), "import {ready} from 'timds-test-build';\nif (!ready) throw new Error('missing tool');\nawait import('./build.mjs');\n");
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'timds.json'), 'utf8'));
  manifest.workspace.build = ['node', 'scripts/custom-build.mjs'];
  await fs.writeFile(path.join(root, 'timds.json'), json(manifest));
  const pkg = {name: 'example-parent', version: manifest.version, private: true, type: 'module', scripts: {timds: 'timds'}, devDependencies: {'timds-test-build': 'file:build-tool'}};
  await fs.writeFile(path.join(root, 'package.json'), json(pkg));
  await fs.writeFile(path.join(root, 'package-lock.json'), json({name: pkg.name, version: pkg.version, lockfileVersion: 3, requires: true, packages: {'': {name: pkg.name, version: pkg.version, devDependencies: pkg.devDependencies}, 'build-tool': {name: 'timds-test-build', version: '1.0.0'}, 'node_modules/timds-test-build': {resolved: 'build-tool', link: true}}}));
  git(root, 'add', '--all'); git(root, 'commit', '-qm', 'Custom build toolchain');
  await runWithOutputSink(() => {}, () => runCli(['shoot', root, '--root', destination, '--system-id', 'example/custom-child', '--source-id', sourceId]));
  await fs.access(path.join(destination, 'node_modules/timds-test-build/index.mjs'));
  assert.equal((await checkWorkspace(destination)).manifest.systemId, 'example/custom-child');
});

test('shoot refuses customized plumbing, unsafe source, and occupied destinations before writing', async t => {
  const {directory, source} = await fixture(t);
  const broken = structuredClone(source), script = broken.files.find(file => file.path === 'scripts/build.mjs');
  script.content = Buffer.from('custom').toString('base64');
  await assert.rejects(transformOffshoot(broken, {systemId: 'example/child', mode: 'structure'}), /customized toolkit plumbing/);
  for (const file of [
    {path: '../escape', mode: '100644', encoding: 'base64', content: ''},
    {path: 'src/link', mode: '120000', encoding: 'base64', content: Buffer.from('../../outside').toString('base64')},
    {...source.files[0], path: source.files[0].path.toUpperCase()},
  ]) assert.throws(() => decodeOffshootSource({...source, files: [...source.files, file]}), /Unsafe|colliding/);
  const occupied = path.join(directory, 'occupied'); await fs.mkdir(occupied); await fs.writeFile(path.join(occupied, 'keep'), 'keep');
  await assert.rejects(shootOffshoot({destination: occupied, source, systemId: 'example/child'}), /empty/);
  assert.equal(await fs.readFile(path.join(occupied, 'keep'), 'utf8'), 'keep');
});

test('failed shoot rolls back its entire new tree; sever requires confirmation and only removes lineage', async t => {
  const {directory, source} = await fixture(t), destination = path.join(directory, 'child');
  await assert.rejects(shootOffshoot({destination, source, systemId: 'example/child', check: async () => { throw new Error('check failed'); }}), /check failed/);
  await assert.rejects(fs.access(destination), {code: 'ENOENT'});
  await shootOffshoot({destination, source, systemId: 'example/child'});
  const tokens = await fs.readFile(path.join(destination, 'tokens.json'));
  await assert.rejects(severOffshoot(destination), /Confirm/);
  await severOffshoot(destination, {confirmed: true});
  assert.deepEqual(await fs.readFile(path.join(destination, 'tokens.json')), tokens);
  const checked = await checkWorkspace(destination);
  assert.equal(checked.machine.index.lineage, null);
});

test('CLI shoot, feed and sever use the local parent and preserve a plain system after sever', async t => {
  const {root, directory} = await fixture(t), destination = path.join(directory, 'cli-child'), lines = [];
  await runWithOutputSink(line => lines.push(line), async () => {
    await runCli(['shoot', root, '--root', destination, '--system-id', 'example/cli-child', '--source-id', sourceId, '--mode', 'structure']);
    git(destination, 'config', 'user.email', 'test@example.com'); git(destination, 'config', 'user.name', 'Test'); git(destination, 'add', '--all'); git(destination, 'commit', '-qm', 'Child');
    await runCli(['feed', '--root', destination, '--from', root]);
    await assert.rejects(runCli(['sever', '--root', destination]), /Confirm/);
    await runCli(['sever', '--root', destination, '--yes']);
  });
  assert.ok(lines.some(line => line.includes('Created structure offshoot')));
  assert.ok(lines.some(line => line.includes('Severed example/core')));
  assert.equal((await checkWorkspace(destination)).offshoot.parent, null);
});
