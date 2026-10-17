import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import test from 'node:test';
import { draftBuildEnvironment, prepareDraftSource } from './draft-source.mjs';
import { packageRoot } from './executable.mjs';

test('packaged draft execution adds only runtime paths after credential filtering', t => {
  const values = { TIMDS_ACCESS_TOKEN: 'private-token', ANTHROPIC_API_KEY: 'private-api-key', GITHUB_TOKEN: 'private-github-token', TIMDS_PORTAL_URL: 'https://private.test', TIMDS_BINARY_EXECUTABLE: '/runtime/timds-cli', TIMDS_RUNTIME_ROOT: '/runtime', TIMDS_RUNTIME_PACKAGE: packageRoot, TIMDS_BINARY_STOCK_DRAFT: 'untrusted', NODE_OPTIONS: '--no-warnings' };
  const before = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  Object.assign(process.env, values);
  t.after(() => { for (const [key, value] of Object.entries(before)) if (value === undefined) delete process.env[key]; else process.env[key] = value; });
  const env = draftBuildEnvironment();
  for (const key of ['TIMDS_ACCESS_TOKEN', 'ANTHROPIC_API_KEY', 'GITHUB_TOKEN', 'TIMDS_PORTAL_URL', 'TIMDS_BINARY_STOCK_DRAFT']) assert.equal(env[key], undefined, key);
  assert.equal(env.TIMDS_BINARY_EXECUTABLE, values.TIMDS_BINARY_EXECUTABLE);
  assert.equal(env.TIMDS_RUNTIME_PACKAGE, packageRoot);
  assert.equal(env.NODE_OPTIONS, '--no-warnings');
});

test('a failed draft build cleans the materialized snapshot and keeps auth on the host request', async () => {
  let root;
  await assert.rejects(prepareDraftSource({ systemId: 'example/core', draft: 'test', portalUrl: 'https://host.test', token: 'secret', fetchImpl: async (_url, options) => {
    assert.equal(options.headers.Authorization, 'Bearer secret');
    return Response.json({ apiVersion: 1, session: { id: 'test', systemId: 'example/core', baseRevision: 'one', status: 'open' }, files: [{ path: 'note.txt', encoding: 'base64', content: Buffer.from('draft source').toString('base64'), mode: '100644' }] });
  }, build: async directory => { root = directory; assert.equal(await fs.readFile(`${root}/note.txt`, 'utf8'), 'draft source'); throw new Error('build failed'); } }), /build failed/);
  assert.equal(await fs.stat(root).catch(() => null), null);
});

test('a custom draft build cannot claim the verified binary stock exception', async t => {
  const values = { TIMDS_BINARY_EXECUTABLE: '/runtime/timds-cli', TIMDS_RUNTIME_ROOT: '/runtime', TIMDS_RUNTIME_PACKAGE: packageRoot };
  const before = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  Object.assign(process.env, values);
  t.after(() => { for (const [key, value] of Object.entries(before)) if (value === undefined) delete process.env[key]; else process.env[key] = value; });
  const prepared = await prepareDraftSource({ systemId: 'example/core', draft: 'test', portalUrl: 'https://host.test', token: 'secret', fetchImpl: async () => Response.json({ apiVersion: 1, session: { id: 'test', baseRevision: 'one', status: 'open' }, files: [] }), build: async () => {} });
  try { assert.equal(prepared.binaryStock, false); }
  finally { await prepared.dispose(); }
});
