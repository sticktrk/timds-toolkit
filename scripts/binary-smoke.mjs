import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { hostedSmoke } from './binary-hosted-smoke.mjs';
const execute = promisify(execFile);
const pkg = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'));
const binary = path.resolve(process.argv[2] || fileURLToPath(new URL(`../dist/binary/timds-cli-v${pkg.version}-${process.platform}-${process.arch}`, import.meta.url)));
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'timds binary smoke '));
const cleanBin = path.join(scratch, 'allowed tools');
const cache = path.join(scratch, 'runtime cache');
const home = path.join(scratch, 'home');
const moved = path.join(scratch, 'relocated executable', 'timds-cli');
await fs.mkdir(cleanBin);
await fs.mkdir(home);
await fs.mkdir(path.dirname(moved));
await fs.copyFile(binary, moved);
await fs.chmod(moved, 0o755);
const git = (await execute('which', ['git'])).stdout.trim();
await fs.symlink(git, path.join(cleanBin, 'git'));
const env = { HOME: home, PATH: cleanBin, TMPDIR: os.tmpdir(), TIMDS_BINARY_CACHE: cache, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Binary Smoke', GIT_AUTHOR_EMAIL: 'smoke@example.test', GIT_COMMITTER_NAME: 'Binary Smoke', GIT_COMMITTER_EMAIL: 'smoke@example.test' };
const run = async (args, cwd = scratch) => {
  try { return await execute(moved, args, { cwd, env, maxBuffer: 16 * 1024 * 1024, timeout: 120000 }); }
  catch (error) { throw new Error(`${args.join(' ')} failed: ${error.stdout || ''}\n${error.stderr || error.message}`); }
};
const workspace = path.join(scratch, 'stock system');
const timings = {};
async function mcp(args) {
  const child = spawn(moved, args, { cwd: scratch, env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  let nextId = 1;
  const pending = new Map();
  child.stderr.on('data', data => stderr += data);
  child.stdout.on('data', data => {
    stdout += data;
    while (stdout.includes('\n')) {
      const end = stdout.indexOf('\n'), line = stdout.slice(0, end); stdout = stdout.slice(end + 1);
      let response;
      try { response = JSON.parse(line); }
      catch { for (const { reject } of pending.values()) reject(new Error(`MCP wrote non-protocol stdout: ${line}`)); return; }
      if (response.id) {
        const request = pending.get(response.id);
        if (request) { pending.delete(response.id); response.error ? request.reject(new Error(JSON.stringify(response.error))) : request.resolve(response.result); }
      }
    }
  });
  child.on('exit', () => { for (const { reject } of pending.values()) reject(new Error(`MCP exited: ${stderr}`)); });
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => reject(new Error(`MCP ${method} timed out: ${stderr}`)), 30000);
    pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  try {
    const initialized = await request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'binary-smoke', version: '1' } });
    assert.equal(initialized.serverInfo.version, pkg.version);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    const { tools } = await request('tools/list', {});
    assert.ok(tools.length > 0);
    const tool = tools.find(tool => /describe.*system|describe.*workspace/.test(tool.name));
    if (tool) { const result = await request('tools/call', { name: tool.name, arguments: {} }); assert.ok(!result.isError); }
  } finally { child.kill('SIGTERM'); await new Promise(resolve => child.once('exit', resolve)); }
}
async function server(command) {
  const reservation = createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const child = spawn(moved, [command, '--root', workspace, '--port', String(port)], { cwd: scratch, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = '';
  child.stdout.on('data', data => logs += data);
  child.stderr.on('data', data => logs += data);
  try {
    let response;
    for (let attempt = 0; attempt < 300; attempt++) {
      if (child.exitCode !== null) throw new Error(`${command} exited: ${logs}`);
      response = await fetch(`http://127.0.0.1:${port}/`).catch(() => null);
      if (response?.ok) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(response?.ok, `${command} failed to serve: ${logs}`);
    assert.match(await response.text(), /html/i);
  } finally {
    child.kill('SIGTERM');
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`${command} did not forward termination`)); }, 10000);
      child.once('exit', (code, signal) => { clearTimeout(timer); try { assert.equal(code, null); assert.equal(signal, 'SIGTERM'); resolve(); } catch (error) { reject(error); } });
    });
    await assert.rejects(fetch(`http://127.0.0.1:${port}/`), /fetch failed/);
  }
}
async function consumerSmoke() {
  const root = path.join(scratch, 'binary consumer');
  await fs.mkdir(path.join(root, 'styles'), { recursive: true });
  const css = ':root { --smoke: #123456; }';
  const digest = createHash('sha256').update(css).digest('hex');
  let base;
  const host = createHttpServer((request, response) => {
    if (request.url === '/v/1.0.0/bundle.json') {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ schemaVersion: 1, system: { id: 'test/consumer-smoke', name: 'Consumer smoke', version: '1.0.0' }, directory: `${base}/v/1.0.0/bundle`, files: [{ path: 'dist/tokens.css', url: `${base}/v/1.0.0/bundle/dist/tokens.css`, bytes: css.length, sha256: digest }] }));
    } else if (request.url === '/v/1.0.0/bundle/dist/tokens.css') response.end(css);
    else { response.statusCode = 404; response.end(); }
  });
  await new Promise(resolve => host.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${host.address().port}`;
  try {
    const manifest = `${JSON.stringify({ schemaVersion: 1, designSystem: { systemId: 'test/consumer-smoke', path: 'design-system', version: '1.0.0', url: base }, apps: { web: { cwd: '.', preview: { serve: ['make', 'serve'], port: 4400, routes: ['/'] }, designSurface: ['styles/**'] } } }, null, 2)}\n`;
    await fs.writeFile(path.join(root, 'timds.consumer.json'), manifest);
    await fs.writeFile(path.join(root, 'styles/site.css'), 'body {}');
    await fs.mkdir(path.join(root, '.claude'));
    await fs.writeFile(path.join(root, '.claude/launch.json'), JSON.stringify({ configurations: [{ name: 'custom', runtimeExecutable: 'product-server', runtimeArgs: [], port: 9999 }] }));
    await fs.writeFile(path.join(root, '.mcp.json'), JSON.stringify({ mcpServers: { custom: { command: 'product-mcp' } } }));
    await fs.mkdir(path.join(root, 'public'));
    await fs.symlink('../design-system/dist/tokens.css', path.join(root, 'public/tokens.css'));
    await execute(git, ['init', '-b', 'main'], { cwd: root, env });
    await run(['consumer', 'init', '--root', root]);
    const installation = JSON.parse(await fs.readFile(path.join(root, '.timds/installation.json'), 'utf8'));
    assert.equal(installation.mode, 'binary');
    assert.equal(installation.version, pkg.version);
    await assert.rejects(fs.access(path.join(root, 'package.json')));
    await assert.rejects(fs.access(path.join(root, 'package-lock.json')));
    assert.equal(await fs.readFile(path.join(root, 'timds.consumer.json'), 'utf8'), manifest);
    assert.equal(await fs.readFile(path.join(root, 'design-system/dist/tokens.css'), 'utf8'), css);
    assert.match((await run(['consumer', 'check', '--root', root])).stdout, /consumer check passed/);
    await execute(git, ['add', '.'], { cwd: root, env });
    await execute(git, ['commit', '-m', 'Binary consumer'], { cwd: root, env });
    await run(['upgrade', '--root', root]);
    await run(['upgrade', '--root', root]);
    assert.equal((await execute(git, ['status', '--porcelain'], { cwd: root, env })).stdout, '');
    assert.equal(await fs.readFile(path.join(root, 'timds.consumer.json'), 'utf8'), manifest);
    assert.equal(await fs.readFile(path.join(root, 'styles/site.css'), 'utf8'), 'body {}');
    assert.equal(await fs.readlink(path.join(root, 'public/tokens.css')), '../design-system/dist/tokens.css');
    assert.equal(JSON.parse(await fs.readFile(path.join(root, '.mcp.json'), 'utf8')).mcpServers.custom.command, 'product-mcp');
    assert.equal(JSON.parse(await fs.readFile(path.join(root, '.claude/launch.json'), 'utf8')).configurations[0].runtimeExecutable, 'product-server');
    await fs.writeFile(path.join(root, '.timds/installation.json'), JSON.stringify({ ...installation, version: '0.1.0' }));
    await assert.rejects(run(['consumer', 'sync', '--root', root]), /Workspace selects TimDS 0\.1\.0/);
    await assert.rejects(run(['upgrade', '--root', root]), /install the verified timds-cli 0\.1\.0/);
  } finally { await new Promise(resolve => host.close(resolve)); }
}

try {
  for (const tool of ['node', 'npm', 'npx', 'bun']) await assert.rejects(execute(tool, ['--version'], { env }), error => error.code === 'ENOENT');
  let start = performance.now();
  const first = await Promise.all([run(['--version']), run(['--help'])]);
  timings.concurrentColdMilliseconds = Math.round(performance.now() - start);
  assert.equal(first[0].stdout.trim(), pkg.version);
  assert.match(first[1].stdout, /TimDS/);
  start = performance.now();
  assert.equal((await run(['--version'])).stdout.trim(), pkg.version);
  timings.warmMilliseconds = Math.round(performance.now() - start);
  await fs.mkdir(workspace);
  await execute(git, ['init', '-b', 'main'], { cwd: workspace, env });
  await run(['init', '--standalone', '--root', workspace, '--name', 'Binary smoke', '--system-id', 'test/binary-smoke']);
  assert.equal((JSON.parse(await fs.readFile(path.join(workspace, '.timds/installation.json'), 'utf8'))).mode, 'binary');
  const check = await run(['check', '--root', workspace]);
  assert.equal((check.stdout.match(/^Warning:/gm) || []).length, 2);
  assert.match(check.stdout, /guidance group voice is empty/);
  assert.match(check.stdout, /brand kit has no logo/);
  const brand = JSON.parse((await run(['brand', '--root', workspace, '--json'])).stdout);
  assert.ok(brand.brand);
  await run(['doctor', '--root', workspace]);
  await server('dev');
  await server('preview');
  await mcp(['mcp', '--root', workspace]);
  await mcp(['mcp', 'read', '--root', workspace]);
  await hostedSmoke({ scratch, run, mcp });
  await consumerSmoke();
  const runtime = (await fs.readdir(cache)).find(name => !name.includes('.partial-') && !name.endsWith('.lock'));
  const resource = path.join(cache, runtime, 'package', 'src', 'executable.mjs');
  await fs.writeFile(resource, 'corrupted runtime');
  assert.equal((await run(['--version'])).stdout.trim(), pkg.version);
  assert.match(await fs.readFile(resource, 'utf8'), /isBinaryRuntime/);
  await fs.rm(path.join(cache, runtime, '.complete'));
  assert.equal((await run(['--version'])).stdout.trim(), pkg.version);
  const errors = await execute(moved, ['not-a-command'], { cwd: workspace, env }).then(() => null, error => error);
  assert.equal(errors.code, 1);
  const worker = await execute(moved, ['run', '-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)));process.exitCode=7', '--', 'argument with spaces', '--literal-flag'], { cwd: workspace, env }).then(() => null, error => error);
  assert.equal(worker.code, 7);
  assert.deepEqual(JSON.parse(worker.stdout), ['argument with spaces', '--literal-flag']);
  console.log(JSON.stringify({ version: pkg.version, platform: `${process.platform}-${process.arch}`, ...timings, checks: ['moved executable', 'spaces in paths', 'no external Node/npm/npx/Bun', 'concurrent cold launches', 'stock init/check/brand/doctor', 'two expected warnings', 'dev/preview termination', 'MCP edit/read JSON-only stdout', 'hosted login/start/submit with mocked service', 'consumer init/sync/check/upgrade without npm', 'corrupt and incomplete cache recovery', 'exit status'] }, null, 2));
} finally {
  if (process.env.TIMDS_KEEP_BINARY_SMOKE) console.log(`Kept binary smoke workspace: ${scratch}`);
  else await fs.rm(scratch, { recursive: true, force: true });
}
