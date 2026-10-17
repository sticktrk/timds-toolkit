import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parse } from 'yaml';
import { adoptConsumerBinary, consumerWorkflow, initializeConsumer, upgradeConsumer } from './consumer-init.mjs';
import { checkConsumer, runConsumerCli } from './consumer.mjs';
import { packageRoot } from './executable.mjs';
import { runtimeIdentity } from './runtime.mjs';

const json = value => `${JSON.stringify(value, null, 2)}\n`;
const read = (root, file) => fs.readFile(path.join(root, file), 'utf8');
const readJson = async (root, file) => JSON.parse(await read(root, file));
const write = async (root, file, value) => { await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true }); await fs.writeFile(path.join(root, file), typeof value === 'string' ? value : json(value)); };
const git = (root, ...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const neverNpm = async () => { throw new Error('Binary consumer setup must not run npm'); };
const base = 'https://assets.example.test/example/core/artifact';
const css = ':root { --example: red; }';
const fetchImpl = async url => {
  if (String(url) === `${base}/v/1.0.0/bundle.json`) return Response.json({ schemaVersion: 1, system: { id: 'example/core', name: 'Example', version: '1.0.0' }, directory: `${base}/v/1.0.0/bundle`, files: [{ path: 'dist/tokens.css', url: `${base}/v/1.0.0/bundle/dist/tokens.css`, bytes: css.length, sha256: createHash('sha256').update(css).digest('hex') }] });
  if (String(url) === `${base}/v/1.0.0/bundle/dist/tokens.css`) return new Response(css);
  return new Response('not found', { status: 404 });
};

async function product(t, { npm = false } = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'timds-consumer-binary-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.email', 'timds-test@example.com');
  git(root, 'config', 'user.name', 'TimDS Test');
  await write(root, 'timds.consumer.json', { schemaVersion: 1, designSystem: { systemId: 'example/core', path: 'design-system', version: '1.0.0', url: base }, apps: { web: { cwd: '.', preview: { serve: ['make', 'serve'], port: 4040, routes: ['/'] }, designSurface: ['styles/**'], protected: ['public/brand/**'] } } });
  await write(root, 'styles/site.css', 'body {}\n');
  await fs.mkdir(path.join(root, 'public/brand'), { recursive: true });
  await fs.symlink('../../design-system/dist/tokens.css', path.join(root, 'public/brand/tokens.css'));
  await write(root, '.mcp.json', { mcpServers: { other: { command: 'existing-mcp', args: [] } } });
  await write(root, '.claude/launch.json', { configurations: [{ name: 'other', runtimeExecutable: 'custom-server', runtimeArgs: [], port: 5050 }] });
  if (npm) {
    await write(root, 'package.json', { name: 'product', private: true, scripts: { postinstall: 'custom-product-setup', build: 'custom-product-build' }, dependencies: { 'product-only': '1.0.0' } });
    await write(root, 'package-lock.json', { lockfileVersion: 3, packages: { '': { dependencies: { 'product-only': '1.0.0' } }, 'node_modules/product-only': { version: '1.0.0' } } });
  }
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'Product source');
  return root;
}

test('binary consumer init fetches the published pin without a package manifest, lockfile or npm', async t => {
  const root = await product(t);
  const manifest = await read(root, 'timds.consumer.json');
  const initialized = await initializeConsumer(root, { mode: 'binary', fetchImpl, runNpm: neverNpm });
  assert.equal(initialized.synced.version, '1.0.0');
  const installation = await readJson(root, '.timds/installation.json');
  assert.equal(installation.mode, 'binary');
  assert.equal(installation.schemaVersion, 2);
  assert.equal(installation.name, '@dtconcepts/timds');
  assert.equal(installation.version, runtimeIdentity.version);
  assert.equal(installation.executable, 'timds-cli');
  await assert.rejects(fs.access(path.join(root, 'package.json')));
  await assert.rejects(fs.access(path.join(root, 'package-lock.json')));
  assert.equal(await read(root, 'timds.consumer.json'), manifest);
  assert.equal(await read(root, 'design-system/dist/tokens.css'), css);
  const skill = await read(root, '.agents/skills/timds-consume-design-system/SKILL.md');
  assert.match(skill, /timds-cli consumer sync/);
  assert.match(skill, /`make serve`/);
  assert.doesNotMatch(skill, /npm run timds|postinstall|npm ci|npm install/);
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'Adopt binary');
  const checked = await checkConsumer(root);
  assert.equal(checked.status, 'passed', checked.errors.join('\n'));
  await initializeConsumer(root, { fetchImpl, runNpm: neverNpm });
  assert.equal(git(root, 'status', '--porcelain'), '');
});

