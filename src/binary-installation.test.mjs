import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { BINARY_DOWNLOAD_BASE, binaryDownloadUrl, binaryInstallationRecord, isStockWorkspace, stockWorkspaceCommands, withFileRollback } from './binary-installation.mjs';
import { runtimeIdentity } from './runtime.mjs';

const packageRoot = fileURLToPath(new URL('../', import.meta.url)).replace(/\/$/, '');
const cli = path.join(packageRoot, 'bin/timds.mjs');
const binaryEnv = {...process.env, TIMDS_BINARY_EXECUTABLE: cli, TIMDS_RUNTIME_ROOT: packageRoot, TIMDS_RUNTIME_PACKAGE: packageRoot};
const run = (root, args, {binary = true, env = {}, fail = false} = {}) => {
  const result = spawnSync(process.execPath, [cli, ...args, '--root', root], {cwd: root, env: {...(binary ? binaryEnv : process.env), ...env}, encoding: 'utf8'});
  if (!fail) assert.equal(result.status, 0, result.stderr || result.stdout);
  return result;
};
const git = (root, ...args) => execFileSync('git', args, {cwd: root, encoding: 'utf8'});
async function fixture(t, binary = true) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'timds binary contract '));
  t.after(() => fs.rm(root, {recursive: true, force: true, maxRetries: 5, retryDelay: 50}));
  git(root, 'init', '-q', '-b', 'main'); git(root, 'config', 'user.email', 'binary@example.test'); git(root, 'config', 'user.name', 'Binary Test');
  // Background Git maintenance can outlive a commit and race fixture cleanup.
  git(root, 'config', 'maintenance.auto', 'false');
  git(root, 'config', 'gc.auto', '0');
  run(root, ['init', '--standalone'], {binary});
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'Initial');
  return root;
}
const read = async (root, name) => JSON.parse(await fs.readFile(path.join(root, name), 'utf8'));

test('fresh binary stock builds without node/npm on PATH, pins exact release and renders instructions', async t => {
  const root = await fixture(t);
  const record = await read(root, '.timds/installation.json');
  assert.equal(record.schemaVersion, 2); assert.equal(record.mode, 'binary'); assert.equal(record.name, '@dtconcepts/timds'); assert.equal(record.version, runtimeIdentity.version);
  const manifest = await read(root, 'timds.json');
  assert.deepEqual(manifest.workspace, stockWorkspaceCommands);
  const pathDir = path.join(root, '.tools'); await fs.mkdir(pathDir);
  const gitPath = execFileSync('/usr/bin/which', ['git'], {encoding: 'utf8'}).trim(); await fs.symlink(gitPath, path.join(pathDir, 'git'));
  const checked = run(root, ['check'], {env: {PATH: pathDir}});
  assert.equal((checked.stdout.match(/Warning: (?!CHANGELOG)/g) || []).length, 2);
  assert.equal((await read(root, 'package.json')).devDependencies, undefined);
  assert.match(await fs.readFile(path.join(root, 'README.md'), 'utf8'), /timds-cli doctor/);
  assert.match(await fs.readFile(path.join(root, '.agents/skills/design-start/SKILL.md'), 'utf8'), /No package-manager installation/);
  assert.match(await fs.readFile(path.join(root, '.github/workflows/timds-design-system.yml'), 'utf8'), /sha256sum --strict --check/);
  run(root, ['dependencies', 'check'], {env: {PATH: pathDir}});
});

test('mismatched binary refuses before writes and doctor reports both versions', async t => {
  const root = await fixture(t);
  const record = await read(root, '.timds/installation.json'); record.version = '0.1.1';
  await fs.writeFile(path.join(root, '.timds/installation.json'), JSON.stringify(record));
  const before = await fs.readFile(path.join(root, 'tokens.json'));
  const result = run(root, ['check'], {fail: true});
  assert.equal(result.status, 1); assert.match(result.stderr, /selects TimDS 0\.1\.1/);
  assert.deepEqual(await fs.readFile(path.join(root, 'tokens.json')), before);
  const doctor = run(root, ['doctor']); assert.match(doctor.stdout, /Toolkit selected: 0\.1\.1/); assert.match(doctor.stdout, new RegExp(`Toolkit running: ${runtimeIdentity.version}`));
  assert.match(run(root, ['upgrade'], {fail: true}).stderr, /install the verified timds-cli 0\.1\.1/);
});

