import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  CONSUMER_NOTES_PATH,
  DESIGNER_REQUEST_MARKER,
  fetchConsumerNotes,
  formatConsumerNotes,
  parseNotesComment,
  resolveConsumerNote,
  runConsumerNotes,
} from "./consumer-notes.mjs";
import { runConsumerCli } from "./consumer.mjs";

const NOTES = [
  {
    id: "note_1",
    repository: "acme/product",
    app: "web",
    pullRequest: 12,
    previewId: "prev_a",
    commit: "abc1234",
    route: "/contact",
    viewport: "phone",
    scheme: "dark",
    point: { x: 120, y: 340 },
    element: {
      id: "e14",
      selector: "main > section.hero > h1",
      tag: "h1",
      text: "Talk to   a lawyer\ntoday",
      source: { file: "web/src/pages/contact.astro", line: 14, column: 5 },
      rect: [16, 300, 343, 80],
    },
    body: "This heading is too big on phones.\nMatch the size on the home page.",
    authorName: "Dana",
    status: "open",
  },
  {
    id: "note_2",
    route: "/",
    viewport: "desktop",
    scheme: "light",
    point: { x: 10, y: 20 },
    element: { id: "e2", selector: "footer a", tag: "a", text: "Privacy", source: null, rect: [0, 0, 10, 10] },
    body: "Footer links feel cramped.",
    authorName: "Dana",
    status: "sent",
  },
  {
    id: "note_3",
    route: "/contact",
    viewport: "desktop",
    scheme: "light",
    point: { x: 5, y: 6 },
    element: null,
    body: "More breathing room above the form.",
    status: "open",
  },
];

async function temporaryDirectory(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "timds-consumer-notes-"));
  t.after(() => fs.rm(directory, { force: true, recursive: true, maxRetries: 5, retryDelay: 50 }));
  return fs.realpath(directory);
}

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** A consumer repo with one app, an origin remote, and one commit. */
async function createConsumerRepo(t) {
  const root = await temporaryDirectory(t);
  git(root, "init", "-b", "main");
  git(root, "config", "user.email", "timds-test@example.com");
  git(root, "config", "user.name", "TimDS Test");
  git(root, "remote", "add", "origin", "git@github.com:acme/product.git");
  await fs.writeFile(path.join(root, "timds.consumer.json"), `${JSON.stringify({
    schemaVersion: 1,
    designSystem: { path: "design-system", systemId: "acme/core" },
    apps: {
      web: {
        cwd: "web",
        preview: { serve: ["npm", "run", "dev"], port: 4321, routes: ["/", "/contact"] },
        designSurface: ["src/**"],
      },
    },
  }, null, 2)}\n`, "utf8");
  git(root, "add", ".");
  git(root, "commit", "-m", "Initial");
  return root;
}

function stubFetch(responder) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: new URL(url), init });
    const { status = 200, body = {} } = await responder(new URL(url), init);
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  };
  return { calls, fetchImpl };
}

test("fetchConsumerNotes asks for open notes on one pull request with the bearer token", async () => {
  const { calls, fetchImpl } = stubFetch(() => ({ body: { notes: NOTES } }));
  const result = await fetchConsumerNotes({
    repository: "acme/product",
    app: "web",
    pullRequest: 12,
    portalUrl: "https://portal.example.test/some/path",
    token: "test-token",
    fetchImpl,
  });
  assert.deepEqual(result, { notes: NOTES });
  assert.equal(calls.length, 1);
  const { url, init } = calls[0];
  assert.equal(url.origin, "https://portal.example.test");
  assert.equal(url.pathname, CONSUMER_NOTES_PATH);
  assert.deepEqual(Object.fromEntries(url.searchParams), { repository: "acme/product", app: "web", pullRequest: "12", status: "open" });
  assert.equal(init.method, "GET");
  assert.equal(init.headers.Authorization, "Bearer test-token");

  await fetchConsumerNotes({ repository: "acme/product", app: "web", pullRequest: 12, all: true, portalUrl: "https://portal.example.test", token: "test-token", fetchImpl });
  assert.equal(calls[1].url.searchParams.has("status"), false);
});

