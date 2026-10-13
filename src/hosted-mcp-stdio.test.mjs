import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

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
    env: { PATH: process.env.PATH, HOME: root, TIMDS_PORTAL_URL: `http://127.0.0.1:${host.address().port}`, TIMDS_ACCESS_TOKEN: 'timds_test_fixture' },
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
