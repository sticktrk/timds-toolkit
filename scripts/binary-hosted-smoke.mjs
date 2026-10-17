import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'node:http';

/** Real HTTP authentication/session transport, with only the remote service mocked. */
export async function hostedSmoke({ scratch, run, mcp }) {
  let snapshot;
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
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(snapshot));
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
    await run(['login', '--token', 'timds_binary_smoke', '--portal-url', portal]);
    await run(['start', 'test/hosted-binary', '--portal-url', portal, '--root', destination]);
    await run(['check', '--root', destination]);
    await run(['doctor', '--root', destination]);
    await run(['brand', '--root', destination]);
    await mcp(['mcp', '--root', destination]);
    await mcp(['mcp', 'read', '--root', destination]);
    await mcp(['mcp', 'read', '--draft', 'binary-smoke', '--system-id', 'test/hosted-binary', '--portal-url', portal]);
    assert.ok(requests.some(request => request.path.endsWith('/drafts/binary-smoke/snapshot')));
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
