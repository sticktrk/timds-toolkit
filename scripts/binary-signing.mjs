import fs from 'node:fs/promises';
import path from 'node:path';

const nativeFileTypes = new Set([2, 6, 8]); // MH_EXECUTE, MH_DYLIB, MH_BUNDLE
const thinMagic = new Map([[0xfeedface, [false, 28]], [0xfeedfacf, [false, 32]], [0xcefaedfe, [true, 28]], [0xcffaedfe, [true, 32]]]);
const fatMagic = new Map([[0xcafebabe, [false, 20]], [0xcafebabf, [false, 32]], [0xbebafeca, [true, 20]], [0xbfbafeca, [true, 32]]]);

export function appleSigningConfiguration({ platform = process.platform, env = process.env } = {}) {
  if (platform !== 'darwin') return { identity: null, profile: null };
  const configuredIdentity = env.TIMDS_CODESIGN_IDENTITY?.trim();
  const identity = configuredIdentity && configuredIdentity !== '-' ? configuredIdentity : null;
  const profile = env.TIMDS_NOTARY_PROFILE?.trim() || null;
  if (env.TIMDS_REQUIRE_APPLE_SIGNING === 'true' && (!identity || !profile)) {
    throw new Error('TIMDS_REQUIRE_APPLE_SIGNING=true requires a Developer ID Application TIMDS_CODESIGN_IDENTITY and TIMDS_NOTARY_PROFILE on macOS');
  }
  if (profile && !identity) throw new Error('Notarization requires a Developer ID Application TIMDS_CODESIGN_IDENTITY');
  return { identity, profile };
}

async function readAt(handle, length, position) {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, position);
  return buffer.subarray(0, bytesRead);
}

function thinType(header) {
  if (header.length < 4) return null;
  const format = thinMagic.get(header.readUInt32BE(0));
  if (!format || header.length < format[1]) return null;
  return format[0] ? header.readUInt32LE(12) : header.readUInt32BE(12);
}

/** Inspect magic and slice headers, including universal binaries. A Java class
 * shares FAT_MAGIC; requiring real Mach-O slices avoids signing those as code. */
export async function isNativeMachO(file) {
  const handle = await fs.open(file, 'r');
  try {
    const { size } = await handle.stat();
    const header = await readAt(handle, 32, 0);
    if (header.length < 4) return false;
    const type = thinType(header);
    if (type !== null) return nativeFileTypes.has(type);
    const format = fatMagic.get(header.readUInt32BE(0));
    if (!format || header.length < 8) return false;
    const read32 = (buffer, offset) => format[0] ? buffer.readUInt32LE(offset) : buffer.readUInt32BE(offset);
    const count = read32(header, 4);
    if (!count || count > 64 || 8 + count * format[1] > size) return false;
    const table = await readAt(handle, count * format[1], 8);
    for (let index = 0; index < count; index++) {
      const entry = index * format[1];
      const offset = format[1] === 20 ? read32(table, entry + 8) : Number(format[0] ? table.readBigUInt64LE(entry + 8) : table.readBigUInt64BE(entry + 8));
      const length = format[1] === 20 ? read32(table, entry + 12) : Number(format[0] ? table.readBigUInt64LE(entry + 16) : table.readBigUInt64BE(entry + 16));
      if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 8 + table.length || length < 28 || offset + length > size) return false;
      if (!nativeFileTypes.has(thinType(await readAt(handle, Math.min(32, length), offset)))) return false;
    }
    return true;
  } finally { await handle.close(); }
}

export async function inventoryMachO(root) {
  const files = [];
  async function walk(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(file);
      else if (entry.isFile() && await isNativeMachO(file)) files.push(file);
      // Symlink targets are inventoried at their real location, never followed.
    }
  }
  await walk(root);
  return files.sort((a, b) => b.split(path.sep).length - a.split(path.sep).length || a.localeCompare(b));
}

const dylibCommands = new Set(['LC_LOAD_DYLIB', 'LC_LOAD_WEAK_DYLIB', 'LC_REEXPORT_DYLIB', 'LC_LAZY_LOAD_DYLIB', 'LC_LOAD_UPWARD_DYLIB']);
export function parseDylibLoads(output) {
  let command;
  const names = new Set();
  for (const line of output.split('\n')) {
    const next = /^\s*cmd (LC_\w+)\s*$/.exec(line);
    if (next) command = next[1];
    const name = /^\s*name (.+) \(offset \d+\)\s*$/.exec(line);
    if (name && dylibCommands.has(command)) names.add(name[1]);
  }
  return [...names];
}

/** Remotion's bundled FFmpeg libraries use bare relative install names. The
 * hardened loader rejects those and ignores DYLD_LIBRARY_PATH. Resolve only
 * inventoried native payload files, then bind them relative to their loader. */
