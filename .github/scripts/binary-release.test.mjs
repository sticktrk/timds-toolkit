import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

async function fixture(t) {
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
    if (target === 'darwin-arm64') {
      const code = (path, hash) => ({ path, teamIdentifier: 'TESTTEAM12', tickets: [{ path, arch: 'arm64', cdhash: hash.repeat(40) }] });
      const report = (submissionId, verifiedCodeCount) => ({ status: 'Accepted', submissionId, archiveSha256: 'a'.repeat(64), ticketCount: verifiedCodeCount, verifiedCodeCount, issues: [] });
      Object.assign(metadata, { signed: 'developer-id', signingTeamId: 'TESTTEAM12', notarized: true,
        nativeCode: [code('runtime/node', 'b'), code('package/native/addon.node', 'c')], launcherCode: code(executable, 'd'),
        payloadNotarization: report('payload-submission', 2), notarization: report('launcher-submission', 1), notarizationSubmissionId: 'launcher-submission' });
    }
    const file = path.join(root, 'dist/binary', executable);
    await fs.writeFile(file, bytes);
    await fs.writeFile(`${file}.sha256`, `${sha(bytes)}  ${executable}\n`);
    await fs.writeFile(`${file}.json`, JSON.stringify(metadata));
    manifests.push({ metadata, file });
  }
  const run = (tag = 'v0.1.2') => spawnSync(process.execPath, ['scripts/binary-release.mjs'], { cwd: root, env: { ...process.env, RELEASE_TAG: tag }, encoding: 'utf8' });
  return { root, manifests, run };
}

test('binary attachments require both native artifacts from the same clean release commit', async t => {
  const { root, manifests, run } = await fixture(t);
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

test('macOS release attachments require accepted payload and launcher ticket coverage', async t => {
  const { manifests, run } = await fixture(t);
  const { file, metadata } = manifests[0];
  for (const invalidate of [
    value => { value.signed = 'ad-hoc'; },
    value => { value.notarized = false; },
    value => { value.signingTeamId = 'unknown'; },
    value => { value.nativeCode = []; },
    value => { value.nativeCode[0].teamIdentifier = 'OTHERTEAM1'; },
    value => { value.nativeCode[0].path = '../runtime/node'; },
    value => { value.nativeCode[0].tickets[0].cdhash = 'invalid'; },
    value => { value.nativeCode[0].tickets[0].path = 'other'; },
    value => { value.nativeCode[0].tickets.push(value.nativeCode[0].tickets[0]); },
    value => { value.nativeCode[0].tickets[0].arch = 'x86_64'; },
    value => { value.nativeCode.push(value.nativeCode[0]); },
    value => { value.launcherCode = null; },
    value => { value.launcherCode.path = 'other'; },
    value => { value.launcherCode.teamIdentifier = 'OTHERTEAM1'; },
    value => { value.payloadNotarization = null; },
    value => { value.payloadNotarization.status = 'Invalid'; },
    value => { value.notarization.status = 'In Progress'; },
    value => { value.payloadNotarization.verifiedCodeCount = 1; },
    value => { value.notarization.verifiedCodeCount = 2; },
    value => { value.payloadNotarization.ticketCount = 1; },
    value => { value.payloadNotarization.archiveSha256 = ''; },
    value => { value.notarization.submissionId = ''; },
    value => { value.notarization.issues = [{ severity: 'error', message: 'Invalid signature' }]; },
    value => { value.notarizationSubmissionId = 'wrong-submission'; },
    value => { value.payloadNotarization.submissionId = value.notarization.submissionId; },
  ]) {
    const invalid = structuredClone(metadata);
    invalidate(invalid);
    await fs.writeFile(`${file}.json`, JSON.stringify(invalid));
    const result = run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /requires verified Developer ID notarization/);
  }
  const deduplicated = structuredClone(metadata);
  deduplicated.nativeCode[1].tickets[0].cdhash = deduplicated.nativeCode[0].tickets[0].cdhash;
  deduplicated.payloadNotarization.ticketCount = 1;
  deduplicated.payloadNotarization.issues = [{ severity: 'warning', message: 'Informational' }];
  await fs.writeFile(`${file}.json`, JSON.stringify(deduplicated));
  const result = run();
  assert.equal(result.status, 0, result.stderr);
});
