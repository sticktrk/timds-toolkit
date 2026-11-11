import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { initializeRepository } from './core.mjs';
import { dev } from './viewer.mjs';

// The stock dev server with and without a workspace site in site/. The fake
// site answers every path (under TIMDS_SITE_BASE and at its root, as Astro
// with EmDash does in development) on --port, else TIMDS_SITE_PORT, and
// accepts a websocket upgrade.
const FAKE_SITE = String.raw`
import http from 'node:http';
const args = process.argv.slice(2);
if (args.includes('--exit')) { console.error('fake site broke'); process.exit(3); }
const base = process.env.TIMDS_SITE_BASE;
const server = http.createServer((request, response) => {
  response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ base, url: request.url, pid: process.pid, port: process.env.TIMDS_SITE_PORT }));
});
server.on('upgrade', (request, socket) => {
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
  socket.on('data', (data) => socket.write('echo:' + data));
});
server.listen(Number(args.includes('--port') ? args[args.indexOf('--port') + 1] : process.env.TIMDS_SITE_PORT), '127.0.0.1');
`;

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function system(t, { site = false, installed = true, args = [], namesPort = true, ready = '/_ready' } = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'timds-viewer-dev-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await initializeRepository(root, { standalone: true });
  if (site) {
    const siteRoot = path.join(root, 'site');
    await fs.mkdir(siteRoot, { recursive: true });
    if (installed) await fs.mkdir(path.join(siteRoot, 'node_modules'));
    await fs.writeFile(path.join(siteRoot, 'fake-site.mjs'), FAKE_SITE);
    const port = await freePort();
    await fs.writeFile(path.join(siteRoot, 'timds.consumer.json'), JSON.stringify({
      designSystem: { workspace: true, systemId: 'example' },
      apps: { site: { cwd: '.', preview: { serve: ['node', 'fake-site.mjs', ...(namesPort ? ['--port', String(port)] : []), ...args], port, ready, routes: ['/'] }, designSurface: ['src/**'] } },
    }));
    return { root, port };
  }
  return root;
}

async function start(t, value, options = {}) {
  const root = typeof value === 'string' ? value : value.root;
  const lines = [];
  const record = (...values) => lines.push(values.join(' '));
  t.mock.method(console, 'log', record);
  t.mock.method(console, 'error', record);
  t.mock.method(console, 'warn', record);
  const server = await dev(root, { port: 0, ...options });
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  t.mock.restoreAll();
  t.after(() => new Promise((resolve) => { if (!server.listening) return resolve(); server.closeAllConnections(); server.close(() => resolve()); }));
  return { server, port: server.address().port, lines };
}

function get(port, requestPath) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: requestPath }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body }));
    }).on('error', reject);
  });
}

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('dev without a site folder serves the system as before', async (t) => {
  const root = await system(t);
  const { server, port, lines } = await start(t, root);
  assert.equal(server.listenerCount('upgrade'), 0);
  assert.equal((await get(port, '/')).status, 200);
  assert.deepEqual(await get(port, '/site/'), { status: 404, body: 'Not found' });
  assert.ok(lines.includes('Starter viewer: http://127.0.0.1:0'));
  assert.ok(!lines.some((line) => /site/i.test(line) && !line.startsWith('Starter viewer')), lines.join('\n'));
});

test('dev with a site that is not installed serves the system alone with the install hint', async (t) => {
  const root = await system(t, { site: true, installed: false });
  const { port, lines } = await start(t, root);
  const hint = 'The site in site/ is not installed, so the dev server shows the Design System alone; run npm ci in site/, then start the dev server again.';
  assert.ok(lines.includes(hint), lines.join('\n'));
  assert.equal((await get(port, '/')).status, 200);
  assert.deepEqual(await get(port, '/site/'), { status: 503, body: `${hint}\n` });
});

test('dev starts the workspace site behind /site and stops it on close', async (t) => {
  const workspace = await system(t, { site: true });
  const { server, port, lines } = await start(t, workspace);
  assert.ok(lines.includes(`Site: http://127.0.0.1:${port}/site/`), lines.join('\n'));
  assert.ok(!lines.some((line) => line.startsWith('EmDash admin')), 'no admin line for a site that is not EmDash');
  assert.equal((await get(port, '/')).status, 200, 'the system pages are still served');
  for (const systemPath of ['/designs/', '/changelog/', '/styles/system.css', '/tokens.css']) {
    const answer = await get(port, systemPath);
    assert.equal(answer.status, 200, systemPath);
    assert.ok(!answer.body.includes('"base"'), `${systemPath} is the system's`);
  }
  // The paths the site's dev server answers at its root reach it unchanged.
  for (const rootPath of ['/_emdash/admin/', '/@vite/client', '/node_modules/vite/dist/client/env.mjs', '/src/pages/404.astro?astro&type=style']) {
    const answer = await get(port, rootPath);
    assert.equal(answer.status, 200, rootPath);
    assert.equal(JSON.parse(answer.body).url, rootPath);
  }
  assert.equal((await get(port, '/nope/')).status, 404, 'an unknown path is the system 404, not the site');
  const answer = await get(port, '/site/articles/x/?q=1');
  assert.equal(answer.status, 200);
  const seen = JSON.parse(answer.body);
  assert.deepEqual([seen.base, seen.url], ['/site', '/site/articles/x/?q=1']);

  const socket = net.connect(port, '127.0.0.1');
  t.after(() => socket.destroy());
  socket.write(`GET /?token=t HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n`);
  let received = '';
  await new Promise((resolve) => socket.on('data', (data) => {
    received += data;
    if (received.endsWith('\r\n\r\n')) socket.write('hi');
    if (received.includes('echo:hi')) resolve();
  }));
  assert.match(received, /^HTTP\/1\.1 101/);

  await new Promise((resolve) => server.close(resolve));
  assert.ok(!alive(seen.pid), 'closing the dev server stops the site');
});

