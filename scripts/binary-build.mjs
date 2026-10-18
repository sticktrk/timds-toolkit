import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { notarizeExecutable } from './binary-notarization.mjs';

const run = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
export const nodeVersion = '24.22.0';
const distributions = {
  'darwin-arm64': '6a9724d9b50a5f22b4816cded441b5a8d9ddae546191a5e5b7efa5a5e2ee26d5',
  'linux-x64': '28ea0a438de9a13bd7891fd758eee6c7819ee8af5442dfd8d45bd65e56d4228c',
};
const sha256 = value => createHash('sha256').update(value).digest('hex');
const target = `${process.platform}-${process.arch}`;
if (!distributions[target]) throw new Error(`Unsupported native binary target ${target}; supported: ${Object.keys(distributions).join(', ')}`);
const packageJson = await fs.readFile(path.join(root, 'package.json'));
const pkg = JSON.parse(packageJson);
const sourceCommit = (await run('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim();
const sourceDirty = Boolean((await run('git', ['status', '--porcelain'], { cwd: root })).stdout.trim());
const packageSha256 = sha256(packageJson);
const lockSha256 = sha256(await fs.readFile(path.join(root, 'package-lock.json')));
const args = process.argv.slice(2);
const out = path.resolve(args.includes('--out') ? args[args.indexOf('--out') + 1] : path.join(root, 'dist/binary'));
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'timds-binary-build-'));
const downloadCache = path.join(os.homedir(), '.cache/timds-build');
await fs.mkdir(downloadCache, { recursive: true });
await fs.mkdir(out, { recursive: true });
try {
  const archiveName = `node-v${nodeVersion}-${target}.tar.gz`;
  const archive = path.join(downloadCache, archiveName);
  let bytes = await fs.readFile(archive).catch(() => null);
  if (!bytes || sha256(bytes) !== distributions[target]) {
    const response = await fetch(`https://nodejs.org/dist/v${nodeVersion}/${archiveName}`);
    if (!response.ok) throw new Error(`Node runtime download failed: ${response.status}`);
    bytes = Buffer.from(await response.arrayBuffer());
    if (sha256(bytes) !== distributions[target]) throw new Error('Node distribution checksum mismatch');
    await fs.writeFile(archive, bytes);
  }
  await run('tar', ['-xzf', archive, '-C', scratch]);
  const nodeRoot = path.join(scratch, `node-v${nodeVersion}-${target}`);
  const node = path.join(nodeRoot, 'bin/node');
  const npm = path.join(nodeRoot, 'lib/node_modules/npm/bin/npm-cli.js');
  const payloadRoot = path.join(scratch, 'payload');
  await fs.mkdir(payloadRoot);
  const packed = JSON.parse((await run(node, [npm, 'pack', '--json', '--pack-destination', scratch], { cwd: root, maxBuffer: 16 * 1024 * 1024 })).stdout)[0];
  await run('tar', ['-xzf', path.join(scratch, packed.filename), '-C', payloadRoot]);
  const packageRoot = path.join(payloadRoot, 'package');
  await fs.copyFile(path.join(root, 'package-lock.json'), path.join(packageRoot, 'package-lock.json'));
  console.log(`Installing exact production dependency graph for ${target}…`);
  await run(node, [npm, 'ci', '--omit=dev', '--no-audit', '--no-fund'], { cwd: packageRoot, env: { ...process.env, PATH: `${path.dirname(node)}${path.delimiter}${process.env.PATH}` }, maxBuffer: 16 * 1024 * 1024 });
  await fs.mkdir(path.join(payloadRoot, 'runtime'));
  await fs.copyFile(node, path.join(payloadRoot, 'runtime/node'));
  await fs.chmod(path.join(payloadRoot, 'runtime/node'), 0o755);
  await fs.copyFile(path.join(nodeRoot, 'LICENSE'), path.join(payloadRoot, 'runtime/LICENSE'));
  // Do not ship the build lock's development graph; installed third-party
  // licenses/notices remain beside their packages, and npm itself is absent.
  await fs.rm(path.join(packageRoot, 'package-lock.json'));
  const payloadVersion = (await run(node, [path.join(packageRoot, 'bin/timds.mjs'), '--version'])).stdout.trim();
  if (payloadVersion !== pkg.version) throw new Error('Packed CLI identity does not match package.json');
  const files = [];
  const buffers = [];
  let offset = 0;
  async function inventory(directory, prefix = '') {
    for (const name of (await fs.readdir(directory)).sort()) {
      const relative = prefix ? `${prefix}/${name}` : name;
      const absolute = path.join(directory, name);
      const stat = await fs.lstat(absolute);
      if (stat.isDirectory()) await inventory(absolute, relative);
      else if (stat.isSymbolicLink()) {
        const link = await fs.readlink(absolute);
        if (!path.resolve(path.dirname(absolute), link).startsWith(`${payloadRoot}${path.sep}`)) throw new Error(`External payload symlink: ${relative}`);
        files.push({ path: relative, link });
      } else if (stat.isFile()) {
        const contents = await fs.readFile(absolute);
        files.push({ path: relative, offset, size: contents.length, mode: (stat.mode & 0o111) ? 0o755 : 0o644, sha256: sha256(contents) });
        buffers.push(contents);
        offset += contents.length;
      } else throw new Error(`Unsupported payload entry: ${relative}`);
    }
  }
  await inventory(payloadRoot);
  const compressed = gzipSync(Buffer.concat(buffers), { level: 9 });
  const manifest = { files, payloadHash: sha256(compressed) };
  const metadata = { schema: 1, version: pkg.version, platform: process.platform, arch: process.arch, node: nodeVersion, manifest };
  const payloadFile = path.join(scratch, 'payload.gz');
  const metadataFile = path.join(scratch, 'metadata.json');
  await fs.writeFile(payloadFile, compressed);
  await fs.writeFile(metadataFile, JSON.stringify(metadata));
  const seaConfig = path.join(scratch, 'sea.json');
  const blob = path.join(scratch, 'sea.blob');
  await fs.writeFile(seaConfig, JSON.stringify({ main: path.join(root, 'scripts/binary-launcher.cjs'), output: blob, disableExperimentalSEAWarning: true, useCodeCache: false, useSnapshot: false, execArgvExtension: 'none', assets: { payload: payloadFile, metadata: metadataFile } }));
  await run(node, ['--experimental-sea-config', seaConfig]);
  const filename = `timds-cli-v${pkg.version}-${target}`;
  const executable = path.join(out, filename);
  await fs.copyFile(node, executable);
  await fs.chmod(executable, 0o755);
  if (process.platform === 'darwin') await run('codesign', ['--remove-signature', executable]);
  const postject = path.join(root, 'node_modules/postject/dist/cli.js');
  if (JSON.parse(await fs.readFile(path.join(root, 'node_modules/postject/package.json'), 'utf8')).version !== '1.0.0-alpha.6') throw new Error('Unexpected postject build tool version');
  await run(node, [postject, executable, 'NODE_SEA_BLOB', blob, '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2', ...(process.platform === 'darwin' ? ['--macho-segment-name', 'NODE_SEA'] : [])], { maxBuffer: 16 * 1024 * 1024 });
  if (process.platform === 'darwin') await run('codesign', ['--force', '--sign', process.env.TIMDS_CODESIGN_IDENTITY || '-', ...(process.env.TIMDS_CODESIGN_IDENTITY ? ['--options', 'runtime', '--timestamp', '--entitlements', path.join(root, 'scripts/binary-entitlements.plist')] : []), executable]);
  let notarization = null;
  if (process.platform === 'darwin' && process.env.TIMDS_NOTARY_PROFILE) {
    if (!process.env.TIMDS_CODESIGN_IDENTITY) throw new Error('Notarization requires TIMDS_CODESIGN_IDENTITY');
    notarization = await notarizeExecutable({ executable, profile: process.env.TIMDS_NOTARY_PROFILE, keychain: process.env.TIMDS_NOTARY_KEYCHAIN, run });
  }
  const executableBytes = await fs.readFile(executable);
  await fs.writeFile(`${executable}.sha256`, `${sha256(executableBytes)}  ${filename}\n`);
  const report = { schema: 1, sourceCommit, sourceDirty, packageSha256, lockSha256, version: pkg.version, node: nodeVersion, postject: '1.0.0-alpha.6', target, executable: filename, executableBytes: executableBytes.length, payloadBytes: compressed.length, extractedBytes: offset, fileCount: files.length, payloadHash: manifest.payloadHash, signed: process.platform === 'darwin' ? (process.env.TIMDS_CODESIGN_IDENTITY ? 'developer-id' : 'ad-hoc') : 'unsigned', notarized: notarization?.status === 'Accepted', notarizationSubmissionId: notarization?.submissionId || null };
  await fs.writeFile(`${executable}.json`, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
} finally { await fs.rm(scratch, { recursive: true, force: true }); }
