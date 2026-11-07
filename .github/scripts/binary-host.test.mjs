import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { BINARY_TARGETS, readRelease, releaseFileNames, uploadRelease } from '../../scripts/binary-host.mjs';
import { binaryDownloadUrl } from '../../src/binary-installation.mjs';

const version = '0.1.500';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

async function release(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'timds-host-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const sums = [];
  for (const target of BINARY_TARGETS) {
    const name = `timds-cli-v${version}-${target}`;
    const bytes = Buffer.from(`executable for ${target}`);
    const line = `${sha256(bytes)}  ${name}\n`;
    await fs.writeFile(path.join(directory, name), bytes);
    await fs.writeFile(path.join(directory, `${name}.sha256`), line);
    await fs.writeFile(path.join(directory, `${name}.json`), JSON.stringify({ version, target, executable: name }));
    sums.push(line);
  }
  await fs.writeFile(path.join(directory, 'SHA256SUMS'), sums.join(''));
  return directory;
}

test('a release is the two executables, their checksums and build records, with SHA256SUMS last', () => {
  const names = releaseFileNames(version);
  assert.equal(names.length, 7);
  assert.equal(names.at(-1), 'SHA256SUMS');
  for (const refused of ['0.1.x', 'latest', '', '0.1.5-rc.1']) assert.throws(() => releaseFileNames(refused), /exact release/);
});

test('a dry run plans every public URL without credentials', async t => {
  const directory = await release(t);
  const lines = [];
  const result = await uploadRelease(directory, version, { dryRun: true, log: line => lines.push(line) });
  assert.deepEqual(result.planned, releaseFileNames(version));
  assert.equal(lines.length, 7);
  assert.ok(lines.every((line, index) => line.startsWith(`would upload ${binaryDownloadUrl(version, releaseFileNames(version)[index])} `)));
});

test('an incomplete or inconsistent release is refused before anything is uploaded', async t => {
  const missing = await release(t);
  await fs.rm(path.join(missing, `timds-cli-v${version}-linux-x64.json`));
  await assert.rejects(readRelease(missing, version), /missing timds-cli-v0\.1\.500-linux-x64\.json/);

  const tampered = await release(t);
  await fs.writeFile(path.join(tampered, `timds-cli-v${version}-darwin-arm64`), 'other bytes');
  await assert.rejects(readRelease(tampered, version), /Checksum mismatch: timds-cli-v0\.1\.500-darwin-arm64\.sha256/);

  const unlisted = await release(t);
  await fs.writeFile(path.join(unlisted, 'SHA256SUMS'), '');
  await assert.rejects(readRelease(unlisted, version), /in SHA256SUMS/);

  const mislabeled = await release(t);
  await fs.writeFile(path.join(mislabeled, `timds-cli-v${version}-linux-x64.json`), JSON.stringify({ version: '0.1.499', target: 'linux-x64', executable: `timds-cli-v${version}-linux-x64` }));
  await assert.rejects(readRelease(mislabeled, version), /Build record does not match/);
});

test('a real upload names the credentials it needs instead of guessing', async t => {
  const directory = await release(t);
  const saved = {};
  for (const name of ['TIMDS_R2_ENDPOINT', 'TIMDS_R2_ACCESS_KEY_ID', 'TIMDS_R2_SECRET_ACCESS_KEY', 'CLOUDFLARE_S3_API_ENDPOINT', 'CLOUDFLARE_ACCESS_KEY', 'CLOUDFLARE_SECRET_ACCESS_KEY']) {
    saved[name] = process.env[name];
    delete process.env[name];
  }
  t.after(() => { for (const [name, value] of Object.entries(saved)) if (value !== undefined) process.env[name] = value; });
  await assert.rejects(uploadRelease(directory, version, { log: () => {} }), /Set TIMDS_R2_ENDPOINT, TIMDS_R2_ACCESS_KEY_ID and TIMDS_R2_SECRET_ACCESS_KEY/);
});
