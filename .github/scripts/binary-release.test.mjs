import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

test('binary attachments require both native artifacts from the same clean release commit', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'timds-binary-release-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'scripts'));
  await fs.mkdir(path.join(root, 'dist/binary'), { recursive: true });
  await fs.copyFile(new URL('../../scripts/binary-release.mjs', import.meta.url), path.join(root, 'scripts/binary-release.mjs'));
  const packageJson = JSON.stringify({ name: '@dtconcepts/timds', version: '0.1.2' });
  const lock = JSON.stringify({ lockfileVersion: 3 });
  await fs.writeFile(path.join(root, 'package.json'), packageJson);
  await fs.writeFile(path.join(root, 'package-lock.json'), lock);
  const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.test', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.test' };
  for (const args of [['init', '-q'], ['add', '.'], ['commit', '-qm', 'fixture']]) execFileSync('git', args, { cwd: root, env: gitEnv });
  const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const manifests = [];
  for (const target of ['darwin-arm64', 'linux-x64']) {
    const executable = `timds-cli-v0.1.2-${target}`, bytes = Buffer.from(`fixture:${target}`);
    const metadata = { version: '0.1.2', target, executable, sourceCommit, sourceDirty: false, packageSha256: sha(packageJson), lockSha256: sha(lock) };
    const file = path.join(root, 'dist/binary', executable);
    await fs.writeFile(file, bytes);
    await fs.writeFile(`${file}.sha256`, `${sha(bytes)}  ${executable}\n`);
    await fs.writeFile(`${file}.json`, JSON.stringify(metadata));
    manifests.push({ metadata, file });
  }
  const run = (tag = 'v0.1.2') => spawnSync(process.execPath, ['scripts/binary-release.mjs'], { cwd: root, env: { ...process.env, RELEASE_TAG: tag }, encoding: 'utf8' });
  assert.equal(run().status, 0);
  assert.equal((await fs.readFile(path.join(root, 'dist/binary/SHA256SUMS'), 'utf8')).trim().split('\n').length, 2);
  assert.match(run('v0.1.3').stderr, /tag must exactly match/);
  const { file, metadata } = manifests[0];
  for (const bad of [{ sourceDirty: true }, { sourceCommit: 'wrong' }, { packageSha256: 'wrong' }, { lockSha256: 'wrong' }]) {
    await fs.writeFile(`${file}.json`, JSON.stringify({ ...metadata, ...bad }));
    assert.match(run().stderr, /exact clean release commit/);
  }
  await fs.writeFile(`${file}.json`, JSON.stringify(metadata));
  await fs.writeFile(file, 'changed binary');
  assert.match(run().stderr, /checksum mismatch/);
});
