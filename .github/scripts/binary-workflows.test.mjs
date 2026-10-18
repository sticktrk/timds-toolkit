import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { parse } from 'yaml';
import { Evaluator, Lexer, Parser, data } from '@actions/expressions';

const binary = parse(await fs.readFile(new URL('../workflows/binary.yml', import.meta.url), 'utf8'));
const release = parse(await fs.readFile(new URL('../workflows/release.yml', import.meta.url), 'utf8'));
const ci = parse(await fs.readFile(new URL('../workflows/ci.yml', import.meta.url), 'utf8'));
const names = ['TIMDS_MACOS_CERTIFICATE_BASE64', 'TIMDS_MACOS_CERTIFICATE_PASSWORD', 'TIMDS_CODESIGN_IDENTITY', 'TIMDS_NOTARY_APPLE_ID', 'TIMDS_NOTARY_TEAM_ID', 'TIMDS_NOTARY_PASSWORD'];

function expressionData(value) {
  if (value === null || value === undefined) return new data.Null();
  if (typeof value === 'boolean') return new data.BooleanData(value);
  if (typeof value === 'string') return new data.StringData(value);
  return new data.Dictionary(...Object.entries(value).map(([key, value]) => ({ key, value: expressionData(value) })));
}
function evaluate(source, context, cancelled = false) {
  const expression = source.trim().replace(/^\$\{\{\s*|\s*\}\}$/g, '');
  const functions = new Map([['cancelled', { name: 'cancelled', minArgs: 0, maxArgs: 0, call: () => new data.BooleanData(cancelled) }]]);
  const parsed = new Parser(new Lexer(expression).lex().tokens, Object.keys(context), [...functions.values()]).parse();
  return new Evaluator(parsed, expressionData(context), functions).evaluate().coerceString();
}

test('releases require all six signing settings before creating tags or building while PRs remain unsigned', () => {
  assert.equal(binary.on.workflow_call.inputs.require_apple_signing.type, 'boolean');
  assert.equal(binary.on.workflow_call.inputs.require_apple_signing.default, false);
  assert.equal(ci.jobs['native-binaries'].secrets, undefined);
  assert.equal(ci.jobs['native-binaries'].with?.require_apple_signing, undefined);
  assert.equal(release.jobs.binaries.with.require_apple_signing, true);
  assert.ok([release.jobs['create-release'].needs].flat().includes('signing-preflight'));
  assert.ok(release.jobs.binaries.needs.includes('signing-preflight'));
  const preflight = release.jobs['signing-preflight'];
  for (const [event, dryRun, expected] of [['release', false, 'true'], ['workflow_dispatch', false, 'true'], ['workflow_dispatch', true, 'false']]) {
    assert.equal(evaluate(preflight.if, { github: { event_name: event }, inputs: { dry_run: dryRun } }), expected);
  }
  for (const [event, result, expected] of [['release', 'failure', 'false'], ['release', 'success', 'true'], ['workflow_dispatch', 'failure', 'false'], ['workflow_dispatch', 'success', 'true']]) {
    assert.equal(evaluate(release.jobs.binaries.if, { github: { event_name: event }, needs: { 'create-release': { result: 'success' }, 'signing-preflight': { result } } }), expected);
  }
  const gate = preflight.steps[0];
  assert.deepEqual(Object.keys(gate.env), names);
  const steps = binary.jobs.binary.steps;
  const buildGate = steps.find(step => step.name === 'Require Apple signing configuration');
  assert.deepEqual(buildGate.env, gate.env);
  assert.equal(buildGate.run, gate.run);
  assert.ok(steps.indexOf(buildGate) < steps.findIndex(step => step.run === 'npm run binary:build'));
  assert.ok(steps.indexOf(buildGate) < steps.findIndex(step => step.name === 'Configure required macOS release signing'));
  const configured = Object.fromEntries(names.map(name => [name, 'test-value']));
  configured.TIMDS_NOTARY_TEAM_ID = 'TESTTEAM12';
  const runGate = values => spawnSync('bash', ['-c', gate.run], { env: { ...process.env, ...configured, ...values }, encoding: 'utf8' });
  assert.equal(runGate({}).status, 0);
  for (const name of names) {
    const result = runGate({ [name]: '' });
    assert.notEqual(result.status, 0, name);
    assert.ok(result.stdout.includes(name), result.stdout);
    assert.ok(!result.stdout.includes('test-value'), 'gate must never print credential values');
  }
  assert.notEqual(runGate({ TIMDS_CODESIGN_IDENTITY: '-' }).status, 0);
  assert.notEqual(runGate({ TIMDS_NOTARY_TEAM_ID: 'invalid' }).status, 0);
});

