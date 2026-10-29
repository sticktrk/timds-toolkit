import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { checkWorkspace, initializeRepository, runCli, runWithOutputSink } from './core.mjs';
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
