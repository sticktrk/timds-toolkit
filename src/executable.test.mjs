import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { cliCommand, isBinaryRuntime, javascriptCommand, packageIdentity, packageRoot, runtimeEnvironment } from './executable.mjs';

test('npm runtime keeps CLI re-entry separate from JavaScript execution', () => {
  assert.equal(isBinaryRuntime(), false);
  assert.deepEqual(cliCommand(['check']), [process.execPath, path.join(packageRoot, 'bin/timds.mjs'), 'check']);
  assert.deepEqual(javascriptCommand(['worker.mjs']), [process.execPath, 'worker.mjs']);
  assert.equal(packageIdentity().name, '@dtconcepts/timds');
});
test('packaged runtime passes only runtime locations into sanitized child environments', () => {
  const keys = ['TIMDS_BINARY_EXECUTABLE', 'TIMDS_RUNTIME_ROOT', 'TIMDS_RUNTIME_PACKAGE', 'TIMDS_ACCESS_TOKEN'];
  const before = keys.map(key => process.env[key]);
  try {
    Object.assign(process.env, { TIMDS_BINARY_EXECUTABLE: '/tmp/with spaces/timds-cli', TIMDS_RUNTIME_ROOT: '/tmp/runtime', TIMDS_RUNTIME_PACKAGE: packageRoot, TIMDS_ACCESS_TOKEN: 'must-not-leak' });
    assert.equal(isBinaryRuntime(), true);
    assert.deepEqual(cliCommand(['check', '--root', '/tmp/with spaces']), ['/tmp/with spaces/timds-cli', 'check', '--root', '/tmp/with spaces']);
    assert.equal(javascriptCommand(['worker.mjs'])[1], '--import');
    const safe = runtimeEnvironment({ PATH: '/safe', CUSTOM: 'preserved' });
    assert.equal(safe.TIMDS_ACCESS_TOKEN, undefined);
    assert.equal(safe.TIMDS_BINARY_CACHE, '/tmp');
    assert.equal(safe.CUSTOM, 'preserved');
    assert.equal(safe.TIMDS_BINARY_EXECUTABLE, '/tmp/with spaces/timds-cli');
  } finally { keys.forEach((key, index) => before[index] === undefined ? delete process.env[key] : process.env[key] = before[index]); }
});
