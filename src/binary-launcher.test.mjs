import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const require = createRequire(import.meta.url);
const { materialize, validate, safePath, sha256 } = require('../scripts/binary-launcher.cjs');
function fixture() {
  const body = Buffer.from('embedded-file');
  const payload = gzipSync(body);
  return { payload, metadata: { version: '0.1.0', platform: process.platform, arch: process.arch, manifest: { payloadHash: sha256(payload), files: [{ path: 'package/bin.mjs', offset: 0, size: body.length, sha256: sha256(body), mode: 0o755 }, { path: 'package/link', link: 'bin.mjs' }] } } };
}
test('extraction verifies files, repairs corruption and incomplete caches, and rejects traversal', async t => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'timds-cache-test-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const { payload, metadata } = fixture();
  const cache = materialize(payload, metadata, base);
  assert.equal(validate(cache, metadata.manifest), true);
  await fs.writeFile(path.join(cache, 'package/bin.mjs'), 'corrupt');
  assert.equal(validate(cache, metadata.manifest), false);
  assert.equal(materialize(payload, metadata, base), cache);
  assert.equal(await fs.readFile(path.join(cache, 'package/bin.mjs'), 'utf8'), 'embedded-file');
  await fs.writeFile(path.join(cache, 'package', 'unexpected.js'), 'shadow import');
  assert.equal(validate(cache, metadata.manifest), false);
  assert.equal(materialize(payload, metadata, base), cache);
  assert.equal(await fs.stat(path.join(cache, 'package', 'unexpected.js')).catch(() => null), null);
  await fs.rm(path.join(cache, '.complete'));
  assert.equal(materialize(payload, metadata, base), cache);
  await fs.rm(cache, { recursive: true });
  assert.throws(() => materialize(Buffer.from('wrong'), metadata, base), /integrity/);
  for (const entry of ['../escape', '/absolute', 'a/../../escape', 'a\\escape', 'a//b']) assert.throws(() => safePath(base, entry), /Unsafe/);
});
test('concurrent first launches publish one complete cache and recover a dead initializer', async t => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'timds-concurrent-test-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const { payload, metadata } = fixture();
  const input = path.join(base, 'input.json');
  await fs.writeFile(input, JSON.stringify({ payload: payload.toString('base64'), metadata }));
  const launcher = require.resolve('../scripts/binary-launcher.cjs');
  const script = `const {materialize}=require(process.argv[1]); const input=require(process.argv[2]); console.log(materialize(Buffer.from(input.payload,'base64'),input.metadata,process.argv[3]));`;
  const runs = await Promise.all(Array.from({ length: 4 }, () => promisify(execFile)(process.execPath, ['-e', script, launcher, input, base])));
  assert.equal(new Set(runs.map(result => result.stdout)).size, 1);
  const cache = runs[0].stdout.trim();
  assert.equal(validate(cache, metadata.manifest), true);
  await fs.rm(cache, { recursive: true });
  await fs.mkdir(`${cache}.lock`);
  await fs.writeFile(path.join(`${cache}.lock`, 'owner'), '2147483647');
  assert.equal(materialize(payload, metadata, base), cache);
});

test('interrupted and malformed initializer owners recover after their write grace period', async t => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'timds-incomplete-lock-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const { payload, metadata } = fixture();
  const cache = materialize(payload, metadata, base);
  for (const owner of [null, 'not-a-pid', '0']) {
    await fs.rm(cache, { recursive: true });
    const lock = `${cache}.lock`;
    await fs.mkdir(lock);
    if (owner !== null) await fs.writeFile(path.join(lock, 'owner'), owner);
    const old = new Date(Date.now() - 5000);
    await fs.utimes(lock, old, old);
    assert.equal(materialize(payload, metadata, base), cache);
  }
});
