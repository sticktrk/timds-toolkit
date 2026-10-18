import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { appleSigningConfiguration, inventoryMachO, isNativeMachO, inspectSignedMachO, parseDylibLoads, relocateNativeDependencies, signNativePayload } from '../../scripts/binary-signing.mjs';

test('required Apple signing fails before building when identity or notary profile is absent', () => {
  const required = { TIMDS_REQUIRE_APPLE_SIGNING: 'true' };
  for (const env of [required, { ...required, TIMDS_CODESIGN_IDENTITY: '-' }, { ...required, TIMDS_CODESIGN_IDENTITY: 'Developer ID Application: Test' }, { ...required, TIMDS_NOTARY_PROFILE: 'release' }, { ...required, TIMDS_CODESIGN_IDENTITY: ' ', TIMDS_NOTARY_PROFILE: 'release' }]) {
    assert.throws(() => appleSigningConfiguration({ platform: 'darwin', env }), /TIMDS_REQUIRE_APPLE_SIGNING=true requires/);
  }
  const configured = { ...required, TIMDS_CODESIGN_IDENTITY: 'A'.repeat(40), TIMDS_NOTARY_PROFILE: 'release' };
  assert.deepEqual(appleSigningConfiguration({ platform: 'darwin', env: configured }), { identity: 'A'.repeat(40), profile: 'release' });
  assert.deepEqual(appleSigningConfiguration({ platform: 'linux', env: required }), { identity: null, profile: null });
  assert.deepEqual(appleSigningConfiguration({ platform: 'darwin', env: {} }), { identity: null, profile: null });
  assert.deepEqual(appleSigningConfiguration({ platform: 'darwin', env: { TIMDS_REQUIRE_APPLE_SIGNING: 'false', TIMDS_CODESIGN_IDENTITY: '-' } }), { identity: null, profile: null });
  assert.throws(() => appleSigningConfiguration({ platform: 'darwin', env: { TIMDS_NOTARY_PROFILE: 'release' } }), /Notarization requires/);
});

