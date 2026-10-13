import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { initializeRepository } from './core.mjs';

test('hosted MCP materializes a large image snapshot and keeps stdio usable across start, join, pull, update and conflicts', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'timds-mcp-large-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  // A normal 6 MiB image becomes >16 MiB if echoed as both text and structured
  // base64, beyond the SDK's 10 MiB stdio limit.
  const image = Buffer.alloc(6 * 1024 * 1024, 17);
  const file = { path: 'public/image.png', content: image.toString('base64'), encoding: 'base64', mode: '100644' };
  let revision = 0;
  let conflicts = [];
  const host = createServer(async (request, response) => {
    for await (const _chunk of request) { /* consume the HTTP body */ }
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ apiVersion: 1, session: { id: 'session-large', systemId: 'example/core', baseRevision: `revision-${++revision}`, status: 'open' }, files: [file], conflicts, mainRevision: `revision-${revision}` }));
  });
  await new Promise((resolve) => host.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { host.closeAllConnections(); host.close(resolve); }));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL('../bin/timds.mjs', import.meta.url)), 'mcp', '--root', root],
    env: { PATH: process.env.PATH, TIMDS_PORTAL_URL: `http://127.0.0.1:${host.address().port}`, TIMDS_ACCESS_TOKEN: 'timds_test_fixture' },
    stderr: 'pipe',
  });
  transport.stderr?.resume();
  const client = new Client({ name: 'large-snapshot-test', version: '1' });
  t.after(() => client.close());
  await client.connect(transport);
  for (const [name, args] of [
    ['timds_start', { systemId: 'example/core' }],
    ['timds_join', { sessionId: 'session-large' }],
    ['timds_pull', {}],
    ['timds_update', {}],
  ]) {
    const result = await client.callTool({ name, arguments: args });
    assert.ok(!result.isError, result.content?.[0]?.text);
    assert.ok(JSON.stringify(result).length < 2000, `${name} should return a small receipt`);
    assert.equal(result.structuredContent.fileCount, 1);
    assert.equal(result.structuredContent.filesMaterialized, true);
    assert.deepEqual(result.structuredContent.files, [{ path: file.path, mode: '100644' }]);
    assert.equal(result.structuredContent.files[0].content, undefined);
    assert.deepEqual(await fs.readFile(path.join(root, file.path)), image);
  }
  conflicts = [{ path: 'tokens/color.json', key: 'brand', base: '#000', mine: '#111', theirs: '#222' }];
  const conflict = await client.callTool({ name: 'timds_update', arguments: {} });
  assert.deepEqual(conflict.structuredContent.conflicts, conflicts);
  assert.equal(conflict.structuredContent.filesMaterialized, false);
  assert.equal(conflict.structuredContent.applied, false);
  assert.ok(JSON.stringify(conflict).length < 2000);
  // A subsequent ordinary MCP request succeeds on the same live transport.
  assert.ok((await client.listTools()).tools.some((tool) => tool.name === 'read_file'));
});

