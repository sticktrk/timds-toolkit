import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { SITE_ROOT_ROUTES, isEmdashRootPath, isSiteRootRoute, navigationAccept, isUnderMount, mountedPath, readyRequestPath, rootOwner, serveNamesPort, siteFolderRoutes, siteRouter, siteServeOptions, startWorkspaceSite, systemHoldsMount } from './site-proxy.mjs';

// A fake site server: answers under TIMDS_SITE_BASE on the port it is given
// (--port, else TIMDS_SITE_PORT), and at the root the way Astro with EmDash
// does in development: EmDash's routes (the seed route answers 500 under the
// base, as EmDash 1.4 does) and Vite's modules, and like Astro's dev server
// it answers a root request whose Accept names text/html with a 404 page. It
// echoes streamed bodies,
// accepts a websocket upgrade (Vite's HMR socket is at the root) and echoes
// its bytes.
// `--wrap PIDFILE` runs the server as a grandchild (as npx runs astro) and
// stays alive itself; `--delay MS` listens late; `--exit CODE` exits at once.
const FAKE_SITE = String.raw`
import http from 'node:http';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
const option = (name) => { const index = args.indexOf(name); return index === -1 ? null : args[index + 1]; };
if (option('--wrap')) {
  const rest = args.filter((_, index) => index !== args.indexOf('--wrap') && index !== args.indexOf('--wrap') + 1);
  const child = spawn(process.execPath, [process.argv[1], '--pidfile', option('--wrap'), ...rest], { stdio: 'inherit' });
  child.on('exit', (code) => process.exit(code ?? 1));
  setInterval(() => {}, 1000);
} else {
  if (option('--exit')) { console.error('fake site failing on purpose'); process.exit(Number(option('--exit'))); }
  if (option('--pidfile')) writeFileSync(option('--pidfile'), String(process.pid));
  const port = Number(option('--port') || process.env.TIMDS_SITE_PORT);
  const base = process.env.TIMDS_SITE_BASE || '';
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://x');
    const underBase = url.pathname === base || url.pathname.startsWith(base + '/');
    if (base && !underBase && (request.headers.accept || '').includes('text/html')) {
      response.writeHead(404, { 'content-type': 'text/html' }).end('astro base 404 ' + request.url);
    } else if (url.pathname === '/_emdash/admin/') {
      response.writeHead(200, { 'content-type': 'text/html' }).end(JSON.stringify({ accept: request.headers.accept, method: request.method, cookie: request.headers.cookie }));
    } else if (url.pathname === base + '/env') {
      response.writeHead(200, { 'content-type': 'application/json', 'set-cookie': ['a=1; Path=/site', 'b=2; Path=/site'] });
      response.end(JSON.stringify({ base, port: process.env.PORT, cwd: process.cwd(), headers: request.headers, url: request.url }));
    } else if (url.pathname === base + '/echo') {
      response.writeHead(201, { 'content-type': 'text/plain', 'x-fake': 'yes' });
      request.pipe(response);
    } else if (url.pathname === base + '/ready') {
      response.writeHead(302, { location: base + '/' }).end();
    } else if (url.pathname === '/_emdash/api/setup/dev-bypass') {
      response.writeHead(url.searchParams.get('redirect') === base + '/' ? 200 : 400, { 'content-type': 'text/html' }).end('seeded, redirect ' + url.searchParams.get('redirect'));
    } else if (url.pathname === base + '/_emdash/api/setup/dev-bypass') {
      response.writeHead(500).end('EmDash fails under a base');
    } else if (/^\/(_emdash|@vite|@id|@fs|@react-refresh|node_modules|src)(\/|$)/.test(url.pathname) || url.pathname.startsWith(process.cwd() + '/')) {
      response.writeHead(200, { 'content-type': 'text/javascript' }).end('site root ' + request.url);
    } else if (url.pathname === base + '/crash') {
      response.end('bye');
      setTimeout(() => process.exit(7), 20);
    } else {
      response.writeHead(404).end('site 404 ' + request.url);
    }
  });
  server.on('upgrade', (request, socket) => {
    if (request.url !== base + '/hmr?token=t' && request.url !== '/?token=t') return socket.destroy();
    const accept = createHash('sha1').update(request.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\nSec-WebSocket-Protocol: ' + request.headers['sec-websocket-protocol'] + '\r\n\r\n');
    socket.on('data', (data) => socket.write(Buffer.concat([Buffer.from('echo:'), data])));
  });
  setTimeout(() => server.listen(port, '127.0.0.1', () => console.log('fake site listening on ' + port + base)), Number(option('--delay') || 0));
}
`;

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function siteFixture(t, { args = [], ready = '/ready', serve } = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'timds-site-proxy-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const siteRoot = path.join(root, 'site');
  await fs.mkdir(siteRoot, { recursive: true });
  const script = path.join(siteRoot, 'fake-site.mjs');
  await fs.writeFile(script, FAKE_SITE);
  const port = await freePort();
  const manifest = {
    designSystem: { workspace: true, systemId: 'example' },
    apps: { site: { cwd: '.', preview: { serve: serve || [process.execPath, script, '--port', String(port), ...args], port, ready, routes: ['/'] }, designSurface: ['src/**'] } },
  };
  return { root, siteRoot, script, port, site: { root: siteRoot, manifestPath: path.join(siteRoot, 'timds.consumer.json'), manifest } };
}