test('only required Apple builds get signing credentials and the longer notarization budget', () => {
  const steps = binary.jobs.binary.steps;
  const signing = steps.find(step => step.name === 'Configure required macOS release signing');
  const build = steps.find(step => step.run === 'npm run binary:build');
  for (const [os, target, required, enabled, timeout] of [['macOS', 'darwin-arm64', true, 'true', '120'], ['macOS', 'darwin-arm64', false, 'false', '35'], ['Linux', 'linux-x64', true, 'false', '35']]) {
    const context = { runner: { os }, matrix: { target }, inputs: { require_apple_signing: required } };
    assert.equal(evaluate(signing.if, context), enabled);
    assert.equal(evaluate(build.env.TIMDS_REQUIRE_APPLE_SIGNING, context), enabled);
    assert.equal(evaluate(binary.jobs.binary['timeout-minutes'], context), timeout);
  }
});

test('release gating includes a separate secret-free quarantined download and full native trust verification', () => {
  const job = binary.jobs['notarized-download'];
  assert.equal(job.needs, 'binary');
  assert.equal(job.if, 'inputs.require_apple_signing');
  assert.equal(job['runs-on'], 'macos-15');
  assert.doesNotMatch(JSON.stringify(job), /secrets\.|store-credentials|security import/);
  const checkout = job.steps.find(step => step.uses === 'actions/checkout@v6');
  assert.equal(checkout.with['persist-credentials'], false);
  const download = job.steps.find(step => step.uses === 'actions/download-artifact@v4');
  assert.equal(download.with.pattern, 'timds-native-*');
  const verification = job.steps.findIndex(step => step.name === 'Verify signed release metadata and download checksums');
  const smoke = job.steps.findIndex(step => step.name === 'Verify quarantined launcher and every extracted native file');
  assert.ok(verification >= 0 && verification < smoke);
  assert.match(job.steps[verification].run, /scripts\/binary-release\.mjs/);
  const script = job.steps[smoke].run;
  assert.match(script, /inventoryMachO\(runtime\)/);
  assert.match(script, /inspectSignedMachO/);
  assert.match(script, /assert\.deepEqual\(native\.map/);
  assert.match(script, /for \(const code of metadata\.nativeCode\) await verifyCode/);
  assert.ok(script.indexOf('await probeNativePayload') > script.indexOf('for (const code of metadata.nativeCode) await verifyCode'));
  assert.match(script, /'-R=notarized', '--check-notarization'/);
  assert.match(script, /attempt === 12/);
  assert.match(script, /'com\.apple\.quarantine'/);
  assert.doesNotMatch(script, /xattr[^\n]*['"]-(?:d|c)['"]/);
  assert.match(script, /PATH: tools/);
  assert.doesNotMatch(script, /spctl|--ignore-scripts|npm ci/);
  const javascript = script.slice(script.indexOf("<<'NODE'\n") + "<<'NODE'\n".length).replace(/\nNODE\s*$/, '');
  const syntax = spawnSync(process.execPath, ['--input-type=module', '--check'], { input: javascript, encoding: 'utf8' });
  assert.equal(syntax.status, 0, syntax.stderr);
  assert.ok(release.jobs.publish.needs.includes('binaries'));
  assert.ok(release.jobs['attach-binaries'].needs.includes('binaries'));
});
