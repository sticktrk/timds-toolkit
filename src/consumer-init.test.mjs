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
  consumerMcpServers,
  initializeConsumer,
  renderConsumerSkill,
  rootAppName,
  runConsumerInit,
} from "./consumer-init.mjs";
import { checkConsumer, loadConsumer, resolveConsumerApp, validateConsumerManifest } from "./consumer.mjs";

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
async function createConsumerRepo(t, { submodule = true, nested = true, rootPackage = null } = {}) {
  const root = await temporaryDirectory(t);
  const designSystem = path.join(root, "acme-design-system");
  await initRepo(designSystem);
  await writeJson(path.join(designSystem, "timds.json"), { schemaVersion: 2, systemId: "acme/core", name: "Acme", version: "1.0.0" });
  git(designSystem, "add", ".");
  git(designSystem, "commit", "-m", "Release 1.0.0");

  const product = path.join(root, "product");
  await initRepo(product);
  await fs.writeFile(path.join(product, "README.md"), "# Product\n", "utf8");

  if (rootPackage) {
    await writeJson(path.join(product, "package.json"), rootPackage);
    await writeJson(path.join(product, "package-lock.json"), { lockfileVersion: 3 });
    for (const folder of ["src/styles", "src/server", "public"]) {
      await fs.mkdir(path.join(product, folder), { recursive: true });
      await fs.writeFile(path.join(product, folder, ".keep"), "", "utf8");
    }
  }

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

  if (!nested) {
    await fs.rm(web, { recursive: true });
    await fs.rm(spa, { recursive: true });
  }
  git(product, "add", "README.md", "docs", ...(nested ? ["web", "spa"] : []), ...(rootPackage ? ["package.json", "package-lock.json", "src", "public"] : []));
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
    preview: { serve: ["npm", "run", "dev"], port: 4321, ready: "/", routes: ["/"], discover: { from: ["/"], limit: 40 }, viewports: ["desktop", "phone"], schemes: ["light", "dark"] },
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
  assert.match(output, /web: preview\.routes lists only "\/" and preview\.discover follows links/);
  assert.match(output, /OPENAI_API_KEY/);
  assert.match(output, /timds-design-change label, set the TIMDS_DESIGNER_BOTS repository variable/);
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
  assert.match(workflow, /BASE_REF: \$\{\{ github\.base_ref \|\| github\.event\.repository\.default_branch \}\}/);
  assert.match(workflow, /if npm run timds -- consumer check --base "origin\/\$\{BASE_REF\}"; then/);
  assert.doesNotMatch(workflow, /run:[^\n]*\$\{\{ github\.base_ref/);
  assert.match(workflow, /ref: \$\{\{ inputs\.ref \|\| github\.event\.pull_request\.head\.sha \}\}/);
  assert.match(workflow, /consumer preview --app "\$APP" --base "origin\/\$\{BASE_REF\}" --publish --pull-request/);
  assert.match(workflow, /<!-- timds-consumer-preview:\$\{APP\} -->/);
  assert.match(workflow, /DESIGN_SYSTEM_DEPLOY_KEY/);
  assert.doesNotMatch(workflow, /__[A-Z_]+__/);
  // Callable from the designer-change workflow with a pull request and a branch.
  assert.match(workflow, /workflow_call:\n\s+inputs:\n\s+pull_request:[\s\S]*ref:/);
  assert.match(workflow, /PULL_REQUEST: \$\{\{ inputs\.pull_request \|\| github\.event\.number \}\}/);

  const designer = await fs.readFile(path.join(product, ".github", "workflows", "timds-designer-change.yml"), "utf8");
  assert.equal(designer, await fs.readFile(new URL("../templates/timds-designer-change.yml", import.meta.url), "utf8"));
  assert.doesNotMatch(designer, /__[A-Z_]+__/);
  assert.match(designer, /issues:\n\s+types: \[labeled\]/);
  assert.match(designer, /github\.event\.label\.name == 'timds-design-change'/);
  assert.match(designer, /contains\(github\.event\.comment\.body, '<!-- timds-designer-request -->'\)/);
  assert.match(designer, /case "\$2" in OWNER\|MEMBER\|COLLABORATOR\) return 0/);
  assert.match(designer, /DESIGNER_BOTS: \$\{\{ vars\.TIMDS_DESIGNER_BOTS \}\}/);
  assert.match(designer, /uses: openai\/codex-action@v1/);
  assert.match(designer, /openai-api-key: \$\{\{ secrets\.OPENAI_API_KEY \}\}/);
  assert.doesNotMatch(designer, /ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN|claude-code-action/);
  assert.match(designer, /sandbox: workspace-write/);
  assert.match(designer, /safety-strategy: drop-sudo/);
  const codexStep = designer.slice(designer.indexOf("      - name: Make the design change with OpenAI"), designer.indexOf("      - name: Validate and publish the draft"));
  assert.doesNotMatch(codexStep, /GH_TOKEN|github\.token|persist-credentials: true/);
  assert.match(designer, /consumer check "\$\{check_args\[@\]\}"/);
  assert.match(designer, /git diff --cached --quiet/);
  assert.match(designer, /gh pr create.*--draft/);
  assert.match(designer, /consumer notes resolve "\$\{note_ids\[@\]\}"/);
  assert.match(designer, /uses: \.\/\.github\/workflows\/timds-consumer-preview\.yml/);
  assert.match(designer, /cancel-in-progress: false/);
  // Event text reaches shell steps only through env, never ${{ }} inside run.
  const runBlocks = designer.split("\n").reduce((blocks, line) => {
    const indent = line.match(/^ */)[0].length;
    const open = blocks.at(-1);
    if (open && !open.done && (line.trim() === "" || indent > open.indent)) open.lines.push(line);
    else if (open) open.done = true;
    if (/^\s*run: [|>]/.test(line)) blocks.push({ indent, lines: [], done: false });
    return blocks;
  }, []);
  assert.ok(runBlocks.length >= 5);
  for (const block of runBlocks) assert.doesNotMatch(block.lines.join("\n"), /\$\{\{/);

  const mcp = JSON.parse(await fs.readFile(path.join(product, ".mcp.json"), "utf8"));
  assert.deepEqual(mcp, { mcpServers: consumerMcpServers() });
  assert.deepEqual(mcp.mcpServers["timds-design-system-read"], {
    type: "http",
    url: "https://timds.com/api/timds/mcp/read",
    headers: { Authorization: "Bearer ${TIMDS_ACCESS_TOKEN}" },
  });

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
  assert.deepEqual(installation.consumer.mcpServers, { "timds-design-system-read": sha256(JSON.stringify(mcp.mcpServers["timds-design-system-read"])) });
});

test("merges the read MCP server into an existing .mcp.json", async (t) => {
  const product = await createConsumerRepo(t);
  const userServer = { command: "npx", args: ["some-mcp"] };
  await writeJson(path.join(product, ".mcp.json"), { mcpServers: { other: userServer }, extra: true });
  await initializeConsumer(product, { skipInstall: true, output: quiet, portalUrl: "https://portal.example.test/ignored/path" });
  const mcpPath = path.join(product, ".mcp.json");
  const merged = JSON.parse(await fs.readFile(mcpPath, "utf8"));
  assert.deepEqual(merged.mcpServers.other, userServer);
  assert.equal(merged.extra, true);
  assert.equal(merged.mcpServers["timds-design-system-read"].url, "https://portal.example.test/api/timds/mcp/read");

  // A rerun is idempotent.
  await initializeConsumer(product, { skipInstall: true, output: quiet, portalUrl: "https://portal.example.test" });
  assert.deepEqual(JSON.parse(await fs.readFile(mcpPath, "utf8")), merged);

  // An unmodified managed entry follows a new portal URL.
  await initializeConsumer(product, { skipInstall: true, output: quiet });
  assert.equal(JSON.parse(await fs.readFile(mcpPath, "utf8")).mcpServers["timds-design-system-read"].url, "https://timds.com/api/timds/mcp/read");

  // A customized entry is kept without --force (other servers untouched) and replaced with it.
  const customized = JSON.parse(await fs.readFile(mcpPath, "utf8"));
  customized.mcpServers["timds-design-system-read"].headers = { Authorization: "Bearer ${MY_TOKEN}" };
  await writeJson(mcpPath, customized);
  const lines = [];
  const kept = await initializeConsumer(product, { skipInstall: true, output: (line) => lines.push(line) });
  assert.deepEqual(kept.keptMcpServers, ["timds-design-system-read"]);
  assert.match(lines.join("\n"), /Kept the customized "timds-design-system-read" server in \.mcp\.json/);
  assert.deepEqual(JSON.parse(await fs.readFile(mcpPath, "utf8")), customized);
  await runConsumerInit(["--root", product, "--skip-install", "--force", "--portal-url", "https://portal.example.test"], { output: quiet });
  const forced = JSON.parse(await fs.readFile(mcpPath, "utf8"));
  assert.deepEqual(forced.mcpServers["timds-design-system-read"], consumerMcpServers({ portalUrl: "https://portal.example.test" })["timds-design-system-read"]);
  assert.deepEqual(forced.mcpServers.other, userServer);

  await writeJson(mcpPath, { mcpServers: [] });
  await assert.rejects(initializeConsumer(product, { skipInstall: true, output: quiet }), /\.mcp\.json has an mcpServers value that is not an object/);
  assert.throws(() => consumerMcpServers({ portalUrl: "ftp://portal.example.test" }), /must use HTTP or HTTPS/);
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

test("names a root app from its package, without a scope, else from the folder", () => {
  assert.equal(rootAppName("@acme/marketing-site", "product"), "marketing-site");
  assert.equal(rootAppName("@acme/My Site!", "product"), "My-Site");
  assert.equal(rootAppName("", "product"), "product");
  assert.equal(rootAppName("@acme/---", "..."), "app");
  assert.equal(rootAppName("x".repeat(140), "product").length, 100);
});

test("discovers an app at the repository root and checks its design surface from the root", async (t) => {
  const product = await createConsumerRepo(t, {
    nested: false,
    rootPackage: { name: "@acme/site", private: true, scripts: { dev: "vite --port 5174", build: "vite build" }, devDependencies: { vite: "6.0.0" } },
  });
  const lines = [];
  const result = await initializeConsumer(product, { skipInstall: true, output: (line) => lines.push(line) });
  const manifest = JSON.parse(await fs.readFile(path.join(product, "timds.consumer.json"), "utf8"));
  assert.deepEqual(Object.keys(manifest.apps), ["site"]);
  assert.deepEqual(manifest.apps.site, {
    cwd: ".",
    install: ["npm", "ci"],
    preview: { serve: ["npm", "run", "dev"], port: 5174, ready: "/", routes: ["/"], discover: { from: ["/"], limit: 40 }, viewports: ["desktop", "phone"], schemes: ["light", "dark"] },
    designSurface: ["src/styles/**", "public/**"],
    protected: [],
  });
  assert.match(lines.join("\n"), /site: this app is the repository root, so its design surface globs are relative to the root/);

  // The toolkit selection lands in the app's own (root) package.json beside its scripts.
  const packageJson = JSON.parse(await fs.readFile(path.join(product, "package.json"), "utf8"));
  assert.equal(packageJson.scripts.dev, "vite --port 5174");
  assert.equal(packageJson.scripts.timds, "timds");

  const skill = await fs.readFile(path.join(product, ".agents", "skills", "timds-consume-design-system", "SKILL.md"), "utf8");
  assert.match(skill, /### `site`\n\n- Folder: repository root\. Paths below are relative to it/);
  const launch = JSON.parse(await fs.readFile(path.join(product, ".claude", "launch.json"), "utf8"));
  assert.deepEqual(launch.configurations, [{ name: "site", runtimeExecutable: "npm", runtimeArgs: ["run", "dev"], cwd: ".", port: 5174 }]);
  assert.deepEqual(launch.configurations, await consumerLaunchConfigurations(result.manifest));

  const consumer = await loadConsumer(product);
  const app = resolveConsumerApp(consumer);
  assert.equal(app.cwd, product);
  assert.equal(app.cwdRelative, ".");

  git(product, "add", "--all");
  git(product, "commit", "-m", "Adopt TimDS");
  git(product, "checkout", "-b", "design/colors");
  await fs.writeFile(path.join(product, "src", "styles", "site.css"), "a { color: red; }\n", "utf8");
  git(product, "add", "--all");
  git(product, "commit", "-m", "Recolor links");
  const passed = await checkConsumer(product, { base: "main" });
  assert.equal(passed.status, "passed", passed.errors.join("\n"));
  assert.deepEqual(passed.apps, [{ name: "site", cwd: ".", cwdExists: true, mode: "crawl" }]);
  assert.deepEqual(passed.changes, [{ path: "src/styles/site.css", status: "allowed", app: "site" }]);

  await fs.writeFile(path.join(product, "src", "server", "api.js"), "export {};\n", "utf8");
  const failed = await checkConsumer(product, { base: "main" });
  assert.equal(failed.status, "failed");
  assert.match(failed.errors.join("\n"), /outside the design surface[\s\S]*- src\/server\/api\.js/);
});

test("puts a root app first beside the app folders", async (t) => {
  const product = await createConsumerRepo(t, { rootPackage: { name: "web", private: true, scripts: { start: "next start" }, dependencies: { next: "15.0.0" } } });
  await initializeConsumer(product, { skipInstall: true, output: quiet });
  const manifest = JSON.parse(await fs.readFile(path.join(product, "timds.consumer.json"), "utf8"));
  // The root package is named like the web folder, so the root app takes a distinct name.
  assert.deepEqual(Object.keys(manifest.apps), ["web-root", "spa", "web"]);
  assert.equal(manifest.apps["web-root"].cwd, ".");
  assert.deepEqual(manifest.apps["web-root"].preview.serve, ["npm", "run", "start"]);
  assert.equal(manifest.apps["web-root"].preview.port, 3000);
  assert.equal(manifest.apps.web.cwd, "web");
  const launch = JSON.parse(await fs.readFile(path.join(product, ".claude", "launch.json"), "utf8"));
  assert.deepEqual(launch.configurations.map((entry) => [entry.name, entry.cwd]), [["web-root", "."], ["spa", "spa"], ["web", "web"]]);
});

test("never treats the root package.json init writes for the toolkit as an app", async (t) => {
  const product = await createConsumerRepo(t, {
    rootPackage: { name: "product", private: true, scripts: { timds: "timds" }, devDependencies: { "@dtconcepts/timds": releaseLine } },
  });
  await initializeConsumer(product, { skipInstall: true, output: quiet });
  const manifest = JSON.parse(await fs.readFile(path.join(product, "timds.consumer.json"), "utf8"));
  assert.deepEqual(Object.keys(manifest.apps), ["spa", "web"]);
  // A forced rerun sees init's own package.json and still finds no root app.
  await initializeConsumer(product, { force: true, skipInstall: true, output: quiet });
  assert.deepEqual(Object.keys(JSON.parse(await fs.readFile(path.join(product, "timds.consumer.json"), "utf8")).apps), ["spa", "web"]);
});
