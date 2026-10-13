import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createHostProvider, materializeHostedSnapshot } from './hosted.mjs';
import { cleanPortalUrl, resolveAccessToken } from './auth.mjs';

/** An authenticated snapshot becomes an isolated, credential-free local build. */
export async function prepareDraftSource({ systemId, draft, portalUrl = process.env.TIMDS_PORTAL_URL || 'https://timds.com', token, credentialsPath, fetchImpl = fetch, build, previous = null } = {}) {
  if (!systemId || !draft) throw new Error('A draft source requires systemId and draft');
  const url = cleanPortalUrl(portalUrl);
  const host = createHostProvider({ url, token: await resolveAccessToken(url, { token, credentialsPath, fetchImpl }), fetchImpl });
  const snapshot = await host.draftSnapshot(systemId, draft);
  if (previous && previous.snapshot.session.baseRevision === snapshot.session.baseRevision) return previous;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'timds-draft-'));
  try {
    await materializeHostedSnapshot(root, snapshot, { kind: 'hosted', url, apiVersion: 1 });
    if (build) await build(root);
    else {
      // No login token or server credential reaches the draft's scripts.
      const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => /^(?:PATH|HOME|TMPDIR|TEMP|TMP|SYSTEMROOT|LANG|LC_.*|NODE_OPTIONS)$/.test(name)));
      const hasLock = await fs.access(path.join(root, 'package-lock.json')).then(() => true, () => false);
      await new Promise((resolve, reject) => {
        const child = spawn('npm', [hasLock ? 'ci' : 'install', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
        let output = '';
        child.stdout.on('data', chunk => { output = (output + chunk).slice(-4000); });
        child.stderr.on('data', chunk => { output = (output + chunk).slice(-4000); });
        child.on('error', reject); child.on('close', code => code === 0 ? resolve() : reject(new Error(`Draft dependency installation failed (${code}): ${output}`)));
      });
      await new Promise((resolve, reject) => {
        const cli = fileURLToPath(new URL('../bin/timds.mjs', import.meta.url));
        const child = spawn(process.execPath, [cli, 'check', '--root', root], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
        let output = '';
        child.stdout.on('data', chunk => { output = (output + chunk).slice(-8000); });
        child.stderr.on('data', chunk => { output = (output + chunk).slice(-8000); });
        child.on('error', reject); child.on('close', code => code === 0 ? resolve() : reject(new Error(`Draft checks failed (${code}): ${output}`)));
      });
    }
    return { root, snapshot, dispose: () => fs.rm(root, { recursive: true, force: true }) };
  } catch (error) { await fs.rm(root, { recursive: true, force: true }); throw error; }
}
