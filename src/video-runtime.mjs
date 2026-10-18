// Package-owned execution for Remotion and its browser. Client components stay
// beside their authored relative imports; runtime dependencies stay in the cache.
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { isBinaryRuntime, javascriptCommand, packageIdentity, packageRoot, runtimeEnvironment } from './executable.mjs';

const require = createRequire(import.meta.url);
const worker = fileURLToPath(import.meta.url);
const remotionRequire = () => createRequire(require.resolve('@remotion/cli/package.json'));

export function remotionCommand(args) {
  const entry = isBinaryRuntime() ? worker : path.join(path.dirname(require.resolve('@remotion/cli/package.json')), 'remotion-cli.js');
  return javascriptCommand([entry, ...(isBinaryRuntime() ? ['remotion'] : []), ...args]);
}

export function packagedWebpackOverride(config) {
  const modules = path.join(packageRoot, 'node_modules');
  return {
    ...config,
    // Remotion's default webpack cache lives in the client node_modules tree.
    cache: false,
    resolve: {
      ...config.resolve,
      modules: [modules, ...(config.resolve?.modules || ['node_modules'])],
      alias: {
        ...config.resolve?.alias,
        ...Object.fromEntries(Object.entries(packageIdentity().exports).map(([key, value]) => [`@dtconcepts/timds${key === '.' ? '' : key.slice(1)}$`, path.join(packageRoot, value)])),
        // One copy of React and Remotion is required even with client tooling.
        react: path.dirname(require.resolve('react/package.json')),
        'react-dom': path.dirname(require.resolve('react-dom/package.json')),
      },
    },
  };
}

export async function packagedBrowserExecutable({ allowDownload = true } = {}) {
  const version = remotionRequire()('@remotion/renderer/package.json').version;
  const base = process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Caches') : process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
  const cache = path.join(process.env.TIMDS_BROWSER_CACHE || path.join(base, 'timds', 'browsers'), version);
  await fs.mkdir(cache, { recursive: true });
  // Remotion discovers its download directory by walking up to package.json.
  // A separate cache root keeps mutable browser downloads out of the verified
  // runtime payload and, crucially, out of the client's source tree.
  await fs.writeFile(path.join(cache, 'package.json'), '{"private":true}\n');
  const [command, ...args] = javascriptCommand([worker, 'browser', allowDownload ? 'download' : 'installed']);
  const { default: lockfile } = await import('proper-lockfile');
  const release = await lockfile.lock(path.join(cache, 'browser-cache'), { realpath: false, stale: 60_000, update: 15_000, retries: { retries: 60, minTimeout: 500, maxTimeout: 2000 } });
  try {
    const { stdout } = await promisify(execFile)(command, args, { cwd: cache, env: runtimeEnvironment(), maxBuffer: 1024 * 1024 });
    return JSON.parse(stdout).path;
  } catch (error) {
    throw new Error(`Headless Chrome is unavailable. Allow its first-use download or set TIMDS_BROWSER_EXECUTABLE to an installed Chrome executable. ${error.stderr || error.message}`, { cause: error });
  } finally {
    await release();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === worker) {
  const mode = process.argv[2];
  try {
    if (mode === 'browser') {
      const { ensureBrowser } = remotionRequire()('@remotion/renderer');
      const result = await ensureBrowser({ logLevel: 'error', ...(process.argv[3] === 'installed' ? { onBrowserDownload() { throw new Error('No cached headless Chrome is installed and downloading was not allowed'); } } : {}) });
      if (!result?.path) throw new Error('Remotion did not return a browser executable');
      process.stdout.write(`${JSON.stringify({ path: result.path })}\n`);
    } else if (mode === 'remotion') {
      process.argv.splice(2, 1);
      const { Config } = require('@remotion/cli/config');
      Config.overrideWebpackConfig(packagedWebpackOverride);
      const overrideWebpack = Config.overrideWebpackConfig;
      Config.overrideWebpackConfig = callback => overrideWebpack(async config => packagedWebpackOverride(await callback(config)));
      Config.setCachingEnabled(false);
      const explicitBrowser = process.env.TIMDS_BROWSER_EXECUTABLE?.trim();
      if (explicitBrowser) await fs.access(explicitBrowser).catch(() => { throw new Error(`Browser executable ${explicitBrowser} does not exist`); });
      Config.setBrowserExecutable(explicitBrowser || await packagedBrowserExecutable());
      // Retain normal CLI argument parsing, client remotion.config loading,
      // dotenv behavior, Studio, native compositor, and render subprocesses.
      require(path.join(path.dirname(require.resolve('@remotion/cli/package.json')), 'remotion-cli.js'));
    } else throw new Error('Unknown TimDS video worker operation');
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
