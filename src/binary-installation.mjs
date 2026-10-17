// Exact executable selection is independent of npm's bounded dependency line.
// Adoption is an explicit contract migration; ordinary upgrades only touch the
// existing managed boundary. No runtime bytes are written into a client repo.
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { isBinaryRuntime, javascriptCommand, packageRoot } from './executable.mjs';
import { runtimeIdentity } from './runtime.mjs';
import { legacyStarterFileHashes } from './starter.mjs';

const selection = new AsyncLocalStorage();
export const BINARY_INSTALLATION_FILE = '.timds/installation.json';
export const stockWorkspaceCommands = Object.freeze(Object.fromEntries(['dev', 'build', 'check'].map(name => [name, ['timds-cli', 'run', `scripts/${name}.mjs`]])));
export const binaryInstallationRecord = (previous = {}) => ({ ...previous, schemaVersion: 2, mode: 'binary', name: runtimeIdentity.name, version: runtimeIdentity.version, executable: 'timds-cli' });
export async function readInstallation(root) {
  try { return JSON.parse(await fs.readFile(path.join(root, BINARY_INSTALLATION_FILE), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
export async function readBinaryInstallation(root) {
  const record = await readInstallation(root);
  if (record?.mode !== 'binary') return null;
  if (record.schemaVersion !== 2 || record.name !== '@dtconcepts/timds' || !/^\d+\.\d+\.\d+$/.test(record.version) || record.executable !== 'timds-cli') throw new Error('Invalid binary installation record; restore the reviewed .timds/installation.json');
  return record;
}
export async function assertBinaryInstallation(root, { allowMismatch = false, allowNpm = false } = {}) {
  if (selection.getStore()) return;
  const record = await readBinaryInstallation(root);
  if (record) {
    if (!allowMismatch && record.version !== runtimeIdentity.version) throw new Error(`Workspace selects TimDS ${record.version}; running toolkit is ${runtimeIdentity.version}. Install timds-cli ${record.version}, or explicitly select this executable with timds-cli upgrade --version ${runtimeIdentity.version}.`);
  } else if (isBinaryRuntime() && !allowNpm) {
    if (process.env.TIMDS_BINARY_STOCK_DRAFT === '1') {
      const manifest = JSON.parse(await fs.readFile(path.join(root, 'timds.json'), 'utf8'));
      if (await isStockWorkspace(root, manifest)) return;
    }
    throw new Error('This workspace has not selected binary execution. Preview timds-cli installation adopt --binary, then apply it with --apply. Custom workspace tools keep their declared requirements.');
  }
}
export function withBinarySelection(task) { return selection.run(true, task); }
export function requireBinaryRelease(version) {
  if (!isBinaryRuntime()) throw new Error('Use the downloaded timds-cli executable for binary adoption or release selection.');
  if (version !== runtimeIdentity.version) throw new Error(`Running executable is ${runtimeIdentity.version}; install the verified timds-cli ${version} download, then run its upgrade --version ${version}. No executable was replaced.`);
}
export function binaryWorkspaceCommand(command) {
  if (command?.[0] === 'timds-cli' && command[1] === 'run') return javascriptCommand(command.slice(2));
  if (isBinaryRuntime() && process.env.TIMDS_BINARY_STOCK_DRAFT === '1' && command?.[0] === 'node') return javascriptCommand(command.slice(1));
  return command;
}
export async function isStockWorkspace(root, manifest) {
  if (manifest.workspace?.install) return false;
  for (const name of ['build', 'check', 'dev']) {
    const command = manifest.workspace?.[name];
    if (JSON.stringify(command) !== JSON.stringify(['node', `scripts/${name}.mjs`]) && JSON.stringify(command) !== JSON.stringify(stockWorkspaceCommands[name])) return false;
  }
  for (const relative of ['scripts/build.mjs', 'scripts/check.mjs', 'scripts/dev.mjs', 'scripts/viewer.mjs']) {
    let contents;
    try { contents = await fs.readFile(path.join(root, relative)); } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
    const hash = createHash('sha256').update(contents).digest('hex');
    const stock = createHash('sha256').update(await fs.readFile(path.join(packageRoot, 'templates/starter', relative))).digest('hex');
    if (hash !== stock && !(legacyStarterFileHashes.get(relative) || []).includes(hash)) return false;
  }
  return true;
}

/** Snapshot only the caller's authorized paths; restore all on failure. */
export async function withFileRollback(paths, task) {
  const unique = [...new Set(paths.map(file => path.resolve(file)))].sort((a, b) => a.length - b.length).filter((file, index, files) => !files.slice(0, index).some(parent => file.startsWith(`${parent}${path.sep}`)));
  const snapshots = new Map();
  async function read(file) {
    let stat;
    try { stat = await fs.lstat(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    if (stat.isSymbolicLink()) return { link: await fs.readlink(file) };
    if (stat.isDirectory()) return { entries: Object.fromEntries(await Promise.all((await fs.readdir(file)).map(async name => [name, await read(path.join(file, name))]))) };
    return { bytes: await fs.readFile(file), mode: stat.mode };
  }
  async function restore(file, snapshot) {
    await fs.rm(file, { recursive: true, force: true });
    if (snapshot === null) return;
    await fs.mkdir(path.dirname(file), { recursive: true });
    if (snapshot.link !== undefined) await fs.symlink(snapshot.link, file);
    else if (snapshot.entries) {
      await fs.mkdir(file, { recursive: true });
      for (const [name, entry] of Object.entries(snapshot.entries)) await restore(path.join(file, name), entry);
    } else await fs.writeFile(file, snapshot.bytes, { mode: snapshot.mode });
  }
  for (const file of unique) snapshots.set(file, await read(file));
  try { return await task(); } catch (error) {
    for (const [file, snapshot] of snapshots) await restore(file, snapshot);
    throw error;
  }
}

export function renderBinaryInstructions(content) {
  return content
    .replace(/Run the CLI as `npx --yes @dtconcepts\/timds@latest <command>`[\s\S]*?never pin a\nversion\./, 'Use `timds-cli <command>` from the verified executable release. Below, `timds` stands for `timds-cli`. Existing source selects its exact release in `.timds/installation.json`; preview and explicitly apply binary adoption when a source snapshot still selects npm.')
    .replace('1. `npm ci` (or `npm install` once when there is no lockfile).', '1. Compare `timds-cli --version` with `.timds/installation.json`; stock binary commands need no package-manager installation.')
    .replace('- Pin a toolkit version. The CLI is always `@dtconcepts/timds@latest`.', '- Change the selected toolkit release. Binary version changes require an explicit reviewed `timds-cli upgrade --version EXACT_VERSION`.')
    .replaceAll('npm run timds --', 'timds-cli')
    .replaceAll('npx --yes @dtconcepts/timds@latest', 'timds-cli')
    .replace(/5\. Install the pinned lockfile[\s\S]*?lockfile it writes in the first commit\./, '5. Verify `timds-cli --version` matches `.timds/installation.json`; the stock system needs no npm install.')
    .replace(/3\. Install: `npm ci`[\s\S]*?first commit\)\./, '3. Verify `timds-cli --version` matches `.timds/installation.json`. No package-manager installation is needed for stock commands.')
    .replace(/1\. Install the toolkit: `npm ci`[\s\S]*?lockfile it writes\./, '1. Verify `timds-cli --version` matches the exact `.timds/installation.json` selection.')
    .replace(/```bash\nnpm install\n/, '```bash\ntimds-cli --version\n')
    .replace(/`npm install` creates the lockfile[\s\S]*?`check` builds/, 'The executable includes the stock runtime. Commit its exact installation record. `check` builds')
    .replace(/timds-cli upgrade --version 0\.1\.x/g, 'timds-cli upgrade --version EXACT_VERSION')
    .replace(/A hosted workspace, or any folder without that\nnpm script,[\s\S]*?version\. Below,/, 'Hosted workspaces use the same selected executable. Never replace a selected workspace release implicitly. Below,');
}
