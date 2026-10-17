import assert from 'node:assert/strict';
import test from 'node:test';
import { notarizeExecutable } from '../../scripts/binary-notarization.mjs';

function fixture(stdout) {
  const calls = [], removed = [];
  return {
    calls, removed,
    options: {
      executable: '/tmp/with spaces/timds-cli', profile: 'release-profile', keychain: '/tmp/signing.keychain-db',
      run: async (command, args) => { calls.push({ command, args }); return { stdout: command === 'xcrun' ? stdout : '' }; },
      remove: async file => { removed.push(file); },
    },
  };
}
test('only an Accepted notarization result authorizes a notarized artifact', async () => {
  const probe = fixture(JSON.stringify({ id: 'submission-123', status: 'Accepted' }));
  assert.deepEqual(await notarizeExecutable(probe.options), { status: 'Accepted', submissionId: 'submission-123' });
  assert.deepEqual(probe.calls[1], { command: 'xcrun', args: ['notarytool', 'submit', '/tmp/with spaces/timds-cli.zip', '--keychain-profile', 'release-profile', '--keychain', '/tmp/signing.keychain-db', '--wait', '--output-format', 'json'] });
  assert.deepEqual(probe.removed, ['/tmp/with spaces/timds-cli.zip']);
});
test('successful tool execution with rejected, incomplete or unreadable status prevents distribution', async () => {
  for (const output of [{ id: 'rejected-123', status: 'Invalid' }, { status: 'Rejected' }, { status: 'In Progress' }, {}, null, 'invalid JSON']) {
    const probe = fixture(typeof output === 'string' ? output : JSON.stringify(output));
    await assert.rejects(notarizeExecutable(probe.options), /notarization (?:was not accepted|did not return valid JSON)/);
    assert.deepEqual(probe.removed, ['/tmp/with spaces/timds-cli.zip']);
  }
});
test('notarytool transport failure is not acceptance and still cleans the upload archive', async () => {
  const probe = fixture('');
  probe.options.run = async command => { if (command === 'xcrun') throw new Error('Notary service unavailable'); };
  await assert.rejects(notarizeExecutable(probe.options), /Notary service unavailable/);
  assert.deepEqual(probe.removed, ['/tmp/with spaces/timds-cli.zip']);
});
