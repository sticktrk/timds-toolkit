import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** One resource root for npm execution and the materialized SEA package. */
export const packageRoot = fileURLToPath(new URL('../', import.meta.url)).replace(/\/$/, '');
export function packageIdentity() {
  return JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
}
export function isBinaryRuntime() {
  return Boolean(process.env.TIMDS_BINARY_EXECUTABLE && process.env.TIMDS_RUNTIME_ROOT &&
    process.env.TIMDS_RUNTIME_PACKAGE === packageRoot);
}
/** CLI re-entry must never be mistaken for a JavaScript interpreter. */
export function cliCommand(args = []) {
  return isBinaryRuntime()
    ? [process.env.TIMDS_BINARY_EXECUTABLE, ...args]
    : [process.execPath, path.join(packageRoot, 'bin/timds.mjs'), ...args];
}
/** The SEA launches an unmodified bundled Node; this is always an interpreter. */
export function javascriptCommand(args = []) {
  return [process.execPath, ...(isBinaryRuntime() ? ['--import', path.join(packageRoot, 'src/executable-register.mjs')] : []), ...args];
}
/** Carry runtime location across an already-sanitized environment, never credentials. */
export function runtimeEnvironment(env = process.env) {
  if (!isBinaryRuntime()) return { ...env };
  return { ...env, TIMDS_BINARY_CACHE: path.dirname(process.env.TIMDS_RUNTIME_ROOT), ...Object.fromEntries(['TIMDS_BINARY_EXECUTABLE', 'TIMDS_RUNTIME_ROOT', 'TIMDS_RUNTIME_PACKAGE'].map(key => [key, process.env[key]])) };
}
