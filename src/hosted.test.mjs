import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import { HOST_API_VERSION, SESSION_FILE, runHostedCommand, sessionChanges, hostedPath } from "./hosted.mjs";
import { initializeRepository } from "./core.mjs";
import { registerHostedSessionTools } from "./mcp.mjs";

const file = (name, content, mode = "100644") => ({ path: name, encoding: "base64", content: Buffer.from(content).toString("base64"), mode });
const snapshot = (files, revision = "base", extra = {}) => ({ apiVersion: 1, session: { id: "session-1", systemId: "example/core", baseRevision: revision, status: "open" }, files, ...extra });
const response = (payload, status = 200) => new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
async function fixture(t, files = [file("note.txt", "base")]) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "timds-hosted-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let next = snapshot(files);
  const requests = [];
  const options = { root, token: "timds_test", portalUrl: "https://host.example", fetchImpl: async (url, request) => { requests.push({ url, ...request, body: request.body ? JSON.parse(request.body) : null }); return response(next); } };
  await runHostedCommand("start", { ...options, systemId: "example/core" });
  return { root, options, requests, set(value) { next = value; }, state: async () => JSON.parse(await fs.readFile(path.join(root, SESSION_FILE), "utf8")) };
}

test("host session materializes plain files, uploads changed/deleted paths, reads history and closes", async (t) => {
  const f = await fixture(t, [file("keep.txt", "same"), file("delete.txt", "delete"), file("note.txt", "base")]);
  assert.equal(await fs.stat(path.join(f.root, ".git")).catch(() => null), null);
  await fs.writeFile(path.join(f.root, "note.txt"), "changed");
  await fs.rm(path.join(f.root, "delete.txt"));
  f.set(snapshot([file("keep.txt", "same"), file("note.txt", "changed")], "head", { submission: { id: "submission", previewUrl: "https://preview.example" } }));
  const submitted = await runHostedCommand("submit", { ...f.options, note: "Edit" });
  assert.equal(submitted.submission.id, "submission");
  const request = f.requests.at(-1);
  assert.match(request.url, /\/session-1\/submit$/);
  assert.deepEqual(request.body.deletedPaths, ["delete.txt"]);
  assert.deepEqual(request.body.changedFiles.map(({ path }) => path), ["note.txt"]);
  assert.equal(request.body.baseRevision, "base");
  assert.equal(request.body.apiVersion, HOST_API_VERSION);
  assert.equal(request.headers.Authorization, "Bearer timds_test");
  assert.equal(request.redirect, "error");
  assert.equal((await f.state()).session.baseRevision, "head");
  assert.ok(!(await fs.readFile(path.join(f.root, SESSION_FILE), "utf8")).includes("timds_test"));
  await runHostedCommand("status", f.options);
  await runHostedCommand("history", f.options);
  await runHostedCommand("close", f.options);
  assert.equal((await f.state()).session.status, "closed");
  await assert.rejects(runHostedCommand("submit", f.options), /closed/);
});

test("pull preserves local edits, reports both-side conflicts, and never partially applies a conflict", async (t) => {
  const f = await fixture(t, [file("a.txt", "base"), file("b.txt", "base")]);
  await fs.writeFile(path.join(f.root, "a.txt"), "ours");
  f.set(snapshot([file("a.txt", "theirs"), file("b.txt", "remote")], "next"));
  const result = await runHostedCommand("pull", f.options);
  assert.deepEqual(result.conflicts, ["a.txt"]);
  assert.equal(await fs.readFile(path.join(f.root, "b.txt"), "utf8"), "base");
  assert.equal((await f.state()).session.baseRevision, "base");
  await fs.writeFile(path.join(f.root, "a.txt"), "theirs");
  assert.equal((await runHostedCommand("pull", f.options)).applied, true);
  assert.equal(await fs.readFile(path.join(f.root, "b.txt"), "utf8"), "remote");
});

test("update uses the host merge and permits submitting a fork with no further local changes", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, "note.txt"), "ours");
  f.set(snapshot([file("note.txt", "ours"), file("remote.txt", "new")], "merged"));
  await runHostedCommand("update", f.options);
  assert.equal(await fs.readFile(path.join(f.root, "remote.txt"), "utf8"), "new");
  assert.equal((await f.state()).session.baseRevision, "merged");
  await runHostedCommand("submit", f.options);
  assert.deepEqual(f.requests.at(-1).body.changedFiles, []);
});

