// Smoke test: the stock pages name the release. A versioned system builds its
// version into the app bar, the Use card and the Install sentence as before;
// an unversioned one builds hidden version slots that the page fills from its
// own response's X-TimDS-Version header (the label a host assigns at
// publication), and its built artifact stays the same from build to build.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const cli = fileURLToPath(new URL("../bin/timds.mjs", import.meta.url));
const timds = (...args) => execFileSync(process.execPath, [cli, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 8 * 1024 * 1024 });
const PAGES = ["index.html", "use/install/index.html", "use/compose/index.html"];

async function walk(root, relative = "") {
  const found = new Map();
  for (const entry of await fs.readdir(path.join(root, relative), { withFileTypes: true })) {
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) for (const [file, bytes] of await walk(root, child)) found.set(file, bytes);
    else if (entry.isFile()) found.set(child, await fs.readFile(path.join(root, child)));
  }
  return found;
}

const page = (root, file) => fs.readFile(path.join(root, "dist", file), "utf8");
// The text a reader sees before any script runs: hidden elements and tags removed.
const visibleText = (html) => html
  .replace(/<script\b[\s\S]*?<\/script>/gi, "")
  .replace(/<(\w+)\b[^>]*\shidden\b[^>]*>[\s\S]*?<\/\1>/gi, "")
  .replace(/<[^>]*>/g, "")
  .replace(/\s+/g, " ");

// Runs the page's own scripts against its version slots, with a fetch that
// answers the given header, and returns the slots' text afterwards.
async function runSlots(html, header) {
  const slots = [...html.matchAll(/<[a-z]+\b([^>]*\bdata-timds-version="[^"]*"[^>]*)>/g)].map(([, attributes]) => {
    const attribute = (name) => new RegExp(`\\b${name}="([^"]*)"`).exec(attributes)?.[1]?.replaceAll("&quot;", '"') ?? null;
    return { hidden: /\shidden\b/.test(attributes), textContent: "", getAttribute: attribute };
  });
  const requests = [];
  const document = { querySelectorAll: (selector) => selector === "[data-timds-version]" ? slots : [], querySelector: () => null };
  const fetch = async (url, init = {}) => {
    requests.push(`${init.method || "GET"} ${url}`);
    return new Response(null, { status: 200, headers: header ? { "X-TimDS-Version": header } : {} });
  };
  const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]).find((source) => source.includes("X-TimDS-Version"));
  assert.ok(script, "the page carries the release label script");
  vm.runInNewContext(script, { document, fetch, location: { href: "https://ds.example.com/use/install/#product", protocol: "https:" } });
  await new Promise((resolve) => setTimeout(resolve, 20));
  return { requests, slots: slots.map((slot) => (slot.hidden ? null : slot.textContent)) };
}

test("stock pages show a declared version as before and an unversioned system's host label at view time", async (t) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "timds-release-label-")));
  t.after(() => fs.rm(root, { force: true, recursive: true, maxRetries: 5, retryDelay: 50 }));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  timds("init", "--standalone", "--root", root, "--name", "Example", "--system-id", "timds-example/release-label");
  const manifestPath = path.join(root, "timds.json");
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  const version = manifest.version;
  assert.ok(version, "init scaffolds a versioned system");

  // Versioned: the version is built in, and no slot or label script is added.
  assert.match(timds("check", "--root", root), /TimDS check passed/);
  const [home, install, compose] = await Promise.all(PAGES.map((file) => page(root, file)));
  assert.ok(home.includes(`<a class="appbar__version" href="/changelog/" title="Changelog">v${version}</a>`));
  assert.ok(home.includes(`<span class="asset-card__glyph" aria-hidden="true">v${version}</span>`));
  assert.ok(install.includes(`<p class="note">This copy is ${version}. A read that fails`));
  assert.ok(compose.includes(`The app bar names this copy's version: ${version}.</p>`));
  for (const html of [home, install, compose]) assert.ok(!html.includes("data-timds-version") && !html.includes("X-TimDS-Version"));

  // Unversioned: nothing dangles in the static page, the slots are marked.
  delete manifest.version;
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  await fs.writeFile(path.join(root, "CHANGELOG.md"), "# Changelog\n\n## Unreleased\n\n- Foundations: start the system.\n");
  assert.match(timds("check", "--root", root), /TimDS check passed/);
  const first = await walk(path.join(root, "dist"));
  const unversioned = await Promise.all(PAGES.map((file) => page(root, file)));
  for (const html of unversioned) {
    assert.doesNotMatch(html, />\s*v\s*</, "no bare v");
    assert.doesNotMatch(visibleText(html), /This copy is|names this copy's version/, "no sentence without its label");
    assert.equal(html.match(/X-TimDS-Version/g)?.length, 1, "one label script per page");
  }
  assert.ok(unversioned[0].includes('<a class="appbar__version" href="/changelog/" title="Changelog" data-timds-version="v" hidden></a>'));
  assert.ok(unversioned[1].includes('<p class="note"><span data-timds-version="This copy is " data-timds-version-after="." hidden></span> A read that fails'));

  // The built artifact is the same from one build to the next: no label or date is baked in.
  assert.match(timds("check", "--root", root), /TimDS check passed/);
  const second = await walk(path.join(root, "dist"));
  assert.deepEqual([...second.keys()].sort(), [...first.keys()].sort());
  for (const [file, bytes] of first) assert.ok(bytes.equals(second.get(file)), `${file} is identical across builds`);

  // At view time: one request for the page's own headers fills every slot
  // with a valid label, and anything else leaves them hidden.
  const shown = await runSlots(unversioned[0], "2026.11.17-1");
  assert.deepEqual(shown.requests, ["HEAD https://ds.example.com/use/install/"]);
  assert.deepEqual(shown.slots, ["v2026.11.17-1", "v2026.11.17-1"]);
  assert.deepEqual((await runSlots(unversioned[1], "2026.11.17-1")).slots, ["v2026.11.17-1", "This copy is 2026.11.17-1."]);
  assert.deepEqual((await runSlots(unversioned[1], null)).slots, [null, null]);
  assert.deepEqual((await runSlots(unversioned[1], "<b>2026</b>")).slots, [null, null]);
});