test('dev with a site that fails to start reports it and serves the system alone', async (t) => {
  const root = await system(t, { site: true, args: ['--exit'] });
  const { port, lines } = await start(t, root);
  assert.ok(lines.some((line) => /^The site in site\/ did not start, so the dev server shows the Design System alone: .*stopped with exit code 3[\s\S]*fake site broke/.test(line)), lines.join('\n'));
  assert.equal((await get(port, '/')).status, 200);
  const down = await get(port, '/site/');
  assert.equal(down.status, 503);
  assert.match(down.body, /did not start/);
});

// A system view named "site" builds to dist/site/, the workspace site's mount.
async function addSiteView(root) {
  const catalogPath = path.join(root, 'src/site.json');
  const catalog = JSON.parse(await fs.readFile(catalogPath, 'utf8'));
  catalog.views.push({ id: 'site', label: 'Site', pages: [{ slug: '', title: 'Site guidance' }, { slug: 'guide', title: 'Site guide' }] });
  await fs.writeFile(catalogPath, JSON.stringify(catalog, null, 2));
  await fs.mkdir(path.join(root, 'src/pages/site'), { recursive: true });
  await fs.writeFile(path.join(root, 'src/pages/site/index.html'), '<h1>Site guidance</h1>\n');
  await fs.writeFile(path.join(root, 'src/pages/site/guide.html'), '<h1>Site guide</h1>\n');
}

for (const installed of [true, false]) {
  test(`dev keeps the system's own pages under /site and does not start a site that is ${installed ? 'installed' : 'not installed'}`, async (t) => {
    const workspace = await system(t, { site: true, installed });
    await addSiteView(workspace.root);
    const { server, port, lines } = await start(t, workspace);
    const notice = 'The Design System already has pages under /site/ (dist/site/), so the site in site/ is not started or served through the dev server. Run the site on its own with npm run dev in site/, where it serves at / on its own port, or rename the view in src/site.json (or the build step) that writes dist/site/.';
    assert.ok(lines.includes(notice), lines.join('\n'));
    assert.ok(!lines.some((line) => line.startsWith('[site]') || line.startsWith('Site:') || /not installed|did not start/.test(line)), lines.join('\n'));
    assert.equal(server.listenerCount('upgrade'), 0, 'no websocket is taken');
    for (const [requestPath, file] of [['/site/', 'site/index.html'], ['/site', 'site/index.html'], ['/site/guide/', 'site/guide/index.html']]) {
      const answer = await get(port, requestPath);
      assert.equal(answer.status, 200, requestPath);
      assert.equal(answer.body, await fs.readFile(path.join(workspace.root, 'dist', file), 'utf8'), `${requestPath} is the system's page`);
    }
    for (const rootPath of ['/_emdash/admin/', '/@vite/client', '/site/missing/']) {
      assert.deepEqual(await get(port, rootPath), { status: 404, body: 'Not found' }, rootPath);
    }
    // Nothing listens on the site's port: its process was never started.
    const probe = await new Promise((resolve) => {
      const socket = net.connect(workspace.port, '127.0.0.1');
      socket.once('connect', () => { socket.destroy(); resolve(true); });
      socket.once('error', () => resolve(false));
    });
    assert.equal(probe, false, 'the site process was not started');
  });
}

test('dev moves the site to a free port when preview.port is taken and names the EmDash admin', async (t) => {
  const workspace = await system(t, { site: true, namesPort: false, ready: '/_emdash/api/setup/dev-bypass?redirect=/' });
  const blocker = net.createServer().listen(workspace.port, '127.0.0.1');
  t.after(() => blocker.close());
  await new Promise((resolve) => blocker.once('listening', resolve));
  const { port, lines } = await start(t, workspace);
  assert.ok(lines.some((line) => line.startsWith(`Port ${workspace.port} (preview.port in site/timds.consumer.json) is in use, so the site's dev server listens on port `)), lines.join('\n'));
  assert.ok(lines.includes(`Site: http://127.0.0.1:${port}/site/`), lines.join('\n'));
  assert.ok(lines.includes(`EmDash admin: http://127.0.0.1:${port}/_emdash/admin/ (sign in on this machine at http://127.0.0.1:${port}/_emdash/api/setup/dev-bypass?redirect=/_emdash/admin/)`), lines.join('\n'));
  // The readiness poll asked EmDash's seed route at the root, its redirect under the mount.
  assert.equal(JSON.parse((await get(port, '/_emdash/api/setup/dev-bypass?redirect=%2Fsite%2F')).body).url, '/_emdash/api/setup/dev-bypass?redirect=%2Fsite%2F');
  const seen = JSON.parse((await get(port, '/site/')).body);
  assert.notEqual(seen.port, String(workspace.port));
  assert.equal(seen.base, '/site');
});