test("fetchConsumerNotes reports refusals and missing context plainly", async () => {
  const refused = stubFetch(() => ({ status: 403, body: { error: "token is not bound to acme" } }));
  await assert.rejects(
    fetchConsumerNotes({ repository: "acme/product", app: "web", pullRequest: 12, token: "test-token", fetchImpl: refused.fetchImpl }),
    /Reading designer notes was refused \(403\): token is not bound to acme\. Check that TIMDS_ACCESS_TOKEN/,
  );
  const broken = stubFetch(() => ({ status: 200, body: {} }));
  await assert.rejects(
    fetchConsumerNotes({ repository: "acme/product", app: "web", pullRequest: 12, token: "test-token", fetchImpl: broken.fetchImpl }),
    /returned no notes list/,
  );
  await assert.rejects(fetchConsumerNotes({ app: "web", pullRequest: 1, token: "t" }), /needs repository/);
});

test("resolveConsumerNote patches status and commit", async () => {
  const { calls, fetchImpl } = stubFetch((_url, init) => ({ body: { note: { id: "note 1/x", ...JSON.parse(init.body) } } }));
  const addressed = await resolveConsumerNote("note 1/x", { commit: "deadbeef", portalUrl: "https://portal.example.test", token: "test-token", fetchImpl });
  assert.equal(calls[0].init.method, "PATCH");
  assert.equal(calls[0].url.pathname, `${CONSUMER_NOTES_PATH}/note%201%2Fx`);
  assert.deepEqual(JSON.parse(calls[0].init.body), { status: "addressed", commit: "deadbeef" });
  assert.equal(calls[0].init.headers["Content-Type"], "application/json");
  assert.equal(addressed.status, "addressed");

  await resolveConsumerNote("note_2", { commit: "deadbeef", dismiss: true, token: "test-token", fetchImpl });
  assert.deepEqual(JSON.parse(calls[1].init.body), { status: "dismissed", commit: "deadbeef" });

  const missing = stubFetch(() => ({ status: 404, body: { error: "no such note" } }));
  await assert.rejects(resolveConsumerNote("nope", { commit: "c", token: "t", fetchImpl: missing.fetchImpl }), /Resolving note nope failed \(404\): no such note/);
});

test("formatConsumerNotes groups by route and keeps the designer's words verbatim", () => {
  const text = formatConsumerNotes(NOTES, { repository: "acme/product", app: "web", pullRequest: 12 });
  assert.match(text, /^3 open designer notes for acme\/product, app web, pull request #12\./);
  // Grouped by route in first-seen order, both /contact notes together.
  assert.ok(text.indexOf("Page /contact") < text.indexOf("Page /\n"), text);
  assert.match(text, /Page \/contact\n- Note note_1 \(phone, dark\) from Dana\n  Source: web\/src\/pages\/contact\.astro:14:5\n  Element: main > section\.hero > h1 <h1>\n  Text: "Talk to a lawyer today"\n  Designer:\n    > This heading is too big on phones\.\n    > Match the size on the home page\.\n- Note note_3 \(desktop, light\)/);
  assert.match(text, /- Note note_3[^\n]*\n  Point: x 5, y 6 on the desktop capture \(no element under it\)/);
  assert.match(text, /- Note note_2 \(desktop, light\) from Dana\n  Source: unknown/);
  assert.match(text, /npm run timds -- consumer notes resolve note_1 note_2 note_3$/);

  assert.equal(formatConsumerNotes([], { repository: "acme/product", app: "web", pullRequest: 12 }), "No open designer notes for acme/product, app web, pull request #12.");
  const all = formatConsumerNotes([{ ...NOTES[0], status: "addressed" }], { all: true });
  assert.match(all, /^1 designer note\./);
  assert.match(all, /\(phone, dark, addressed\)/);
  assert.doesNotMatch(all, /consumer notes resolve/);
});

test("parseNotesComment reads the portal's designer request comment", () => {
  const body = [
    DESIGNER_REQUEST_MARKER,
    "Dana left 2 notes on the preview:",
    "",
    "1. /contact (phone): This heading is too big on phones.",
    "",
    "```json",
    JSON.stringify({ notes: NOTES.slice(0, 2) }, null, 2),
    "```",
  ].join("\r\n");
  assert.deepEqual(parseNotesComment(body), NOTES.slice(0, 2));
  assert.deepEqual(parseNotesComment(`${DESIGNER_REQUEST_MARKER}\n\`\`\`json\n${JSON.stringify(NOTES)}\n\`\`\``), NOTES);
  assert.equal(parseNotesComment("Looks good to me ```json\n[]\n```"), null);
  assert.equal(parseNotesComment(undefined), null);
  assert.throws(() => parseNotesComment(`${DESIGNER_REQUEST_MARKER}\nno block`), /has no ```json block/);
  assert.throws(() => parseNotesComment(`${DESIGNER_REQUEST_MARKER}\n\`\`\`json\n{nope\n\`\`\``), /not valid JSON/);
  assert.throws(() => parseNotesComment(`${DESIGNER_REQUEST_MARKER}\n\`\`\`json\n{"items":[]}\n\`\`\``), /must be an array of notes/);
});

