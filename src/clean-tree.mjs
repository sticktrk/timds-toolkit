// Shared read-only Git guard for migrations that may write selected files.
// Callers own hosted-session exceptions and select their exact write boundary.
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const invoke = promisify(execFile);

export async function requireCleanPaths(root, relatives, {
  message = 'Refusing to run over uncommitted changes to the files it writes',
  remedy = 'Commit or stash them first',
  failureCode = 'dirty_worktree',
} = {}) {
  if (!relatives.length) return;
  root = await fs.realpath(root);
  let toplevel;
  try { toplevel = (await invoke('git', ['rev-parse', '--show-toplevel'], { cwd: root })).stdout.trim(); }
  catch (error) { if (error.code === 128) return; throw error; }
  const paths = relatives.map(relative => path.relative(toplevel, path.join(root, relative)).split(path.sep).join('/'));
  const { stdout } = await invoke('git', ['--literal-pathspecs', 'status', '--porcelain', '--untracked-files=all', '--', ...paths], { cwd: toplevel });
  if (stdout.trim()) throw Object.assign(new Error(`${message}:\n${stdout.trim()}\n${remedy}`), { failureCode });
}
