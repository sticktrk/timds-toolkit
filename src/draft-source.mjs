import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { createHostProvider, materializeHostedSnapshot } from './hosted.mjs';
import { cleanPortalUrl, resolveAccessToken } from './auth.mjs';
import { cliCommand, isBinaryRuntime, runtimeEnvironment } from './executable.mjs';

/** Preserve the credential filter before adding package-owned runtime paths. */
export function draftBuildEnvironment() {
  const filtered = Object.fromEntries(Object.entries(process.env).filter(([name]) => /^(?:PATH|HOME|TMPDIR|TEMP|TMP|SYSTEMROOT|LANG|LC_.*|NODE_OPTIONS)$/.test(name)));
  return runtimeEnvironment(filtered);
}

function draftSubprocess(command, args, { root, env, label, limit }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', chunk => { output = (output + chunk).slice(-limit); });
    child.stderr.on('data', chunk => { output = (output + chunk).slice(-limit); });
    child.on('error', error => reject(error.code === 'ENOENT'
      ? new Error(`${label} requires the external tool ${command}. Install the draft's declared toolchain before building it.`, { cause: error }) : error));
    child.on('close', code => code === 0 ? resolve() : reject(new Error(`${label} failed (${code}): ${output}`)));
  });
}

/** An authenticated snapshot becomes an isolated, credential-free local build. */
export async function prepareDraftSource({ systemId, draft, portalUrl = process.env.TIMDS_PORTAL_URL || 'https://timds.com', token, credentialsPath, fetchImpl = fetch, build, previous = null } = {}) {
  if (!systemId || !draft) throw new Error('A draft source requires systemId and draft');
  const url = cleanPortalUrl(portalUrl);
  const host = createHostProvider({ url, token: await resolveAccessToken(url, { token, credentialsPath, fetchImpl }), fetchImpl });
  const snapshot = await host.draftSnapshot(systemId, draft);
  if (previous && previous.snapshot.session.baseRevision === snapshot.session.baseRevision) return previous;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'timds-draft-'));
  try {
    let binaryStock = false;
    await materializeHostedSnapshot(root, snapshot, { kind: 'hosted', url, apiVersion: 1 });
    if (build) await build(root);
    else {
      // No login token or server credential reaches the draft's scripts.
      const env = draftBuildEnvironment();
      if (isBinaryRuntime()) {
        const { isStockWorkspace } = await import('./binary-installation.mjs');
        const manifest = JSON.parse(await fs.readFile(path.join(root, 'timds.json'), 'utf8'));
        if (!await isStockWorkspace(root, manifest)) throw new Error('This hosted draft uses custom workspace commands or scripts. Build it with its declared Node/npm toolchain; the standalone binary only bypasses dependency installation for verified stock drafts.');
        env.TIMDS_BINARY_STOCK_DRAFT = '1';
        binaryStock = true;
      } else {
        const hasLock = await fs.access(path.join(root, 'package-lock.json')).then(() => true, () => false);
        await draftSubprocess('npm', [hasLock ? 'ci' : 'install', '--ignore-scripts', '--no-audit', '--no-fund'], { root, env, label: 'Draft dependency installation', limit: 4000 });
      }
      const [command, ...args] = cliCommand(['check', '--root', root]);
      await draftSubprocess(command, args, { root, env, label: 'Draft checks', limit: 8000 });
    }
    return { root, snapshot, binaryStock, dispose: () => fs.rm(root, { recursive: true, force: true }) };
  } catch (error) { await fs.rm(root, { recursive: true, force: true }); throw error; }
}
