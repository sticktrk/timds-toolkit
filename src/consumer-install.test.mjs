import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { initializeConsumer } from "./consumer-init.mjs";
import { migrateConsumerToPublished } from "./consumer-migrate.mjs";
import { checkConsumer } from "./consumer.mjs";
import { planConsumerToolkitLock, resolveConsumerToolkitLock } from "./consumer-install.mjs";
import { runtimeIdentity } from "./runtime.mjs";

const execute = promisify(execFile);
const OLD_VERSION = "0.1.451";
const { name, version, releaseLine } = runtimeIdentity;
const newerVersion = version.replace(/\d+$/, (patch) => Number(patch) + 1);
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const readJson = async (file) => JSON.parse(await fs.readFile(file, "utf8"));
const git = (cwd, ...args) => execFileSync("git", ["-c", "protocol.file.allow=always", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

async function temporaryDirectory(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "timds-consumer-install-"));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  return fs.realpath(root);
}

function initRepo(root) {
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "timds-test@example.com");
  git(root, "config", "user.name", "TimDS Test");
  git(root, "config", "commit.gpgsign", "false");
}

/** Local npm packages dispatch to the real consumer CLI; installs need no external registry. */
async function registry(t, root) {
  const archives = new Map();
  for (const selected of [OLD_VERSION, version, newerVersion]) {
    const directory = path.join(root, selected);
    await fs.mkdir(path.join(directory, "package"), { recursive: true });
    await fs.writeFile(path.join(directory, "package/package.json"), json({ name, version: selected, type: "module", bin: { timds: "timds.mjs" } }));
    const cli = selected === OLD_VERSION
      ? 'console.error("TimDS: Unknown consumer command sync"); process.exitCode = 1;'
      : `const { runConsumerCli } = await import(${JSON.stringify(new URL("./consumer.mjs", import.meta.url).href)}); await runConsumerCli(process.argv.slice(3));`;
    await fs.writeFile(path.join(directory, "package/timds.mjs"), `#!/usr/bin/env node\n${cli}\n`, { mode: 0o755 });
    const archive = path.join(directory, "timds.tgz");
    execFileSync("tar", ["-czf", archive, "-C", directory, "package"]);
    archives.set(selected, await fs.readFile(archive));
  }
  let url;
  const stylesheet = ".brand{}";
  const server = createServer((request, response) => {
    const pathname = decodeURIComponent(request.url.split("?")[0]);
    if (pathname === `/${name}`) {
      response.setHeader("content-type", "application/json");
      response.end(json({ name, "dist-tags": { latest: newerVersion }, versions: Object.fromEntries([...archives].map(([selected, archive]) => [selected, {
        name, version: selected, bin: { timds: "timds.mjs" },
        dist: { tarball: `${url}/timds-${selected}.tgz`, integrity: `sha512-${createHash("sha512").update(archive).digest("base64")}` },
      }])) }));
    } else if (pathname.startsWith("/timds-")) {
      response.end(archives.get(pathname.slice(7, -4)));
    } else if (pathname === "/system/v/1.0.0/bundle.json") {
      response.setHeader("content-type", "application/json");
      response.end(json({ schemaVersion: 1, system: { id: "acme/core", name: "Acme", version: "1.0.0" }, directory: `${url}/system/v/1.0.0/bundle`, files: [
        { path: "src/brand.css", bytes: stylesheet.length, sha256: createHash("sha256").update(stylesheet).digest("hex"), url: `${url}/system/v/1.0.0/bundle/src/brand.css` },
      ] }));
    } else if (pathname === "/system/v/1.0.0/bundle/src/brand.css") {
      response.end(stylesheet);
    } else {
      response.statusCode = 404;
      response.end("missing");
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${server.address().port}`;
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  return url;
}

test("init and migrate refresh an old lock; clean npm ci runs the resolved CLI's postinstall", async (t) => {
  for (const command of ["init", "migrate"]) await t.test(command, async (t) => {
    const root = await temporaryDirectory(t);
    const url = await registry(t, root);
    const product = path.join(root, "product");
    await fs.mkdir(path.join(product, "web/src"), { recursive: true });
    initRepo(product);
    await fs.writeFile(path.join(product, "web/package.json"), json({ name: "web", scripts: { dev: "vite" } }));
    await fs.writeFile(path.join(product, ".gitignore"), "node_modules/\npostinstall-ran\n");
    await fs.writeFile(path.join(product, ".npmrc"), `registry=${url}\naudit=false\nfund=false\ncache=${path.join(root, "npm-cache")}\n`);
    const pkg = { name: "product", private: true, scripts: { timds: "timds" }, devDependencies: { [name]: OLD_VERSION } };
    await fs.writeFile(path.join(product, "package.json"), json(pkg));
    await execute("npm", ["install", "--ignore-scripts"], { cwd: product });
    pkg.devDependencies[name] = releaseLine;
    pkg.scripts.postinstall = 'node -e "require(\'node:fs\').writeFileSync(\'postinstall-ran\', \'yes\')"';
    await fs.writeFile(path.join(product, "package.json"), json(pkg));
    const oldLock = await readJson(path.join(product, "package-lock.json"));
    oldLock.packages[""].devDependencies[name] = releaseLine;
    await fs.writeFile(path.join(product, "package-lock.json"), json(oldLock));
    assert.equal(oldLock.packages[`node_modules/${name}`].version, OLD_VERSION);

    if (command === "migrate") {
      const origin = path.join(root, "origin");
      await fs.mkdir(path.join(origin, "src"), { recursive: true });
      initRepo(origin);
      await fs.writeFile(path.join(origin, "timds.json"), json({ schemaVersion: 2, systemId: "acme/core", version: "1.0.0" }));
      await fs.writeFile(path.join(origin, "src/brand.css"), ".brand{}");
      git(origin, "add", ".");
      git(origin, "commit", "-qm", "Design System");
      git(product, "submodule", "add", "-q", origin, "design-system");
      await fs.writeFile(path.join(product, "timds.consumer.json"), json({ schemaVersion: 1, designSystem: { path: "design-system", systemId: "acme/core" }, apps: {
        web: { cwd: "web", preview: { serve: ["npm", "run", "dev"], port: 5173, routes: ["/"] }, designSurface: ["src/**"] },
      } }));
    }
    git(product, "add", ".");
    git(product, "commit", "-qm", "Old toolkit lock");

    const options = { url: `${url}/system`, version: "1.0.0" };
    const result = command === "init"
      ? await initializeConsumer(product, { ...options, system: "acme/core" })
      : await migrateConsumerToPublished(product, options);
    assert.ok(result.written.includes("package-lock.json"));
    const lock = await readJson(path.join(product, "package-lock.json"));
    assert.equal(lock.packages[`node_modules/${name}`].version, version, "select the running release, even when the registry has a newer release");
    assert.equal(lock.packages[""].devDependencies[name], releaseLine);
    assert.equal((await readJson(path.join(product, "package.json"))).devDependencies[name], releaseLine);
    assert.equal((await checkConsumer(product)).status, "passed");

    // Reruns must not need npm or move the reviewed resolution.
    await initializeConsumer(product, { runNpm: () => { throw new Error("Unexpected install on rerun"); } });
    git(product, "add", ".");
    git(product, "commit", "-qm", "Published consumer");
    const clone = path.join(root, "clone");
    git(root, "clone", "-q", product, clone);
    await execute("npm", ["ci"], { cwd: clone });
    assert.equal(await fs.readFile(path.join(clone, "design-system/src/brand.css"), "utf8"), ".brand{}");
    assert.equal(await fs.readFile(path.join(clone, "postinstall-ran"), "utf8"), "yes", "the existing postinstall still runs");
    await execute("npm", ["run", "timds", "--", "consumer", "check"], { cwd: clone });
  });
});

test("lock preflight restores package and lock bytes on failure and preserves newer locks", async (t) => {
  const root = await temporaryDirectory(t);
  const pkg = json({ private: true, devDependencies: { [name]: releaseLine } });
  const lock = json({ lockfileVersion: 3, packages: { "": { devDependencies: { [name]: releaseLine } }, [`node_modules/${name}`]: { version: OLD_VERSION } } });
  await fs.writeFile(path.join(root, "package.json"), pkg);
  await fs.writeFile(path.join(root, "package-lock.json"), lock);
  await assert.rejects(resolveConsumerToolkitLock(root, pkg, { runNpm: async () => {
    await fs.writeFile(path.join(root, "package-lock.json"), "partial lock");
    throw new Error("registry unavailable");
  } }), /Could not refresh the locked toolkit[\s\S]*registry unavailable/);
  assert.equal(await fs.readFile(path.join(root, "package.json"), "utf8"), pkg);
  assert.equal(await fs.readFile(path.join(root, "package-lock.json"), "utf8"), lock);
  for (const selected of [version, newerVersion]) {
    const current = JSON.parse(lock);
    current.packages[`node_modules/${name}`].version = selected;
    await fs.writeFile(path.join(root, "package-lock.json"), json(current));
    assert.equal((await planConsumerToolkitLock(root)).refresh, false);
  }
  await fs.writeFile(path.join(root, "npm-shrinkwrap.json"), json({ lockfileVersion: 1, dependencies: { [name]: { version: OLD_VERSION } } }));
  assert.deepEqual(await planConsumerToolkitLock(root), { path: "npm-shrinkwrap.json", version: OLD_VERSION, refresh: true });
});