test('npm adoption plans before writing, preserves package pins/docs, and is idempotent', async t => {
  const root = await fixture(t, false);
  const before = new Map(await Promise.all(['package.json', 'README.md', 'AGENTS.md'].map(async name => [name, await fs.readFile(path.join(root, name))])));
  assert.match(run(root, ['check'], {fail: true}).stderr, /installation adopt/);
  const plan = run(root, ['installation', 'adopt', '--binary']); assert.match(plan.stdout, /stock workspace commands/);
  assert.notEqual((await read(root, '.timds/installation.json')).mode, 'binary');
  run(root, ['installation', 'adopt', '--binary', '--apply']);
  for (const [name, bytes] of before) assert.deepEqual(await fs.readFile(path.join(root, name)), bytes, name);
  run(root, ['check']);
  const after = await fs.readFile(path.join(root, '.timds/installation.json'));
  run(root, ['installation', 'adopt', '--binary', '--apply']);
  assert.deepEqual(await fs.readFile(path.join(root, '.timds/installation.json')), after);
});

test('binary adoption leaves stale committed aggregates untouched until apply', async t => {
  const root = await fixture(t, false);
  const names = ['tokens.json', 'media.json'];
  const expected = await Promise.all(names.map(name => fs.readFile(path.join(root, name), 'utf8')));
  const stale = ['{}\n', '{"schemaVersion":2,"assets":[]}\n'];
  for (let index = 0; index < names.length; index++) await fs.writeFile(path.join(root, names[index]), stale[index]);
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'Stale generated views');
  run(root, ['installation', 'adopt', '--binary']);
  assert.deepEqual(await Promise.all(names.map(name => fs.readFile(path.join(root, name), 'utf8'))), stale);
  assert.equal(git(root, 'status', '--porcelain').trim(), '');
  const skill = '.agents/skills/design-start/SKILL.md';
  await fs.appendFile(path.join(root, skill), '\nCustom instruction\n');
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'Custom skill');
  assert.match(run(root, ['installation', 'adopt', '--binary', '--apply'], {fail: true}).stderr, /customized managed skill/);
  assert.deepEqual(await Promise.all(names.map(name => fs.readFile(path.join(root, name), 'utf8'))), stale);
  assert.equal(git(root, 'status', '--porcelain').trim(), '');
  run(root, ['installation', 'adopt', '--binary', '--apply', '--force']);
  assert.deepEqual(await Promise.all(names.map(name => fs.readFile(path.join(root, name), 'utf8'))), expected);
});

test('binary upgrade refusals and failed checks preserve stale aggregate views', async t => {
  const root = await fixture(t);
  const names = ['tokens.json', 'media.json'];
  const expected = await Promise.all(names.map(name => fs.readFile(path.join(root, name), 'utf8')));
  const stale = ['{}\n', '{"schemaVersion":2,"assets":[]}\n'];
  for (let index = 0; index < names.length; index++) await fs.writeFile(path.join(root, names[index]), stale[index]);
  const record = await read(root, '.timds/installation.json'); record.version = '0.1.1';
  await fs.writeFile(path.join(root, '.timds/installation.json'), JSON.stringify(record));
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'Stale selected release');
  assert.match(run(root, ['upgrade'], {fail: true}).stderr, /install the verified timds-cli 0\.1\.1/);
  assert.deepEqual(await Promise.all(names.map(name => fs.readFile(path.join(root, name), 'utf8'))), stale);
  assert.equal(git(root, 'status', '--porcelain').trim(), '');
  await fs.appendFile(path.join(root, 'README.md'), '\nUncommitted work\n');
  assert.match(run(root, ['upgrade', '--version', runtimeIdentity.version], {fail: true}).stderr, /require a clean working tree/);
  assert.deepEqual(await Promise.all(names.map(name => fs.readFile(path.join(root, name), 'utf8'))), stale);
  git(root, 'restore', 'README.md');
  const manifest = await read(root, 'timds.json');
  manifest.workspace.check = ['missing-custom-check'];
  await fs.writeFile(path.join(root, 'timds.json'), JSON.stringify(manifest));
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'Failing custom checker');
  assert.match(run(root, ['upgrade', '--version', runtimeIdentity.version], {fail: true}).stderr, /Required command "missing-custom-check" is unavailable/);
  assert.deepEqual(await Promise.all(names.map(name => fs.readFile(path.join(root, name), 'utf8'))), stale);
  assert.equal(git(root, 'status', '--porcelain').trim(), '');
  manifest.workspace.check = stockWorkspaceCommands.check;
  await fs.writeFile(path.join(root, 'timds.json'), JSON.stringify(manifest));
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'Restore stock checker');
  run(root, ['upgrade', '--version', runtimeIdentity.version]);
  assert.deepEqual(await Promise.all(names.map(name => fs.readFile(path.join(root, name), 'utf8'))), expected);
});

