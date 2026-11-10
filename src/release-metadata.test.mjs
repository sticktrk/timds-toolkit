import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import test from 'node:test';
import { packageIdentity, packageRoot } from './executable.mjs';
import { initializeRepository, runWithOutputSink } from './core.mjs';
import { hostedSkillName, renderHostedSkillFiles } from './skills-install.mjs';
import { describeToolkitRelease, readToolkitReleaseResource, renderToolkitManagedFiles } from './release-metadata.mjs';

const exec = promisify(execFile);
const hash = content => createHash('sha256').update(content).digest('hex');
const hostedSkill = { portalUrl: 'https://host.example.com', systemId: 'example/core', systemName: 'Example', studioUrl: 'https://host.example.com/studio/example' };
async function scratch(t, prefix) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

test('release metadata preserves both starter ownership boundaries and template hashes', async () => {
  for (const starter of ['starter', 'brand-kit']) {
    const metadata = await describeToolkitRelease({ schemaVersion: 1, starter });
    assert.deepEqual(metadata.toolkit, { name: '@dtconcepts/timds', version: packageIdentity().version });
    assert.deepEqual(metadata, await describeToolkitRelease({ starter }));
    assert.equal(metadata.files.filter(file => file.policy === 'starter-plumbing').length, 6, 'three stub scripts and three browser files; the renderer is no longer copied');
    for (const retired of ['scripts/viewer.mjs', 'scripts/brand-kit.mjs']) assert.ok(!metadata.files.some(file => file.path === retired), retired);
    assert.equal(metadata.files.filter(file => file.policy === 'stock-fragment').length, starter === 'starter' ? 6 : 0);
    for (const file of metadata.files.filter(file => file.path.startsWith('src/pages/'))) {
      if (starter === 'brand-kit') assert.equal(file.policy, 'seed-only', file.path);
    }
    assert.equal(metadata.files.find(file => file.path === 'src/styles/system.css').policy, 'seed-only');
    assert.equal(metadata.files.find(file => file.path === 'src/site.json').policy, 'catalog-merge');
    assert.equal(metadata.files.find(file => file.path === 'src/layout.html').policy, 'layout-patch');
    assert.equal(metadata.generated.find(file => file.path === '.timds/starter.json').policy, 'version-metadata');
    for (const resource of metadata.resources) {
      assert.ok(!resource.packagePath.includes('..'));
      const read = await readToolkitReleaseResource(resource.packagePath, { starter });
      const { content, ...actual } = read;
      assert.deepEqual(actual, resource);
      assert.equal(hash(content), resource.sha256);
    }
    const rendered = await renderToolkitManagedFiles({ starter, hostedSkill });
    assert.ok(rendered.files.every(file => !['seed-only', 'catalog-merge', 'layout-patch', 'release-automation', 'dependency-automation'].includes(file.policy)));
    for (const file of rendered.files) assert.equal(hash(file.content), file.sha256);
    const hosted = await renderHostedSkillFiles(hostedSkill);
    for (const file of hosted) {
      const actual = rendered.files.find(output => output.path === `.agents/skills/${hostedSkillName(hostedSkill.systemId)}/${file.relative}`);
      assert.equal(actual.content, file.content);
      assert.notEqual(actual.sha256, metadata.resources.find(resource => resource.packagePath === `skills/timds-hosted-design-system/${file.relative}`).sha256);
    }
  }
});