test("consumer notes resolves repository, app, and pull request from the checkout", async (t) => {
  const root = await createConsumerRepo(t);
  const { calls, fetchImpl } = stubFetch(() => ({ body: { notes: NOTES } }));
  const lines = [];
  const result = await runConsumerNotes(["--root", root, "--portal-url", "https://portal.example.test"], {
    output: (line) => lines.push(line),
    env: { GITHUB_REF: "refs/pull/12/merge" },
    fetchImpl,
    token: "test-token",
  });
  assert.equal(result.repository, "acme/product");
  assert.equal(result.app, "web");
  assert.equal(result.pullRequest, 12);
  assert.deepEqual(Object.fromEntries(calls[0].url.searchParams), { repository: "acme/product", app: "web", pullRequest: "12", status: "open" });
  assert.match(lines.join("\n"), /3 open designer notes for acme\/product, app web, pull request #12\./);

  // --json prints the list unchanged; --pull-request wins over GITHUB_REF; --all drops the status filter.
  lines.length = 0;
  await runConsumerNotes(["--root", root, "--json", "--all", "--pull-request", "7", "--app", "web"], {
    output: (line) => lines.push(line),
    env: { GITHUB_REF: "refs/pull/12/merge" },
    fetchImpl,
    token: "test-token",
  });
  assert.deepEqual(JSON.parse(lines.join("\n")), { notes: NOTES });
  assert.equal(calls[1].url.searchParams.get("pullRequest"), "7");
  assert.equal(calls[1].url.searchParams.has("status"), false);

  await assert.rejects(runConsumerNotes(["--root", root, "--app", "docs", "--pull-request", "7"], { fetchImpl, token: "t" }), /Unknown app "docs"/);
  await assert.rejects(runConsumerNotes(["--root", root, "--bogus"], { fetchImpl, token: "t" }), /Unknown option --bogus/);
  await assert.rejects(runConsumerNotes(["--root", root, "--pull-request", "7", "--dismiss"], { fetchImpl, token: "t" }), /belong to `timds consumer notes resolve`/);
});

test("consumer notes resolve marks each id at HEAD by default", async (t) => {
  const root = await createConsumerRepo(t);
  const head = git(root, "rev-parse", "HEAD");
  const { calls, fetchImpl } = stubFetch((_url, init) => ({ body: { note: JSON.parse(init.body) } }));
  const lines = [];
  await runConsumerNotes(["resolve", "note_1", "note_3", "--root", root], { output: (line) => lines.push(line), fetchImpl, token: "test-token" });
  assert.deepEqual(calls.map((call) => call.url.pathname), [`${CONSUMER_NOTES_PATH}/note_1`, `${CONSUMER_NOTES_PATH}/note_3`]);
  for (const call of calls) assert.deepEqual(JSON.parse(call.init.body), { status: "addressed", commit: head });
  assert.match(lines.join("\n"), new RegExp(`Note note_1 marked addressed at ${head.slice(0, 12)}\\.`));

  await runConsumerNotes(["resolve", "note_2", "--dismiss", "--commit", "cafe123"], { output: () => {}, fetchImpl, token: "test-token" });
  assert.deepEqual(JSON.parse(calls[2].init.body), { status: "dismissed", commit: "cafe123" });

  await assert.rejects(runConsumerNotes(["resolve", "--root", root], { fetchImpl, token: "t" }), /Name the notes to resolve/);
});

test("timds consumer notes is dispatched with raw arguments", async (t) => {
  const root = await createConsumerRepo(t);
  const lines = [];
  await runConsumerCli(["notes", "--help"], { output: (line) => lines.push(line) });
  assert.match(lines.join("\n"), /timds consumer notes resolve ID/);
  lines.length = 0;
  await runConsumerCli(["help"], { output: (line) => lines.push(line) });
  assert.match(lines.join("\n"), /timds consumer notes \[--root PATH\]/);
  await assert.rejects(runConsumerCli(["notes", "resolve", "--root", root]), /Name the notes to resolve/);
});
