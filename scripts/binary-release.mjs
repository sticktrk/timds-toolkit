import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
const packageJson = await fs.readFile(new URL('../package.json', import.meta.url));
const pkg = JSON.parse(packageJson);
const checksum = bytes => createHash('sha256').update(bytes).digest('hex');
const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: new URL('../', import.meta.url), encoding: 'utf8' }).trim();
const packageSha256 = checksum(packageJson);
const lockSha256 = checksum(await fs.readFile(new URL('../package-lock.json', import.meta.url)));
if (process.env.RELEASE_TAG !== `v${pkg.version}`) throw new Error('Binary release tag must exactly match package.json');
const output = new URL('../dist/binary/', import.meta.url);
const checksums = [];

function requireAppleNotarization(metadata, name) {
  const fail = detail => { throw new Error(`macOS release requires verified Developer ID notarization: ${name} (${detail})`); };
  if (metadata.signed !== 'developer-id' || metadata.notarized !== true || !/^[A-Z0-9]{10}$/.test(metadata.signingTeamId || '')) fail('signing identity');
  if (!Array.isArray(metadata.nativeCode) || !metadata.nativeCode.length || !metadata.nativeCode.some(code => code?.path === 'runtime/node')) fail('native payload inventory');
  const paths = new Set();
  function ticketsFor(code, expectedPath) {
    if (!code || typeof code.path !== 'string' || !code.path || code.path.includes('\\') || code.path.split('/').some(part => !part || part === '.' || part === '..') || paths.has(code.path)) fail('native code path');
    paths.add(code.path);
    if (expectedPath && code.path !== expectedPath || code.teamIdentifier !== metadata.signingTeamId || !Array.isArray(code.tickets) || !code.tickets.length) fail('native signature inventory');
    const architectures = new Set();
    for (const ticket of code.tickets) {
      if (!ticket || ticket.path !== code.path || !/^[a-zA-Z0-9_]+$/.test(ticket.arch || '') || architectures.has(ticket.arch) || !/^[a-f0-9]{40}$/.test(ticket.cdhash || '')) fail('native code ticket');
      architectures.add(ticket.arch);
    }
    if ((code.path === 'runtime/node' || expectedPath) && !architectures.has('arm64')) fail('native arm64 code');
    return code.tickets;
  }
  const payloadTickets = metadata.nativeCode.flatMap(code => ticketsFor(code));
  const launcherTickets = ticketsFor(metadata.launcherCode, name);
  function requireReport(report, tickets) {
    const uniqueHashes = new Set(tickets.map(ticket => ticket.cdhash));
    if (report?.status !== 'Accepted' || !/^[a-zA-Z0-9-]+$/.test(report.submissionId || '') || !/^[a-f0-9]{64}$/.test(report.archiveSha256 || '') || !Number.isInteger(report.ticketCount) || report.ticketCount < uniqueHashes.size || report.verifiedCodeCount !== tickets.length || !Array.isArray(report.issues) || report.issues.some(issue => issue?.severity === 'error')) fail('accepted ticket coverage');
  }
  requireReport(metadata.payloadNotarization, payloadTickets);
  requireReport(metadata.notarization, launcherTickets);
  if (metadata.notarizationSubmissionId !== metadata.notarization.submissionId || metadata.payloadNotarization.submissionId === metadata.notarization.submissionId) fail('separate payload and launcher submissions');
}

for (const target of ['darwin-arm64', 'linux-x64']) {
  const name = `timds-cli-v${pkg.version}-${target}`;
  const metadata = JSON.parse(await fs.readFile(new URL(`${name}.json`, output), 'utf8'));
  if (metadata.version !== pkg.version || metadata.target !== target || metadata.executable !== name) throw new Error(`Binary metadata does not match release: ${name}`);
  if (metadata.sourceDirty || metadata.sourceCommit !== sourceCommit || metadata.packageSha256 !== packageSha256 || metadata.lockSha256 !== lockSha256) throw new Error(`Binary did not come from this exact clean release commit: ${name}`);
  if (target === 'darwin-arm64') requireAppleNotarization(metadata, name);
  const binary = await fs.readFile(new URL(name, output));
  const sum = `${createHash('sha256').update(binary).digest('hex')}  ${name}\n`;
  if (sum !== await fs.readFile(new URL(`${name}.sha256`, output), 'utf8')) throw new Error(`Binary checksum mismatch: ${name}`);
  checksums.push(sum);
}
await fs.writeFile(new URL('SHA256SUMS', output), checksums.join(''));
console.log(`Verified ${checksums.length} native executables for v${pkg.version}`);
