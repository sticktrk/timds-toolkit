import assert from 'node:assert/strict';
import test from 'node:test';
import { notarizeExecutable, notarizePayload, validateNotarizationLog } from '../../scripts/binary-notarization.mjs';

const archiveSha256 = 'a'.repeat(64);
const tickets = [{ path: 'runtime/node', arch: 'arm64', cdhash: 'b'.repeat(40) }, { path: 'package/helper', arch: 'x86_64', cdhash: 'c'.repeat(40) }];
function fixture() {
  const calls = [], removed = [], reports = [];
  const outputs = {
    submit: { id: 'submission-123', status: 'In Progress' },
    wait: { id: 'submission-123', status: 'Accepted' },
    log: { jobId: 'submission-123', status: 'Accepted', sha256: archiveSha256, ticketContents: tickets.map(ticket => ({ ...ticket, path: `upload.zip/payload/${ticket.path}` })), issues: null },
  };
  return {
    calls, removed, reports, outputs,
    options: {
      executable: '/tmp/with spaces/timds-cli', profile: 'release-profile', keychain: '/tmp/signing.keychain-db', tickets,
      run: async (command, args) => { calls.push({ command, args }); return { stdout: command === 'xcrun' ? (typeof outputs[args[1]] === 'string' ? outputs[args[1]] : JSON.stringify(outputs[args[1]])) : '' }; },
      hashFile: async () => archiveSha256,
      report: message => { reports.push(message); },
      remove: async file => { removed.push(file); },
    },
  };
}

test('Accepted completion must have the exact archive and every native CodeDirectory in its log', async () => {
  const probe = fixture();
  assert.deepEqual(await notarizeExecutable(probe.options), { status: 'Accepted', submissionId: 'submission-123', archiveSha256, ticketCount: 2, verifiedCodeCount: 2, issues: [] });
  assert.deepEqual(probe.calls[1], { command: 'xcrun', args: ['notarytool', 'submit', '/tmp/with spaces/timds-cli.zip', '--keychain-profile', 'release-profile', '--keychain', '/tmp/signing.keychain-db', '--output-format', 'json'] });
  assert.equal(probe.calls[2].args[1], 'wait');
  assert.equal(probe.calls[3].args[1], 'log');
  assert.match(probe.reports[0], /submission-123.*2 native code slices/);
  assert.deepEqual(probe.removed, ['/tmp/with spaces/timds-cli.zip']);
});

test('payload submission preserves the directory and reports non-secret ID before waiting', async () => {
  const probe = fixture();
  const original = probe.options.run;
  probe.options.run = async (command, args) => {
    if (args[1] === 'wait') assert.match(probe.reports[0], /submission-123/);
    return original(command, args);
  };
  await notarizePayload({ ...probe.options, root: '/tmp/payload', keychain: undefined });
  assert.deepEqual(probe.calls[0], { command: 'ditto', args: ['-c', '-k', '--keepParent', '/tmp/payload', '/tmp/payload.zip'] });
  assert.ok(probe.calls.slice(1).every(call => !call.args.includes('--keychain')));
});

test('successful tool execution with rejected, incomplete or unreadable status prevents distribution', async () => {
  for (const output of [{ id: 'submission-123', status: 'Invalid' }, { status: 'Rejected' }, { status: 'In Progress' }, { status: 'Accepted', id: 'different-job' }, {}, null, 'invalid JSON']) {
    const probe = fixture();
    probe.outputs.wait = output;
    await assert.rejects(notarizeExecutable(probe.options), /notarization (?:was not accepted|did not return valid JSON)/);
    assert.deepEqual(probe.removed, ['/tmp/with spaces/timds-cli.zip']);
  }
});

test('unverifiable submission ID, log identity, native coverage and errors fail closed', async () => {
  for (const mutate of [
    probe => { probe.outputs.submit = {}; },
    probe => { probe.outputs.log.jobId = 'different-job'; },
    probe => { probe.outputs.log.status = 'Invalid'; },
    probe => { probe.outputs.log.sha256 = 'd'.repeat(64); },
    probe => { probe.outputs.log.ticketContents.pop(); },
    probe => { probe.outputs.log.ticketContents = null; },
    probe => { probe.outputs.log.issues = [{ severity: 'error', message: 'Invalid code' }]; },
    probe => { probe.outputs.log = 'unreadable'; },
  ]) {
    const probe = fixture();
    mutate(probe);
    await assert.rejects(notarizeExecutable(probe.options), /notarization/);
    assert.deepEqual(probe.removed, ['/tmp/with spaces/timds-cli.zip']);
  }
});

test('accepted logs preserve and report warnings rather than silently discard them', async () => {
  const probe = fixture();
  probe.outputs.log.issues = [{ severity: 'warning', message: 'Review this issue before the next submission' }];
  const result = await notarizeExecutable(probe.options);
  assert.deepEqual(result.issues, probe.outputs.log.issues);
  assert.match(probe.reports[1], /warning: Review this issue/);
});

test('empty code inventory cannot authorize notarization and transport failure cleans the archive', async () => {
  const probe = fixture();
  await assert.rejects(notarizeExecutable({ ...probe.options, tickets: [] }), /inventory/);
  assert.equal(probe.calls.length, 0);
  probe.options.run = async command => { if (command === 'xcrun') throw new Error('Notary service unavailable'); };
  await assert.rejects(notarizeExecutable(probe.options), /Notary service unavailable/);
  assert.deepEqual(probe.removed, ['/tmp/with spaces/timds-cli.zip']);
});

test('code hashes remain authoritative when Apple returns different paths and case', () => {
  const probe = fixture();
  probe.outputs.log.ticketContents = tickets.map(ticket => ({ cdhash: ticket.cdhash.toUpperCase(), arch: 'informational', path: 'different-path' }));
  assert.equal(validateNotarizationLog(probe.outputs.log, { submissionId: 'submission-123', archiveSha256, tickets }).verifiedCodeCount, 2);
});