function request(port, { method = 'GET', path: requestPath = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const outgoing = http.request({ host: '127.0.0.1', port, method, path: requestPath, headers }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    outgoing.on('error', reject);
    outgoing.end(body);
  });
}

async function front(t, site, { systemHas } = {}) {
  const router = siteRouter({ fallback: (request, response) => response.writeHead(200).end(`system ${request.url}`), getSite: () => ({ site: site(), message: 'starting' }), systemHas });
  const server = http.createServer(router.request);
  server.on('upgrade', router.upgrade);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  return server.address().port;
}

const quiet = () => {};
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function waitFor(check, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return true;
}

test('mount matching and serve options', async (t) => {
  assert.ok(isUnderMount('/site') && isUnderMount('/site/') && isUnderMount('/site/@vite/client'));
  assert.ok(!isUnderMount('/sitemap.xml') && !isUnderMount('/') && !isUnderMount('/brand/site/'));
  assert.equal(mountedPath('/_emdash/api/setup/dev-bypass?redirect=/'), '/site/_emdash/api/setup/dev-bypass?redirect=/');
  // EmDash's seed route is polled at the root, its redirect moved under the mount; other paths under it.
  assert.equal(readyRequestPath('/_emdash/api/setup/dev-bypass?redirect=/'), '/_emdash/api/setup/dev-bypass?redirect=%2Fsite%2F');
  assert.equal(readyRequestPath('/_emdash/api/setup/dev-bypass?redirect=/articles/'), '/_emdash/api/setup/dev-bypass?redirect=%2Fsite%2Farticles%2F');
  assert.equal(readyRequestPath('/_emdash/api/setup/dev-bypass?redirect=/site/x'), '/_emdash/api/setup/dev-bypass?redirect=/site/x', 'a redirect already under the mount is kept');
  assert.equal(readyRequestPath('/_emdash/api/health'), '/_emdash/api/health');
  assert.equal(readyRequestPath('/ready'), '/site/ready');
  assert.equal(readyRequestPath('/'), '/site/');
  assert.ok(serveNamesPort(['astro', 'dev', '--port', '1']) && serveNamesPort(['astro', 'dev', '--port=1']));
  assert.ok(!serveNamesPort(['npm', 'run', 'dev', '--', '--host', '127.0.0.1']));
  const { site, port } = await siteFixture(t);
  assert.equal(siteServeOptions(site).port, port);
  assert.equal(siteServeOptions(site).cwd, site.root);
  const two = { root: site.root, manifest: { apps: { a: { cwd: 'a', preview: {} }, web: { cwd: '.', preview: { serve: ['x'], port: 1 } } } } };
  assert.equal(siteServeOptions(two).app, 'web');
  assert.throws(() => siteServeOptions({ root: site.root, manifest: {} }), /declares no apps/);
  assert.throws(() => siteServeOptions({ root: site.root, manifest: { apps: { a: { cwd: 'a' }, b: { cwd: 'b' } } } }), /2 apps \(a, b\) and none with cwd "\."/);
  assert.throws(() => siteServeOptions({ root: site.root, manifest: { apps: { web: { cwd: '.', preview: { port: 1 } } } } }), /apps\.web\.preview\.serve must be/);
  assert.throws(() => siteServeOptions({ root: site.root, manifest: { apps: { web: { cwd: '.', preview: { serve: ['x'] } } } } }), /apps\.web\.preview\.port must be/);
  assert.throws(() => siteServeOptions({ root: site.root, manifest: { apps: { web: { cwd: '../x', preview: { serve: ['x'], port: 1 } } } } }), /must stay inside the site folder/);
});