test("change sets honor nested gitignore and the tracked-file exception without git", async (t) => {
  const f = await fixture(t, [file(".gitignore", "*.log\nnode_modules/\n"), file("tracked.log", "tracked"), file("src/.gitignore", "private.txt\n"), file("src/keep.txt", "keep")]);
  await fs.writeFile(path.join(f.root, "ignored.log"), "ignored");
  await fs.writeFile(path.join(f.root, "tracked.log"), "edited");
  await fs.writeFile(path.join(f.root, "src/private.txt"), "ignored");
  await fs.writeFile(path.join(f.root, "src/new.txt"), "new");
  await fs.writeFile(path.join(f.root, ".env.server"), "private-value");
  const { changes } = await sessionChanges(f.root, await f.state());
  assert.deepEqual(changes.changedFiles.map(({ path }) => path), ["src/new.txt", "tracked.log"]);
});

test("relative symlinks and executable files round-trip while escape and cycles are refused", async (t) => {
  const f = await fixture(t, [file(".agents/skills/a.md", "skill"), file(".claude/skills", "../.agents/skills", "120000"), file("scripts/task.sh", "#!/bin/sh\n", "100755")]);
  assert.equal(await fs.readlink(path.join(f.root, ".claude/skills")), "../.agents/skills");
  assert.ok((await fs.stat(path.join(f.root, "scripts/task.sh"))).mode & 0o111);
  assert.deepEqual((await sessionChanges(f.root, await f.state())).changes.changedFiles, []);
  await fs.symlink("../../outside", path.join(f.root, "bad"));
  await assert.rejects(sessionChanges(f.root, await f.state()), /Unsafe session file path/);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "timds-hosted-cycle-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await assert.rejects(runHostedCommand("start", { ...f.options, root, systemId: "example/core", fetchImpl: async () => response(snapshot([file("a", "b", "120000"), file("b", "a", "120000")])) }), /Cyclic/);
  assert.deepEqual(await fs.readdir(root), [".timds"]);
  assert.equal(await fs.stat(path.join(root, "a")).catch(() => null), null);
});

test("hosted files reject traversal, credentials, malformed snapshots and linked metadata before mutation", async (t) => {
  for (const name of ["../outside", "/absolute", "a/../../bad", ".git/config", ".env.server", "a\\b", ".timds/Session.json", ".timds/Start.json", SESSION_FILE]) assert.throws(() => hostedPath(name));
  const f = await fixture(t);
  f.set(snapshot([file("safe.txt", "new"), file("../outside", "bad")], "next"));
  await assert.rejects(runHostedCommand("pull", f.options), /Unsafe/);
  assert.equal(await fs.stat(path.join(f.root, "safe.txt")).catch(() => null), null);
  f.set({ apiVersion: 2 });
  await assert.rejects(runHostedCommand("status", f.options), /Unsupported/);
});

test("hosted scaffold has Wrangler/noindex, no workflows, and check works without git installed", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "timds-hosted-scaffold-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await initializeRepository(root, { standalone: true, provider: "hosted", portalUrl: "https://host.example" });
  assert.equal(await fs.stat(path.join(root, ".github")).catch(() => null), null);
  const manifest = JSON.parse(await fs.readFile(path.join(root, "timds.json"), "utf8"));
  assert.equal(manifest.provider.kind, "hosted");
  const wrangler = JSON.parse(await fs.readFile(path.join(root, "wrangler.jsonc"), "utf8"));
  assert.deepEqual(wrangler.assets, { directory: "./dist" });
  assert.deepEqual(wrangler.previews, {});
  assert.match(await fs.readFile(path.join(root, "dist/_headers"), "utf8"), /X-Robots-Tag: noindex/);
  const bin = path.join(root, "local-bin");
  await fs.mkdir(bin); await fs.symlink(process.execPath, path.join(bin, "node"));
  const cli = new URL("../bin/timds.mjs", import.meta.url).pathname;
  await promisify(execFile)(process.execPath, [cli, "check", "--root", root], { env: { ...process.env, PATH: bin }, maxBuffer: 2_000_000 });
});