function thin({ littleEndian = true, bits = 64, type = 2 } = {}) {
  const buffer = Buffer.alloc(bits === 64 ? 32 : 28);
  const put = (offset, value) => littleEndian ? buffer.writeUInt32LE(value, offset) : buffer.writeUInt32BE(value, offset);
  put(0, bits === 64 ? 0xfeedfacf : 0xfeedface);
  put(4, 0x0100000c);
  put(12, type);
  return buffer;
}
function universal({ littleEndian = false, bits = 32 } = {}) {
  const entrySize = bits === 64 ? 32 : 20;
  const offset = 8 + 2 * entrySize;
  const buffer = Buffer.alloc(offset + 64);
  const put = (offset, value) => littleEndian ? buffer.writeUInt32LE(value, offset) : buffer.writeUInt32BE(value, offset);
  put(0, bits === 64 ? 0xcafebabf : 0xcafebabe);
  put(4, 2);
  for (let index = 0; index < 2; index++) {
    const entry = 8 + index * entrySize;
    if (bits === 64) {
      const put64 = (offset, value) => littleEndian ? buffer.writeBigUInt64LE(BigInt(value), offset) : buffer.writeBigUInt64BE(BigInt(value), offset);
      put64(entry + 8, offset + index * 32);
      put64(entry + 16, 32);
    } else {
      put(entry + 8, offset + index * 32);
      put(entry + 12, 32);
    }
    thin().copy(buffer, offset + index * 32);
  }
  return buffer;
}
async function temporary(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'timds-signing-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test('native inventory discovers actual thin and universal code regardless of extension or mode', async t => {
  const root = await temporary(t);
  const expected = [];
  for (const bits of [32, 64]) for (const littleEndian of [false, true]) {
    for (const type of [2, 6, 8]) {
      const file = path.join(root, `thin-${bits}-${littleEndian}-${type}.data`);
      await fs.writeFile(file, thin({ bits, littleEndian, type }), { mode: 0o644 });
      expected.push(file);
    }
    const file = path.join(root, `fat-${bits}-${littleEndian}`);
    await fs.writeFile(file, universal({ bits, littleEndian }));
    expected.push(file);
  }
  await fs.writeFile(path.join(root, 'not-native.node'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  await fs.writeFile(path.join(root, 'object.o'), thin({ type: 1 }));
  await fs.writeFile(path.join(root, 'java.class'), Buffer.from('cafebabe0000003d0001000100000000', 'hex'));
  await fs.symlink(root, path.join(root, 'cycle'));
  await fs.symlink(expected[0], path.join(root, 'helper-link'));
  assert.deepEqual((await inventoryMachO(root)).sort(), expected.sort());
});

test('universal candidates require valid, bounded native slices', async t => {
  const root = await temporary(t);
  const file = path.join(root, 'candidate');
  for (const invalid of [Buffer.alloc(0), Buffer.from('cffaedfe', 'hex'), Buffer.from('cafebabe00000001', 'hex')]) {
    await fs.writeFile(file, invalid);
    assert.equal(await isNativeMachO(file), false);
  }
  const broken = universal();
  broken.writeUInt32BE(0xffffffff, 16);
  await fs.writeFile(file, broken);
  assert.equal(await isNativeMachO(file), false);
});

test('load-command parsing excludes dylib IDs and deduplicates universal slices', () => {
  const output = `Load command 0
          cmd LC_ID_DYLIB
         name libavcodec.dylib (offset 24)
Load command 1
          cmd LC_LOAD_DYLIB
         name libavutil.dylib (offset 24)
Load command 2
          cmd LC_LOAD_WEAK_DYLIB
         name /usr/lib/libSystem.B.dylib (offset 24)
Load command 3
          cmd LC_RPATH
         path /path/ignored (offset 12)
Load command 4
          cmd LC_LOAD_DYLIB
         name libavutil.dylib (offset 24)
Load command 5
          cmd LC_REEXPORT_DYLIB
         name @rpath/Framework.dylib (offset 24)`;
  assert.deepEqual(parseDylibLoads(output), ['libavutil.dylib', '/usr/lib/libSystem.B.dylib', '@rpath/Framework.dylib']);
});

test('relative native libraries are bound to their packaged loader before signing', async t => {
  const root = await temporary(t);
  const executable = path.join(root, 'ffmpeg');
  const library = path.join(root, 'libavutil.dylib');
  for (const file of [executable, library]) await fs.writeFile(file, thin());
  const calls = [];
  const load = name => `  cmd LC_LOAD_DYLIB\n name ${name} (offset 24)\n`;
  const run = async (command, args) => {
    calls.push({ command, args });
    return { stdout: command === 'otool' && args.at(-1) === executable ? load('libavutil.dylib') + load('/usr/lib/libSystem.B.dylib') + load('@loader_path/already-fixed.dylib') : '' };
  };
  const changes = await relocateNativeDependencies([executable, library], { run });
  assert.deepEqual(changes.get(executable), [{ from: 'libavutil.dylib', to: '@loader_path/libavutil.dylib' }]);
  assert.deepEqual(calls.find(call => call.command === 'install_name_tool'), { command: 'install_name_tool', args: ['-change', 'libavutil.dylib', '@loader_path/libavutil.dylib', executable] });
  assert.equal(calls.filter(call => call.command === 'install_name_tool').length, 1);
});

test('relative native references cannot escape the signed inventory through files or symlinks', async t => {
  const root = await temporary(t);
  const executable = path.join(root, 'helper');
  const external = path.join(root, 'unsigned-library');
  await fs.writeFile(executable, thin());
  await fs.writeFile(external, thin());
  await fs.symlink(external, path.join(root, 'alias.dylib'));
  for (const name of ['missing.dylib', 'unsigned-library', 'alias.dylib']) {
    const commands = [];
    await assert.rejects(relocateNativeDependencies([executable], { run: async (command, args) => {
      commands.push(command);
      return { stdout: `cmd LC_LOAD_DYLIB\nname ${name} (offset 24)` };
    } }), /outside the signed payload or missing/);
    assert.deepEqual(commands, ['otool']);
  }
});

const display = (arch, team = 'X4K998YQ4V') => `CodeDirectory v=20500 flags=0x10000(runtime)\nAuthority=Developer ID Application: Test (${team})\nTimestamp=Oct 18, 2026\nTeamIdentifier=${team}\nCDHash=${(arch === 'arm64' ? 'a' : 'b').repeat(40)}\n`;
test('signature inspection collects every architecture and rejects ad-hoc, untimestamped and unhardened code', async () => {
  const run = async (command, args) => command === 'lipo' ? { stdout: 'arm64 x86_64\n' } : { stdout: '', stderr: args.includes('--display') ? display(args[3]) : '' };
  const code = await inspectSignedMachO('/tmp/helper', { run, relativePath: 'package/helper' });
  assert.equal(code.teamIdentifier, 'X4K998YQ4V');
  assert.equal(code.tickets.length, 2);
  assert.equal(code.tickets[1].cdhash, 'b'.repeat(40));
  for (const missing of [/Authority=.*\n/, /Timestamp=.*\n/, /CodeDirectory .*\n/, /CDHash=.*\n/]) {
    await assert.rejects(inspectSignedMachO('/tmp/helper', { run: async (command, args) => {
      const result = await run(command, args);
      return { ...result, stderr: result.stderr?.replace(missing, '') };
    } }), /missing a Developer ID signature/);
  }
});

test('payload signs nested native code before parent code, applies Node entitlements only, and verifies one team', async t => {
  const root = await temporary(t);
  const node = path.join(root, 'runtime/node');
  const addon = path.join(root, 'package/node_modules/pkg/addon.node');
  for (const file of [node, addon]) { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, thin()); }
  const calls = [];
  const run = async (command, args) => {
    calls.push({ command, args });
    return command === 'lipo' ? { stdout: 'arm64\n' } : { stdout: '', stderr: args.includes('--display') ? display('arm64') : '' };
  };
  const nativeCode = await signNativePayload({ root, identity: 'Developer ID Application: Test', entitlements: '/entitlements.plist', run });
  const signing = calls.filter(call => call.args.includes('--sign'));
  assert.deepEqual(signing.map(call => call.args.at(-1)), [addon, node]);
  assert.ok(!signing[0].args.includes('--entitlements'));
  assert.ok(signing[1].args.includes('--entitlements'));
  assert.equal(nativeCode.length, 2);
  await assert.rejects(signNativePayload({ root, identity: '-', run }), /requires a Developer ID/);
  await assert.rejects(signNativePayload({ root, identity: 'Test', entitlements: '/entitlements.plist', run: async (command, args) => {
    const result = await run(command, args);
    if (args.includes('--display') && args.at(-1) === addon) result.stderr = display('arm64', 'OTHERTEAM');
    return result;
  } }), /one Developer ID team/);
});

test('new native bundles require an explicit resource-seal and entitlement policy', async t => {
  const root = await temporary(t);
  for (const file of ['runtime/node', 'package/Helper.app/Contents/MacOS/Helper']) {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.writeFile(path.join(root, file), thin());
  }
  let ran = false;
  await assert.rejects(signNativePayload({ root, identity: 'Test', run: async () => { ran = true; } }), /Native bundle requires an explicit signing policy/);
  assert.equal(ran, false);
});