for (const starter of ['starter', 'brand-kit']) test(`rendered ${starter} managed bytes and modes match actual initialization`, async t => {
  const directory = await scratch(t, 'timds-metadata-init-');
  await runWithOutputSink(() => {}, () => initializeRepository(directory, { standalone: true, starter, name: 'Example', systemId: 'example/core' }));
  const rendered = await renderToolkitManagedFiles({ starter, releaseAutomation: true });
  for (const file of rendered.files) {
    const absolute = path.join(directory, file.path);
    const stat = await fs.lstat(absolute);
    const mode = stat.isSymbolicLink() ? '120000' : stat.mode & 0o111 ? '100755' : '100644';
    const content = stat.isSymbolicLink() ? await fs.readlink(absolute) : await fs.readFile(absolute, 'utf8');
    assert.equal(content, file.content, file.path);
    assert.equal(mode, file.mode, file.path);
  }
  const record = JSON.parse(await fs.readFile(path.join(directory, '.timds/starter.json')));
  assert.deepEqual(record.files, Object.fromEntries(rendered.files.filter(file => ['starter-plumbing', 'stock-fragment'].includes(file.policy)).map(file => [file.path, file.sha256])));
  const metadata = await describeToolkitRelease({ starter });
  for (const file of metadata.files.filter(file => file.policy === 'seed-only' && file.operation === 'copy')) {
    assert.equal(await fs.readFile(path.join(directory, file.path), 'utf8'), (await readToolkitReleaseResource(file.resource, { starter })).content, file.path);
  }
});

test('metadata rejects unsupported contracts, resources, and colliding hosted identities', async () => {
  await assert.rejects(describeToolkitRelease({ version: 'latest' }), /Unknown toolkit release metadata option/);
  await assert.rejects(describeToolkitRelease({ schemaVersion: 2 }), /Unsupported toolkit release metadata schema/);
  await assert.rejects(renderToolkitManagedFiles({ starter: 'unknown' }), /Unknown starter/);
  await assert.rejects(readToolkitReleaseResource('../package.json'), /Unknown toolkit release resource/);
  await assert.rejects(readToolkitReleaseResource('/etc/passwd'), /Unknown toolkit release resource/);
  await assert.rejects(readToolkitReleaseResource('templates/brand-kit/src/pages/index.html'), /Unknown toolkit release resource/);
  await assert.rejects(renderToolkitManagedFiles({ releaseAutomation: 'yes' }), /must be a boolean/);
  await assert.rejects(renderToolkitManagedFiles({ hostedSkill: {} }), /portal|system|URL/i);
  await assert.rejects(renderToolkitManagedFiles({ hostedSkill: { ...hostedSkill, systemId: 'example/edit-design-system' } }), /collides/);
});