test('binary adoption refuses customized skills, rolls back failed custom checks, keeps custom commands', async t => {
  const root = await fixture(t, false);
  const skill = '.agents/skills/design-start/SKILL.md'; await fs.appendFile(path.join(root, skill), '\nCustom instruction\n');
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'Custom skill');
  assert.match(run(root, ['installation', 'adopt', '--binary', '--apply'], {fail: true}).stderr, /customized managed skill/);
  const manifest = await read(root, 'timds.json'); manifest.workspace.check = ['missing-custom-tool', 'check'];
  await fs.writeFile(path.join(root, 'timds.json'), JSON.stringify(manifest)); git(root, 'add', '.'); git(root, 'commit', '-qm', 'Custom toolchain');
  const before = await fs.readFile(path.join(root, '.timds/installation.json'));
  const failed = run(root, ['installation', 'adopt', '--binary', '--apply', '--force'], {fail: true});
  assert.match(failed.stderr, /Required command "missing-custom-tool" is unavailable/);
  assert.deepEqual(await fs.readFile(path.join(root, '.timds/installation.json')), before);
  assert.deepEqual((await read(root, 'timds.json')).workspace.check, ['missing-custom-tool', 'check']);
  assert.match(await fs.readFile(path.join(root, skill), 'utf8'), /Custom instruction/);
});

test('explicit binary upgrade selects running release, ordinary sync is idempotent, failure restores selection', async t => {
  const root = await fixture(t);
  const record = await read(root, '.timds/installation.json'); record.version = '0.1.1';
  await fs.writeFile(path.join(root, '.timds/installation.json'), JSON.stringify(record)); git(root, 'add', '.'); git(root, 'commit', '-qm', 'Earlier selection');
  run(root, ['upgrade', '--version', runtimeIdentity.version]);
  assert.equal((await read(root, '.timds/installation.json')).version, runtimeIdentity.version);
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'Selected release');
  run(root, ['upgrade']); assert.equal(git(root, 'status', '--porcelain').trim(), '');
  const manifest = await read(root, 'timds.json'); manifest.workspace.check = ['no-such-check'];
  await fs.writeFile(path.join(root, 'timds.json'), JSON.stringify(manifest));
  record.version = '0.1.2'; await fs.writeFile(path.join(root, '.timds/installation.json'), JSON.stringify(record));
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'Failing custom checker');
  const failed = run(root, ['upgrade', '--version', runtimeIdentity.version], {fail: true}); assert.equal(failed.status, 1);
  assert.equal((await read(root, '.timds/installation.json')).version, '0.1.2');
  assert.equal(git(root, 'status', '--porcelain').trim(), '');
});

test('file rollback restores files, directories, modes and links without following them', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'timds rollback ')); t.after(() => fs.rm(root, {recursive: true, force: true}));
  const file = path.join(root, 'file'); await fs.writeFile(file, 'before', {mode: 0o755});
  const link = path.join(root, 'link'); await fs.symlink('file', link);
  await assert.rejects(withFileRollback([file, link], async () => { await fs.writeFile(file, 'after'); await fs.rm(link); throw new Error('stop'); }), /stop/);
  assert.equal(await fs.readFile(file, 'utf8'), 'before'); assert.equal(await fs.readlink(link), 'file'); assert.equal((await fs.stat(file)).mode & 0o777, 0o755);
});


test('stock draft recognition rejects custom scripts even when the snapshot records their hash', async t => {
  const root = await fixture(t);
  const file = 'scripts/check.mjs';
  await fs.appendFile(path.join(root, file), '\nconsole.log("custom checker");\n');
  const {createHash} = await import('node:crypto');
  const record = await read(root, '.timds/starter.json');
  record.files[file] = createHash('sha256').update(await fs.readFile(path.join(root, file))).digest('hex');
  await fs.writeFile(path.join(root, '.timds/starter.json'), JSON.stringify(record));
  assert.equal(await isStockWorkspace(root, await read(root, 'timds.json')), false);
});