export async function relocateNativeDependencies(files, { run }) {
  const nativePaths = new Set(await Promise.all(files.map(file => fs.realpath(file))));
  const relocated = new Map();
  for (const file of files) {
    const loads = parseDylibLoads((await run('otool', ['-l', file], { maxBuffer: 8 * 1024 * 1024 })).stdout);
    const changes = [];
    for (const name of loads) {
      if (path.isAbsolute(name) || /^@(loader_path|executable_path|rpath)\//.test(name)) continue;
      const dependency = path.resolve(path.dirname(file), name);
      const real = await fs.realpath(dependency).catch(() => null);
      if (!real || !nativePaths.has(real)) throw new Error(`Native dependency is outside the signed payload or missing: ${file} -> ${name}`);
      const replacement = `@loader_path/${path.relative(path.dirname(file), dependency).split(path.sep).join('/')}`;
      changes.push({ from: name, to: replacement });
    }
    if (changes.length) await run('install_name_tool', [...changes.flatMap(change => ['-change', change.from, change.to]), file]);
    relocated.set(file, changes);
  }
  return relocated;
}

/** Run under the extracted interpreter, including native add-ons and the
 * actual compositor protocol. A signature that verifies can still fail dyld.
 * No helper gets DYLD variables or its library directory as the working dir. */
export async function probeNativePayload({ root, run }) {
  const script = `
    const assert = require('node:assert/strict');
    const path = require('node:path');
    const {spawnSync} = require('node:child_process');
    assert.match(require('esbuild').transformSync('const value: number = 1', {loader: 'ts'}).code, /value/);
    assert.ok(Object.keys(require('@rspack/binding')).length);
    const renderer = path.dirname(require.resolve('@remotion/renderer'));
    const {serializeCommand} = require(path.join(renderer, 'compositor/serialize-command.js'));
    const directory = path.dirname(require.resolve('@remotion/compositor-darwin-arm64/package.json'));
    const command = serializeCommand('StartLongRunningProcess', {concurrency: 1, maximum_frame_cache_size_in_bytes: 16777216, verbose: false});
    for (const [name, args, input] of [['ffmpeg', ['-version'], ''], ['ffprobe', ['-version'], ''], ['remotion', [JSON.stringify(command)], 'EOF\\n']]) {
      const result = spawnSync(path.join(directory, name), args, {cwd: process.cwd(), env: {}, input, encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024});
      assert.equal(result.status, 0, name + ' failed: ' + (result.error?.message || result.signal || '') + '\\n' + result.stderr);
    }
    console.log('Signed native payload startup passed (Node, esbuild, rspack, FFmpeg, FFprobe, compositor)');
  `;
  return run(path.join(root, 'runtime/node'), ['--eval', script], { cwd: path.join(root, 'package'), timeout: 60000, maxBuffer: 4 * 1024 * 1024 });
}

/** After all signing, inspect every architecture's actual CodeDirectory hash.
 * Never infer notarization coverage from a file name or a successful upload. */
export async function inspectSignedMachO(file, { run, relativePath = path.basename(file) }) {
  await run('codesign', ['--verify', '--strict', '--verbose=2', file]);
  const architectures = (await run('lipo', ['-archs', file])).stdout.trim().split(/\s+/).filter(Boolean);
  if (!architectures.length || architectures.some(arch => !/^[a-zA-Z0-9_]+$/.test(arch))) throw new Error(`Cannot determine Mach-O architectures: ${relativePath}`);
  const tickets = [];
  let teamIdentifier;
  for (const arch of architectures) {
    const result = await run('codesign', ['--display', '--verbose=4', '--arch', arch, file]);
    const display = `${result.stdout || ''}\n${result.stderr || ''}`;
    const cdhash = /^CDHash=([a-fA-F0-9]{40})\s*$/m.exec(display)?.[1]?.toLowerCase();
    const team = /^TeamIdentifier=([A-Z0-9]+)\s*$/m.exec(display)?.[1];
    if (!cdhash || !team || !/^Authority=Developer ID Application:/m.test(display) || !/^Timestamp=.+/m.test(display) || !/^CodeDirectory .*\bruntime\b/m.test(display)) {
      throw new Error(`Native code is missing a Developer ID signature, secure timestamp, hardened runtime or CDHash: ${relativePath} (${arch})`);
    }
    if (teamIdentifier && teamIdentifier !== team) throw new Error(`Native code has inconsistent signing teams: ${relativePath}`);
    teamIdentifier = team;
    tickets.push({ path: relativePath, arch, cdhash });
  }
  return { path: relativePath, teamIdentifier, tickets };
}

export async function signNativePayload({ root, identity, entitlements, run }) {
  if (!identity || identity === '-') throw new Error('Signing the native payload requires a Developer ID Application identity');
  const files = await inventoryMachO(root);
  if (!files.includes(path.join(root, 'runtime/node'))) throw new Error('The native payload is missing its Mach-O Node runtime');
  // The current package contains bare executables, dylibs and Node add-ons.
  // Fail closed if a future dependency introduces a native app/framework bundle:
  // signing its files alone would omit the bundle resource seal and entitlements.
  for (const file of files) {
    if (path.relative(root, file).split(path.sep).slice(0, -1).some(part => /\.(app|framework|xpc|bundle)$/i.test(part))) {
      throw new Error(`Native bundle requires an explicit signing policy: ${path.relative(root, file)}`);
    }
  }
  const relocated = await relocateNativeDependencies(files, { run });
  for (const file of files) {
    await run('codesign', ['--force', '--sign', identity, '--options', 'runtime', '--timestamp',
      ...(file === path.join(root, 'runtime/node') ? ['--entitlements', entitlements] : []), file]);
  }
  const nativeCode = [];
  for (const file of files) nativeCode.push({ ...await inspectSignedMachO(file, { run, relativePath: path.relative(root, file).split(path.sep).join('/') }), relocations: relocated.get(file) });
  const teams = new Set(nativeCode.map(item => item.teamIdentifier));
  if (teams.size !== 1) throw new Error('Payload native code was not signed by one Developer ID team');
  return nativeCode;
}
