// Real Astro/EmDash development reloads in disposable synthetic workspaces.
// No host credentials or deployed resources. Reuse pinned dependencies with
// --dependencies /absolute/path/to/node_modules, or install them once locally.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const templates = fileURLToPath(new URL("../templates/emdash/", import.meta.url));
const root = await mkdtemp(path.join(tmpdir(), "timds-emdash-dev-"));
let deadline = Date.now() + 300_000;
const environment = { ...process.env, ASTRO_TELEMETRY_DISABLED: "1", WRANGLER_SEND_METRICS: "false" };
const json = async (file) => JSON.parse(await readFile(file, "utf8"));
const save = (file, value) => writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let child, output = "";

async function command(args, cwd) {
  const process = spawn(args[0], args.slice(1), { cwd, env: environment, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  for (const stream of [process.stdout, process.stderr]) stream.on("data", (chunk) => { log = (log + chunk).slice(-16_000); });
  const timer = setTimeout(() => process.kill("SIGTERM"), Math.max(1, deadline - Date.now()));
  try {
    await new Promise((resolve, reject) => {
      process.once("error", reject);
      process.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`${args[0]} failed:\n${log}`)));
    });
  } finally { clearTimeout(timer); }
}

async function until(check, label) {
  console.log(`Checking ${label}.`);
  let last;
  while (Date.now() < deadline) {
    if (child && (child.exitCode !== null || child.signalCode !== null)) throw new Error(`Astro exited during ${label}:\n${output}`);
    try { if (await check()) return; } catch (error) { last = error; }
    await pause(150);
  }
  throw new Error(`Timed out waiting for ${label}: ${last?.message || "condition not met"}\n${output}`);
}

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function stop() {
  if (!child) return;
  const running = child;
  child = null;
  if (running.exitCode !== null || running.signalCode !== null) return;
  running.kill("SIGTERM");
  const timer = setTimeout(() => running.kill("SIGKILL"), 5_000);
  try { await new Promise((resolve) => running.once("exit", resolve)); } finally { clearTimeout(timer); }
}

async function fixture(name, dependencies) {
  const workspace = path.join(root, name), site = path.join(workspace, "site");
  await mkdir(site, { recursive: true });
  for (const folder of ["site", "site-workspace", "site-cloudflare"]) await cp(path.join(templates, folder), site, { recursive: true });
  for (const relative of await readdir(site, { recursive: true })) {
    const file = path.join(site, relative);
    let text;
    try { text = await readFile(file, "utf8"); } catch (error) { if (error.code === "EISDIR") continue; throw error; }
    for (const [before, after] of Object.entries({ __PACKAGE_NAME__: "timds-example-site", __DESIGN_ID__: "website", __LAYOUT_IMPORT__: "../../layouts/Base.astro", __SITE_URL__: "", __SITE_NAME__: "Example site", __WORKER_NAME__: "timds-example-site" })) text = text.replaceAll(before, after);
    await writeFile(file, text);
  }
  const lock = await json(path.join(site, "package-lock.json"));
  await save(path.join(site, "package.json"), { ...lock.packages[""], private: true, type: "module", scripts: { "sections:sync": "node scripts/sections.mjs" } });
  // Reused node_modules must not share optimizer output across dev servers.
  const config = path.join(site, "astro.config.mjs");
  await writeFile(config, (await readFile(config, "utf8")).replace("vite: { server:", 'vite: { cacheDir: ".astro/vite-cache", server:'));
  await symlink(dependencies, path.join(site, "node_modules"), "dir");
  await save(path.join(workspace, "timds.json"), { systemId: "timds-example", name: "Example site", description: "Synthetic development verification.", version: "1.0.0" });
  const pages = path.join(workspace, "src/designs/website/pages");
  await mkdir(path.join(pages, "commercial-division"), { recursive: true });
  await save(path.join(workspace, "src/designs/website/design.json"), { title: "Website", pages: {} });
  await writeFile(path.join(pages, "index.html"), "<html><head><title>Example home</title></head><body><main>Example home</main></body></html>");
  await writeFile(path.join(pages, "commercial-division.html"), '<html><head><title>Commercial division</title></head><body><main><h1>Commercial division</h1><a href="/commercial-division/about/">About</a><a href="/commercial-division/lease-faq/">Lease FAQ</a></main></body></html>');
  await writeFile(path.join(pages, "commercial-division/about.html"), "<html><head><title>About commercial division</title></head><body><main><h1>About commercial division</h1></main></body></html>");
  await mkdir(path.join(site, "src/forms/commercial-division"), { recursive: true });
  await writeFile(path.join(site, "src/forms/commercial-division/lease-faq.ts"), 'export const POST = () => new Response("lease-form-handled", { status: 201, headers: { "Content-Type": "text/plain" } });\n');
  // Seed only local synthetic content: the stock sample includes remote media.
  const seedFile = path.join(site, "seed/seed.json"), seed = await json(seedFile);
  seed.content = { articles: [{ id: "articles-example", slug: "example-article", status: "published", data: { title: "Example article", summary: "Synthetic local content.", body: [] } }] };
  await save(seedFile, seed);
  // Observe the same module used by pages, independently of database seeding.
  await writeFile(path.join(site, "src/pages/contract.json.ts"), 'import { sectionsContract, sections, sectionSchema } from "virtual:timds/design-system";\nexport const GET = () => Response.json({ sectionsContract, sections, sectionSchema });\n');
  return site;
}

