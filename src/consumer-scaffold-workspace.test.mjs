import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { checkConsumer, loadConsumer, resolveConsumerApp, validateConsumerManifest } from "./consumer.mjs";
import { EMDASH_RECORD_PATH, EMDASH_TEMPLATES_ROOT, compileTokenCss, planEmdashTemplates, readEmdashTemplateSet, runConsumerScaffold } from "./consumer-scaffold.mjs";
import { WORKSPACE_AGENTS_MARKER, scaffoldWorkspaceEmdashSite, workspacePackageJson, articleRoutePorts } from "./consumer-scaffold-workspace.mjs";
import { consumerSkillFiles } from "./consumer-init.mjs";
import { initializeRepository } from "./core.mjs";

const TEMPLATES = EMDASH_TEMPLATES_ROOT;
const INTEGRATION = path.join(TEMPLATES, "site-workspace", "src", "integrations", "design-system.mjs");
const quiet = () => {};
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function temporaryDirectory(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "timds-workspace-site-"));
  t.after(() => fs.rm(directory, { force: true, recursive: true, maxRetries: 5, retryDelay: 50 }));
  return fs.realpath(directory);
}

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

async function write(filePath, content) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, typeof content === "string" ? content : `${JSON.stringify(content, null, 2)}\n`, "utf8");
}

/** A Design System workspace exactly as `timds init --standalone` writes it, at `directory`. */
async function starterWorkspace(directory) {
  await fs.mkdir(directory, { recursive: true });
  git(directory, "init", "-b", "main");
  await initializeRepository(directory, { standalone: true, name: "Acme", systemId: "acme/core" });
  return directory;
}