test('the root routes: reserved paths are the site\'s, /src and the site folder unless the system has them', async (t) => {
  for (const pathname of ['/_emdash', '/_emdash/admin/', '/_emdash/api/media/file/a.jpg', '/@vite/client', '/@id/astro:scripts/page.js', '/@fs/x/y.js', '/@react-refresh', '/__vite_ping', '/__open-in-editor', '/node_modules/vite/dist/client/env.mjs', '/.astro/content.d.ts']) {
    assert.ok(isSiteRootRoute(pathname), pathname);
    assert.equal(rootOwner(pathname, { systemHas: () => true }), 'site', `${pathname} is reserved, whatever the system holds`);
  }
  // Every reserved name starts with "_", "@" or "." or is node_modules, which a system's view, page and design ids cannot be.
  for (const { path: route } of SITE_ROOT_ROUTES) assert.match(route.split('/')[1], /^(?:[_@.]|node_modules$)/, route);
  // The system's own output stays the system's.
  for (const pathname of ['/', '/index.html', '/brand/color/', '/designs/', '/designs/website/', '/changelog/', '/styles/system.css', '/scripts/compose.js', '/assets/logo.svg', '/bundle/bundle.json', '/llms.txt', '/llms-full.txt', '/index.json', '/tokens.css', '/robots.txt', '/use/compose/', '/_emdashx', '/@vitex', '/node_modulesx', '/srcx', '/sitemap.xml']) {
    assert.equal(rootOwner(pathname, { folders: ['/work/ws/site'] }), 'system', pathname);
  }
  // /src/** and the site folder's absolute path: the site's unless the system's dist/ holds that top-level entry.
  assert.equal(rootOwner('/src/pages/404.astro'), 'site');
  assert.equal(rootOwner('/src/pages/404.astro', { systemHas: (segment) => segment === 'src' }), 'system');
  assert.equal(rootOwner('/work/ws/site/src/pages/x.astro', { folders: ['/work/ws/site'] }), 'site');
  assert.equal(rootOwner('/work/ws/site/src/pages/x.astro', { folders: ['/work/ws/site'], systemHas: (segment) => segment === 'work' }), 'system');
  assert.equal(rootOwner('/work/ws/siteextra/x', { folders: ['/work/ws/site'] }), 'system');
  const { siteRoot, root } = await siteFixture(t);
  const link = path.join(root, 'link');
  await fs.symlink(siteRoot, link);
  assert.deepEqual(siteFolderRoutes(link), [link, siteRoot].map((folder) => folder.split(path.sep).join('/')));
});

test('page navigations to /_emdash lose only their text/html ranges', () => {
  const browser = 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8';
  assert.equal(navigationAccept(browser), 'application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8');
  assert.equal(navigationAccept('text/html'), '*/*');
  assert.equal(navigationAccept('text/html;q=0.9, text/plain'), 'text/plain');
  assert.equal(navigationAccept('application/json'), null);
  assert.equal(navigationAccept(undefined), null);
  assert.equal(navigationAccept('*/*'), null);
  assert.ok(isEmdashRootPath('/_emdash') && isEmdashRootPath('/_emdash/admin/') && !isEmdashRootPath('/_emdashx') && !isEmdashRootPath('/site/_emdash/'));
});

