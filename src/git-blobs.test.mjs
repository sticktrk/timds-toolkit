import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {readBlobs} from './git-blobs.mjs';

test('batched blob reads return exact deduplicated bytes and enforce response bounds', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'timds-git-blobs-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  execFileSync('git', ['init', '-q'], {cwd: root});
  const bytes = Buffer.from([0, 255, 10, 13, 128, 1]);
  const sha = execFileSync('git', ['hash-object', '-w', '--stdin'], {cwd: root, input: bytes, encoding: 'utf8'}).trim();
  const blobs = readBlobs(root, [sha, sha]);
  assert.equal(blobs.size, 1);
  assert.deepEqual(blobs.get(sha), bytes);
  assert.deepEqual(readBlobs(root, []), new Map());
  assert.throws(() => readBlobs(root, ['HEAD']), /exact object IDs/);
  assert.throws(() => readBlobs(root, ['0'.repeat(40)]), /could not be read/);
  assert.throws(() => readBlobs(root, [sha], {maxBytes: bytes.length - 1}), /could not be read/);
  assert.throws(() => readBlobs(root, [sha], {maxBlobBytes: bytes.length - 1}), /could not be read/);
});
