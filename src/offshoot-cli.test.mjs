import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { checkWorkspace, extractWorkspace, initializeRepository, loadWorkspace, runCli, runWithOutputSink, syncStarterWorkspace, upgradeRepository } from './core.mjs';
import { readDerivedLayer } from './derived.mjs';

const sourceId = '11111111-1111-4111-8111-111111111111';
const json = value => `${JSON.stringify(value, null, 2)}\n`;
const git = (root, ...args) => execFileSync('git', ['-C', root, ...args], {encoding: 'utf8', stdio: 'pipe'}).trim();
async function workspaceFixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'timds-offshoot-cli-'));
  t.after(() => fs.rm(directory, {recursive: true, force: true}));
  const root = path.join(directory, 'parent');
  await fs.mkdir(root);
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'Test'); git(root, 'config', 'user.email', 'test@example.com');
  await runWithOutputSink(() => {}, () => initializeRepository(root, {standalone: true, systemId: 'example/core', name: 'Example Core'}));
  return {root, directory};
}

test('shoot suppresses lifecycle and custom installation scripts unless --install opts in', async t => {
  const {root, directory} = await workspaceFixture(t);
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'timds.json'), 'utf8'));
  manifest.workspace.build = ['node', 'scripts/custom-build.mjs'];
  manifest.workspace.install = ['node', 'scripts/install-tools.mjs'];
  await fs.writeFile(path.join(root, 'timds.json'), json(manifest));
  await fs.mkdir(path.join(root, 'build-tool'));
  await fs.writeFile(path.join(root, 'build-tool/package.json'), json({name: 'timds-test-build', version: '1.0.0', type: 'module', main: 'index.mjs'}));
  await fs.writeFile(path.join(root, 'build-tool/index.mjs'), 'export const ready = true;\n');
  await fs.writeFile(path.join(root, 'scripts/custom-build.mjs'), "import {ready} from 'timds-test-build';\nif (!ready) throw new Error('missing tool');\nawait import('./build.mjs');\n");
  await fs.writeFile(path.join(root, 'scripts/install-tools.mjs'), "import {writeFileSync} from 'node:fs';\nimport {execFileSync} from 'node:child_process';\nwriteFileSync('custom-install-ran', 'yes');\nexecFileSync('npm', ['ci'], {stdio: 'inherit'});\n");
  await fs.writeFile(path.join(root, 'scripts/postinstall.mjs'), "import {writeFileSync} from 'node:fs';\nwriteFileSync('postinstall-ran', 'yes');\n");
  const pkg = {name: 'example-parent', version: manifest.version, private: true, type: 'module', scripts: {timds: 'timds', postinstall: 'node scripts/postinstall.mjs'}, devDependencies: {'timds-test-build': 'file:build-tool'}};
  await fs.writeFile(path.join(root, 'package.json'), json(pkg));
  await fs.writeFile(path.join(root, 'package-lock.json'), json({name: pkg.name, version: pkg.version, lockfileVersion: 3, requires: true, packages: {'': {name: pkg.name, version: pkg.version, hasInstallScript: true, devDependencies: pkg.devDependencies}, 'build-tool': {name: 'timds-test-build', version: '1.0.0'}, 'node_modules/timds-test-build': {resolved: 'build-tool', link: true}}}));
  git(root, 'add', '--all'); git(root, 'commit', '-qm', 'Parent custom toolchain');
  for (const install of [false, true]) {
    const destination = path.join(directory, install ? 'opt-in' : 'default');
    await runWithOutputSink(() => {}, () => runCli(['shoot', root, '--root', destination, '--system-id', install ? 'example/opt-in' : 'example/default', '--source-id', sourceId, ...(install ? ['--install'] : [])]));
    await fs.access(path.join(destination, 'node_modules/timds-test-build/index.mjs'));
    for (const marker of ['postinstall-ran', 'custom-install-ran']) {
      if (install) assert.equal(await fs.readFile(path.join(destination, marker), 'utf8'), 'yes');
      else await assert.rejects(fs.access(path.join(destination, marker)), {code: 'ENOENT'});
    }
  }
});

test('shoot requires a committed exact lock before installing a custom full toolchain', async t => {
  const { root, directory } = await workspaceFixture(t);
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'timds.json'), 'utf8'));
  manifest.workspace.build = ['node', 'scripts/custom-build.mjs'];
  await fs.writeFile(path.join(root, 'timds.json'), json(manifest));
  await fs.writeFile(path.join(root, 'scripts/custom-build.mjs'), "await import('./build.mjs');\n");
  await fs.rm(path.join(root, 'package-lock.json'), { force: true });
  git(root, 'add', '--all'); git(root, 'commit', '-qm', 'Custom toolchain without a lock');
  const destination = path.join(directory, 'no-lock');
  await assert.rejects(runWithOutputSink(() => {}, () => runCli(['shoot', root, '--root', destination, '--system-id', 'example/no-lock', '--source-id', sourceId])), /custom build toolchain requires an exact package-lock.json; commit it in the parent/);
  await assert.rejects(fs.access(destination), { code: 'ENOENT' });
});