test('a running site answers its root routes and websockets at the root, polled ready at the root, on a free port when preview.port is taken', async (t) => {
  const { site, port, script, siteRoot } = await siteFixture(t, { ready: '/_emdash/api/setup/dev-bypass?redirect=/' });
  // No --port in the command: the port comes from TIMDS_SITE_PORT, so the site can move.
  site.manifest.apps.site.preview.serve = [process.execPath, script];
  const blocker = net.createServer().listen(port, '127.0.0.1');
  t.after(() => blocker.close());
  await new Promise((resolve) => blocker.once('listening', resolve));
  const lines = [];
  const handle = await startWorkspaceSite(site, { log: (line) => lines.push(line) });
  t.after(() => handle.stop());
  assert.notEqual(handle.port, port);
  assert.ok(lines.includes(`Port ${port} (preview.port in site/timds.consumer.json) is in use, so the site's dev server listens on port ${handle.port}; it is still served through this dev server.`), lines.join('\n'));
  assert.deepEqual(handle.folders, [siteRoot]);
  const frontPort = await front(t, () => handle, { systemHas: (segment) => segment === 'designs' });
  const env = JSON.parse((await request(frontPort, { path: '/site/env' })).body);
  assert.equal(env.port, String(handle.port));

  for (const rootPath of ['/_emdash/api/manifest', '/_emdash/api/media/file/a.jpg', '/@vite/client', '/@id/astro:scripts/page.js', '/@react-refresh', '/node_modules/vite/dist/client/env.mjs', '/src/pages/404.astro?astro&type=style&index=0&lang.css', `${siteRoot}/src/pages/404.astro?astro&type=script&index=0&lang.ts`]) {
    assert.deepEqual(await request(frontPort, { path: rootPath }).then(({ status, body }) => [status, body]), [200, `site root ${rootPath}`], rootPath);
  }
  assert.equal((await request(frontPort, { path: '/_emdash/api/setup/dev-bypass?redirect=/site/' })).status, 200);
  for (const systemPath of ['/', '/designs/', '/brand/', '/llms.txt', '/styles/system.css']) {
    assert.equal((await request(frontPort, { path: systemPath })).body, `system ${systemPath}`, systemPath);
  }
  assert.equal(handle.emdash, true, 'a site whose ready path is EmDash\'s seed route is an EmDash site');

  // A browser opening the admin: only Accept changes, so Astro's base check lets it through.
  const browser = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';
  const admin = await request(frontPort, { path: '/_emdash/admin/', headers: { accept: browser, cookie: 'astro-session=s' } });
  assert.equal(admin.status, 200);
  assert.deepEqual(JSON.parse(admin.body), { accept: 'application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', method: 'GET', cookie: 'astro-session=s' });
  assert.equal(JSON.parse((await request(frontPort, { path: '/_emdash/admin/', headers: { accept: 'application/json' } })).body).accept, 'application/json', 'a non-navigation is forwarded as it is');
  // Vite's paths and the mount are forwarded unchanged: Astro's own answer stands.
  assert.deepEqual(await request(frontPort, { path: '/@vite/client', headers: { accept: browser } }).then(({ status, body }) => [status, body]), [404, 'astro base 404 /@vite/client']);
  assert.equal((await request(frontPort, { path: '/site/missing', headers: { accept: browser } })).body, 'site 404 /site/missing');

  // A guessed /site/_emdash/** link is sent to the root for GET and HEAD; other methods reach the site as they are.
  const moved = await request(frontPort, { path: '/site/_emdash/admin/?a=1&b=2', headers: { accept: browser } });
  assert.deepEqual([moved.status, moved.headers.location], [307, '/_emdash/admin/?a=1&b=2']);
  const head = await request(frontPort, { method: 'HEAD', path: '/site/_emdash' });
  assert.deepEqual([head.status, head.headers.location, head.body], [307, '/_emdash', '']);
  assert.equal((await request(frontPort, { method: 'POST', path: '/site/_emdash/api/setup/dev-bypass', body: 'x' })).status, 500);
  assert.equal((await request(frontPort, { path: '/site/_emdashx' })).status, 404, 'only /site/_emdash and below move');

  // Vite's HMR socket is at the root.
  const socket = net.connect(frontPort, '127.0.0.1');
  t.after(() => socket.destroy());
  socket.write(`GET /?token=t HTTP/1.1\r\nHost: 127.0.0.1:${frontPort}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Protocol: vite-hmr\r\n\r\n`);
  let received = '';
  await new Promise((resolve, reject) => {
    socket.on('data', (data) => {
      received += data.toString('utf8');
      if (received.includes('\r\n\r\n') && !received.includes('echo:')) socket.write('ping');
      if (received.includes('echo:ping')) resolve();
    });
    socket.on('error', reject);
  });
  assert.match(received, /^HTTP\/1\.1 101 Switching Protocols/);
});