test('hosted MCP keeps empty, missing and interrupted destinations inside an unrelated repository isolated', async (t) => {
  const ancestor = await fs.mkdtemp(path.join(os.tmpdir(), 'timds-mcp-parent-'));
  t.after(() => fs.rm(ancestor, { recursive: true, force: true }));
  execFileSync('git', ['init', '-b', 'main'], { cwd: ancestor, stdio: 'ignore' });
  await initializeRepository(ancestor, { standalone: true });
  await fs.writeFile(path.join(ancestor, 'note.txt'), 'Unrelated ancestor content');
  const manifest = JSON.parse(await fs.readFile(path.join(ancestor, 'timds.json'), 'utf8'));
  manifest.provider = { kind: 'local' };
  await fs.writeFile(path.join(ancestor, 'timds.json'), JSON.stringify(manifest));
  const parentFiles = await Promise.all(['timds.json', 'tokens.json', 'media.json', 'note.txt'].map(async (name) => [name, await fs.readFile(path.join(ancestor, name))]));
  const sessionManifest = { ...manifest, provider: { kind: 'hosted', url: 'https://host.example' } };
  const files = [...parentFiles.filter(([name]) => !['timds.json', 'note.txt'].includes(name)), ['timds.json', Buffer.from(JSON.stringify(sessionManifest))], ['note.txt', Buffer.from('Session content')]].map(([name, content]) => ({ path: name, content: content.toString('base64'), encoding: 'base64', mode: '100644' }));
  const requests = [];
  const host = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    requests.push({ path: request.url, body: body ? JSON.parse(body) : null });
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ apiVersion: 1, session: { id: 'session-child', systemId: manifest.systemId, baseRevision: 'child-revision', status: 'open' }, files, conflicts: [] }));
  });
  await new Promise((resolve) => host.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { host.closeAllConnections(); host.close(resolve); }));
  const portalUrl = `http://127.0.0.1:${host.address().port}`;
  for (const kind of ['empty', 'missing', 'interrupted']) {
    if (kind !== 'empty') {
      await fs.writeFile(path.join(ancestor, 'timds.json'), JSON.stringify({ ...manifest, provider: { kind: 'hosted', url: portalUrl } }));
      await fs.writeFile(path.join(ancestor, '.timds/session.json'), JSON.stringify({ apiVersion: 1, provider: { kind: 'hosted', url: portalUrl }, session: { id: 'ancestor-session', systemId: manifest.systemId, baseRevision: 'ancestor-revision', status: 'open' }, files: [] }));
    }
    const parentNames = [...parentFiles.map(([name]) => name), ...(kind === 'empty' ? [] : ['.timds/session.json'])];
    const ancestorBefore = await Promise.all(parentNames.map(async (name) => [name, await fs.readFile(path.join(ancestor, name))]));
    const root = path.join(ancestor, kind);
    if (kind !== 'missing') await fs.mkdir(root);
    if (kind === 'interrupted') {
      await fs.mkdir(path.join(root, '.timds'));
      await fs.writeFile(path.join(root, '.timds/start.json'), JSON.stringify({ apiVersion: 1, provider: { kind: 'hosted', url: portalUrl }, systemId: manifest.systemId, idempotencyKey: 'original-key' }));
    }
    const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../bin/timds.mjs', import.meta.url)), 'mcp', '--root', root], env: { PATH: process.env.PATH, TIMDS_PORTAL_URL: portalUrl, TIMDS_ACCESS_TOKEN: 'timds_test_fixture' }, stderr: 'pipe' });
    let stderr = '';
    transport.stderr?.on('data', (chunk) => { stderr += chunk; });
    const client = new Client({ name: `destination-${kind}`, version: '1' });
    t.after(() => client.close());
    await client.connect(transport);
    const before = await client.callTool({ name: 'write_file', arguments: { path: 'note.txt', content: 'must not reach ancestor', note: 'Test destination isolation' } });
    assert.equal(before.isError, true);
    assert.match(before.content[0].text, /Start or join a hosted session/);
    const requestCount = requests.length;
    for (const name of ['timds_pull', 'timds_update', 'timds_active_work']) {
      assert.equal((await client.callTool({ name, arguments: {} })).isError, true);
      assert.equal(requests.length, requestCount, `${name} does not reach an ancestor session`);
    }
    const operation = kind === 'missing' ? ['timds_join', { sessionId: 'session-child' }] : ['timds_start', { systemId: manifest.systemId }];
    const result = await client.callTool({ name: operation[0], arguments: operation[1] });
    assert.ok(!result.isError, result.content?.[0]?.text);
    assert.equal(await fs.readFile(path.join(root, 'note.txt'), 'utf8'), 'Session content');
    assert.equal(JSON.parse(await fs.readFile(path.join(root, '.timds/session.json'), 'utf8')).session.id, 'session-child');
    if (kind === 'interrupted') assert.equal(requests.at(-1).body.idempotencyKey, 'original-key');
    const edited = await client.callTool({ name: 'write_file', arguments: { path: 'note.txt', content: 'Edited session only', note: 'Edit after bootstrap' } });
    assert.ok(!edited.isError, edited.content?.[0]?.text);
    assert.equal(await fs.readFile(path.join(root, 'note.txt'), 'utf8'), 'Edited session only');
    assert.ok(stderr.includes(`ready on stdio for ${root}`));
    await client.close();
    for (const [name, content] of ancestorBefore) assert.deepEqual(await fs.readFile(path.join(ancestor, name)), content, `${name} in the ancestor is unchanged`);
    if (kind === 'empty') assert.equal(await fs.stat(path.join(ancestor, '.timds/session.json')).catch(() => null), null);
  }
});
