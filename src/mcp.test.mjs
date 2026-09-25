import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { initializeRepository, loadWorkspace } from "./core.mjs";
import {
  authoredSurfaceRoot,
  createDesignSystemMcpServer,
  editingGuideText,
  isProtectedPath,
  registerDesignSystemTools,
} from "./mcp.mjs";

async function temporaryDirectory(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "timds-mcp-"));
  t.after(() => fs.rm(directory, { force: true, recursive: true, maxRetries: 5, retryDelay: 50 }));
  return fs.realpath(directory);
}

function gitInit(repoRoot) {
  execFileSync("git", ["init", "-b", "main"], { cwd: repoRoot, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "timds-test@example.com"], { cwd: repoRoot });
  execFileSync("git", ["config", "user.name", "TimDS Test"], { cwd: repoRoot });
}

async function standaloneRepo(t) {
  const repoRoot = await temporaryDirectory(t);
  gitInit(repoRoot);
  await initializeRepository(repoRoot, { standalone: true });
  return repoRoot;
}

async function embeddedRepo(t) {
  const repoRoot = await temporaryDirectory(t);
  gitInit(repoRoot);
  await initializeRepository(repoRoot);
  return repoRoot;
}

async function connect(server) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "timds-test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

async function call(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  return result;
}

async function ok(client, name, args = {}) {
  const result = await call(client, name, args);
  assert.ok(!result.isError, `${name} failed: ${result.content?.[0]?.text}`);
  return result.structuredContent;
}

const STANDALONE_PROTECTED = [
  ".git/config",
  ".timds/installation.json",
  ".agents/skills/timds-edit-design-system/SKILL.md",
  ".github/workflows/timds-design-system.yml",
  "package.json",
  "package-lock.json",
  "node_modules/example/index.js",
  "dist/index.html",
  "timds.json",
  "media.json",
  ".gitignore",
  "media-local/original.png",
  "video-local/render.mp4",
  "src/node_modules/x.js",
  "src/.gitignore",
  "scripts/release.mjs",
  "scripts/release.sh",
  "scripts/check-versions.mjs",
  "scripts/prepare-merge-release.mjs",
  "scripts/prepare-merge-release.test.mjs",
];

test("refuses every protected path, traversal, and absolute path on a standalone system", async (t) => {
  const repoRoot = await standaloneRepo(t);
  const workspace = await loadWorkspace(repoRoot);
  assert.equal(authoredSurfaceRoot(workspace), ".");
  for (const protectedPath of [...STANDALONE_PROTECTED, "../outside.txt", "src/../../outside.txt", "/etc/passwd", "C:/Windows/x", ""]) {
    assert.equal(isProtectedPath(workspace, protectedPath), true, protectedPath);
  }
  assert.equal(isProtectedPath(workspace, "src/index.html"), false);
  assert.equal(isProtectedPath(workspace, "src/pages/new.html"), false);
  for (const authored of ["scripts/build.mjs", "scripts/check.mjs", "scripts/dev.mjs", "scripts/optimize-images.mjs"]) {
    assert.equal(isProtectedPath(workspace, authored), false, authored);
  }

  const client = await connect(await createDesignSystemMcpServer({ root: repoRoot }));
  for (const protectedPath of [...STANDALONE_PROTECTED, "../outside.txt", "/tmp/outside.txt"]) {
    const written = await call(client, "write_file", { path: protectedPath, content: "x" });
    assert.equal(written.isError, true, `write ${protectedPath}`);
    const read = await call(client, "read_file", { path: protectedPath });
    assert.equal(read.isError, true, `read ${protectedPath}`);
    const deleted = await call(client, "delete_file", { path: protectedPath });
    assert.equal(deleted.isError, true, `delete ${protectedPath}`);
  }
  // The manifest was not touched.
  JSON.parse(await fs.readFile(path.join(repoRoot, "timds.json"), "utf8"));
  await assert.rejects(fs.access(path.join(repoRoot, "..", "outside.txt")));
});

test("refuses symbolic links to files and through linked directories", async (t) => {
  const repoRoot = await standaloneRepo(t);
  const outside = await temporaryDirectory(t);
  await fs.writeFile(path.join(outside, "secret.txt"), "secret\n", "utf8");
  await fs.symlink(path.join(outside, "secret.txt"), path.join(repoRoot, "src", "linked.txt"));
  await fs.symlink(outside, path.join(repoRoot, "src", "linked-dir"));
  const workspace = await loadWorkspace(repoRoot);
  assert.equal(isProtectedPath(workspace, "src/linked.txt"), true);
  assert.equal(isProtectedPath(workspace, "src/linked-dir/secret.txt"), true);
  assert.equal(isProtectedPath(workspace, "src/linked-dir/new.txt"), true);

  const client = await connect(await createDesignSystemMcpServer({ root: repoRoot }));
  assert.equal((await call(client, "read_file", { path: "src/linked.txt" })).isError, true);
  assert.equal((await call(client, "write_file", { path: "src/linked.txt", content: "x" })).isError, true);
  assert.equal((await call(client, "write_file", { path: "src/linked-dir/new.txt", content: "x" })).isError, true);
  assert.equal((await call(client, "delete_file", { path: "src/linked-dir/secret.txt" })).isError, true);
  assert.equal(await fs.readFile(path.join(outside, "secret.txt"), "utf8"), "secret\n");
  await assert.rejects(fs.access(path.join(outside, "new.txt")));
  const listed = await ok(client, "list_files", {});
  assert.ok(!listed.files.some((file) => file.path.startsWith("src/linked")));
});