test('without a running site the root routes stay with the system and upgrades outside the mount are closed', async (t) => {
  const frontPort = await front(t, () => null);
  assert.equal((await request(frontPort, { path: '/_emdash/admin/' })).body, 'system /_emdash/admin/');
  assert.equal((await request(frontPort, { path: '/@vite/client' })).body, 'system /@vite/client');
  assert.deepEqual(await request(frontPort, { path: '/site/' }).then(({ status, body }) => [status, body]), [503, 'starting\n']);
  assert.equal((await request(frontPort, { path: '/site/_emdash/admin/' })).status, 503, 'no redirect without a running site');
  const socket = net.connect(frontPort, '127.0.0.1');
  t.after(() => socket.destroy());
  socket.write(`GET /?token=t HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n`);
  await new Promise((resolve) => socket.once('close', resolve));
});

test('a system with its own pages under /site keeps them, with or without a site handle', async (t) => {
  assert.ok(systemHoldsMount((segment) => segment === 'site'));
  assert.ok(!systemHoldsMount((segment) => segment === 'sitemap.xml'));
  assert.ok(!systemHoldsMount());
  assert.ok(systemHoldsMount((segment) => segment === 'preview', '/preview'));
  const systemHas = (segment) => segment === 'site';
  // A handle that would answer everything, to prove it is never asked.
  const handle = {
    folders: [],
    handleRequest: (request, response) => response.writeHead(200).end(`site ${request.url}`),
    handleUpgrade: (request, socket) => socket.end('HTTP/1.1 101 Switching Protocols\r\n\r\n'),
  };
  for (const site of [() => null, () => handle]) {
    const frontPort = await front(t, site, { systemHas });
    for (const systemPath of ['/site', '/site/', '/site/guide/', '/site/_emdash/admin/', '/_emdash/admin/', '/@vite/client', '/src/pages/x.astro', '/']) {
      assert.deepEqual(await request(frontPort, { path: systemPath }).then(({ status, body }) => [status, body]), [200, `system ${systemPath}`], systemPath);
    }
    for (const upgradePath of ['/', '/site/hmr']) {
      const socket = net.connect(frontPort, '127.0.0.1');
      t.after(() => socket.destroy());
      let received = '';
      socket.on('data', (data) => { received += data; });
      socket.write(`GET ${upgradePath} HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n`);
      await new Promise((resolve) => socket.once('close', resolve));
      assert.equal(received, '', `${upgradePath} upgrade is closed, as with no site`);
    }
  }
});