test('stock draft recognition accepts the stock stub scripts only', async t => {
  const root = await fixture(t);
  const manifest = await read(root, 'timds.json');
  assert.equal(await isStockWorkspace(root, manifest), true, 'a fresh scaffold runs the packaged renderer through its stubs');
  await assert.rejects(fs.access(path.join(root, 'scripts/viewer.mjs')), {code: 'ENOENT'});
  await fs.rm(path.join(root, 'scripts/dev.mjs'));
  assert.equal(await isStockWorkspace(root, manifest), false, 'every stub is required');
  await fs.copyFile(path.join(packageRoot, 'templates/starter/scripts/dev.mjs'), path.join(root, 'scripts/dev.mjs'));
  assert.equal(await isStockWorkspace(root, manifest), true);
  // Commands after the build are the system's own tools.
  assert.equal(await isStockWorkspace(root, {...manifest, workspace: {...manifest.workspace, after: {build: [['node', 'scripts/extra.mjs']]}}}), false);
});

test('binary global skill installation renders hosted instructions without npm bootstrapping', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'timds binary skills '));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  run(root, ['skills', 'install', '--portal-url', 'https://host.example.test', '--system-id', 'example/core']);
  const directories = await fs.readdir(path.join(root, '.agents/skills'));
  const name = directories.find(name => !['timds-edit-design-system', 'design-start', 'design-media', 'design-ship', 'design-handoff'].includes(name));
  const text = await fs.readFile(path.join(root, '.agents/skills', name, 'SKILL.md'), 'utf8');
  assert.match(text, /Use `timds-cli <command>`/);
  assert.doesNotMatch(text, /npx --yes|npm ci|npm install|never pin a/);
});

test('every executable download names the one public download host', async () => {
  assert.equal(binaryDownloadUrl('0.1.500', 'SHA256SUMS'), `${BINARY_DOWNLOAD_BASE}/v0.1.500/SHA256SUMS`);
  const surfaces = [];
  for (const directory of ['templates', 'docs']) {
    for (const entry of await fs.readdir(path.join(packageRoot, directory), {withFileTypes: true})) {
      if (entry.isFile() && /\.(ya?ml|md)$/.test(entry.name)) surfaces.push(`${directory}/${entry.name}`);
    }
  }
  surfaces.push('README.md');
  let downloads = 0;
  for (const surface of surfaces) {
    const text = await fs.readFile(path.join(packageRoot, surface), 'utf8');
    assert.doesNotMatch(text, /github\.com\/[^/\s]+\/timds-toolkit\/releases/, `${surface} downloads executables from GitHub Releases`);
    for (const [, base] of text.matchAll(/(https:\/\/[^\s"']+)\/v\$\{(?:version|VERSION)\}/g)) {
      assert.equal(base, BINARY_DOWNLOAD_BASE, `${surface} downloads from ${base}`);
      downloads += 1;
    }
  }
  assert.ok(downloads >= 7, `expected the stock workflows and install docs to download executables, found ${downloads}`);
});

test('binary upgrade refuses a system below the starter floor before any write, stale aggregates included', async t => {
  const root = await fixture(t);
  const record = await read(root, '.timds/starter.json');
  delete record.level;
  await fs.writeFile(path.join(root, '.timds/starter.json'), `${JSON.stringify(record, null, 2)}\n`);
  const group = await read(root, 'tokens/space.json');
  group['1'].value = '0.3rem';
  await fs.writeFile(path.join(root, 'tokens/space.json'), `${JSON.stringify(group, null, 2)}\n`);
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'Below the floor, with a stale aggregate');
  for (const args of [['upgrade', '--json'], ['upgrade', '--version', runtimeIdentity.version, '--json']]) {
    const result = run(root, args, {fail: true});
    assert.equal(result.status, 1, args.join(' '));
    assert.equal(JSON.parse(result.stdout).error.code, 'below_floor', args.join(' '));
    assert.equal(git(root, 'status', '--porcelain', '--untracked-files=all').trim(), '', `${args.join(' ')} wrote nothing`);
  }
});
