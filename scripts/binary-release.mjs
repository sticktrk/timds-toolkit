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
for (const target of ['darwin-arm64', 'linux-x64']) {
  const name = `timds-cli-v${pkg.version}-${target}`;
  const metadata = JSON.parse(await fs.readFile(new URL(`${name}.json`, output), 'utf8'));
  if (metadata.version !== pkg.version || metadata.target !== target || metadata.executable !== name) throw new Error(`Binary metadata does not match release: ${name}`);
  if (metadata.sourceDirty || metadata.sourceCommit !== sourceCommit || metadata.packageSha256 !== packageSha256 || metadata.lockSha256 !== lockSha256) throw new Error(`Binary did not come from this exact clean release commit: ${name}`);
  const binary = await fs.readFile(new URL(name, output));
  const sum = `${createHash('sha256').update(binary).digest('hex')}  ${name}\n`;
  if (sum !== await fs.readFile(new URL(`${name}.sha256`, output), 'utf8')) throw new Error(`Binary checksum mismatch: ${name}`);
  checksums.push(sum);
}
await fs.writeFile(new URL('SHA256SUMS', output), checksums.join(''));
console.log(`Verified ${checksums.length} native executables for v${pkg.version}`);
