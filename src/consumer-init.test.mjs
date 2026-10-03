import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  consumerLaunchConfigurations,
  consumerManagedFiles,
  initializeConsumer,
  renderConsumerSkill,
  runConsumerInit,
} from "./consumer-init.mjs";
import { validateConsumerManifest } from "./consumer.mjs";

const toolkitPackage = JSON.parse(await fs.readFile(new URL("../package.json", import.meta.url), "utf8"));
const releaseLine = toolkitPackage.version.replace(/^(\d+\.\d+)\.\d+.*$/, "$1.x");
const sha256 = (content) => createHash("sha256").update(content).digest("hex");

async function temporaryDirectory(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "timds-consumer-init-"));
  t.after(() => fs.rm(directory, { force: true, recursive: true, maxRetries: 5, retryDelay: 50 }));
  return fs.realpath(directory);
}

function git(cwd, ...args) {
  return execFileSync("git", ["-c", "protocol.file.allow=always", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function initRepo(directory) {
  await fs.mkdir(directory, { recursive: true });
  git(directory, "init", "-b", "main");
  git(directory, "config", "user.email", "timds-test@example.com");
  git(directory, "config", "user.name", "TimDS Test");
}

/** A product repo with two apps and a real design-system submodule. */
async function createConsumerRepo(t, { submodule = true } = {}) {
  const root = await temporaryDirectory(t);
  const designSystem = path.join(root, "acme-design-system");
  await initRepo(designSystem);
  await writeJson(path.join(designSystem, "timds.json"), { schemaVersion: 2, systemId: "acme/core", name: "Acme", version: "1.0.0" });
  git(designSystem, "add", ".");
  git(designSystem, "commit", "-m", "Release 1.0.0");

  const product = path.join(root, "product");
  await initRepo(product);
  await fs.writeFile(path.join(product, "README.md"), "# Product\n", "utf8");

  const web = path.join(product, "web");
  await writeJson(path.join(web, "package.json"), { name: "web", scripts: { dev: "astro dev" }, dependencies: { astro: "5.0.0" } });
  await writeJson(path.join(web, "package-lock.json"), { lockfileVersion: 3 });
  for (const folder of ["src/styles", "src/pages", "src/server", "public"]) {
    await fs.mkdir(path.join(web, folder), { recursive: true });
    await fs.writeFile(path.join(web, folder, ".keep"), "", "utf8");
  }

  const spa = path.join(product, "spa");
  await writeJson(path.join(spa, "package.json"), { name: "spa", scripts: { dev: "vite" }, devDependencies: { vite: "6.0.0" } });
  await fs.writeFile(path.join(spa, "bun.lockb"), "", "utf8");
  await fs.mkdir(path.join(spa, "src", "components"), { recursive: true });
  await fs.writeFile(path.join(spa, "src", "components", ".keep"), "", "utf8");

  // Never apps: dependencies, dot-folders, and folders without package.json.
  await writeJson(path.join(product, "node_modules", "package.json"), { name: "nope" });
  await writeJson(path.join(product, ".tools", "package.json"), { name: "nope" });
  await fs.mkdir(path.join(product, "docs"), { recursive: true });
  await fs.writeFile(path.join(product, "docs", "index.md"), "# Docs\n", "utf8");

  git(product, "add", "README.md", "web", "spa", "docs");
  if (submodule) git(product, "submodule", "add", "../acme-design-system", "design-system");
  git(product, "commit", "-m", "Initial");
  return product;
}

const quiet = () => {};

test("refuses a repository without a design-system gitlink", async (t) => {
  const product = await createConsumerRepo(t, { submodule: false });
  await fs.mkdir(path.join(product, "design-system"), { recursive: true });
  await writeJson(path.join(product, "design-system", "timds.json"), { systemId: "copied/core" });
  await assert.rejects(
    initializeConsumer(product, { skipInstall: true, output: quiet }),
    /has no design-system submodule[\s\S]*git submodule add/,
  );
  await assert.rejects(fs.access(path.join(product, "timds.consumer.json")));
  await assert.rejects(fs.access(path.join(product, ".timds", "installation.json")));
});

test("discovers apps and writes the manifest with guessed defaults", async (t) => {
  const product = await createConsumerRepo(t);
  const lines = [];
  const result = await runConsumerInit(["--root", product, "--skip-install"], { output: (line) => lines.push(line) });
  const manifest = JSON.parse(await fs.readFile(path.join(product, "timds.consumer.json"), "utf8"));
  validateConsumerManifest(manifest);
  assert.deepEqual(Object.keys(manifest.apps), ["spa", "web"]);
  assert.deepEqual(manifest.designSystem, { path: "design-system", systemId: "acme/core" });
  assert.deepEqual(manifest.apps.web, {
    cwd: "web",
    install: ["npm", "ci"],
    preview: { serve: ["npm", "run", "dev"], port: 4321, ready: "/", routes: ["/"], viewports: ["desktop", "phone"], schemes: ["light", "dark"] },
    designSurface: ["src/styles/**", "src/pages/**", "public/**"],
    protected: [],
  });
  assert.deepEqual(manifest.apps.spa.install, ["bun", "install", "--frozen-lockfile"]);
  assert.deepEqual(manifest.apps.spa.preview.serve, ["bun", "run", "dev"]);
  assert.equal(manifest.apps.spa.preview.port, 5173);
  assert.deepEqual(manifest.apps.spa.designSurface, ["src/components/**"]);

  const output = lines.join("\n");
  assert.match(output, /For the developer to confirm:/);
  assert.match(output, /web: preview\.port is 4321 \(the astro default\)/);
  assert.match(output, /spa: install is bun install --frozen-lockfile \(bun is not set up/);
  assert.match(output, /TIMDS_ACCESS_TOKEN/);
  assert.match(output, /DESIGN_SYSTEM_DEPLOY_KEY/);
  assert.equal(result.keptManifest, false);

  const packageJson = JSON.parse(await fs.readFile(path.join(product, "package.json"), "utf8"));
  assert.equal(packageJson.private, true);
  assert.equal(packageJson.scripts.timds, "timds");
  assert.equal(packageJson.devDependencies["@dtconcepts/timds"], releaseLine);
  const gitignore = await fs.readFile(path.join(product, ".gitignore"), "utf8");
  assert.match(gitignore, /^\.timds\/preview\/$/m);
  assert.match(gitignore, /^node_modules\/$/m);
});

test("renders the skill from the manifest and records managed-file hashes", async (t) => {
  const product = await createConsumerRepo(t);
  await writeJson(path.join(product, "timds.consumer.json"), {
    schemaVersion: 1,
    designSystem: { path: "design-system", systemId: "acme/core" },
    apps: {
      web: {
        cwd: "web",
        install: ["npm", "ci"],
        preview: { serve: ["npm", "run", "dev"], port: 4321, routes: ["/", "/estate-planning", "/contact"] },
        designSurface: ["src/styles/**", "src/pages/**"],
        protected: ["src/server/**"],
      },
      docs: {
        cwd: "docs",
        preview: { build: ["npm", "run", "build"], output: "dist" },
        designSurface: ["**/*.md"],
      },
    },
  });
  const result = await initializeConsumer(product, { skipInstall: true, output: quiet });
  assert.equal(result.keptManifest, true);

  const skillPath = path.join(product, ".agents", "skills", "timds-consume-design-system", "SKILL.md");
  const skill = await fs.readFile(skillPath, "utf8");
  assert.doesNotMatch(skill, /__[A-Z_]+__/);
  assert.match(skill, /^name: timds-consume-design-system$/m);
  assert.match(skill, /TimDS Design System, `acme\/core`/);
  assert.match(skill, /consumer check --base origin\/main/);
  assert.match(skill, /### `web`[\s\S]*Folder: `web\/`/);
  assert.match(skill, /Review routes: `\/`, `\/estate-planning`, `\/contact`\./);
  assert.match(skill, /Design surface \(may change\): `src\/styles\/\*\*`, `src\/pages\/\*\*`\./);
  assert.match(skill, /Protected \(never change, even inside the surface\): `src\/server\/\*\*`\./);
  assert.match(skill, /the `web` entry in `\.claude\/launch\.json` \(`npm run dev`\), then open http:\/\/localhost:4321\//);
  assert.match(skill, /### `docs`[\s\S]*build with `npm run build` \(output in `dist\/`\)[\s\S]*consumer preview --app docs/);
  assert.match(skill, /Protected: nothing beyond/);
  assert.equal(skill, await renderConsumerSkill(result.manifest, { defaultBranch: "main" }));
  await fs.access(path.join(product, ".agents", "skills", "timds-consume-design-system", "agents", "openai.yaml"));

  const workflow = await fs.readFile(path.join(product, ".github", "workflows", "timds-consumer-preview.yml"), "utf8");
  assert.match(workflow, /pull_request:\n\s+types: \[opened, synchronize, reopened\]/);
  // The scope check reports instead of failing the job (developer pull requests leave the surface),
  // the base ref reaches the shell through env, and the preview builds the pull request's head commit.
  assert.match(workflow, /BASE_REF: \$\{\{ github\.base_ref \}\}/);
  assert.match(workflow, /if npm run timds -- consumer check --base "origin\/\$\{BASE_REF\}"; then/);
  assert.doesNotMatch(workflow, /run:[^\n]*\$\{\{ github\.base_ref/);
  assert.match(workflow, /ref: \$\{\{ github\.event\.pull_request\.head\.sha \}\}/);
  assert.match(workflow, /consumer preview --app "\$APP" --publish --pull-request/);
  assert.match(workflow, /<!-- timds-consumer-preview:\$\{APP\} -->/);
  assert.match(workflow, /DESIGN_SYSTEM_DEPLOY_KEY/);
  assert.doesNotMatch(workflow, /__[A-Z_]+__/);

  const installation = JSON.parse(await fs.readFile(path.join(product, ".timds", "installation.json"), "utf8"));
  assert.equal(installation.consumer.name, toolkitPackage.name);
  assert.equal(installation.consumer.version, toolkitPackage.version);
  const managed = await consumerManagedFiles(result.manifest, { defaultBranch: "main" });
  assert.deepEqual(Object.keys(installation.consumer.managedFiles).sort(), managed.map((file) => file.path).sort());
  for (const relative of Object.keys(installation.consumer.managedFiles)) {
    assert.equal(installation.consumer.managedFiles[relative], sha256(await fs.readFile(path.join(product, relative), "utf8")), relative);
  }
  const launch = JSON.parse(await fs.readFile(path.join(product, ".claude", "launch.json"), "utf8"));
  assert.deepEqual(Object.keys(installation.consumer.launchConfigurations), ["web"]);
  assert.equal(installation.consumer.launchConfigurations.web, sha256(JSON.stringify(launch.configurations[0])));
});

test("merges launch entries into an existing launch.json", async (t) => {
  const product = await createConsumerRepo(t);
  const userEntry = { name: "astro-dev", runtimeExecutable: "npm", runtimeArgs: ["run", "dev"], port: 4321 };
  await writeJson(path.join(product, ".claude", "launch.json"), { version: "0.0.1", configurations: [userEntry] });
  const result = await initializeConsumer(product, { skipInstall: true, output: quiet });
  const launch = JSON.parse(await fs.readFile(path.join(product, ".claude", "launch.json"), "utf8"));
  assert.deepEqual(launch.configurations[0], userEntry);
  assert.deepEqual(launch.configurations.slice(1), await consumerLaunchConfigurations(result.manifest));
  assert.deepEqual(launch.configurations[2], { name: "web", runtimeExecutable: "npm", runtimeArgs: ["run", "dev"], cwd: "web", port: 4321 });

  // A rerun is idempotent and does not duplicate entries.
  await initializeConsumer(product, { skipInstall: true, output: quiet });
  const again = JSON.parse(await fs.readFile(path.join(product, ".claude", "launch.json"), "utf8"));
  assert.deepEqual(again, launch);

  // A customized managed entry is kept without --force and replaced with it.
  again.configurations[2].port = 4399;
  await writeJson(path.join(product, ".claude", "launch.json"), again);
  const kept = await initializeConsumer(product, { skipInstall: true, output: quiet });
  assert.deepEqual(kept.keptLaunchConfigurations, ["web"]);
  assert.equal(JSON.parse(await fs.readFile(path.join(product, ".claude", "launch.json"), "utf8")).configurations[2].port, 4399);
  await initializeConsumer(product, { force: true, skipInstall: true, output: quiet });
  assert.equal(JSON.parse(await fs.readFile(path.join(product, ".claude", "launch.json"), "utf8")).configurations[2].port, 4321);
});

test("keeps an existing manifest unless forced, and refreshes only unmodified managed files", async (t) => {
  const product = await createConsumerRepo(t);
  await initializeConsumer(product, { skipInstall: true, output: quiet });
  const manifestPath = path.join(product, "timds.consumer.json");
  const edited = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  edited.apps.web.preview.routes = ["/", "/contact"];
  edited.apps.web.protected = ["src/server/**"];
  await writeJson(manifestPath, edited);
  const editedText = await fs.readFile(manifestPath, "utf8");

  // Rerun without --force: the manifest is never overwritten, and the skill,
  // which nobody edited, is re-rendered from it.
  const lines = [];
  const rerun = await initializeConsumer(product, { skipInstall: true, output: (line) => lines.push(line) });
  assert.equal(rerun.keptManifest, true);
  assert.equal(await fs.readFile(manifestPath, "utf8"), editedText);
  assert.match(lines.join("\n"), /Kept the existing timds\.consumer\.json/);
  const skillPath = path.join(product, ".agents", "skills", "timds-consume-design-system", "SKILL.md");
  assert.match(await fs.readFile(skillPath, "utf8"), /Review routes: `\/`, `\/contact`\./);

  // A customized managed file is refused without --force, before anything is written.
  await fs.appendFile(skillPath, "\nLocal note.\n", "utf8");
  edited.apps.web.preview.routes = ["/", "/about"];
  await writeJson(manifestPath, edited);
  await assert.rejects(
    initializeConsumer(product, { skipInstall: true, output: quiet }),
    /Refusing to replace customized TimDS consumer files:\n- \.agents\/skills\/timds-consume-design-system\/SKILL\.md/,
  );
  assert.match(await fs.readFile(skillPath, "utf8"), /Local note\./);

  // --force regenerates the manifest from discovery and replaces the skill.
  await initializeConsumer(product, { force: true, skipInstall: true, output: quiet });
  const regenerated = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  assert.deepEqual(regenerated.apps.web.preview.routes, ["/"]);
  assert.doesNotMatch(await fs.readFile(skillPath, "utf8"), /Local note\./);
});

test("refuses a conflicting toolkit declaration without --force", async (t) => {
  const product = await createConsumerRepo(t);
  await writeJson(path.join(product, "package.json"), { name: "product", private: true, devDependencies: { "@dtconcepts/timds": "latest" } });
  await assert.rejects(
    initializeConsumer(product, { skipInstall: true, output: quiet }),
    /already declares @dtconcepts\/timds as latest; rerun timds consumer init with --force/,
  );
  await assert.rejects(fs.access(path.join(product, "timds.consumer.json")));
  await initializeConsumer(product, { force: true, skipInstall: true, output: quiet });
  const packageJson = JSON.parse(await fs.readFile(path.join(product, "package.json"), "utf8"));
  assert.equal(packageJson.devDependencies["@dtconcepts/timds"], releaseLine);
  assert.equal(packageJson.name, "product");
});
