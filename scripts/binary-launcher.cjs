// Deliberately builtins only: this file runs inside Node's SEA bootstrap.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { spawn } = require('node:child_process');
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');

function safePath(root, name) {
  if (typeof name !== 'string' || !name || name.includes('\\') || path.isAbsolute(name) || name.split('/').some(part => !part || part === '.' || part === '..')) throw new Error(`Unsafe binary resource path: ${name}`);
  return path.join(root, name);
}
function validate(root, manifest) {
  try {
    if (!fs.lstatSync(root).isDirectory() || fs.lstatSync(root).isSymbolicLink()) return false;
    for (const entry of manifest.files) {
      const file = safePath(root, entry.path);
      // Check every ancestor so a replaced directory cannot redirect reads.
      let parent = path.dirname(file);
      while (parent !== root) { if (fs.lstatSync(parent).isSymbolicLink()) return false; parent = path.dirname(parent); }
      const stat = fs.lstatSync(file);
      if (entry.link) {
        if (!stat.isSymbolicLink() || fs.readlinkSync(file) !== entry.link) return false;
      } else if (!stat.isFile() || stat.size !== entry.size || (stat.mode & 0o777) !== entry.mode || sha256(fs.readFileSync(file)) !== entry.sha256) return false;
    }
    const expected = new Set(['.complete']);
    for (const entry of manifest.files) {
      expected.add(entry.path);
      let parent = path.posix.dirname(entry.path);
      while (parent !== '.') { expected.add(parent); parent = path.posix.dirname(parent); }
    }
    // Added files can shadow legitimate Node imports even when every shipped
    // file still has its original hash. The runtime cache is immutable.
    function inventory(directory, prefix = '') {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (!expected.has(relative)) return false;
        if (entry.isDirectory() && !inventory(path.join(directory, entry.name), relative)) return false;
      }
      return true;
    }
    return inventory(root) && fs.readFileSync(path.join(root, '.complete'), 'utf8') === manifest.payloadHash;
  } catch { return false; }
}
function secureDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid())) throw new Error(`Binary cache must be a directory owned by this user: ${directory}`);
  fs.chmodSync(directory, 0o700);
}
function lock(directory) {
  const start = Date.now();
  while (true) {
    try {
      fs.mkdirSync(directory, { mode: 0o700 });
      fs.writeFileSync(path.join(directory, 'owner'), String(process.pid));
      return () => fs.rmSync(directory, { recursive: true, force: true });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let stale = false;
      let lockStat;
      try { lockStat = fs.lstatSync(directory); }
      catch (probe) { if (probe.code === 'ENOENT') continue; throw probe; }
      try {
        const pid = Number(fs.readFileSync(path.join(directory, 'owner'), 'utf8'));
        if (!Number.isInteger(pid) || pid <= 0) stale = Date.now() - lockStat.mtimeMs > 2000;
        else {
          try { process.kill(pid, 0); }
          catch (probe) { if (probe.code === 'ESRCH') stale = true; }
        }
      } catch (probe) {
        if (probe.code !== 'ENOENT') throw probe;
        stale = Date.now() - lockStat.mtimeMs > 2000;
      }
      if (stale) {
        try {
          const current = fs.lstatSync(directory);
          if (current.ino === lockStat.ino && current.mtimeMs === lockStat.mtimeMs) fs.rmSync(directory, { recursive: true, force: true });
        } catch (probe) { if (probe.code !== 'ENOENT') throw probe; }
        continue;
      }
      if (Date.now() - start > 120000) throw new Error(`Timed out waiting for binary cache initialization: ${directory}`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }
}
function materialize(compressed, metadata, cacheBase) {
  // The executable is the trust anchor; the cache is always checked against its
  // embedded manifest, never against a mutable manifest in the cache itself.
  const { manifest } = metadata;
  secureDirectory(cacheBase);
  const cache = path.join(cacheBase, `${metadata.version}-${metadata.platform}-${metadata.arch}-${manifest.payloadHash.slice(0, 20)}`);
  if (validate(cache, manifest)) return cache;
  const release = lock(`${cache}.lock`);
  let temporary;
  try {
    if (validate(cache, manifest)) return cache;
    if (sha256(compressed) !== manifest.payloadHash) throw new Error('Embedded runtime integrity check failed');
    const payload = zlib.gunzipSync(compressed);
    temporary = fs.mkdtempSync(`${cache}.partial-`);
    for (const entry of manifest.files) {
      const file = safePath(temporary, entry.path);
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      if (entry.link) {
        const target = path.resolve(path.dirname(file), entry.link);
        if (!target.startsWith(`${temporary}${path.sep}`)) throw new Error(`Unsafe resource link: ${entry.path}`);
        fs.symlinkSync(entry.link, file);
      } else {
        const contents = payload.subarray(entry.offset, entry.offset + entry.size);
        if (sha256(contents) !== entry.sha256) throw new Error(`Embedded resource integrity check failed: ${entry.path}`);
        fs.writeFileSync(file, contents, { mode: entry.mode });
        fs.chmodSync(file, entry.mode);
      }
    }
    fs.writeFileSync(path.join(temporary, '.complete'), manifest.payloadHash, { mode: 0o600 });
    if (!validate(temporary, manifest)) throw new Error('Extracted runtime integrity check failed');
    if (fs.existsSync(cache)) {
      const stale = `${cache}.invalid-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
      fs.renameSync(cache, stale);
      fs.rmSync(stale, { recursive: true, force: true });
    }
    fs.renameSync(temporary, cache);
    temporary = null;
    return cache;
  } finally {
    if (temporary) fs.rmSync(temporary, { recursive: true, force: true });
    release();
  }
}
function main() {
  try {
    const sea = require('node:sea');
    const metadata = JSON.parse(sea.getAsset('metadata', 'utf8'));
    const defaultBase = process.platform === 'darwin' ? path.join(os.homedir(), 'Library/Caches/timds/runtime') : path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'timds/runtime');
    const cache = fs.realpathSync(materialize(Buffer.from(sea.getRawAsset('payload')), metadata, process.env.TIMDS_BINARY_CACHE || defaultBase));
    const packageRoot = path.join(cache, 'package');
    const env = { ...process.env, TIMDS_BINARY_EXECUTABLE: process.execPath, TIMDS_RUNTIME_ROOT: cache, TIMDS_RUNTIME_PACKAGE: packageRoot };
    delete env.NODE_OPTIONS;
    const child = spawn(path.join(cache, 'runtime/node'), ['--import', path.join(packageRoot, 'src/executable-register.mjs'), path.join(packageRoot, 'bin/timds.mjs'), ...process.argv.slice(2)], { cwd: process.cwd(), env, stdio: 'inherit', detached: true });
    const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
    let receivedSignal = null;
    const forward = signal => { receivedSignal ||= signal; try { process.kill(-child.pid, signal); } catch { child.kill(signal); } };
    const listeners = signals.map(signal => { const listener = () => forward(signal); process.on(signal, listener); return listener; });
    child.on('error', error => { process.stderr.write(`TimDS binary: ${error.message}\n`); process.exitCode = 1; });
    child.on('exit', (code, signal) => {
      signals.forEach((signalName, index) => process.removeListener(signalName, listeners[index]));
      if (receivedSignal || signal) process.kill(process.pid, receivedSignal || signal);
      else process.exitCode = code ?? 1;
    });
  } catch (error) { process.stderr.write(`TimDS binary: ${error.message}\n`); process.exitCode = 1; }
}
if (require('node:sea').isSea()) main();
else module.exports = { materialize, validate, safePath, sha256 };