try {
  const at = process.argv.indexOf("--dependencies");
  let dependencies;
  if (at !== -1) {
    assert.ok(process.argv[at + 1], "--dependencies requires a node_modules directory");
    dependencies = path.resolve(process.argv[at + 1]);
  } else {
    const directory = path.join(root, "dependencies");
    await mkdir(directory);
    const lock = JSON.parse((await readFile(path.join(templates, "site-workspace/package-lock.json"), "utf8")).replaceAll("__PACKAGE_NAME__", "timds-example-site"));
    await save(path.join(directory, "package-lock.json"), lock);
    await save(path.join(directory, "package.json"), lock.packages[""]);
    await command(["npm", "ci", "--ignore-scripts", "--no-audit", "--no-fund"], directory);
    dependencies = path.join(directory, "node_modules");
  }
  assert.equal((await json(path.join(dependencies, "emdash/package.json"))).version, "1.4.0");
  const astro = await json(path.join(dependencies, "astro/package.json"));
  assert.equal(astro.version, "7.4.10");
  const astroCli = path.join(dependencies, "astro", astro.bin.astro);

  const baseIndex = process.argv.indexOf("--base");
  const bases = baseIndex === -1 ? ["/", "/site"] : [process.argv[baseIndex + 1]];
  assert.ok(bases.every((base) => base === "/" || base === "/site"), "--base must be / or /site");
  for (const base of bases) {
    deadline = Date.now() + 300_000;
    const site = await fixture(base === "/" ? "root" : "mounted", dependencies);
    const port = await freePort(), serverOrigin = `http://127.0.0.1:${port}`, origin = serverOrigin + (base === "/" ? "" : base);
    // EmDash's development API stays at the root even when pages use /site.
    const request = (pathname, init = {}) => fetch((pathname.startsWith("/_emdash/") ? serverOrigin : origin) + pathname, { signal: AbortSignal.timeout(10_000), redirect: "manual", ...init });
    const status = async (pathname, init) => { const response = await request(pathname, init); await response.body?.cancel(); return response.status; };
    const read = async (pathname) => { const response = await request(pathname); assert.equal(response.status, 200, pathname); return response.text(); };
    const post = { method: "POST", headers: { Origin: serverOrigin, "Content-Type": "application/x-www-form-urlencoded" }, body: "example=1" };
    const contract = async () => { const response = await request("/contract.json"); assert.equal(response.status, 200); return response.json(); };
    const synchronize = () => command([process.execPath, "scripts/sections.mjs"], site);
    const declarations = path.join(site, "sections.json"), seedFile = path.join(site, "seed/seed.json"), schemaFile = path.join(site, "section-schema.json");
    const declaration = await json(declarations);
    assert.equal(declaration.schemaVersion, 2);
    const division = "/commercial-division/", prefix = `${division}lease-faq/`, slug = "how-to-lease-building";
    console.log(`Checking EmDash development reloads at ${base}.`);
    output = "";
    child = spawn(process.execPath, [astroCli, "dev", "--host", "127.0.0.1", "--port", String(port), "--ignore-lock"], { cwd: site, env: { ...environment, TIMDS_SITE_BASE: base }, stdio: ["ignore", "pipe", "pipe"] });
    for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => { output = (output + chunk).slice(-24_000); });
    await until(async () => await status("/_emdash/api/setup/dev-bypass") === 200, `${base} development setup`);
    assert.equal(await status("/articles/"), 200);
    assert.equal(await status("/articles/example-article/"), 200);
    assert.equal(await status("/articles/rss.xml"), 200);
    assert.equal((await contract()).sectionsContract, 2);
    assert.ok((await read(division)).includes("<h1>Commercial division</h1>"));
    assert.ok((await read(`${division}about/`)).includes("<h1>About commercial division</h1>"));

    declaration.sections.push({ collection: "lease_faq", prefix, label: "Lease FAQ", singularLabel: "Lease answer", feed: true });
    output = "";
    await save(declarations, declaration);
    await until(() => output.includes("Continuing with previous valid configuration"), `${base} invalid declaration/seed recovery`);
    assert.equal(await status("/articles/"), 200);
    assert.equal(await status(prefix), 404);
    // Supply the requested entry slug before sync derives its new collection.
    const additionalSeed = await json(seedFile);
    additionalSeed.content.lease_faq = [{ id: "lease-faq-example", slug, status: "published", data: { title: "How to lease a building", summary: "Synthetic leasing guide.", body: [] } }];
    output = "";
    await save(seedFile, additionalSeed);
    await until(() => output.includes("Continuing with previous valid configuration"), `${base} new collection awaiting sync`);
    output = "";
    await synchronize();
    await until(() => output.includes("server restarted."), `${base} added section Astro restart`);
    await until(async () => (await contract()).sections.some((section) => section.collection === "lease_faq" && section.urlPattern === `${prefix}{slug}/`), `${base} added nested section route configuration`);
    // Dev bypass explicitly reapplies the changed seed to this local database.
    // Production schema reconciliation is a separate host responsibility.
    assert.equal(await status("/_emdash/api/setup/dev-bypass"), 200);
    console.log(`Checking ${base} nested content, division pages and method ownership.`);
    const listing = await read(prefix), entry = await read(`${prefix}${slug}/`), feed = await read(`${prefix}rss.xml`);
    assert.ok(listing.includes("How to lease a building"));
    assert.ok(listing.includes(`${base === "/" ? "" : base}${prefix}${slug}/`));
    assert.ok(entry.includes("How to lease a building"));
    assert.ok(feed.includes(origin + prefix + slug + "/"));
    assert.ok((await read(division)).includes("<h1>Commercial division</h1>"));
    assert.ok((await read(`${division}about/`)).includes("<h1>About commercial division</h1>"));
    const handled = await request(prefix, post);
    assert.equal(handled.status, 201);
    assert.equal(await handled.text(), "lease-form-handled");
    for (const pathname of [`${division}about/`, `${prefix}${slug}/`]) assert.equal(await status(pathname, post), 405, `${base}${pathname} POST`);
    for (const pathname of [`${division}missing/`, `${prefix}missing/`, `${prefix}${slug}/extra/`]) assert.equal(await status(pathname), 404, `${base}${pathname}`);

    const model = await json(schemaFile);
    model.fields.push({ slug: "review_note", label: "Review note", type: "text" });
    output = "";
    await save(schemaFile, model);
    await until(() => output.includes("Continuing with previous valid configuration"), `${base} invalid schema/seed recovery`);
    assert.ok(!(await contract()).sectionSchema.fields.some((field) => field.slug === "review_note"));
    output = "";
    await synchronize();
    await until(() => output.includes("server restarted."), `${base} schema Astro restart`);
    await until(async () => (await contract()).sectionSchema.fields.some((field) => field.slug === "review_note"), `${base} schema data reload`);

    const helper = path.join(site, "src/lib/articles/sections.mjs");
    const originalHelper = await readFile(helper, "utf8");
    assert.ok(originalHelper.includes('label: "Topics"'));
    output = "";
    await writeFile(helper, originalHelper.replace('label: "Topics"', 'label: "Topic library"'));
    await until(() => output.includes("Continuing with previous valid configuration"), `${base} helper config dependency`);
    output = "";
    await synchronize();
    await until(() => output.includes("server restarted."), `${base} helper Astro restart`);
    await until(async () => (await contract()).sectionSchema.taxonomies[0].label === "Topic library", `${base} helper import refresh`);

    output = "";
    declaration.sections.pop();
    await save(declarations, declaration);
    await until(() => output.includes("Continuing with previous valid configuration"), `${base} removed section before sync`);
    // Remove its development schema and content explicitly before sync.
    const seed = await json(seedFile);
    seed.collections = seed.collections.filter((collection) => collection.slug !== "lease_faq");
    delete seed.content.lease_faq;
    output = "";
    await save(seedFile, seed);
    await until(() => output.includes("Continuing with previous valid configuration"), `${base} removed section taxonomy before sync`);
    output = "";
    await synchronize();
    await until(() => output.includes("server restarted."), `${base} removed section Astro restart`);
    await until(async () => (await contract()).sections.length === 1 && await status(prefix) === 404, `${base} removed section route`);
    assert.equal(await status("/articles/"), 200);
    assert.ok((await read(division)).includes("<h1>Commercial division</h1>"));
    assert.ok((await read(`${division}about/`)).includes("<h1>About commercial division</h1>"));
    await stop();
    console.log(`Passed EmDash development reloads at ${base}: nested list/entry/feed, division pages, POST ownership, 404/405, invalid-pair recovery, schema JSON, helper changes and removal.`);
  }
} finally {
  await stop();
  await rm(root, { recursive: true, force: true });
}
