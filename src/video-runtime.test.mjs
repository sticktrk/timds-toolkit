import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { packageRoot } from './executable.mjs';
import { packagedWebpackOverride, remotionCommand } from './video-runtime.mjs';
import { videoFixture } from './video.fixture.mjs';
import { voiceoverVideoWorkspace } from './video.mjs';
import { loadVideoComponentModule } from './video-component-loader.mjs';

const require = createRequire(import.meta.url);

test('npm Remotion execution remains a JavaScript worker with arguments intact', () => {
  assert.deepEqual(remotionCommand(['render', 'entry with spaces.tsx', 'Example']), [process.execPath, path.join(path.dirname(require.resolve('@remotion/cli/package.json')), 'remotion-cli.js'), 'render', 'entry with spaces.tsx', 'Example']);
});

test('packaged webpack resolves exported toolkit paths and keeps client aliases', () => {
  const config = packagedWebpackOverride({ cache: { type: 'filesystem' }, resolve: { extensions: ['.tsx'], alias: { client: '/client' }, modules: ['node_modules', '/custom'] } });
  assert.equal(config.cache, false);
  assert.equal(config.resolve.alias.client, '/client');
  assert.equal(config.resolve.alias['@dtconcepts/timds/video/remotion$'], path.join(packageRoot, 'video/remotion.tsx'));
  assert.equal(config.resolve.alias['@dtconcepts/timds/video/producer$'], path.join(packageRoot, 'src/video-producer.mjs'));
  assert.deepEqual(config.resolve.extensions, ['.tsx']);
  assert.deepEqual(config.resolve.modules, [path.join(packageRoot, 'node_modules'), 'node_modules', '/custom']);
});

test('voiceover diagnoses a missing command-specific media dependency', async t => {
  const workspace = await videoFixture(t);
  await assert.rejects(voiceoverVideoWorkspace(workspace, 'sample-topic', { python: path.join(workspace.designSystemRoot, 'missing-python') }), /Required external tool .*missing-python was not found/);
});

test('CommonJS workspaces load relative TSX exports and helper edits with authored URLs', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'timds-component-graph-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'package.json'), '{}');
  const entry = path.join(root, 'components.tsx'), helper = path.join(root, 'helper.tsx');
  await fs.writeFile(entry, 'import type {NeverLoaded} from "./absent-types"; export {value, source} from "./helper";');
  await fs.writeFile(helper, 'export const value = "before"; export const source = import.meta.url;');
  const before = await loadVideoComponentModule(entry, path.join(root, 'local'));
  assert.equal(before.value, 'before');
  assert.equal(before.source, pathToFileURL(helper).href);
  await fs.writeFile(helper, 'export const value = "after"; export const source = import.meta.url;');
  assert.equal((await loadVideoComponentModule(entry, path.join(root, 'local'))).value, 'after');
});