test("writes, reads, lists, and deletes authored files and reports each change to afterWrite", async (t) => {
  const repoRoot = await standaloneRepo(t);
  const changes = [];
  const server = new McpServer({ name: "timds-design-system", version: "0.0.0" });
  registerDesignSystemTools(server, {
    resolveWorkspace: () => loadWorkspace(repoRoot),
    hooks: {
      afterWrite(workspace, change) {
        assert.equal(workspace.repoRoot, repoRoot);
        changes.push(change);
        return { commit: `c${changes.length}` };
      },
    },
  });
  const client = await connect(server);

  const written = await ok(client, "write_file", { path: "src/pages/about.html", content: "<h1>About</h1>\n", note: "Add about page" });
  assert.equal(written.created, true);
  assert.deepEqual(written.hook, { commit: "c1" });
  assert.deepEqual(changes[0], { paths: ["src/pages/about.html"], note: "Add about page" });
  const read = await ok(client, "read_file", { path: "src/pages/about.html" });
  assert.equal(read.content, "<h1>About</h1>\n");
  assert.equal(read.encoding, "utf8");
  assert.equal(read.sha256, written.sha256);

  const replaced = await ok(client, "write_file", { path: "src/pages/about.html", content: "<h1>About us</h1>\n" });
  assert.equal(replaced.created, false);
  assert.deepEqual(changes[1], { paths: ["src/pages/about.html"], note: undefined });
  const entries = await fs.readdir(path.join(repoRoot, "src", "pages"));
  assert.deepEqual(entries, ["about.html"], "no temporary files remain");

  const listed = await ok(client, "list_files", { path: "src" });
  assert.ok(listed.files.some((file) => file.path === "src/pages/about.html"));
  assert.ok(listed.files.every((file) => file.path.startsWith("src/")));
  const css = await ok(client, "list_files", { glob: "**/*.css" });
  assert.deepEqual(css.files.map((file) => file.path), ["src/styles.css"]);
  const everything = await ok(client, "list_files", {});
  for (const file of everything.files) assert.equal(isProtectedPath(await loadWorkspace(repoRoot), file.path), false, file.path);
  assert.ok(!everything.files.some((file) => /^(dist|node_modules|\.timds|\.agents|\.github)\//.test(file.path)));

  const deleted = await ok(client, "delete_file", { path: "src/pages/about.html", note: "Remove about page" });
  assert.equal(deleted.deleted, true);
  assert.deepEqual(changes[2], { paths: ["src/pages/about.html"], note: "Remove about page" });
  assert.equal((await call(client, "read_file", { path: "src/pages/about.html" })).isError, true);
  assert.equal((await call(client, "delete_file", { path: "src/pages/about.html" })).isError, true);
});

test("remote mode requires a draftId and passes it to resolveWorkspace", async (t) => {
  const repoRoot = await standaloneRepo(t);
  const drafts = [];
  const server = new McpServer({ name: "timds-design-system", version: "0.0.0" });
  registerDesignSystemTools(server, {
    resolveWorkspace: (request) => {
      drafts.push(request);
      if (request?.draftId !== "draft-1") throw new Error("Unknown draft");
      return loadWorkspace(repoRoot);
    },
    hooks: { remote: true },
  });
  const client = await connect(server);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((tool) => tool.name).sort(), [
    "delete_file", "describe_workspace", "get_editing_guide", "list_files", "list_media",
    "read_derived", "read_file", "run_check", "write_file",
  ]);
  for (const tool of tools) assert.ok(tool.inputSchema.required?.includes("draftId"), tool.name);
  assert.equal((await call(client, "list_files", {})).isError, true);
  assert.equal((await call(client, "list_files", { draftId: "nope" })).isError, true);
  await ok(client, "list_files", { draftId: "draft-1" });
  assert.deepEqual(drafts.at(-1), { draftId: "draft-1" });
});

test("restricts an embedded system to design-system/**", async (t) => {
  const repoRoot = await embeddedRepo(t);
  await fs.writeFile(path.join(repoRoot, "app.js"), "console.log('app')\n", "utf8");
  const workspace = await loadWorkspace(repoRoot);
  assert.equal(authoredSurfaceRoot(workspace), "design-system");
  for (const outside of ["app.js", "README.md", "package.json", ".github/workflows/timds-design-system.yml", "design-system/timds.json", "design-system/media.json", "design-system/dist/index.html", "design-system/.timds/installation.json", "design-system/media-local/a.png", "design-system/.gitignore", "design-system/scripts/release.mjs"]) {
    assert.equal(isProtectedPath(workspace, outside), true, outside);
  }
  assert.equal(isProtectedPath(workspace, "design-system/src/index.html"), false);

  const client = await connect(await createDesignSystemMcpServer({ root: repoRoot }));
  assert.equal((await call(client, "write_file", { path: "app.js", content: "x" })).isError, true);
  assert.equal((await call(client, "read_file", { path: "app.js" })).isError, true);
  await ok(client, "write_file", { path: "design-system/src/extra.css", content: ":root{}\n" });
  const listed = await ok(client, "list_files", {});
  assert.ok(listed.files.length > 0);
  assert.ok(listed.files.every((file) => file.path.startsWith("design-system/")));
  assert.ok(listed.files.some((file) => file.path === "design-system/src/extra.css"));
  const described = await ok(client, "describe_workspace", {});
  assert.equal(described.layout, "embedded");
  assert.equal(described.authoredSurface, "design-system/**");
  assert.ok(described.protectedPaths.includes("design-system/timds.json"));
  assert.ok(described.authoredDirectories.some((entry) => entry.path === "design-system/src"));
});

test("run_check returns structured findings and read_derived serves the derived layer", async (t) => {
  const repoRoot = await standaloneRepo(t);
  const client = await connect(await createDesignSystemMcpServer({ root: repoRoot }));

  const described = await ok(client, "describe_workspace", {});
  assert.equal(described.layout, "standalone");
  assert.match(described.systemId, /\/core$/);
  assert.deepEqual(described.workspaceCommands.build, ["node", "scripts/build.mjs"]);
  assert.match(described.brandKit.report, /Roles|Brand kit/);

  const checked = await ok(client, "run_check", {});
  assert.ok(["passed", "warnings"].includes(checked.status), JSON.stringify(checked.errors));
  assert.deepEqual(checked.errors, []);
  assert.ok(Array.isArray(checked.warnings));
  assert.equal(checked.status === "warnings", checked.warnings.length > 0);
  assert.ok(checked.artifact.fileCount > 0);
  assert.ok(checked.artifact.totalBytes > 0);
  assert.equal(checked.brand.derived, true);
  assert.ok(Array.isArray(checked.brand.gaps));
  assert.ok(checked.log.some((line) => /Running build/.test(line)), "build progress is captured, not printed");

  for (const name of ["brand", "tokens", "index"]) {
    const derived = await ok(client, "read_derived", { name });
    assert.equal(derived.name, name);
    assert.equal(derived.stale, false);
    assert.ok(derived.content && typeof derived.content === "object", name);
  }
  assert.equal((await call(client, "read_derived", { name: "llms" })).isError, true);

  const media = await ok(client, "list_media", {});
  assert.equal(media.total, 0);
  assert.equal((await ok(client, "list_media", { tag: "b-roll" })).total, 0);

  // A broken build is reported as a failed status rather than a thrown error.
  await ok(client, "write_file", { path: "scripts/build.mjs", content: "console.error('broken build'); process.exit(3);\n" });
  const failed = await ok(client, "run_check", {});
  assert.equal(failed.status, "failed");
  assert.match(failed.errors[0], /broken build/);
  assert.equal(failed.artifact, null);
});

test("read_derived before any check says to run the check", async (t) => {
  const repoRoot = await standaloneRepo(t);
  await fs.rm(path.join(repoRoot, "dist"), { recursive: true, force: true });
  const client = await connect(await createDesignSystemMcpServer({ root: repoRoot }));
  const result = await call(client, "read_derived", { name: "brand" });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /run_check/);
});