test('starts the site with the base, proxies streamed HTTP and websockets, and stops its process group', async (t) => {
  const { site, port, siteRoot } = await siteFixture(t, { args: ['--wrap', 'PIDFILE', '--delay', '300'] });
  const pidFile = path.join(siteRoot, 'grandchild.pid');
  site.manifest.apps.site.preview.serve = site.manifest.apps.site.preview.serve.map((part) => (part === 'PIDFILE' ? pidFile : part));
  const lines = [];
  const handle = await startWorkspaceSite(site, { log: (line) => lines.push(line) });
  t.after(() => handle.stop());
  assert.equal(handle.port, port);
  assert.equal(handle.host, '127.0.0.1');
  assert.ok(lines.some((line) => line.startsWith('[site] fake site listening')), 'the child output is forwarded with a prefix');
  const frontPort = await front(t, () => handle);

  // The base variable and the port reach the child; the request is forwarded unchanged.
  const env = await request(frontPort, { path: '/site/env?x=1', headers: { 'x-forwarded-for': '10.0.0.1' } });
  assert.equal(env.status, 200);
  const seen = JSON.parse(env.body);
  assert.equal(seen.base, '/site');
  assert.equal(seen.port, String(port));
  assert.equal(seen.cwd, siteRoot);
  assert.ok(lines.every((line) => !line.includes('is in use')), 'a free preview.port is used as it is');
  assert.equal(handle.emdash, false);
  assert.equal(seen.url, '/site/env?x=1');
  assert.equal(seen.headers.host, `127.0.0.1:${frontPort}`, 'the browser host is kept');
  assert.equal(seen.headers['x-forwarded-host'], `127.0.0.1:${frontPort}`);
  assert.equal(seen.headers['x-forwarded-proto'], 'http');
  assert.equal(seen.headers['x-forwarded-for'], '10.0.0.1, 127.0.0.1');
  assert.deepEqual(env.headers['set-cookie'], ['a=1; Path=/site', 'b=2; Path=/site']);

  // Outside the mount stays with the system; a site 404 stays the site's.
  assert.equal((await request(frontPort, { path: '/sitemap.xml' })).body, 'system /sitemap.xml');
  assert.deepEqual(await request(frontPort, { path: '/site/missing' }).then(({ status, body }) => [status, body]), [404, 'site 404 /site/missing']);

  // POST bodies stream both ways: the first chunk comes back before the request ends.
  const echoed = await new Promise((resolve, reject) => {
    const outgoing = http.request({ host: '127.0.0.1', port: frontPort, method: 'POST', path: '/site/echo', headers: { 'content-type': 'text/plain' } }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        body += chunk;
        if (body === 'first ') outgoing.end('second');
      });
      response.on('end', () => resolve({ status: response.statusCode, fake: response.headers['x-fake'], body }));
    });
    outgoing.on('error', reject);
    outgoing.write('first ');
  });
  assert.deepEqual(echoed, { status: 201, fake: 'yes', body: 'first second' });

  // A websocket upgrade round trip through the one port.
  const key = 'dGhlIHNhbXBsZSBub25jZQ==';
  const socket = net.connect(frontPort, '127.0.0.1');
  t.after(() => socket.destroy());
  socket.write(`GET /site/hmr?token=t HTTP/1.1\r\nHost: 127.0.0.1:${frontPort}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Protocol: vite-hmr\r\n\r\n`);
  let received = '';
  const handshake = await new Promise((resolve, reject) => {
    socket.on('data', (data) => {
      received += data.toString('utf8');
      if (received.includes('\r\n\r\n') && !received.includes('echo:')) {
        socket.write('ping');
      }
      if (received.includes('echo:ping')) resolve(received);
    });
    socket.on('error', reject);
  });
  assert.match(handshake, /^HTTP\/1\.1 101 Switching Protocols/);
  assert.ok(handshake.includes(`Sec-WebSocket-Accept: ${createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64')}`));
  assert.ok(handshake.includes('Sec-WebSocket-Protocol: vite-hmr'));

  // Stopping kills the whole group, the grandchild server included, and closes open upgrades.
  const grandchild = Number(await fs.readFile(pidFile, 'utf8'));
  assert.ok(alive(grandchild));
  const socketClosed = new Promise((resolve) => socket.once('close', resolve));
  await handle.stop();
  await socketClosed;
  assert.ok(await waitFor(() => !alive(grandchild)), 'the grandchild server is gone');
  assert.ok(!alive(handle.child.pid));
  assert.equal(handle.state().status, 'stopped');
  assert.equal((await request(frontPort, { path: '/site/env' })).status, 502);
});