test("MCP exposes hosted commands and principal-authorized publication", () => {
  const names = [];
  registerHostedSessionTools({ registerTool(name) { names.push(name); } });
  assert.deepEqual(names, ["timds_start", "timds_pull", "timds_submit", "timds_update", "timds_status", "timds_history", "timds_sessions_close", "timds_publish"]);
});

test('hosted publish resolves the current submission, confirms, polls and closes local session metadata', async t => {
  const f = await fixture(t); const calls = []; let confirmed = false;
  const fetchImpl = async (url, request) => {
    const body = request.body && JSON.parse(request.body); calls.push({ url, body });
    if (url.endsWith('/status')) return response({ apiVersion: 1, submissions: [{ id: 'submitted', status: 'submitted' }] });
    if (body?.preflight) return response({ apiVersion: 1, submissionId: 'submitted', sessionId: 'session-1', systemId: 'example/core', version: '1.0.1', previewUrl: 'https://preview.example' });
    if (url.endsWith('/publish')) { assert(confirmed); return response({ apiVersion: 1, publication: { id: 'publication', status: 'queued' } }); }
    return response({ apiVersion: 1, publication: { id: 'publication', status: 'published', result: { publicRoot: 'https://public.example' } } });
  };
  const result = await runHostedCommand('publish', { ...f.options, fetchImpl, wait: async () => {}, confirm: async summary => { assert.equal(summary.version, '1.0.1'); confirmed = true; return true; } });
  assert.equal(result.status, 'published');
  assert.equal((await f.state()).session.status, 'closed');
  assert(calls.some(call => call.url.endsWith('/submissions/submitted/publish')));
  assert(calls.some(call => call.url.endsWith('/publications/publication')));
});

test('explicit submission dry run works without a local session and sends no publish mutation', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'timds-publish-dry-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  let calls = 0;
  const result = await runHostedCommand('publish', { root, submission: 'chosen', dryRun: true, portalUrl: 'https://host.example', token: 'test', fetchImpl: async (url, request) => {
    calls++; assert(url.endsWith('/submissions/chosen/publish')); assert.equal(JSON.parse(request.body).dryRun, true);
    return response({ apiVersion: 1, dryRun: true, buildChecked: true });
  } });
  assert.equal(calls, 1); assert(result.buildChecked); assert.deepEqual(await fs.readdir(root), []);
});

test('hosted publication refusal and background build failures surface as errors', async t => {
  const f = await fixture(t);
  const options = { ...f.options, submission: 'chosen', yes: true, wait: async () => {} };
  await assert.rejects(runHostedCommand('publish', { ...options, fetchImpl: async () => response({ error: 'Publish grant required' }, 403) }), /Publish grant required/);
  await assert.rejects(runHostedCommand('publish', { ...options, fetchImpl: async (url, request) => {
    const body = request.body && JSON.parse(request.body);
    if (body?.preflight) return response({ apiVersion: 1 });
    return response({ apiVersion: 1, publication: { id: 'failure', status: 'failed', error: 'Build failed' } });
  } }), /Build failed/);
  await assert.rejects(runHostedCommand('publish', { ...options, fetchImpl: async (url, request) => {
    if (request.body && JSON.parse(request.body).preflight) return response({ apiVersion: 1 });
    return response({ apiVersion: 1, publication: { id: 'cleanup', status: 'closing', error: 'Preview removal failed' } });
  } }), /session cleanup failed/);
});

test("hosted commands without host configuration explain local and git modes", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "timds-no-host-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await assert.rejects(runHostedCommand("start", { root, systemId: "example/core", token: "timds_test" }), /local mode.*git mode/);
});