test("the editing guide carries the rules without local-only steps", async (t) => {
  const guide = editingGuideText();
  for (const rule of ["authored surface", "timds.json", "data-timds-role", "list_media", "run_check", "Submit only when asked", "dist/"]) {
    assert.ok(guide.includes(rule), rule);
  }
  for (const local of ["npm ci", "git switch", "git clone", "npm run timds", "doctor", "timds -- dev"]) {
    assert.ok(!guide.includes(local), local);
  }

  const repoRoot = await standaloneRepo(t);
  const client = await connect(await createDesignSystemMcpServer({ root: repoRoot }));
  const fromTool = await ok(client, "get_editing_guide", {});
  assert.equal(fromTool.guide, guide);
  const resource = await client.readResource({ uri: "timds://guide" });
  assert.equal(resource.contents[0].text, guide);
  const { tools } = await client.listTools();
  const annotations = Object.fromEntries(tools.map((tool) => [tool.name, tool.annotations]));
  assert.equal(annotations.read_file.readOnlyHint, true);
  assert.equal(annotations.write_file.readOnlyHint, false);
  assert.equal(annotations.delete_file.destructiveHint, true);
  for (const tool of tools) assert.ok(!Object.hasOwn(tool.inputSchema.properties ?? {}, "draftId"), tool.name);
});