test('workspace operations reuse one parent snapshot and later resolutions see changed lineage', async t => {
  const {root} = await workspaceFixture(t);
  const parentFile = path.join(root, '.timds/parent.json');
  const parent = {schemaVersion: 1, systemId: 'example/parent', sourceId, version: '1.0.0', commit: '1'.repeat(40), mode: 'full', baseline: {site: {views: []}, formats: null}};
  await fs.writeFile(parentFile, json(parent));
  const original = fs.readFile;
  let reads = 0;
  t.mock.method(fs, 'readFile', async (...args) => {
    if (typeof args[0] === 'string' && path.resolve(args[0]) === await fs.realpath(parentFile)) reads++;
    return original(...args);
  });
  const workspace = await runWithOutputSink(() => {}, () => checkWorkspace(root));
  assert.equal(reads, 1, 'check and extraction share the validated parent snapshot');
  await extractWorkspace(workspace);
  await readDerivedLayer(root, workspace.manifest, {parentRecord: workspace.parentRecord});
  assert.equal(reads, 1, 'readers of the same workspace do not reparse its baseline');
  await fs.writeFile(parentFile, json({...parent, version: '1.1.0'}));
  const next = await loadWorkspace(root);
  assert.equal(next.parentRecord.version, '1.1.0');
  assert.equal(reads, 2, 'the cache does not survive a workspace resolution');
});

test('offshoot sync and upgrade allow dirty authored catalogs and fragments while guarding their plumbing writes', async t => {
  for (const [name, operation] of [['sync', syncStarterWorkspace], ['upgrade', upgradeRepository]]) await t.test(name, async t => {
    const {root} = await workspaceFixture(t);
    const read = relative => fs.readFile(path.join(root, relative), 'utf8');
    const parent = {schemaVersion: 1, systemId: 'example/parent', sourceId, version: '1.0.0', commit: '1'.repeat(40), mode: 'full', baseline: {site: JSON.parse(await read('src/site.json')), formats: JSON.parse(await read('src/formats.json'))}};
    const parentText = json(parent);
    await fs.writeFile(path.join(root, '.timds/parent.json'), parentText);
    await fs.appendFile(path.join(root, 'scripts/dev.mjs'), '\n// Earlier toolkit plumbing.\n');
    git(root, 'add', '--all'); git(root, 'commit', '-qm', 'Offshoot with earlier plumbing');
    const authored = new Map();
    for (const relative of ['src/site.json', 'src/formats.json', 'src/pages/use/index.html']) {
      const next = `${await read(relative)}${relative.endsWith('.html') ? '\n<!-- Uncommitted authored overview. -->\n' : '\n'}`;
      await fs.writeFile(path.join(root, relative), next);
      authored.set(relative, next);
    }
    const result = await runWithOutputSink(() => {}, () => operation(root));
    const sync = name === 'sync' ? result : result.starter;
    assert.ok(sync.written.includes('scripts/dev.mjs'), 'the operation refreshes clean plumbing while authored changes are present');
    assert.ok(sync.check, 'the changed plumbing passes the workspace check');
    const assertAuthored = async () => {
      for (const [relative, expected] of authored) assert.equal(await read(relative), expected, relative);
      assert.equal(await read('.timds/parent.json'), parentText);
    };
    await assertAuthored();
    git(root, 'add', 'scripts/dev.mjs', '.timds/starter.json'); git(root, 'commit', '-qm', 'Refresh toolkit plumbing');
    for (const relative of ['scripts/dev.mjs', 'src/layout.html']) {
      const original = await read(relative);
      await fs.appendFile(path.join(root, relative), '\n');
      await assert.rejects(runWithOutputSink(() => {}, () => operation(root)), /Starter sync refuses to run over uncommitted changes to the files it writes/);
      assert.equal(await read(relative), `${original}\n`, 'the refusal preserves the dirty protected file');
      await assertAuthored();
      await fs.writeFile(path.join(root, relative), original);
    }
  });
});

test('help and usage errors expose every offshoot source and installation flag', async () => {
  const lines = [];
  await runWithOutputSink(line => lines.push(line), () => runCli(['--help']));
  const help = lines.join('\n').split('\n');
  const shoot = help.find(line => line.includes('timds shoot')).trim();
  const feed = help.find(line => line.includes('timds feed')).trim();
  for (const flag of ['--name', '--portal-url', '--source-id', '--ref', '--install', '--json']) assert.ok(shoot.includes(flag), flag);
  for (const flag of ['--from', '--portal-url', '--source-id', '--ref', '--force', '--json']) assert.ok(feed.includes(flag), flag);
  await assert.rejects(runCli(['shoot']), error => error.message === `Usage: ${shoot}`);
  await assert.rejects(runCli(['feed', '--force']), error => error.message === `Usage: ${feed}`);
});