test("explicit conflict resolution keeps ours and binds the retry to the main revision shown", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, "note.txt"), "ours");
  f.set(snapshot([file("note.txt", "base")], "base", { conflicts: ["note.txt"], mainRevision: "main-2" }));
  assert.deepEqual((await runHostedCommand("update", f.options)).conflicts, ["note.txt"]);
  assert.equal(await fs.readFile(path.join(f.root, "note.txt"), "utf8"), "ours");
  assert.equal((await f.state()).session.baseRevision, "base");
  f.set(snapshot([file("note.txt", "ours")], "resolved"));
  await runHostedCommand("update", { ...f.options, resolve: ["note.txt"] });
  assert.deepEqual(f.requests.at(-1).body.resolvedPaths, ["note.txt"]);
  assert.equal(f.requests.at(-1).body.mainRevision, "main-2");
  assert.equal(await fs.readFile(path.join(f.root, "note.txt"), "utf8"), "ours");
  assert.equal((await f.state()).pendingConflicts, undefined);
  await runHostedCommand("submit", f.options);
  assert.equal(f.requests.at(-1).body.baseRevision, "resolved");
});

test("pull applies file/directory transitions without deleting untracked siblings", async (t) => {
  const f = await fixture(t, [file("one", "file"), file("two/child", "child")]);
  f.set(snapshot([file("one/child", "nested"), file("two", "file")], "next"));
  await runHostedCommand("pull", f.options);
  assert.equal(await fs.readFile(path.join(f.root, "one/child"), "utf8"), "nested");
  assert.equal(await fs.readFile(path.join(f.root, "two"), "utf8"), "file");
  await fs.writeFile(path.join(f.root, "one/untracked"), "keep");
  f.set(snapshot([file("one", "replacement"), file("two", "changed")], "newer"));
  await assert.rejects(runHostedCommand("pull", f.options), /overwrite a local path/);
  assert.equal(await fs.readFile(path.join(f.root, "one/child"), "utf8"), "nested");
  assert.equal(await fs.readFile(path.join(f.root, "one/untracked"), "utf8"), "keep");
  assert.equal(await fs.readFile(path.join(f.root, "two"), "utf8"), "file");
});

test("symlink targets cannot hide parent traversal after another link", async (t) => {
  const f = await fixture(t);
  f.set(snapshot([file("a", "deep/b/../../outside", "120000"), file("deep/b", "../d", "120000"), file("d/file", "safe")], "next"));
  await assert.rejects(runHostedCommand("pull", f.options), /Unsafe session symlink/);
  assert.equal(await fs.stat(path.join(f.root, "a")).catch(() => null), null);
});

test("large valid base64 snapshots stay within limits without regex stack overflow", async (t) => {
  const content = "x".repeat(1024 * 1024);
  const f = await fixture(t, [file("large.txt", content)]);
  assert.equal((await fs.stat(path.join(f.root, "large.txt"))).size, content.length);
  assert.deepEqual((await sessionChanges(f.root, await f.state())).changes.changedFiles, []);
});

test("an interrupted start retries the same fork key without storing credentials", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "timds-retry-start-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const requests = [];
  const options = { root, systemId: "example/core", token: "timds_secret", portalUrl: "https://host.example", fetchImpl: async (_url, request) => {
    requests.push(JSON.parse(request.body));
    if (requests.length === 1) throw new Error("response lost");
    return response(snapshot([file("note.txt", "base")]));
  } };
  await assert.rejects(runHostedCommand("start", options), /response lost/);
  const pending = await fs.readFile(path.join(root, ".timds/start.json"), "utf8");
  assert.ok(!pending.includes("timds_secret"));
  await assert.rejects(runHostedCommand("start", { ...options, systemId: "different/core" }), /another system/);
  await runHostedCommand("start", options);
  assert.equal(requests[0].idempotencyKey, requests[1].idempotencyKey);
  assert.equal(await fs.stat(path.join(root, ".timds/start.json")).catch(() => null), null);
  assert.equal(await fs.readFile(path.join(root, "note.txt"), "utf8"), "base");
});


test("snapshot refuses paths that collide on a case-insensitive filesystem before writing", async (t) => {
  const f = await fixture(t);
  f.set(snapshot([file("Name.txt", "one"), file("name.txt", "two")], "next"));
  await assert.rejects(runHostedCommand("pull", f.options), /collide/);
  assert.equal(await fs.stat(path.join(f.root, "Name.txt")).catch(() => null), null);
  f.set(snapshot([file("Folder", "file"), file("folder/child", "child")], "next"));
  await assert.rejects(runHostedCommand("pull", f.options), /Conflicting session file path/);
});