test('binary adoption is explicit, reviewable and idempotent while preserving the product boundary', async t => {
  const root = await product(t, { npm: true });
  await initializeConsumer(root, { skipInstall: true });
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'npm consumer');
  await assert.rejects(initializeConsumer(root, { mode: 'binary', skipInstall: true }), /Adopt explicitly/);
  const preserved = ['package.json', 'package-lock.json', 'timds.consumer.json', 'styles/site.css', '.claude/launch.json', '.mcp.json'];
  const before = await Promise.all(preserved.map(file => read(root, file)));
  const preview = await adoptConsumerBinary(root);
  assert.equal(preview.applied, false);
  assert.equal(preview.changed, true);
  assert.ok(preview.files.includes('.timds/installation.json'));
  assert.ok(!preview.files.some(file => ['package.json', 'package-lock.json', 'timds.consumer.json'].includes(file)));
  assert.equal(git(root, 'status', '--porcelain'), '');
  const applied = await adoptConsumerBinary(root, { apply: true });
  assert.equal(applied.applied, true);
  assert.equal(applied.installation.version, runtimeIdentity.version);
  assert.deepEqual(await Promise.all(preserved.map(file => read(root, file))), before);
  assert.match((await readJson(root, 'package.json')).scripts.postinstall, /^timds consumer sync && custom-product-setup$/);
  assert.equal((await adoptConsumerBinary(root, { apply: true })).changed, false);
  await upgradeConsumer(root);
  assert.equal(await fs.readlink(path.join(root, 'public/brand/tokens.css')), '../../design-system/dist/tokens.css');
  assert.deepEqual(await Promise.all(preserved.map(file => read(root, file))), before);
  const developer = await read(root, '.agents/skills/timds-update-design-system/SKILL.md');
  assert.match(developer, /timds-cli consumer update/);
  assert.doesNotMatch(developer, /npm run timds/);
});

test('binary adoption refuses customized managed files before any mutation and force stays managed', async t => {
  const root = await product(t, { npm: true });
  await initializeConsumer(root, { skipInstall: true });
  const workflow = '.github/workflows/timds-consumer-preview.yml';
  await fs.appendFile(path.join(root, workflow), '# product customization\n');
  const before = await read(root, '.timds/installation.json');
  const pkg = await read(root, 'package.json');
  await assert.rejects(adoptConsumerBinary(root, { apply: true }), /Refusing to replace customized TimDS consumer files/);
  assert.equal(await read(root, '.timds/installation.json'), before);
  assert.match(await read(root, workflow), /product customization/);
  await adoptConsumerBinary(root, { apply: true, force: true });
  assert.doesNotMatch(await read(root, workflow), /product customization/);
  assert.equal(await read(root, 'package.json'), pkg);
});

test('binary consumer workflows install the exact verified CLI and keep custom product execution separate', async () => {
  for (const name of ['timds-consumer-preview.yml', 'timds-designer-change.yml']) {
    const source = await consumerWorkflow(name, { mode: 'binary' });
    const workflow = parse(source);
    const steps = Object.values(workflow.jobs).flatMap(job => job.steps ?? []);
    const installers = steps.filter(step => step.name === 'Install the exact TimDS executable');
    assert.ok(installers.length);
    for (const step of installers) {
      assert.match(step.run, /\.timds\/installation\.json/);
      assert.match(step.run, /SHA256SUMS/);
      assert.match(step.run, /sha256sum --check --strict/);
      assert.match(step.run, /schemaVersion == 2/);
    }
    assert.ok(steps.some(step => step.name === 'Fetch the published Design System pin'));
    assert.doesNotMatch(source, /npm run timds|run: npm ci|cache: npm|\$\(node /);
    const toolchains = steps.filter(step => step.uses === 'actions/setup-node@v5');
    assert.ok(toolchains.length, 'product toolchains remain supported in CI');
    assert.ok(toolchains.every(step => step.with['package-manager-cache'] === false), 'binary tooling must not implicitly require a root npm lockfile');
  }
});


test('standalone runtime selects binary init by default and rejects mismatched consumer commands', async t => {
  const root = await product(t);
  const values = { TIMDS_BINARY_EXECUTABLE: path.join(root, 'timds-cli'), TIMDS_RUNTIME_ROOT: path.dirname(packageRoot), TIMDS_RUNTIME_PACKAGE: packageRoot };
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  Object.assign(process.env, values);
  try {
    await initializeConsumer(root, { fetchImpl, runNpm: neverNpm });
    const installation = await readJson(root, '.timds/installation.json');
    assert.equal(installation.mode, 'binary');
    installation.version = '0.1.0';
    await write(root, '.timds/installation.json', installation);
    for (const command of ['check', 'sync', 'update', 'migrate', 'preview', 'notes', 'init']) {
      await assert.rejects(runConsumerCli([command, '--root', root]), /Workspace selects TimDS 0\.1\.0/);
    }
    await assert.rejects(runConsumerCli(['sync', '--root=.', `--root=${root}`]), /Workspace selects TimDS 0\.1\.0/);
    await assert.rejects(runConsumerCli(['sync', '-root', root]), /Workspace selects TimDS 0\.1\.0/);
    await assert.rejects(adoptConsumerBinary(root, { apply: true }), /use timds-cli upgrade --version/);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