test('an exited site answers 502 with the reason while the system keeps answering', async (t) => {
  const { site } = await siteFixture(t);
  const lines = [];
  let stoppedWith = null;
  const handle = await startWorkspaceSite(site, { log: (line) => lines.push(line), onStop: (reason) => { stoppedWith = reason; } });
  t.after(() => handle.stop());
  const frontPort = await front(t, () => handle);
  assert.equal((await request(frontPort, { path: '/site/crash' })).body, 'bye');
  assert.ok(await waitFor(() => stoppedWith !== null));
  assert.equal(stoppedWith, 'exit code 7');
  const down = await request(frontPort, { path: '/site/env' });
  assert.equal(down.status, 502);
  assert.match(down.body, /stopped with exit code 7; restart the dev server/);
  assert.equal((await request(frontPort, { path: '/brand/' })).body, 'system /brand/');
  assert.ok(lines.some((line) => /The site's dev server stopped with exit code 7/.test(line)));
});

test('an upstream that is not listening answers 502', async (t) => {
  const port = await freePort();
  const frontPort = await front(t, () => ({ handleRequest: (request, response) => import('./site-proxy.mjs').then(({ proxySiteRequest }) => proxySiteRequest(request, response, { host: '127.0.0.1', port })) }));
  const answer = await request(frontPort, { path: '/site/' });
  assert.equal(answer.status, 502);
  assert.match(answer.body, new RegExp(`not answering on port ${port} \\(ECONNREFUSED\\)`));
});

test('readiness failures stop the child and report the tail of its output', async (t) => {
  const early = await siteFixture(t, { args: ['--exit', '3'] });
  await assert.rejects(startWorkspaceSite(early.site, { log: quiet }), /stopped with exit code 3 before \/site\/ready answered[\s\S]*fake site failing on purpose/);

  const slow = await siteFixture(t, { args: ['--delay', '10000', '--pidfile', 'PIDFILE'] });
  const pidFile = path.join(slow.siteRoot, 'slow.pid');
  slow.site.manifest.apps.site.preview.serve = slow.site.manifest.apps.site.preview.serve.map((part) => (part === 'PIDFILE' ? pidFile : part));
  await assert.rejects(startWorkspaceSite(slow.site, { log: quiet, readyTimeoutMs: 600 }), /did not answer \/site\/ready on port \d+ within 1s; check that it reads TIMDS_SITE_BASE/);
  const pid = Number(await fs.readFile(pidFile, 'utf8'));
  assert.ok(await waitFor(() => !alive(pid)), 'the timed-out child is stopped');

  const missing = await siteFixture(t, { serve: [path.join(os.tmpdir(), 'timds-no-such-command')] });
  await assert.rejects(startWorkspaceSite(missing.site, { log: quiet }), /Could not start the site's dev server .*ENOENT/);

  const taken = await siteFixture(t);
  const blocker = net.createServer().listen(taken.port, '127.0.0.1');
  t.after(() => blocker.close());
  await new Promise((resolve) => blocker.once('listening', resolve));
  await assert.rejects(startWorkspaceSite(taken.site, { log: quiet }), new RegExp(`Port ${taken.port} \\(preview\\.port in site/timds\\.consumer\\.json\\) is already in use and preview\\.serve names --port, so the site cannot move`));
});

test('an aborted start stops the child before it is ready', async (t) => {
  const { site } = await siteFixture(t, { args: ['--delay', '10000'] });
  const controller = new AbortController();
  const starting = startWorkspaceSite(site, { log: quiet, signal: controller.signal });
  setTimeout(() => controller.abort(), 300);
  await assert.rejects(starting, /stopped before it was ready/);
});
