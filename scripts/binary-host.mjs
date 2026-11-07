#!/usr/bin/env node
// Serve released executables from the public download host: an R2 bucket
// behind BINARY_DOWNLOAD_BASE (src/binary-installation.mjs), where the stock
// workflows and the install docs download them. GitHub Releases stay the
// internal record; nothing a client runs depends on them. See
// docs/binary-hosting.md for the one-time setup.
//
//   node scripts/binary-host.mjs upload VERSION [--dir dist/binary] [--dry-run]
//     release.yml, after scripts/binary-release.mjs verified the directory.
//   node scripts/binary-host.mjs mirror (VERSION... | --all) [--dry-run]
//     One-off: copy releases already attached to GitHub Releases (needs gh).
//
// Every key is immutable: an existing object with the same bytes is skipped,
// one with different bytes fails the run. SHA256SUMS is written last so it
// never names a file that is not there yet, and every upload is read back
// from the public URL and compared before the run succeeds.
//
// Credentials: TIMDS_R2_ENDPOINT, TIMDS_R2_ACCESS_KEY_ID and
// TIMDS_R2_SECRET_ACCESS_KEY (falling back to the CLOUDFLARE_S3_API_ENDPOINT,
// CLOUDFLARE_ACCESS_KEY and CLOUDFLARE_SECRET_ACCESS_KEY names in a local
// .env); TIMDS_R2_BUCKET overrides the bucket name. Uses the aws CLI.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { binaryDownloadUrl } from '../src/binary-installation.mjs';

export const BINARY_TARGETS = Object.freeze(['darwin-arm64', 'linux-x64']);
export const DEFAULT_BUCKET = 'timds-downloads';
const IMMUTABLE = 'public, max-age=31536000, immutable';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

/** The seven files of one release, SHA256SUMS last. */
export function releaseFileNames(version) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`Not an exact release version: ${version}`);
  return [
    ...BINARY_TARGETS.flatMap(target => {
      const name = `timds-cli-v${version}-${target}`;
      return [name, `${name}.sha256`, `${name}.json`];
    }),
    'SHA256SUMS',
  ];
}

function contentType(name) {
  if (name.endsWith('.json')) return 'application/json';
  if (name.endsWith('.sha256') || name === 'SHA256SUMS') return 'text/plain; charset=utf-8';
  return 'application/octet-stream';
}

/**
 * Read one release from a directory and prove it is whole: every file present,
 * each executable matching its .sha256 and its SHA256SUMS line, and its build
 * record naming this version and target.
 */
export async function readRelease(directory, version) {
  const files = [];
  for (const name of releaseFileNames(version)) {
    const file = path.join(directory, name);
    const bytes = await fs.readFile(file).catch(error => {
      if (error.code === 'ENOENT') throw new Error(`Release ${version} is missing ${name} in ${directory}`);
      throw error;
    });
    files.push({ name, path: file, bytes, sha256: sha256(bytes), contentType: contentType(name) });
  }
  const byName = new Map(files.map(file => [file.name, file]));
  const sums = byName.get('SHA256SUMS').bytes.toString('utf8');
  for (const target of BINARY_TARGETS) {
    const name = `timds-cli-v${version}-${target}`;
    const line = `${byName.get(name).sha256}  ${name}\n`;
    if (byName.get(`${name}.sha256`).bytes.toString('utf8') !== line) throw new Error(`Checksum mismatch: ${name}.sha256`);
    if (!sums.split('\n').includes(line.trimEnd())) throw new Error(`Checksum mismatch: ${name} in SHA256SUMS`);
    const metadata = JSON.parse(byName.get(`${name}.json`).bytes.toString('utf8'));
    if (metadata.version !== version || metadata.target !== target || metadata.executable !== name) throw new Error(`Build record does not match the release: ${name}.json`);
  }
  return files;
}

function hostConfig(env = process.env) {
  const endpoint = env.TIMDS_R2_ENDPOINT || env.CLOUDFLARE_S3_API_ENDPOINT;
  const accessKey = env.TIMDS_R2_ACCESS_KEY_ID || env.CLOUDFLARE_ACCESS_KEY;
  const secretKey = env.TIMDS_R2_SECRET_ACCESS_KEY || env.CLOUDFLARE_SECRET_ACCESS_KEY;
  if (!endpoint || !accessKey || !secretKey) throw new Error('Set TIMDS_R2_ENDPOINT, TIMDS_R2_ACCESS_KEY_ID and TIMDS_R2_SECRET_ACCESS_KEY (see docs/binary-hosting.md).');
  return {
    bucket: env.TIMDS_R2_BUCKET || DEFAULT_BUCKET,
    endpoint,
    env: {
      ...env,
      AWS_ACCESS_KEY_ID: accessKey,
      AWS_SECRET_ACCESS_KEY: secretKey,
      AWS_DEFAULT_REGION: 'auto',
      // R2 rejects the newer default request checksums some aws CLI releases send.
      AWS_REQUEST_CHECKSUM_CALCULATION: 'when_required',
      AWS_RESPONSE_CHECKSUM_VALIDATION: 'when_required',
    },
  };
}

function aws(host, args) {
  return spawnSync('aws', ['s3api', ...args, '--bucket', host.bucket, '--endpoint-url', host.endpoint], { env: host.env, encoding: 'utf8' });
}

