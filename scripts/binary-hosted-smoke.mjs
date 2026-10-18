import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'node:http';

/** Real HTTP authentication/session transport, with only the remote service mocked. */
export async function hostedSmoke({ scratch, run, mcp }) {
  let snapshot;
  let draftSnapshot;
  const requests = [];
  const remote = createServer(async (request, response) => {
    try {
      assert.equal(request.headers.authorization, 'Bearer timds_binary_smoke');
      let body = '';
      for await (const chunk of request) body += chunk;
      const parsed = body ? JSON.parse(body) : null;
      requests.push({ path: request.url, method: request.method, body: parsed });
      if (request.url.endsWith('/submit') || request.url.endsWith('/update')) {
        const files = new Map(snapshot.files.map(file => [file.path, file]));
        for (const name of parsed.deletedPaths || []) files.delete(name);
        for (const file of parsed.changedFiles || []) files.set(file.path, file);
        snapshot = { ...snapshot, session: { ...snapshot.session, baseRevision: 'next' }, files: [...files.values()], ...(request.url.endsWith('/submit') ? { submission: { id: 'binary-submission', previewUrl: 'https://preview.example.test' } } : {}) };
      }
      const selected = request.url.endsWith('/drafts/legacy-npm/snapshot') ? draftSnapshot : snapshot;
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(selected));
    } catch (error) {
      response.writeHead(500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: error.message }));
    }
  });
  await new Promise(resolve => remote.listen(0, '127.0.0.1', resolve));
  const portal = `http://127.0.0.1:${remote.address().port}`;
  const source = path.join(scratch, 'hosted source');
  const destination = path.join(scratch, 'hosted session');
  try {
    await run(['init', '--standalone', '--provider', 'hosted', '--portal-url', portal, '--root', source, '--name', 'Hosted binary smoke', '--system-id', 'test/hosted-binary']);
    const files = [];
    async function walk(directory, prefix = '') {
      for (const name of await fs.readdir(directory)) {
        if (['.git', 'dist', 'node_modules', 'media-local', 'video-local'].includes(name)) continue;
        const absolute = path.join(directory, name), relative = prefix ? `${prefix}/${name}` : name;
        const stat = await fs.lstat(absolute);
        if (stat.isDirectory()) await walk(absolute, relative);
        else files.push({ path: relative, encoding: 'base64', content: (stat.isSymbolicLink() ? Buffer.from(await fs.readlink(absolute)) : await fs.readFile(absolute)).toString('base64'), mode: stat.isSymbolicLink() ? '120000' : stat.mode & 0o111 ? '100755' : '100644' });
      }
    }
    await walk(source);
    snapshot = { apiVersion: 1, session: { id: 'binary-hosted-session', systemId: 'test/hosted-binary', baseRevision: 'initial', status: 'open' }, files };
    // Existing hosted sources still select npm. A packaged read-only draft may
    // execute verified stock scripts without adopting or rewriting that source.
    draftSnapshot = structuredClone(snapshot);
    draftSnapshot.session = { ...draftSnapshot.session, id: 'legacy-npm-draft', baseRevision: 'legacy-npm' };
    const editDraftJson = (name, edit) => {
      const file = draftSnapshot.files.find(file => file.path === name);
      assert.ok(file, `Missing legacy draft fixture file ${name}`);
      file.content = Buffer.from(`${JSON.stringify(edit(JSON.parse(Buffer.from(file.content, 'base64').toString('utf8'))), null, 2)}\n`).toString('base64');
    };
    editDraftJson('timds.json', manifest => ({ ...manifest, workspace: { ...manifest.workspace, ...Object.fromEntries(['build', 'check', 'dev'].map(name => [name, ['node', `scripts/${name}.mjs`]])) } }));
    editDraftJson('.timds/installation.json', record => ({ name: record.name, schemaVersion: 1, version: record.version }));
    editDraftJson('package.json', pkg => ({ ...pkg, scripts: { ...pkg.scripts, timds: 'timds', build: 'node scripts/build.mjs', check: 'node scripts/check.mjs', dev: 'node scripts/dev.mjs' }, devDependencies: { ...pkg.devDependencies, '@dtconcepts/timds': '0.1.x' } }));
    const draftRecord = JSON.parse(Buffer.from(draftSnapshot.files.find(file => file.path === '.timds/installation.json').content, 'base64').toString('utf8'));
    assert.equal(draftRecord.schemaVersion, 1);
    assert.equal(draftRecord.mode, undefined);
    assert.equal(JSON.parse(Buffer.from(snapshot.files.find(file => file.path === '.timds/installation.json').content, 'base64').toString('utf8')).mode, 'binary', 'regular hosted start remains explicitly binary');
    await run(['login', '--token', 'timds_binary_smoke', '--portal-url', portal]);
    await run(['start', 'test/hosted-binary', '--portal-url', portal, '--root', destination]);
    await run(['check', '--root', destination]);
    await run(['doctor', '--root', destination]);
    await run(['brand', '--root', destination]);
    await mcp(['mcp', '--root', destination]);
    await mcp(['mcp', 'read', '--root', destination]);
    await mcp(['mcp', 'read', '--draft', 'legacy-npm', '--system-id', 'test/hosted-binary', '--portal-url', portal]);
    assert.ok(requests.some(request => request.path.endsWith('/drafts/legacy-npm/snapshot')));
    const changelog = path.join(destination, 'CHANGELOG.md');
    await fs.writeFile(changelog, '# Changelog\n\n## Unreleased\n');
    const before = requests.length;
    await assert.rejects(run(['submit', '--message', 'Review binary changes', '--dry-run', '--root', destination]), /has no note/);
    assert.equal(requests.length, before, 'invalid submissions must never reach the host');
    await fs.writeFile(changelog, '# Changelog\n\n## Unreleased\n\n- Viewer: verify packaged submission.\n');
    await run(['submit', '--message', 'Review binary changes', '--dry-run', '--root', destination]);
    assert.equal(requests.length, before, 'dry-run submission must not publish');
    await run(['submit', '--message', 'Review binary changes', '--root', destination]);
    assert.ok(requests.some(request => request.path.endsWith('/submit') && request.body.changedFiles.some(file => file.path === 'CHANGELOG.md')));
    assert.ok(!(await fs.readFile(path.join(destination, '.timds/session.json'), 'utf8')).includes('timds_binary_smoke'));
    assert.equal(await fs.stat(path.join(destination, 'node_modules')).catch(() => null), null);
  } finally { await new Promise(resolve => remote.close(resolve)); }
}