/** A workspace whose website design is its own: full-document pages, no layout.html, its own stylesheet. */
async function ownDesignWorkspace(directory) {
  await starterWorkspace(directory);
  await fs.rm(path.join(directory, "src/designs/website"), { recursive: true, force: true });
  await write(path.join(directory, "src/designs/marketing/design.json"), { title: "Marketing" });
  await write(path.join(directory, "src/styles/brand.css"), ".masthead { padding: 1rem; }\n.page-body { margin: 0 auto; }\n.prose { max-width: 40rem; }\n");
  const page = (title) => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>${title}</title>
    <link rel="stylesheet" href="/styles/brand.css">
  </head>
  <body class="page">
    <header class="masthead"><a href="/">Home</a> <a href="/company/team">Team</a></header>
    <main class="page-body"><h1>${title}</h1></main>
  </body>
</html>
`;
  await write(path.join(directory, "src/designs/marketing/pages/index.html"), page("Own home"));
  await write(path.join(directory, "src/designs/marketing/pages/company/team.html"), page("Our team"));
  return directory;
}

/** Every file under `directory` with the sha256 of its bytes, directories marked. */
async function treeHash(directory) {
  const result = {};
  const visit = async (relative) => {
    for (const entry of await fs.readdir(path.join(directory, relative), { withFileTypes: true })) {
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) {
        result[child] = `-> ${await fs.readlink(path.join(directory, child))}`;
      } else if (entry.isDirectory()) {
        result[`${child}/`] = "dir";
        await visit(child);
      } else {
        result[child] = sha256(await fs.readFile(path.join(directory, child)));
      }
    }
  };
  await visit("");
  return result;
}

async function walk(directory, prefix = "") {
  const files = [];
  for (const entry of await fs.readdir(path.join(directory, prefix), { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await walk(directory, relative));
    else files.push(relative);
  }
  return files.sort();
}

/** The site paths the template directories install, the workspace overlay renamed and on top. */
async function expectedTemplatePaths() {
  const set = await readEmdashTemplateSet(TEMPLATES);
  const paths = new Set([...await walk(path.join(TEMPLATES, "site")), ...await walk(path.join(TEMPLATES, "site-cloudflare"))]);
  for (const file of await walk(path.join(TEMPLATES, "site-workspace"))) paths.add(set.workspace.renames[file] ?? file);
  return [...paths].sort();
}

test("--workspace writes a complete site into site/ of a starter workspace", async (t) => {
  const root = await temporaryDirectory(t);
  const workspace = await starterWorkspace(path.join(root, "ws"));
  const installs = [];
  const lines = [];
  const result = await scaffoldWorkspaceEmdashSite(workspace, {
    runInstall: async (cwd) => { installs.push(cwd); return { code: 0, stdout: "", stderr: "" }; },
    output: (line) => lines.push(line),
  });
  const site = path.join(workspace, "site");
  assert.equal(result.siteRoot, site);
  assert.equal(result.mode, "workspace");
  assert.equal(result.design.id, "website");
  assert.deepEqual(result.design.pages, ["/", "/404", "/about", "/contact", "/privacy", "/terms"]);
  assert.equal(result.tokens, true);
  assert.deepEqual(result.noPort, [], "the starter's stylesheet styles every article route");
  assert.deepEqual(installs, [site], "npm ci runs in the site");

  const templatePaths = await expectedTemplatePaths();
  const onDisk = await walk(site);
  assert.deepEqual(onDisk, [...templatePaths, "package.json", "timds.consumer.json", EMDASH_RECORD_PATH].sort());
  assert.ok(onDisk.includes(".gitignore") && onDisk.includes(".env.example"), "the renamed templates land under their own names");
  assert.ok(!onDisk.includes("gitignore") && !onDisk.includes("env.example"));
  assert.deepEqual([...result.written].sort(), onDisk.map((file) => `site/${file}`).sort());

  for (const file of onDisk) {
    const text = await fs.readFile(path.join(site, file), "utf8");
    assert.doesNotMatch(text, /__[A-Z][A-Z0-9_]*__/, `${file} has no placeholder left`);
  }
  // The handover is the workspace's own, not the existing mode's.
  assert.match(await fs.readFile(path.join(site, "docs/emdash-handover.md"), "utf8"), /scaffold emdash --workspace/);
  assert.equal(await fs.readFile(path.join(site, "docs/emdash-handover.md"), "utf8"), await fs.readFile(path.join(TEMPLATES, "site-workspace/docs/emdash-handover.md"), "utf8"));

  // No origin, no resource name or id, no credential is committed.
  const libraryIndex = await fs.readFile(path.join(site, "src/lib/articles/index.ts"), "utf8");
  assert.match(libraryIndex, /const CONFIGURED_SITE_URL: string = "";/);
  const wrangler = await fs.readFile(path.join(site, "wrangler.jsonc"), "utf8");
  assert.match(wrangler, /"name": "acme-core-site"/);
  assert.doesNotMatch(wrangler, /database_name|database_id|bucket_name|"id"|EMDASH_SITE_URL|example\.com/);
  for (const binding of ["DB", "MEDIA", "SESSION"]) assert.match(wrangler, new RegExp(`"binding": "${binding}"`));
  assert.match(await fs.readFile(path.join(site, "astro.config.mjs"), "utf8"), /designSystem\(\{ design: "website" \}\)/);
  assert.match(await fs.readFile(path.join(site, "astro.config.mjs"), "utf8"), /process\.env\.TIMDS_SITE_BASE \|\| "\/"/);
  assert.match(await fs.readFile(path.join(site, "src/routes/articles/index.astro"), "utf8"), /import Layout from "\.\.\/\.\.\/layouts\/Article\.astro";/);

  // Its own package, with the template set's exact versions, and no toolkit.
  const set = await readEmdashTemplateSet(TEMPLATES);
  const packageJson = JSON.parse(await fs.readFile(path.join(site, "package.json"), "utf8"));
  assert.deepEqual(packageJson, workspacePackageJson(set, { name: "acme-core-site" }));
  assert.equal(packageJson.private, true);
  assert.equal(packageJson.dependencies.emdash, set.dependencies.all.emdash);
  assert.equal(packageJson.dependencies["@astrojs/cloudflare"], set.dependencies.cloudflare["@astrojs/cloudflare"]);
  assert.equal(packageJson.dependencies.astro, set.workspace.dependencies.astro);
  assert.equal(packageJson.devDependencies.wrangler, set.devDependencies.cloudflare.wrangler);
  assert.ok(!JSON.stringify(packageJson).includes("@dtconcepts/timds"));
  const lockfile = JSON.parse(await fs.readFile(path.join(site, "package-lock.json"), "utf8"));
  assert.equal(lockfile.name, "acme-core-site");
  assert.equal(lockfile.packages[""].name, "acme-core-site");
  const rootPackage = JSON.parse(await fs.readFile(path.join(workspace, "package.json"), "utf8"));
  assert.ok(!rootPackage.workspaces, "the site is not an npm workspace of the root");

  // The workspace form of the manifest, with the design pairs.
  const manifest = JSON.parse(await fs.readFile(path.join(site, "timds.consumer.json"), "utf8"));
  assert.deepEqual(manifest.designSystem, { workspace: true, systemId: "acme/core" });
  assert.deepEqual(validateConsumerManifest(manifest).designSystem, { workspace: true, systemId: "acme/core" });
  const app = manifest.apps.site;
  assert.equal(app.cwd, ".");
  assert.equal(app.preview.ready, set.preview.ready);
  // The port comes from astro.config (TIMDS_SITE_PORT, else preview.port), so the dev server can move it.
  assert.deepEqual(app.preview.serve, ["npm", "run", "dev", "--", "--host", "127.0.0.1", "--ignore-lock"]);
  assert.equal(app.preview.port, 4380);
  assert.ok((await fs.readFile(path.join(site, "astro.config.mjs"), "utf8")).includes(`port: Number(process.env.TIMDS_SITE_PORT) || ${app.preview.port} }`));
  assert.deepEqual(app.preview.routes, ["/", "/about", "/contact", "/privacy", "/terms", ...set.preview.routes]);
  assert.deepEqual(app.preview.discover.exclude, ["/_emdash/**"]);
  assert.equal(app.preview.designs["/"], "website:/");
  assert.equal(app.preview.designs["/about"], "website:/about");
  for (const [route, designRoute] of Object.entries(set.preview.designs)) assert.equal(app.preview.designs[route], `website:${designRoute}`);
  assert.deepEqual(app.designSurface, ["src/layouts/**", "src/components/**", "src/styles/**", "src/pages/**", "src/routes/**", "src/divisions/**", "public/**"]);

  // The record: template version, platform, mode, and a hash of every template file as written.
  const record = JSON.parse(await fs.readFile(path.join(site, EMDASH_RECORD_PATH), "utf8"));
  assert.deepEqual(Object.keys(record), ["template", "platform", "mode", "files", "workspaceFiles", "workspaceSections"]);
  assert.deepEqual({ template: record.template, platform: record.platform, mode: record.mode }, { template: set.version, platform: "cloudflare", mode: "workspace" });
  assert.deepEqual(Object.keys(record.files).sort(), templatePaths.filter((file) => file !== "package-lock.json"));
  for (const [file, hash] of Object.entries(record.files)) assert.equal(hash, sha256(await fs.readFile(path.join(site, file))), `${file} is recorded as written`);
  assert.deepEqual(result.record, record);

  assert.ok(lines.some((line) => line.includes("Pages built from src/designs/website/")));
  assert.ok(!lines.some((line) => line.includes("No port yet")));
});

test("--workspace takes a fresh brand kit: its own website design, every article route ported", async (t) => {
  const root = await temporaryDirectory(t);
  const workspace = path.join(root, "kit");
  await fs.mkdir(workspace, { recursive: true });
  git(workspace, "init", "-b", "main");
  await initializeRepository(workspace, { standalone: true, starter: "brand-kit", name: "Example kit", systemId: "example-kit" });
  const lines = [];
  const result = await scaffoldWorkspaceEmdashSite(workspace, { skipInstall: true, output: (line) => lines.push(line) });
  assert.equal(result.design.id, "website");
  assert.equal(result.design.layout, true);
  assert.deepEqual(result.design.pages, ["/", "/404", "/about", "/contact", "/privacy", "/terms"]);
  assert.deepEqual(result.stylesheets, ["/styles/system.css"]);
  assert.deepEqual(result.noPort, []);
  assert.ok(!lines.some((line) => line.includes("No port yet")));
  assert.ok(!result.todos.some((todo) => todo.includes("has no port")));
});

test("--workspace writes byte-identical sites for identical workspaces", async (t) => {
  const root = await temporaryDirectory(t);
  const sites = [];
  for (const name of ["one", "two"]) {
    const workspace = await starterWorkspace(path.join(root, name));
    await scaffoldWorkspaceEmdashSite(workspace, { skipInstall: true, output: quiet });
    sites.push(await treeHash(path.join(workspace, "site")));
  }
  assert.deepEqual(sites[0], sites[1]);
});

test("--workspace installs into an embedded workspace's design-system/ folder and from any folder inside it", async (t) => {
  const root = await temporaryDirectory(t);
  const repository = path.join(root, "product");
  await fs.mkdir(repository, { recursive: true });
  git(repository, "init", "-b", "main");
  await initializeRepository(repository, { name: "Acme", systemId: "acme/core" });
  assert.ok(existsSync(path.join(repository, "design-system", "timds.json")) && !existsSync(path.join(repository, "timds.json")));
  await fs.mkdir(path.join(repository, "apps", "web"), { recursive: true });
  const result = await scaffoldWorkspaceEmdashSite(path.join(repository, "apps", "web"), { skipInstall: true, output: quiet });
  assert.equal(result.layout, "embedded");
  assert.equal(result.designSystemRoot, path.join(repository, "design-system"));
  assert.ok(existsSync(path.join(repository, "design-system", "site", "timds.consumer.json")));
  assert.ok(!existsSync(path.join(repository, "site")));
});

test("--workspace outside Git resolves a --root reached through a symlink before computing the site's folder", async (t) => {
  const root = await temporaryDirectory(t);
  // Standalone: the system is the folder --root names, through a link.
  const standalone = await starterWorkspace(path.join(root, "standalone"));
  await fs.rm(path.join(standalone, ".git"), { recursive: true, force: true });
  await fs.symlink(standalone, path.join(root, "standalone-link"), "dir");
  const result = await scaffoldWorkspaceEmdashSite(path.join(root, "standalone-link"), { skipInstall: true, output: quiet });
  assert.equal(result.layout, "standalone");
  assert.equal(result.designSystemRoot, standalone);
  assert.ok(result.written.length && result.written.every((file) => file.startsWith("site/")), "the site's files are written under site/");
  assert.ok(result.workspaceFiles.includes("AGENTS.md"), result.workspaceFiles.join(", "));
  assert.ok(result.workspaceFiles.every((file) => !file.startsWith("../")));
  assert.ok(existsSync(path.join(standalone, "site", "timds.consumer.json")));
  const record = JSON.parse(await fs.readFile(path.join(standalone, "site", EMDASH_RECORD_PATH), "utf8"));
  assert.ok(Object.keys(record.workspaceFiles).every((file) => !file.startsWith("../")));

  // Embedded: the system is design-system/ of the folder --root names, through a link.
  const repository = path.join(root, "product");
  await fs.mkdir(repository, { recursive: true });
  await initializeRepository(repository, { name: "Acme", systemId: "acme/core" });
  await fs.rm(path.join(repository, ".git"), { recursive: true, force: true });
  await fs.symlink(repository, path.join(root, "product-link"), "dir");
  const embedded = await scaffoldWorkspaceEmdashSite(path.join(root, "product-link"), { skipInstall: true, output: quiet });
  assert.equal(embedded.layout, "embedded");
  assert.equal(embedded.designSystemRoot, path.join(repository, "design-system"));
  assert.ok(embedded.written.length && embedded.written.every((file) => file.startsWith("site/")), "the site's files are written under the system's site/");
  // Paths from the repository root name the system's folder, never a way around a link.
  assert.ok(embedded.workspaceFiles.includes("design-system/AGENTS.md"), embedded.workspaceFiles.join(", "));
  assert.ok(embedded.workspaceFiles.every((file) => !file.startsWith("../")));
  assert.ok(existsSync(path.join(repository, "design-system", "site", "timds.consumer.json")));
});

test("--workspace builds a system's own design and lists the article routes with no port yet", async (t) => {
  const root = await temporaryDirectory(t);
  const workspace = await ownDesignWorkspace(path.join(root, "ws"));
  const lines = [];
  const result = await scaffoldWorkspaceEmdashSite(workspace, { skipInstall: true, output: (line) => lines.push(line) });
  assert.equal(result.design.id, "marketing");
  assert.equal(result.design.layout, false);
  assert.deepEqual(result.design.pages, ["/", "/company/team"]);
  assert.deepEqual(result.stylesheets, ["/styles/brand.css"]);
  assert.deepEqual(result.noPort.map((entry) => entry.route), ["/articles", "/articles/[slug]", "/topics/[slug]"]);
  const article = result.noPort.find((entry) => entry.route === "/articles/[slug]");
  assert.ok(article.missing.includes("hero") && article.missing.includes("table-scroll"));
  assert.ok(!article.missing.includes("prose"), "a class the system declares is not missing");
  assert.ok(lines.some((line) => line.startsWith("No port yet")));
  assert.ok(result.todos.some((todo) => todo.startsWith("/articles has no port to this system yet")));
  // The routes are installed all the same.
  for (const file of ["src/routes/articles/index.astro", "src/routes/articles/entry.astro", "src/pages/topics/[slug].astro"]) assert.ok(existsSync(path.join(workspace, "site", file)));
  const manifest = JSON.parse(await fs.readFile(path.join(workspace, "site", "timds.consumer.json"), "utf8"));
  assert.deepEqual(manifest.apps.site.preview.designs, { "/": "marketing:/", "/company/team": "marketing:/company/team" });
  assert.match(await fs.readFile(path.join(workspace, "site", "astro.config.mjs"), "utf8"), /designSystem\(\{ design: "marketing" \}\)/);
});

test("--workspace refuses before writing anything", async (t) => {
  const root = await temporaryDirectory(t);
  const notWorkspace = path.join(root, "plain");
  await fs.mkdir(notWorkspace, { recursive: true });
  await assert.rejects(scaffoldWorkspaceEmdashSite(notWorkspace, { skipInstall: true, output: quiet }), /is not in a Design System workspace/);
  assert.deepEqual(await fs.readdir(notWorkspace), []);
  await assert.rejects(scaffoldWorkspaceEmdashSite(path.join(root, "missing"), { skipInstall: true, output: quiet }), /is not a directory/);

  const workspace = await starterWorkspace(path.join(root, "ws"));
  await write(path.join(workspace, "site", "notes.md"), "mine\n");
  const before = await treeHash(workspace);
  await assert.rejects(scaffoldWorkspaceEmdashSite(workspace, { skipInstall: true, output: quiet }), /site already exists and is not empty/);
  assert.deepEqual(await treeHash(workspace), before);

  await fs.rm(path.join(workspace, "site"), { recursive: true });
  await write(path.join(workspace, "site"), "a file\n");
  await assert.rejects(scaffoldWorkspaceEmdashSite(workspace, { skipInstall: true, output: quiet }), /already exists and is not a directory/);
  await fs.rm(path.join(workspace, "site"));

  await fs.rm(path.join(workspace, "src", "designs"), { recursive: true });
  const bare = await treeHash(workspace);
  await assert.rejects(scaffoldWorkspaceEmdashSite(workspace, { skipInstall: true, output: quiet }), /has no website design under src\/designs\/ with a page to build/);
  assert.deepEqual(await treeHash(workspace), bare);
});

test("--workspace writes into an empty site/ and keeps it on a refusal", async (t) => {
  const root = await temporaryDirectory(t);
  const workspace = await starterWorkspace(path.join(root, "ws"));
  await fs.mkdir(path.join(workspace, "site"));
  const result = await scaffoldWorkspaceEmdashSite(workspace, { skipInstall: true, output: quiet });
  assert.ok(result.written.includes("site/package.json"));
  await assert.rejects(scaffoldWorkspaceEmdashSite(workspace, { skipInstall: true, output: quiet }), /not empty/, "a second run refuses");
});

test("--workspace removes what it wrote when a write fails part-way", async (t) => {
  const root = await temporaryDirectory(t);
  const workspace = await starterWorkspace(path.join(root, "ws"));
  const before = await treeHash(workspace);
  let count = 0;
  await assert.rejects(scaffoldWorkspaceEmdashSite(workspace, {
    skipInstall: true,
    output: quiet,
    writeFile: async (target, content) => {
      count += 1;
      if (count === 12) throw new Error("disk full");
      await fs.writeFile(target, content);
    },
  }), /disk full/);
  assert.deepEqual(await treeHash(workspace), before);
  assert.ok(!existsSync(path.join(workspace, "site")));
});

test("--workspace leaves the files in place and explains when npm ci fails", async (t) => {
  const root = await temporaryDirectory(t);
  const workspace = await starterWorkspace(path.join(root, "ws"));
  await assert.rejects(scaffoldWorkspaceEmdashSite(workspace, {
    output: quiet,
    runInstall: async () => ({ code: 1, stdout: "", stderr: "npm ERR! network" }),
  }), (error) => /npm ci failed/.test(error.message) && /npm ERR! network/.test(error.message) && /Do not rerun the scaffold/.test(error.message));
  assert.ok(existsSync(path.join(workspace, "site", "package-lock.json")));
});

test("runConsumerScaffold parses --workspace and refuses the other modes' flags and platforms", async (t) => {
  const root = await temporaryDirectory(t);
  const workspace = await starterWorkspace(path.join(root, "ws"));
  for (const [flags, pattern] of [
    [["--platform", "node"], /--platform node is not available with --workspace/],
    [["--existing"], /--existing is withdrawn and nothing was written/],
    [["--design-system", "https://example.com/ds.git"], /--design-system belongs/],
    [["--stylesheet", "src/styles/system.css"], /--stylesheet belongs/],
    [["--layout", "src/layouts/Base.astro"], /--layout belongs/],
    [["--site-url", "https://example.com"], /--site-url belongs/],
    [["--portal-url", "https://example.com"], /--portal-url belongs/],
  ]) {
    await assert.rejects(runConsumerScaffold(["emdash", "--workspace", "--root", workspace, "--skip-install", ...flags], { output: quiet }), pattern);
  }
  assert.ok(!existsSync(path.join(workspace, "site")));
  const help = [];
  await runConsumerScaffold(["--help"], { output: (line) => help.push(line) });
  assert.match(help.join("\n"), /timds consumer scaffold emdash --workspace \[--root PATH\] \[--skip-install\]/);
  const result = await runConsumerScaffold(["emdash", "--workspace", "--root", workspace, "--platform", "cloudflare", "--skip-install"], { output: quiet });
  assert.equal(result.mode, "workspace");
});

test("the shipped lockfile agrees with site.json and the generated package.json", async () => {
  const set = await readEmdashTemplateSet(TEMPLATES);
  const lockfile = JSON.parse(await fs.readFile(path.join(TEMPLATES, "site-workspace", "package-lock.json"), "utf8"));
  const packageJson = workspacePackageJson(set, { name: "__PACKAGE_NAME__" });
  const root = lockfile.packages[""];
  assert.equal(lockfile.lockfileVersion, 3);
  assert.equal(lockfile.name, "__PACKAGE_NAME__");
  assert.equal(root.name, "__PACKAGE_NAME__");
  // Regenerate after changing a version: write workspacePackageJson(set, { name }) to a scratch
  // folder, run npm install --package-lock-only there, and replace the name with __PACKAGE_NAME__.
  assert.deepEqual(root.dependencies, packageJson.dependencies, "lockfile dependencies match site.json");
  assert.deepEqual(root.devDependencies, packageJson.devDependencies, "lockfile devDependencies match site.json");
  for (const [name, version] of Object.entries({ ...packageJson.dependencies, ...packageJson.devDependencies })) {
    assert.equal(lockfile.packages[`node_modules/${name}`]?.version, version, `${name} resolves to ${version}`);
  }
});

test("the existing mode's plan has none of the workspace files", async (t) => {
  const root = await temporaryDirectory(t);
  const plan = await planEmdashTemplates(root, { platform: "cloudflare", layout: "src/layouts/Base.astro", siteName: "acme-site", templatesRoot: TEMPLATES });
  const paths = plan.files.map((file) => file.path);
  assert.ok(!paths.includes("astro.config.mjs") && !paths.includes("package-lock.json") && !paths.includes("src/integrations/design-system.mjs"));
  assert.ok(plan.manual.length > 0, "the existing mode still prints its manual changes");
  assert.match(plan.files.find((file) => file.path === "docs/emdash-handover.md").content.toString(), /The scaffold added an EmDash article section/);
});

test("the integration renders the starter design under a base path", async (t) => {
  const root = await temporaryDirectory(t);
  const workspace = await starterWorkspace(path.join(root, "ws"));
  const { renderWorkspaceDesign, applyBase, readTokens, compileTokenCss: siteTokenCss, runsStarterBuild, TITLE_MARKER } = await import(INTEGRATION);
  const rendered = renderWorkspaceDesign(workspace, { design: "website", base: "/site" });
  assert.deepEqual(rendered.pages.map((page) => page.route), ["/", "/404", "/about", "/contact", "/privacy", "/terms"]);
  const about = rendered.pages.find((page) => page.route === "/about");
  assert.equal(about.title, "About");
  assert.deepEqual(about.htmlAttributes, { lang: "en" });
  assert.match(about.head, /<title>About · Acme<\/title>/);
  assert.match(about.head, /href="\/site\/styles\/system\.css"/);
  assert.match(about.head, /href="\/site\/tokens\.css"/);
  assert.match(about.body, /<header class="site-header wrap">/);
  assert.match(about.body, /href="\/site\/about"/);
  assert.match(about.body, /<footer class="site-footer wrap">/);
  assert.doesNotMatch(about.body, /href="\/(?!site)/);
  assert.ok(rendered.shell.head.includes(TITLE_MARKER));
  assert.match(rendered.shell.before, /<header class="site-header wrap">[\s\S]*<main class="wrap">\s*$/);
  assert.match(rendered.shell.after, /^\s*<\/main>[\s\S]*<footer class="site-footer wrap">/);

  assert.equal(applyBase('<a href="/x">a</a><a href="//cdn/x">b</a><a href="#top">c</a><img srcset="/a.png 1x, /b.png 2x"><script>const u = "/raw";</script>', "/site/"), '<a href="/site/x">a</a><a href="//cdn/x">b</a><a href="#top">c</a><img srcset="/site/a.png 1x, /site/b.png 2x"><script>const u = "/raw";</script>');
  assert.equal(applyBase('<a href="/x">', "/"), '<a href="/x">');

  // The site compiles the tokens exactly as the starter build and the fresh mode do, from the tokens/ groups.
  const tokensJson = JSON.parse(await fs.readFile(path.join(workspace, "tokens.json"), "utf8"));
  assert.deepEqual(readTokens(workspace), tokensJson);
  assert.equal(siteTokenCss(readTokens(workspace)), compileTokenCss(tokensJson));
  assert.equal(siteTokenCss(readTokens(workspace)), await fs.readFile(path.join(workspace, "dist", "tokens.css"), "utf8"));
  assert.equal(runsStarterBuild(JSON.parse(await fs.readFile(path.join(workspace, "timds.json"), "utf8"))), true);
});

test("the integration lends a layout-less design its home page as the article shell", async (t) => {
  const root = await temporaryDirectory(t);
  const workspace = await ownDesignWorkspace(path.join(root, "ws"));
  const { renderWorkspaceDesign, TITLE_MARKER } = await import(INTEGRATION);
  const rendered = renderWorkspaceDesign(workspace, { design: "marketing", base: "/" });
  assert.deepEqual(rendered.pages.map((page) => page.route), ["/", "/company/team"]);
  assert.equal(rendered.pages[1].title, "Our team");
  assert.deepEqual(rendered.shell.bodyAttributes, { class: "page" });
  assert.match(rendered.shell.before, /<header class="masthead">[\s\S]*<main class="page-body">$/);
  assert.equal(rendered.shell.after.trim(), "</main>");
  assert.match(rendered.shell.head, new RegExp(`<title>${TITLE_MARKER} · Acme</title>`));
  assert.throws(() => renderWorkspaceDesign(workspace, { design: "website" }), /has no website design website/);
});

const CONSUMER_SKILLS = ["timds-consume-design-system", "timds-update-design-system"];
const SECTION_OPEN = `<!-- ${WORKSPACE_AGENTS_MARKER} -->`;
const SECTION_CLOSE = `<!-- /${WORKSPACE_AGENTS_MARKER} -->`;

/** The bytes the site adds outside its folder: the two consumer skills and the system's AGENTS.md. */
async function rootFilesHash(repository, agentsPath = "AGENTS.md") {
  const result = {};
  for (const name of CONSUMER_SKILLS) {
    const folder = path.join(repository, ".agents", "skills", name);
    result[name] = existsSync(folder) ? await treeHash(folder) : null;
  }
  result[agentsPath] = existsSync(path.join(repository, agentsPath)) ? sha256(await fs.readFile(path.join(repository, agentsPath))) : null;
  return result;
}

function sectionOf(text) {
  const start = text.indexOf(SECTION_OPEN);
  const end = text.indexOf(SECTION_CLOSE);
  assert.ok(start !== -1 && end > start, "the section is delimited");
  return text.slice(start, end + SECTION_CLOSE.length + 1);
}

test("--workspace adds the consumer skills and an AGENTS.md section at the repository root, and records them", async (t) => {
  const root = await temporaryDirectory(t);
  const workspace = await starterWorkspace(path.join(root, "ws"));
  const agentsBefore = await fs.readFile(path.join(workspace, "AGENTS.md"), "utf8");
  const lines = [];
  const result = await scaffoldWorkspaceEmdashSite(workspace, { skipInstall: true, output: (line) => lines.push(line) });

  // The skills are rendered for the site's manifest, beside the system's own skills.
  const manifest = JSON.parse(await fs.readFile(path.join(workspace, "site", "timds.consumer.json"), "utf8"));
  const expected = await consumerSkillFiles(manifest, { siteFolder: "site", defaultBranch: "main" });
  assert.deepEqual(expected.map((file) => file.path).sort(), [
    ".agents/skills/timds-consume-design-system/SKILL.md",
    ".agents/skills/timds-consume-design-system/agents/openai.yaml",
    ".agents/skills/timds-update-design-system/SKILL.md",
    ".agents/skills/timds-update-design-system/agents/openai.yaml",
  ]);
  for (const file of expected) {
    const text = await fs.readFile(path.join(workspace, file.path), "utf8");
    assert.equal(text, file.content, `${file.path} is the rendering for the site`);
    assert.doesNotMatch(text, /__[A-Z][A-Z0-9_]*__|<!-- timds:|`\.\.\//, `${file.path} has no placeholder, block marker, or path above the repository`);
  }
  const consume = await fs.readFile(path.join(workspace, ".agents/skills/timds-consume-design-system/SKILL.md"), "utf8");
  assert.match(consume, /npm run timds -- consumer check --root site\n/);
  assert.match(consume, /## Run the two-way check/);
  assert.match(consume, /served from `src\/designs\/<id>\/pages\/`/);
  assert.doesNotMatch(consume, /pinned at|\.claude\/launch\.json|consumer sync|git submodule/);
  const update = await fs.readFile(path.join(workspace, ".agents/skills/timds-update-design-system/SKILL.md"), "utf8");
  assert.match(update, /## Find the routes with no port/);
  assert.match(update, /`site\/\.timds\/emdash\.json` records the template version/);
  assert.doesNotMatch(update, /## Move the pin|consumer update /);
  assert.match(await fs.readFile(path.join(workspace, ".agents/skills/timds-update-design-system/agents/openai.yaml"), "utf8"), /display_name: "Keep the site in step with its Design System"/);
  // The system's own skills are untouched and the Claude link sees the new ones.
  assert.ok(existsSync(path.join(workspace, ".claude", "skills", "timds-consume-design-system", "SKILL.md")));

  // The section is appended once to the system's AGENTS.md, which keeps every byte it had.
  const agents = await fs.readFile(path.join(workspace, "AGENTS.md"), "utf8");
  assert.ok(agents.startsWith(agentsBefore.replace(/\s*$/, "")));
  assert.equal(agents.split(SECTION_OPEN).length, 2);
  const section = sectionOf(agents);
  assert.ok(agents.endsWith(section));
  assert.match(section, /```bash\nnpm run timds -- consumer check --root site\n```/);
  assert.match(section, /\(`\.agents\/skills\/timds-consume-design-system\/`\)/);
  assert.match(section, /`src\/designs\/website\/`/);
  assert.doesNotMatch(section, /__[A-Z][A-Z0-9_]*__/);

  // The record names every file outside the site by hash and the section by marker.
  const record = JSON.parse(await fs.readFile(path.join(workspace, "site", EMDASH_RECORD_PATH), "utf8"));
  assert.deepEqual(Object.keys(record.workspaceFiles), [...Object.keys(record.workspaceFiles)].sort((left, right) => left.localeCompare(right)));
  assert.deepEqual(Object.keys(record.workspaceFiles).sort(), expected.map((file) => file.path).sort());
  for (const [file, hash] of Object.entries(record.workspaceFiles)) assert.equal(hash, sha256(await fs.readFile(path.join(workspace, file))), `${file} is recorded as written`);
  assert.deepEqual(record.workspaceSections, { "AGENTS.md": { marker: WORKSPACE_AGENTS_MARKER, sha256: sha256(section) } });
  assert.deepEqual(result.workspaceFiles, [...expected.map((file) => file.path), "AGENTS.md"]);
  assert.ok(lines.some((line) => line.startsWith("Wrote beside the system's own guidance")));

  // The site's own guidance names the same command.
  assert.match(await fs.readFile(path.join(workspace, "site", "AGENTS.md"), "utf8"), /`npm run timds -- consumer check --root site`, run from the repository root/);
  assert.match(await fs.readFile(path.join(workspace, "site", "DESIGN_SYSTEM.md"), "utf8"), /`npm run timds -- consumer check --root site`, from the repository root, finds it/);
});

test("--workspace writes byte-identical root files for identical workspaces", async (t) => {
  const root = await temporaryDirectory(t);
  const hashes = [];
  for (const name of ["one", "two"]) {
    const workspace = await starterWorkspace(path.join(root, name));
    await scaffoldWorkspaceEmdashSite(workspace, { skipInstall: true, output: quiet });
    hashes.push(await rootFilesHash(workspace));
  }
  assert.deepEqual(hashes[0], hashes[1]);
});

test("--workspace in an embedded workspace puts the skills at the repository root and the section in the system's AGENTS.md", async (t) => {
  const root = await temporaryDirectory(t);
  const repository = path.join(root, "product");
  await fs.mkdir(repository, { recursive: true });
  git(repository, "init", "-b", "main");
  await initializeRepository(repository, { name: "Acme", systemId: "acme/core" });
  const rootAgents = existsSync(path.join(repository, "AGENTS.md")) ? await fs.readFile(path.join(repository, "AGENTS.md")) : null;
  const result = await scaffoldWorkspaceEmdashSite(repository, { skipInstall: true, output: quiet });
  assert.deepEqual(result.workspaceFiles.at(-1), "design-system/AGENTS.md");
  assert.deepEqual(rootAgents, existsSync(path.join(repository, "AGENTS.md")) ? await fs.readFile(path.join(repository, "AGENTS.md")) : null, "the product's own AGENTS.md is not the system's");
  assert.ok(!existsSync(path.join(repository, "design-system", ".agents")));
  const consume = await fs.readFile(path.join(repository, ".agents/skills/timds-consume-design-system/SKILL.md"), "utf8");
  assert.match(consume, /npm run timds -- consumer check --root design-system\/site\n/);
  assert.match(consume, /served from `design-system\/src\/designs\/<id>\/pages\/`/);
  assert.match(consume, /the Design System's own `design-system\/AGENTS\.md`/);
  assert.match(consume, /Folder: `design-system\/site\/`/);
  const section = sectionOf(await fs.readFile(path.join(repository, "design-system", "AGENTS.md"), "utf8"));
  assert.match(section, /\(`\.\.\/\.agents\/skills\/timds-consume-design-system\/`\)/);
  assert.match(section, /--root design-system\/site/);
  const record = JSON.parse(await fs.readFile(path.join(repository, "design-system", "site", EMDASH_RECORD_PATH), "utf8"));
  assert.deepEqual(Object.keys(record.workspaceSections), ["design-system/AGENTS.md"]);
  assert.ok(Object.keys(record.workspaceFiles).every((file) => file.startsWith(".agents/skills/")));
});

test("--workspace keeps what is already in place and refuses a skill folder it would overwrite", async (t) => {
  const root = await temporaryDirectory(t);
  // A first site, removed, leaves the skills and the section behind: a second scaffold keeps them.
  const workspace = await starterWorkspace(path.join(root, "ws"));
  await scaffoldWorkspaceEmdashSite(workspace, { skipInstall: true, output: quiet });
  const kept = await rootFilesHash(workspace);
  const record = JSON.parse(await fs.readFile(path.join(workspace, "site", EMDASH_RECORD_PATH), "utf8"));
  await fs.rm(path.join(workspace, "site"), { recursive: true });
  const again = await scaffoldWorkspaceEmdashSite(workspace, { skipInstall: true, output: quiet });
  assert.deepEqual(again.workspaceFiles, []);
  assert.deepEqual(await rootFilesHash(workspace), kept);
  const rerecorded = JSON.parse(await fs.readFile(path.join(workspace, "site", EMDASH_RECORD_PATH), "utf8"));
  assert.deepEqual([rerecorded.workspaceFiles, rerecorded.workspaceSections], [record.workspaceFiles, record.workspaceSections]);

  // An edited section is the client's: kept as it is, and recorded as found.
  await fs.rm(path.join(workspace, "site"), { recursive: true });
  const agentsPath = path.join(workspace, "AGENTS.md");
  await fs.writeFile(agentsPath, (await fs.readFile(agentsPath, "utf8")).replace("Read `site/AGENTS.md`", "Read `site/AGENTS.md` first"));
  const edited = await fs.readFile(agentsPath);
  await scaffoldWorkspaceEmdashSite(workspace, { skipInstall: true, output: quiet });
  assert.deepEqual(await fs.readFile(agentsPath), edited);
  assert.equal(JSON.parse(await fs.readFile(path.join(workspace, "site", EMDASH_RECORD_PATH), "utf8")).workspaceSections["AGENTS.md"].sha256, sha256(sectionOf(edited.toString())));

  // A skill folder that differs, holds another file, or is a file is refused before anything is written.
  const skill = path.join(workspace, ".agents/skills/timds-update-design-system");
  const rendered = path.join(root, "rendered-update-skill");
  await fs.cp(skill, rendered, { recursive: true });
  for (const change of [
    () => fs.appendFile(path.join(skill, "SKILL.md"), "\nLocal rule.\n"),
    () => write(path.join(skill, "notes.md"), "mine\n"),
    async () => { await fs.rm(skill, { recursive: true }); await write(skill, "a file\n"); },
  ]) {
    await fs.rm(path.join(workspace, "site"), { recursive: true, force: true });
    await fs.rm(skill, { recursive: true, force: true });
    await fs.cp(rendered, skill, { recursive: true });
    await change();
    const before = await treeHash(workspace);
    await assert.rejects(scaffoldWorkspaceEmdashSite(workspace, { skipInstall: true, output: quiet }), /\.agents\/skills\/timds-update-design-system already exists and .*Nothing was written/);
    assert.deepEqual(await treeHash(workspace), before);
  }
});

test("--workspace creates the system's AGENTS.md with the section alone when there is none", async (t) => {
  const root = await temporaryDirectory(t);
  const workspace = await starterWorkspace(path.join(root, "ws"));
  await fs.rm(path.join(workspace, "AGENTS.md"));
  await scaffoldWorkspaceEmdashSite(workspace, { skipInstall: true, output: quiet });
  const agents = await fs.readFile(path.join(workspace, "AGENTS.md"), "utf8");
  assert.ok(agents.startsWith(SECTION_OPEN));
  assert.equal(agents, sectionOf(agents));
});

test("--workspace rolls the root files back with the site when the last write fails", async (t) => {
  const root = await temporaryDirectory(t);
  const workspace = await starterWorkspace(path.join(root, "ws"));
  const before = await treeHash(workspace);
  await assert.rejects(scaffoldWorkspaceEmdashSite(workspace, {
    skipInstall: true,
    output: quiet,
    writeFile: async (target, content) => {
      if (target === path.join(workspace, "AGENTS.md")) throw new Error("disk full");
      await fs.writeFile(target, content);
    },
  }), /disk full/);
  assert.deepEqual(await treeHash(workspace), before);
  for (const name of CONSUMER_SKILLS) assert.ok(!existsSync(path.join(workspace, ".agents", "skills", name)));
});

test("a root upgrade after the scaffold leaves the consumer skills and the AGENTS.md section alone and reports nothing about them", async (t) => {
  const root = await temporaryDirectory(t);
  const workspace = await starterWorkspace(path.join(root, "ws"));
  await scaffoldWorkspaceEmdashSite(workspace, { skipInstall: true, output: quiet });
  // The system is committed (upgrade refuses uncommitted managed files); the consumer skills are left untracked.
  git(workspace, "add", "-A");
  git(workspace, "reset", "-q", "--", ...CONSUMER_SKILLS.map((name) => `.agents/skills/${name}`));
  git(workspace, "-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-q", "-m", "System with its site");
  const before = await rootFilesHash(workspace);
  const cli = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "bin", "timds.mjs");
  const run = (...args) => execFileSync(process.execPath, [cli, ...args], { cwd: workspace, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const report = JSON.parse(run("upgrade", "--root", workspace, "--json"));
  assert.equal(report.ok, true);
  assert.deepEqual(await rootFilesHash(workspace), before);
  const text = JSON.stringify(report);
  for (const name of [...CONSUMER_SKILLS, WORKSPACE_AGENTS_MARKER, "emdash"]) assert.ok(!text.includes(name), `the upgrade report does not mention ${name}`);
  assert.deepEqual(report.managedFiles.written.filter((file) => CONSUMER_SKILLS.some((name) => file.includes(name))), []);
});

test("--workspace renders the root files for a workspace that selects the executable", async (t) => {
  const root = await temporaryDirectory(t);
  const workspace = await starterWorkspace(path.join(root, "ws"));
  const installationPath = path.join(workspace, ".timds", "installation.json");
  await write(installationPath, { ...JSON.parse(await fs.readFile(installationPath, "utf8")), mode: "binary" });
  await scaffoldWorkspaceEmdashSite(workspace, { skipInstall: true, output: quiet });
  for (const name of CONSUMER_SKILLS) {
    const text = await fs.readFile(path.join(workspace, ".agents", "skills", name, "SKILL.md"), "utf8");
    assert.doesNotMatch(text, /npm run timds --/, name);
    assert.match(text, /timds-cli consumer check --root site/, name);
  }
  assert.match(sectionOf(await fs.readFile(path.join(workspace, "AGENTS.md"), "utf8")), /```bash\ntimds-cli consumer check --root site\n```/);
  assert.match(await fs.readFile(path.join(workspace, "site", "AGENTS.md"), "utf8"), /`timds-cli consumer check --root site`/);
});


test("section declaration drives seed checks and preview routes without rewriting the manifest", async (t) => {
  const root = await temporaryDirectory(t);
  const workspace = await starterWorkspace(path.join(root, "sections"));
  await scaffoldWorkspaceEmdashSite(workspace, { skipInstall: true, output: quiet });
  const site = path.join(workspace, "site");
  const originalManifest = await fs.readFile(path.join(site, "timds.consumer.json"), "utf8");
  const declaration = JSON.parse(await fs.readFile(path.join(site, "sections.json"), "utf8"));
  declaration.sections.push(
    { collection: "guides_for_owners", prefix: "/guides-for-owners/", label: "Guides", singularLabel: "Guide", feed: true },
    { collection: "recipes", prefix: "/recipes/", label: "Recipes", singularLabel: "Recipe", feed: false },
  );
  await write(path.join(site, "sections.json"), declaration);
  const beforeSync = await checkConsumer(site, { fix: false });
  assert.equal(beforeSync.status, "failed");
  assert.ok(beforeSync.errors.some((error) => /different collections.*sections:sync/.test(error)), beforeSync.errors.join("\n"));
  execFileSync(process.execPath, ["scripts/sections.mjs"], { cwd: site });
  const afterSync = await checkConsumer(site, { fix: false });
  assert.equal(afterSync.status, "passed", afterSync.errors.join("\n"));
  const app = resolveConsumerApp(await loadConsumer(site));
  const { readDesignCatalog } = await import("./designs.mjs");
  const { normalizeSections } = await import("../templates/emdash/site/src/lib/articles/sections.mjs");
  const design = (await readDesignCatalog(workspace)).designs.find((item) => item.id === "website");
  const ports = await articleRoutePorts({ designSystemRoot: workspace, design, templatesRoot: TEMPLATES, sections: normalizeSections(declaration) });
  assert.deepEqual(ports.routes.map((item) => item.route), ["/articles", "/articles/[slug]", "/guides-for-owners", "/guides-for-owners/[slug]", "/recipes", "/recipes/[slug]", "/topics/[slug]"]);
  assert.ok(ports.routes.every((item) => item.classes.length && !item.missing.length));
  for (const prefix of ["/articles", "/guides-for-owners", "/recipes"]) {
    assert.ok(app.preview.routes.includes(prefix));
    assert.ok(app.preview.routes.includes(`${prefix}/example-article`));
    assert.equal(app.preview.designs[prefix], "website:/articles");
    assert.equal(app.preview.designs[`${prefix}/example-article`], "website:/articles/example-article");
  }
  assert.equal(await fs.readFile(path.join(site, "timds.consumer.json"), "utf8"), originalManifest);
  const seed = JSON.parse(await fs.readFile(path.join(site, "seed/seed.json"), "utf8"));
  assert.equal(seed.collections.length, 3);
  assert.ok(seed.content.guides_for_owners.some((entry) => entry.slug === "example-article"));
  assert.ok(seed.content.recipes.some((entry) => entry.slug === "example-article"));
  assert.deepEqual(seed.collections.map((item) => item.fields), Array(3).fill(seed.collections[0].fields));
  assert.match(await fs.readFile(path.join(site, "docs/content-api.md"), "utf8"), /guides_for_owners.*guides-for-owners/);
  seed.collections[1].urlPattern = "/wrong/{slug}/";
  await write(path.join(site, "seed/seed.json"), seed);
  const drift = await checkConsumer(site, { fix: false });
  assert.ok(drift.errors.some((error) => /guides_for_owners.*urlPattern/.test(error)), drift.errors.join("\n"));
  await write(path.join(site, "sections.json"), { schemaVersion: 2, sections: [declaration.sections[1]] });
  const reverse = await checkConsumer(site, { fix: false });
  assert.ok(reverse.errors.some((error) => /different collections/.test(error)), reverse.errors.join("\n"));
});

test("section sync and consumer check share schema data and preserve authored seed metadata", async (t) => {
  const root = await temporaryDirectory(t);
  const workspace = await starterWorkspace(path.join(root, "section-schema"));
  await scaffoldWorkspaceEmdashSite(workspace, { skipInstall: true, output: quiet });
  const site = path.join(workspace, "site");
  const model = JSON.parse(await fs.readFile(path.join(site, "section-schema.json"), "utf8"));
  model.fields.push({ slug: "reading_time", label: "Reading time", type: "integer", validation: { min: 0 } });
  await write(path.join(site, "section-schema.json"), model);
  const before = await checkConsumer(site, { fix: false });
  assert.ok(before.errors.some((error) => /different fields.*sections:sync/.test(error)), before.errors.join("\n"));
  const seedFile = path.join(site, "seed/seed.json");
  const seed = JSON.parse(await fs.readFile(seedFile, "utf8"));
  seed.collections[0].description = "An authored collection description";
  seed.taxonomies[0].description = "An authored topic description";
  seed.taxonomies[0].label = "Sujets";
  seed.taxonomies[0].labelSingular = "Sujet";
  seed.taxonomies[0].locale = "fr";
  seed.taxonomies[0].translationGroup = "topic-translations";
  const category = { name: "category", label: "Categories", labelSingular: "Category", hierarchical: true, collections: ["articles"], terms: [{ slug: "news", label: "News" }] };
  seed.taxonomies.unshift(category);
  await write(seedFile, seed);
  execFileSync(process.execPath, ["scripts/sections.mjs"], { cwd: site });
  const synced = JSON.parse(await fs.readFile(seedFile, "utf8"));
  assert.deepEqual(synced.collections[0].fields, model.fields);
  assert.equal(synced.collections[0].description, seed.collections[0].description);
  assert.deepEqual(synced.taxonomies, seed.taxonomies);
  assert.deepEqual(synced.content, seed.content);
  // A consumer check reads only data; custom executable site code is not trusted.
  const helperFile = path.join(site, "src/lib/articles/sections.mjs");
  const helper = await fs.readFile(helperFile, "utf8");
  await fs.writeFile(helperFile, 'throw new Error("Site code must not execute in consumer check");\n');
  const checked = await checkConsumer(site, { fix: false });
  assert.equal(checked.status, "passed", checked.errors.join("\n"));
  await fs.writeFile(helperFile, helper);
  synced.collections.push({ slug: "authors", label: "Authors", fields: [] });
  await write(seedFile, synced);
  const seedBefore = await fs.readFile(seedFile, "utf8");
  const writerBefore = await fs.readFile(path.join(site, "docs/content-api.md"), "utf8");
  assert.throws(() => execFileSync(process.execPath, ["scripts/sections.mjs"], { cwd: site, stdio: "pipe" }), /Remove undeclared seed collections/);
  assert.equal(await fs.readFile(seedFile, "utf8"), seedBefore);
  assert.equal(await fs.readFile(path.join(site, "docs/content-api.md"), "utf8"), writerBefore);
});

test("nested section check and preview share public pages, template references and collision refusals", async (t) => {
  const root = await temporaryDirectory(t);
  const workspace = await starterWorkspace(path.join(root, "nested-sections"));
  await scaffoldWorkspaceEmdashSite(workspace, { skipInstall: true, output: quiet });
  const site = path.join(workspace, "site"), directory = path.join(workspace, "src/designs/website");
  for (const route of ["commercial-division/index", "commercial-division/about"]) await write(path.join(directory, "pages", `${route}.html`), `<h1>${route}</h1>`);
  const declaration = JSON.parse(await fs.readFile(path.join(site, "sections.json"), "utf8"));
  assert.equal(declaration.schemaVersion, 2);
  declaration.sections.push({ collection: "lease_faq", prefix: "/commercial-division/lease-faq/", label: "Lease FAQs", singularLabel: "Lease FAQ", feed: true });
  await write(path.join(site, "sections.json"), declaration);
  execFileSync(process.execPath, ["scripts/sections.mjs"], { cwd: site });
  let checked = await checkConsumer(site, { fix: false });
  assert.equal(checked.status, "passed", checked.errors.join("\n"));
  const app = resolveConsumerApp(await loadConsumer(site));
  for (const route of ["/commercial-division", "/commercial-division/about", "/commercial-division/lease-faq", "/commercial-division/lease-faq/example-article"]) assert.ok(app.preview.routes.includes(route), route);
  assert.equal(app.preview.designs["/commercial-division/about"], "website:/commercial-division/about");
  assert.equal(app.preview.designs["/commercial-division/lease-faq"], "website:/articles");
  const collision = "/commercial-division/lease-faq/how-to-lease-building";
  await write(path.join(directory, "pages", `${collision.slice(1)}.html`), "<h1>Lease information</h1>");
  checked = await checkConsumer(site, { fix: false });
  assert.equal(checked.status, "failed");
  assert.ok(checked.errors.some((error) => error.includes(collision) && /conflicts.*namespace/.test(error)), checked.errors.join("\n"));
  const design = JSON.parse(await fs.readFile(path.join(directory, "design.json"), "utf8"));
  design.pages[collision] = { title: "Lease reference", site: "reference" };
  await write(path.join(directory, "design.json"), design);
  checked = await checkConsumer(site, { fix: false });
  assert.equal(checked.status, "passed", checked.errors.join("\n"));
  assert.ok(!resolveConsumerApp(await loadConsumer(site)).preview.routes.includes(collision));
  const manifestFile = path.join(site, "timds.consumer.json");
  const manifest = JSON.parse(await fs.readFile(manifestFile, "utf8"));
  manifest.apps.site.preview.routes.push(`${collision}/`);
  manifest.apps.site.preview.designs[`${collision}/`] = `website:${collision}/`;
  await write(manifestFile, manifest);
  const authoredPreview = resolveConsumerApp(await loadConsumer(site)).preview;
  assert.ok(authoredPreview.routes.includes(collision));
  assert.equal(authoredPreview.designs[collision], `website:${collision}`);
  assert.deepEqual(JSON.parse(await fs.readFile(manifestFile, "utf8")), manifest);
  await write(path.join(site, "src/pages/commercial-division/[slug].astro"), "<h1>Dynamic page</h1>");
  checked = await checkConsumer(site, { fix: false });
  assert.ok(checked.errors.some((error) => /Site page.*conflicts/.test(error)), checked.errors.join("\n"));
  await fs.rm(path.join(site, "src/pages/commercial-division/[slug].astro"));
  const shadow = path.join(site, "public/commercial-division/lease-faq/index.html");
  await write(shadow, "<h1>Static replacement</h1>");
  checked = await checkConsumer(site, { fix: false });
  assert.ok(checked.errors.some((error) => /Public file.*conflicts/.test(error)), checked.errors.join("\n"));
  await fs.rm(shadow);
  const target = path.join(site, "src/components/linked-page.astro"), link = path.join(site, "src/pages/commercial-division/lease-faq/linked.astro");
  await write(target, "<h1>Linked page</h1>");
  await fs.mkdir(path.dirname(link), { recursive: true });
  await fs.symlink(target, link);
  checked = await checkConsumer(site, { fix: false });
  assert.ok(checked.errors.some((error) => /symbolic links/.test(error)), checked.errors.join("\n"));
  await fs.rm(link);
});

test("section checks and previews follow the configured design after selection changes", async (t) => {
  const root = await temporaryDirectory(t);
  const workspace = await starterWorkspace(path.join(root, "selected-design"));
  await scaffoldWorkspaceEmdashSite(workspace, { skipInstall: true, output: quiet });
  const site = path.join(workspace, "site"), directory = path.join(workspace, "src/designs/learn");
  await fs.cp(path.join(workspace, "src/designs/website"), directory, { recursive: true });
  await write(path.join(directory, "pages/commercial-division/about.html"), "<h1>About the division</h1>");
  const declaration = JSON.parse(await fs.readFile(path.join(site, "sections.json"), "utf8"));
  declaration.sections.push({ collection: "lease_faq", prefix: "/commercial-division/lease-faq/", label: "Lease FAQs", singularLabel: "Lease FAQ", feed: true });
  await write(path.join(site, "sections.json"), declaration);
  execFileSync(process.execPath, ["scripts/sections.mjs"], { cwd: site });
  const config = path.join(site, "astro.config.mjs");
  await write(config, `// designSystem({ design: "website" }) is an obsolete example.\nconst example = 'designSystem({ design: "website" })';\nconst unused = () => designSystem({ design: "website" });\n` + (await fs.readFile(config, "utf8")).replace('design: "website"', 'design: "learn"'));
  const recorded = await fs.readFile(path.join(site, "timds.consumer.json"), "utf8");
  assert.ok(recorded.includes("website:/"));
  const collision = "/commercial-division/lease-faq/how-to-lease-building";
  await write(path.join(directory, "pages", `${collision.slice(1)}.html`), "<h1>Lease information</h1>");
  let checked = await checkConsumer(site, { fix: false });
  assert.equal(checked.status, "failed");
  assert.ok(checked.errors.some((error) => error.includes(collision) && /conflicts.*namespace/.test(error)), checked.errors.join("\n"));
  const design = JSON.parse(await fs.readFile(path.join(directory, "design.json"), "utf8"));
  design.pages[collision] = { title: "Lease reference", site: "reference" };
  await write(path.join(directory, "design.json"), design);
  checked = await checkConsumer(site, { fix: false });
  assert.equal(checked.status, "passed", checked.errors.join("\n"));
  const app = resolveConsumerApp(await loadConsumer(site));
  assert.equal(app.preview.designs["/commercial-division/about"], "learn:/commercial-division/about");
  assert.equal(app.preview.designs["/commercial-division/lease-faq"], "learn:/articles");
  assert.ok(Object.values(app.preview.designs).every((reference) => reference.startsWith("learn:")));
  assert.ok(!app.preview.routes.includes(collision));
  assert.equal(await fs.readFile(path.join(site, "timds.consumer.json"), "utf8"), recorded);
  const configured = await fs.readFile(config, "utf8");
  for (const changed of [configured.replace('design: "learn"', 'design: process.env.DESIGN'), configured.replace('designSystem({ design: "learn" })', 'designSystem({})'), configured.replace('export default defineConfig(', 'export default opaqueConfig('), configured.replace('design: "learn"', '["design"]: "learn"'), configured.replace('design: "learn"', 'design: "website", ["design"]: "learn"'), configured.replace('import designSystem from "./src/integrations/design-system.mjs";', 'const designSystem = () => ({});')]) {
    await write(config, changed);
    const invalid = await checkConsumer(site, { fix: false });
    assert.ok(invalid.errors.some((error) => /literal designSystem/.test(error)), invalid.errors.join("\n"));
  }
});

test("division routes and checks use the selected design without changing section declarations", async (t) => {
  const root = await temporaryDirectory(t);
  const workspace = await starterWorkspace(path.join(root, "workspace"));
  await scaffoldWorkspaceEmdashSite(workspace, { skipInstall: true, output: quiet });
  const siteRoot = path.join(workspace, "site");
  const save = async (folder, relative, body) => {
    const target = path.join(folder, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, typeof body === "string" ? body : JSON.stringify(body));
  };
  const division = {
    id: "studio", prefix: "/our-studio/", system: "main", design: "studio",
    pages: "src/divisions/studio/pages", layout: "src/layouts/Studio.astro", collections: ["articles"],
  };
  const declaration = { schemaVersion: 1, systems: { main: { workspace: true } }, divisions: [division] };
  await save(workspace, "src/designs/studio/design.json", { title: "Studio" });
  await save(workspace, "src/designs/studio/layout.html", '<html><head><link rel="stylesheet" href="/styles/studio.css"></head><body>{{content}}</body></html>');
  await save(workspace, "src/designs/studio/pages/index.html", '<h1 class="studio-only">Studio reference</h1>');
  await save(workspace, "src/designs/studio/pages/articles.html", '<h1 class="studio-only">Reference list</h1>');
  await save(workspace, "src/styles/studio.css", ':root { --studio-color: #112233; } .studio-only { color: var(--studio-color); }');
  await save(siteRoot, "divisions.json", declaration);
  await save(siteRoot, `${division.pages}/index.html`, '<h1 class="studio-only">Owner Studio</h1>');
  await save(siteRoot, `${division.pages}/about.html`, '<h1 class="studio-only">About</h1>');
  await save(siteRoot, division.layout, '<html><head><slot name="head" /></head><body><slot /></body></html>');
  const before = await fs.readFile(path.join(siteRoot, "sections.json"), "utf8");
  const { loadConsumer } = await import("./consumer.mjs");
  const { checkWorkspaceSite } = await import("./consumer-workspace-check.mjs");
  const consumer = await loadConsumer(siteRoot);
  const app = consumer.apps.site;
  assert.ok(app.preview.routes.includes("/our-studio/about"));
  assert.equal(app.preview.designs["/our-studio"], "studio:/");
  assert.equal(app.preview.designs["/articles"], "studio:/articles");
  assert.equal(app.preview.designs["/about"], "website:/about");
  assert.deepEqual((await checkWorkspaceSite({ siteRoot, designSystemRoot: workspace, designSurface: app.designSurface, files: [`${division.pages}/index.html`], fix: false })).findings, []);
  assert.equal(await fs.readFile(path.join(siteRoot, "sections.json"), "utf8"), before);

  await save(siteRoot, "public/our-studio/about/index.html", "shadow");
  await assert.rejects(loadConsumer(siteRoot), /Public file .* conflicts with a division mount/);
  await fs.rm(path.join(siteRoot, "public"), { recursive: true });
  await save(siteRoot, "divisions.json", { ...declaration, divisions: [division, { ...division, id: "second", prefix: "/our-studio/sub/" }] });
  await assert.rejects(loadConsumer(siteRoot), /overlapping mount/);
});

test("pinned sibling references are checked against verified bytes and never become site pages", async (t) => {
  const root = await temporaryDirectory(t);
  const workspace = await starterWorkspace(path.join(root, "workspace"));
  await scaffoldWorkspaceEmdashSite(workspace, { skipInstall: true, output: quiet });
  const siteRoot = path.join(workspace, "site");
  const staged = path.join(siteRoot, ".timds-site-inputs");
  const write = async (root, relative, body) => {
    const file = path.join(root, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, typeof body === "string" ? body : JSON.stringify(body));
  };
  const systemId = "example/sibling";
  const version = "2026.11.1";
  const digest = "a".repeat(64);
  const division = { id: "studio", prefix: "/studio/", system: "sibling", design: "website", pages: "src/divisions/studio/pages", layout: "src/layouts/Studio.astro", collections: [] };
  const declaration = { schemaVersion: 1, systems: { main: { workspace: true }, sibling: { systemId, version } }, divisions: [division] };
  const files = {
    "bundle.json": JSON.stringify({ schemaVersion: 1, system: { id: systemId, version } }),
    "designs.json": JSON.stringify({ schemaVersion: 1, system: { id: systemId, version }, designs: [{ id: "website", url: "/design-system/designs/website/", pages: [
      { route: "/", states: [{ name: "default", html: '<link rel="stylesheet" href="/design-system/styles/brand.css"><script>throw Error("reference-only")</script>' }] },
      { route: "/sample", states: [{ name: "default", html: "<h1>Reference only</h1>" }] },
    ] }] }),
    "files/styles/brand.css": '@import "colors.css"; .sibling-only { color: var(--accent); }',
    "files/styles/colors.css": ":root { --accent: #789abc; }",
  };
  await write(siteRoot, "divisions.json", declaration);
  await write(siteRoot, `${division.pages}/index.html`, '<h1 class="sibling-only">Owner-authored</h1>');
  await write(siteRoot, division.layout, '<html><head><slot name="head" /></head><body><slot /></body></html>');
  const { loadConsumer } = await import("./consumer.mjs");
  await assert.rejects(loadConsumer(siteRoot), /Stage the exact sibling/);
  for (const [file, bytes] of Object.entries(files)) await write(staged, `sibling/${file}`, bytes);
  const dependency = {
    alias: "sibling", sourceId: "11111111-1111-4111-8111-111111111111", systemId, version, commit: "b".repeat(40), contentDigest: digest, manifestDigest: "c".repeat(64),
    files: Object.entries(files).map(([file, bytes]) => ({ path: file, size: Buffer.byteLength(bytes), sha256: sha256(bytes) })),
  };
  await write(staged, "receipt.json", { schemaVersion: 1, dependencies: [dependency] });
  const app = (await loadConsumer(siteRoot)).apps.site;
  assert.ok(app.preview.routes.includes("/studio"));
  assert.ok(!app.preview.routes.includes("/studio/sample"));
  const { checkWorkspaceSite } = await import("./consumer-workspace-check.mjs");
  assert.deepEqual((await checkWorkspaceSite({ siteRoot, designSystemRoot: workspace, designSurface: app.designSurface, files: [`${division.pages}/index.html`], fix: false })).findings, []);
  await write(staged, "sibling/files/styles/colors.css", files["files/styles/colors.css"].replace("789abc", "000000"));
  await assert.rejects(loadConsumer(siteRoot), /pins and digests/);
});