/** The bytes already stored under a key, or null when there is none. */
async function storedBytes(host, key) {
  const head = aws(host, ['head-object', '--key', key]);
  if (head.status !== 0) {
    if (/\b(404|Not Found|NoSuchKey)\b/.test(head.stderr)) return null;
    throw new Error(`Could not read ${key} from ${host.bucket}: ${head.stderr.trim()}`);
  }
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'timds-host-'));
  try {
    const target = path.join(scratch, 'object');
    const get = aws(host, ['get-object', '--key', key, target]);
    if (get.status !== 0) throw new Error(`Could not read ${key} from ${host.bucket}: ${get.stderr.trim()}`);
    return await fs.readFile(target);
  } finally {
    await fs.rm(scratch, { recursive: true, force: true });
  }
}

async function readPublic(url, expected, attempts = 5) {
  let last = '';
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const response = await fetch(url, { cache: 'no-store' }).catch(error => ({ ok: false, status: error.message }));
    if (response.ok) {
      const actual = sha256(Buffer.from(await response.arrayBuffer()));
      if (actual === expected) return;
      last = `sha256 ${actual}`;
    } else last = `HTTP ${response.status}`;
    await new Promise(resolve => setTimeout(resolve, attempt * 2000));
  }
  throw new Error(`${url} does not serve the uploaded bytes (${last})`);
}

/** Upload one verified release; returns what was written and what was already there. */
export async function uploadRelease(directory, version, { dryRun = false, log = console.log } = {}) {
  const files = await readRelease(directory, version);
  if (dryRun) {
    for (const file of files) log(`would upload ${binaryDownloadUrl(version, file.name)} (${file.bytes.length} bytes, ${file.contentType})`);
    return { written: [], current: [], planned: files.map(file => file.name) };
  }
  const host = hostConfig();
  const written = [];
  const current = [];
  for (const file of files) {
    const key = `timds-cli/v${version}/${file.name}`;
    const stored = await storedBytes(host, key);
    if (stored) {
      if (sha256(stored) !== file.sha256) throw new Error(`${key} already holds different bytes; released files are never replaced.`);
      current.push(file.name);
      continue;
    }
    const put = aws(host, ['put-object', '--key', key, '--body', file.path, '--content-type', file.contentType, '--cache-control', IMMUTABLE]);
    if (put.status !== 0) throw new Error(`Could not upload ${key}: ${put.stderr.trim()}`);
    written.push(file.name);
    log(`uploaded ${key}`);
  }
  for (const file of files) await readPublic(binaryDownloadUrl(version, file.name), file.sha256);
  log(`v${version}: ${written.length} uploaded, ${current.length} already current; all ${files.length} verified at ${binaryDownloadUrl(version)}/`);
  return { written, current, planned: [] };
}

function sourceRepository() {
  const pkg = JSON.parse(execFileSync('git', ['show', 'HEAD:package.json'], { cwd: fileURLToPath(new URL('../', import.meta.url)), encoding: 'utf8' }));
  const match = String(pkg.repository?.url || '').match(/github\.com[/:]([^/]+\/[^/.]+)/);
  if (!match) throw new Error('package.json repository.url does not name a GitHub repository');
  return match[1];
}

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
}

/** Every release tag that has executables attached, oldest first. */
function releasesWithExecutables(repository) {
  const tags = gh(['api', `repos/${repository}/releases`, '--paginate', '--jq', '.[] | select(any(.assets[]; .name | startswith("timds-cli-"))) | .tag_name']);
  return tags.split('\n').filter(Boolean).map(tag => tag.replace(/^v/, '')).reverse();
}

export async function mirrorReleases(versions, { all = false, dryRun = false, log = console.log } = {}) {
  const repository = sourceRepository();
  const selected = all ? releasesWithExecutables(repository) : versions;
  if (!selected.length) throw new Error('Name the versions to mirror, or pass --all.');
  for (const version of selected) {
    const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'timds-mirror-'));
    try {
      gh(['release', 'download', `v${version}`, '--repo', repository, '--dir', scratch, '--pattern', 'timds-cli-*', '--pattern', 'SHA256SUMS']);
      await uploadRelease(scratch, version, { dryRun, log });
    } finally {
      await fs.rm(scratch, { recursive: true, force: true });
    }
  }
  log(`${dryRun ? 'Checked' : 'Mirrored'} ${selected.length} release(s).`);
}

async function main(argv) {
  const [mode, ...rest] = argv;
  const dryRun = rest.includes('--dry-run');
  const dirIndex = rest.indexOf('--dir');
  const directory = dirIndex === -1 ? 'dist/binary' : rest[dirIndex + 1];
  const positional = rest.filter((arg, index) => !arg.startsWith('--') && (dirIndex === -1 || index !== dirIndex + 1));
  if (mode === 'upload' && positional.length === 1) return uploadRelease(directory, positional[0].replace(/^v/, ''), { dryRun });
  if (mode === 'mirror') return mirrorReleases(positional.map(version => version.replace(/^v/, '')), { all: rest.includes('--all'), dryRun });
  throw new Error('Usage: binary-host.mjs upload VERSION [--dir DIR] [--dry-run] | mirror (VERSION... | --all) [--dry-run]');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => {
    console.error(`binary-host: ${error.message}`);
    process.exit(1);
  });
}