test('packed export is complete, typed, deterministic outside the checkout, and rejects damaged resources', async t => {
  const directory = await scratch(t, 'timds-metadata-package-');
  const { stdout } = await exec('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', directory], { cwd: packageRoot, maxBuffer: 10 * 1024 * 1024 });
  const packed = JSON.parse(stdout)[0];
  assert.ok(packed.files.some(file => file.path === 'src/release-metadata.d.mts'));
  const installed = path.join(directory, 'node_modules/@dtconcepts/timds');
  await fs.mkdir(installed, { recursive: true });
  await exec('tar', ['-xzf', path.join(directory, packed.filename), '-C', installed, '--strip-components=1']);
  const runner = path.join(directory, 'read.mjs');
  await fs.writeFile(runner, `
import {describeToolkitRelease, renderToolkitManagedFiles} from '@dtconcepts/timds/release-metadata';
Date.now = () => { throw new Error('clock must not be read'); };
const result = [];
for (const starter of ['starter', 'brand-kit']) result.push([await describeToolkitRelease({schemaVersion:1,starter}), await renderToolkitManagedFiles({starter,hostedSkill:${JSON.stringify(hostedSkill)},releaseAutomation:true,dependencyAutomation:true})]);
console.log(JSON.stringify(result));
`);
  const env = { ...process.env, TIMDS_BINARY_EXECUTABLE: '/unused/binary', TIMDS_RUNTIME_ROOT: directory, TIMDS_RUNTIME_PACKAGE: installed, TIMDS_PORTAL_URL: 'https://unused.example.com', XDG_CONFIG_HOME: path.join(directory, 'missing-config') };
  const first = await exec(process.execPath, [runner], { cwd: directory, env, maxBuffer: 5 * 1024 * 1024 });
  const second = await exec(process.execPath, [runner], { cwd: os.tmpdir(), env: { ...env, TZ: 'Pacific/Honolulu' }, maxBuffer: 5 * 1024 * 1024 });
  assert.equal(first.stdout, second.stdout);
  const expected = [];
  for (const starter of ['starter', 'brand-kit']) expected.push([await describeToolkitRelease({ starter }), await renderToolkitManagedFiles({ starter, hostedSkill, releaseAutomation: true, dependencyAutomation: true })]);
  assert.deepEqual(JSON.parse(first.stdout), expected);
  const manifestPath = path.join(installed, 'package.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath));
  await fs.writeFile(manifestPath, JSON.stringify({...manifest, version: '999.1.0'}));
  const versionOnly = JSON.parse((await exec(process.execPath, [runner], {cwd: directory, env, maxBuffer: 5 * 1024 * 1024})).stdout);
  for (let index = 0; index < expected.length; index += 1) {
    assert.equal(versionOnly[index][0].toolkit.version, '999.1.0');
    assert.equal(versionOnly[index][1].toolkit.version, '999.1.0');
    assert.deepEqual(versionOnly[index][0].resources, expected[index][0].resources);
    assert.deepEqual(versionOnly[index][1].files, expected[index][1].files, 'version metadata alone is not a managed-content change');
  }
  await fs.writeFile(path.join(directory, 'types.mts'), `
import {describeToolkitRelease, readToolkitReleaseResource, renderToolkitManagedFiles, type FileMode} from '@dtconcepts/timds/release-metadata';
const release = await describeToolkitRelease({schemaVersion:1, starter:'brand-kit'});
const raw: string = (await readToolkitReleaseResource(release.resources[0].packagePath)).content;
const mode: FileMode = (await renderToolkitManagedFiles({hostedSkill:{portalUrl:'https://host.example.com',systemId:'example/core'}})).files[0].mode;
// @ts-expect-error Unknown schema versions must be negotiated explicitly.
await describeToolkitRelease({schemaVersion:2});
// @ts-expect-error Only named starters are supported.
await renderToolkitManagedFiles({starter:'unknown'});
void raw; void mode;
`);
  const require = createRequire(import.meta.url);
  await exec(process.execPath, [require.resolve('typescript/bin/tsc'), '--noEmit', '--strict', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--target', 'ES2023', path.join(directory, 'types.mts')], { cwd: directory });
  const resource = path.join(installed, 'skills/timds-hosted-design-system/SKILL.md');
  await fs.rm(resource);
  await assert.rejects(exec(process.execPath, [runner], { cwd: directory, env }), /missing required skill entry point/);
  // A missing file could otherwise disappear from directory enumeration. The
  // package must declare its required skill entry points as well as extras.
  await fs.symlink(path.join(packageRoot, 'skills/timds-hosted-design-system/SKILL.md'), resource);
  await assert.rejects(exec(process.execPath, [runner], { cwd: directory, env }), /Unsupported toolkit resource|symbolic links/);
  await fs.rm(resource);
  await fs.writeFile(resource, Buffer.from([0xff]));
  await assert.rejects(exec(process.execPath, [runner], { cwd: directory, env }), /Cannot read toolkit resource.*SKILL.md/);
  await fs.writeFile(resource, '\uFEFF# Example\n');
  const probe = `import {readToolkitReleaseResource} from '@dtconcepts/timds/release-metadata'; console.log(JSON.stringify(await readToolkitReleaseResource('skills/timds-hosted-design-system/SKILL.md')));`;
  const {stdout: bom} = await exec(process.execPath, ['--input-type=module', '-e', probe], {cwd: directory});
  assert.equal(JSON.parse(bom).content, '\uFEFF# Example\n');
  assert.equal(JSON.parse(bom).sha256, hash(JSON.parse(bom).content));
});
