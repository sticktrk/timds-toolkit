import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { requireCleanPaths } from './clean-tree.mjs';

test('clean-tree guards literal selected paths from a nested root and allows unrelated edits', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'timds-clean-tree-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  git('init', '-q');
  git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.com');
  for (const folder of ['[draft]', 'd']) {
    await fs.mkdir(path.join(root, 'src', folder), { recursive: true });
    await fs.writeFile(path.join(root, 'src', folder, 'target.mjs'), 'original');
  }
  git('add', '--all'); git('commit', '-qm', 'Tracked boundary');
  await fs.writeFile(path.join(root, 'src/d/target.mjs'), 'authored change');
  await requireCleanPaths(path.join(root, 'src'), ['[draft]/target.mjs']);
  await fs.writeFile(path.join(root, 'src/[draft]/target.mjs'), 'dirty protected file');
  await assert.rejects(requireCleanPaths(path.join(root, 'src'), ['[draft]/target.mjs'], { message: 'A feed requires clean files' }), error => error.failureCode === 'dirty_worktree' && /A feed requires clean files/.test(error.message));
  await requireCleanPaths(root, []);
});

test('clean-tree permits a workspace outside Git', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'timds-clean-tree-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await requireCleanPaths(root, ['missing.json']);
});
