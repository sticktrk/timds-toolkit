// Run with the release executable, outside the source tree. The driver may use
// Node; every tested workflow and rendering child has no JavaScript tools on PATH.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const pkg = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'));
const binary = path.resolve(process.argv[2] || fileURLToPath(new URL(`../dist/binary/timds-cli-v${pkg.version}-${process.platform}-${process.arch}`, import.meta.url)));
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'timds binary video '));
const readJson = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const writeJson = async (file, value) => { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`); };
const digest = async file => createHash('sha256').update(await fs.readFile(file)).digest('hex');
const cleanBin = path.join(scratch, 'allowed tools');
await fs.mkdir(cleanBin);
const git = (await execute('which', ['git'])).stdout.trim();
await fs.symlink(git, path.join(cleanBin, 'git'));
const moved = path.join(scratch, 'moved executable', 'timds-cli');
await fs.mkdir(path.dirname(moved));
await fs.copyFile(binary, moved);
await fs.chmod(moved, 0o755);
const env = { HOME: process.env.HOME || os.homedir(), PATH: cleanBin, TMPDIR: os.tmpdir(), TIMDS_BINARY_CACHE: path.join(scratch, 'runtime cache'), ...(process.env.TIMDS_BROWSER_EXECUTABLE ? { TIMDS_BROWSER_EXECUTABLE: process.env.TIMDS_BROWSER_EXECUTABLE } : {}), ...(process.env.TIMDS_BROWSER_CACHE ? { TIMDS_BROWSER_CACHE: process.env.TIMDS_BROWSER_CACHE } : {}) };
async function run(root, ...args) {
  try { return await execute(moved, [...args, '--root', root], { cwd: root, env, maxBuffer: 20_000_000, timeout: 240_000 }); }
  catch (error) { throw new Error(`${args.join(' ')} failed:\n${error.stdout || ''}\n${error.stderr || error.message}`); }
}
async function unusedPort() {
  const listener = http.createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const { port } = listener.address();
  await new Promise(resolve => listener.close(resolve));
  return port;
}
async function service(root, args, port) {
  const child = spawn(moved, [...args, '--root', root], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', chunk => { output = (output + chunk).slice(-10000); });
  child.stderr.on('data', chunk => { output = (output + chunk).slice(-10000); });
  try {
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`${args.join(' ')} exited: ${output}`);
      const response = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2000) }).catch(() => null);
      if (response?.ok) {
        const html = await response.text();
        if (args[1] === 'studio') {
          const bundle = await fetch(`http://127.0.0.1:${port}/bundle.js`, { signal: AbortSignal.timeout(30_000) });
          assert.equal(bundle.status, 200);
          assert.ok((await bundle.text()).length > 1000, 'Studio compiles the authored TSX and serves its client bundle');
        }
        return html;
      }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    throw new Error(`${args.join(' ')} did not become ready: ${output}`);
  } finally {
    child.kill('SIGTERM');
    await Promise.race([new Promise(resolve => child.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 10_000))]);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
}
async function files(root, prefix = '') {
  const result = [];
  for (const entry of await fs.readdir(path.join(root, prefix), { withFileTypes: true })) {
    if (['.git', '.github', 'node_modules', 'dist', 'video-local', '.claude', '.agents', '.cursor'].includes(entry.name)) continue;
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) result.push(...await files(root, name));
    else if (entry.isFile()) result.push({ path: name, encoding: 'base64', content: (await fs.readFile(path.join(root, name))).toString('base64'), mode: '100644' });
  }
  return result;
}
const images = new Map();
let server;
try {
  for (const [name, color] of [['north', '#142238'], ['lake', '#165f38']]) {
    const root = path.join(scratch, `${name} system`);
    await fs.mkdir(root);
    await execute(git, ['init', '-b', 'main'], { cwd: root, env });
    await run(root, 'init', '--standalone', '--name', `Binary ${name}`, '--system-id', `example/${name}`);
    // Capture a stock hosted draft before adding the video authoring fixtures.
    if (name === 'north') await writeJson(path.join(scratch, 'snapshot.json'), { apiVersion: 1, session: { id: 'binary-draft', systemId: `example/${name}`, baseRevision: 'fixture', status: 'open' }, files: await files(root) });
    await run(root, 'video', 'init');
    const contractPath = path.join(root, 'video/contract.json'), contract = await readJson(contractPath);
    contract.brand.colors = { background: color, panel: color, accent: '#f4c75b', text: '#ffffff', muted: '#dae1ea' };
    contract.brand.logo = 'public/logo.svg';
    contract.brand.fontFiles = [];
    contract.package.shortCount = 0;
    contract.formats = { longform: { width: 320, height: 180 }, cover: { width: 640, height: 360 }, short: { width: 180, height: 320 } };
    contract.structure.longform.requireOutro = false;
    await writeJson(contractPath, contract);
    const boardsPath = path.join(root, 'video/boards.json'), boards = await readJson(boardsPath);
    delete boards.cadence.minimumChapters;
    await writeJson(boardsPath, boards);
    await fs.mkdir(path.join(root, 'public'), { recursive: true });
    await fs.writeFile(path.join(root, 'public/logo.svg'), `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="${color}"/></svg>`);
    await fs.writeFile(path.join(root, 'public/cover.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="640" height="360" fill="#b4bac0"/></svg>');
    await writeJson(path.join(root, 'video/assets.json'), { schemaVersion: 1, assets: { cover: { publicPath: 'public/cover.svg', kind: 'image' } } });
    const productionRoot = path.join(root, 'video/productions/probe');
    await writeJson(path.join(productionRoot, 'production.json'), { schemaVersion: 1, slug: 'probe', audioSrc: null, longform: { audioSrc: null, cover: { headline: 'What matters?', asset: 'cover' }, scenes: [{ id: 'intro', intro: true }] }, shorts: [] });
    await writeJson(path.join(productionRoot, 'captions.json'), { lines: [{ id: 'intro', durationMs: 200, words: [{ text: 'Welcome', startMs: 0, endMs: 100 }] }] });
    await writeJson(path.join(productionRoot, 'script.json'), { slug: 'probe', lines: [] });
    await writeJson(path.join(productionRoot, 'request.json'), { source: 'packaged runtime fixture' });
    await writeJson(path.join(productionRoot, 'publishing.json'), { topicName: 'Binary probe', description: 'A rendering fixture.', shorts: [] });
    for (const mode of ['shared', 'snapshot', 'override']) {
      if (mode === 'snapshot') await run(root, 'video', 'components', 'init');
      if (mode === 'override') {
        await fs.writeFile(path.join(root, 'video/badge.tsx'), 'import React from "react"; export const Badge = () => <div style={{position:"absolute",inset:0,background:"#ff00ff",opacity:0.5}}/>;\n');
        await fs.writeFile(path.join(root, 'video/remotion.tsx'), 'import React from "react"; import {defaultVideoProjectComponents as shared} from "@dtconcepts/timds/video/remotion"; import {Badge} from "./badge.tsx"; const Cover = props => <><shared.Cover {...props}/><Badge/></>; export default {Cover};\n');
      }
      await run(root, 'video', 'check', 'probe');
      await run(root, 'video', 'render', 'probe', '--date', '2026-01-01');
      const output = path.join(root, 'video-local/out/Binary probe - 2026-01-01/Longform');
      assert.ok((await fs.stat(path.join(output, 'probe-longform.mp4'))).size > 500, 'the native compositor produced a real MP4');
      images.set(`${name}-${mode}`, await digest(path.join(output, 'thumbnail.jpg')));
      if (process.env.TIMDS_VISUAL_OUTPUT) { await fs.mkdir(process.env.TIMDS_VISUAL_OUTPUT, { recursive: true }); await fs.copyFile(path.join(output, 'thumbnail.jpg'), path.join(process.env.TIMDS_VISUAL_OUTPUT, `${name}-${mode}.jpg`)); }
      assert.equal(await fs.stat(path.join(root, 'node_modules')).catch(() => null), null, 'runtime, browser, and webpack cache stay outside the workspace');
      console.log(`${name}: ${mode} validation, real rendering, and child-process dependency resolution passed`);
    }
    assert.equal(images.get(`${name}-shared`), images.get(`${name}-snapshot`), 'editable snapshots preserve the shared cover pixels');
    assert.notEqual(images.get(`${name}-shared`), images.get(`${name}-override`), 'a partial TSX override with a relative TSX import changes the rendered pixels');
    if (name === 'north') {
      const labPort = await unusedPort();
      assert.match(await service(root, ['video', 'lab', '--serve', '--port', String(labPort)], labPort), /Video Lab/i);
      const studioPort = await unusedPort();
      // An authored CommonJS config still resolves its installed Remotion API;
      // its overrides compose with the toolkit's packaged module resolution.
      await fs.writeFile(path.join(root, 'remotion.config.js'), `const {Config} = require('@remotion/cli/config'); Config.setShouldOpenBrowser(false); Config.setPort(${studioPort}); Config.overrideWebpackConfig(config => ({...config, resolve: {...config.resolve, alias: {fixture: '/unused-fixture'}}}));\n`);
      assert.match(await service(root, ['video', 'studio', 'probe'], studioPort), /remotion/i);
      assert.equal(await fs.stat(path.join(root, 'node_modules')).catch(() => null), null);
      console.log('Video Lab and Remotion Studio serve from the packaged runtime and stop on SIGTERM');
    }
  }
  assert.notEqual(images.get('north-shared'), images.get('lake-shared'), 'two brands retain distinct shared-component visuals');
  server = http.createServer((_request, response) => response.writeHead(200, { 'Content-Type': 'text/html' }).end('<html><body><h1>Packaged browser capture</h1></body></html>'));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const probe = path.join(scratch, 'runtime-probe.mjs');
  await fs.writeFile(probe, `import assert from 'node:assert/strict';
import {readFile,stat} from 'node:fs/promises';
const base = import.meta.resolve('@dtconcepts/timds/core');
const {prepareDraftSource} = await import(new URL('./draft-source.mjs',base));
const snapshot = JSON.parse(await readFile(${JSON.stringify(path.join(scratch, 'snapshot.json'))},'utf8'));
const draft = await prepareDraftSource({systemId:'example/north',draft:'binary',portalUrl:'https://fixture.test',token:'fixture-secret',fetchImpl:async (_url,options)=>{assert.equal(options.headers.Authorization,'Bearer fixture-secret');return Response.json(snapshot);}});
try {assert.ok((await stat(draft.root+'/dist/index.html')).size);assert.equal(await stat(draft.root+'/node_modules').catch(()=>null),null);}finally{await draft.dispose();}
const {launchBrowser} = await import(new URL('./consumer-browser.mjs',base));
const browser = await launchBrowser();
try {const capture = await browser.capture({url:${JSON.stringify(`http://127.0.0.1:${server.address().port}`)},width:320,height:180});assert.ok(capture.png.length>100);}finally{await browser.close();}
console.log('Hosted stock draft and consumer browser capture passed');
`);
  try {
    const result = await execute(moved, ['run', probe], { cwd: path.join(scratch, 'north system'), env, timeout: 240_000, maxBuffer: 10_000_000 });
    process.stdout.write(result.stdout);
  } catch (error) { throw new Error(`Packaged draft/browser probe failed:\n${error.stdout || ''}\n${error.stderr || error.message}`); }
  console.log('Packaged video, TSX overrides, editable snapshots, two-brand visual comparisons, browser capture, and hosted draft checks passed without external Node/npm.');
} finally {
  if (server) await new Promise(resolve => server.close(resolve));
  if (process.env.TIMDS_KEEP_BINARY_SMOKE) console.log(`Retained fixtures: ${scratch}`);
  else await fs.rm(scratch, { recursive: true, force: true });
}
