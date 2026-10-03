// `timds consumer notes`: the agent's read and resolve side of designer notes.
//
// A designer reviews a consumer preview in the TimDS portal and leaves notes
// on it: a point on a page capture, the element under it (selector, text, and
// the source file and line when the product's dev build stamps them), and the
// designer's words. Notes thread by repository + app + pull request across
// preview versions. This module lists the notes for the current pull request
// in a form an agent can act on, and marks them addressed (or dismissed) once
// a fix is pushed. `parseNotesComment` reads the same notes from the single
// pull-request comment the portal posts (marker `<!-- timds-designer-request
// -->` plus a fenced json block), so the designer-change workflow can act on
// them without a portal token.
//
// Boundary: the portal owns notes, their storage, and the review page; this
// module only calls its agent API with the CLI token. It never edits the
// product, and it never decides a note is addressed on its own.

import { spawn } from "node:child_process";
import process from "node:process";

import { resolveAccessToken } from "./auth.mjs";
import { loadConsumer, resolveConsumerApp } from "./consumer.mjs";
import { normalizeRepository, resolvePullRequest } from "./consumer-preview.mjs";

export const CONSUMER_NOTES_PATH = "/api/timds/consumer-previews/notes";
export const DESIGNER_REQUEST_MARKER = "<!-- timds-designer-request -->";
const DEFAULT_PORTAL_URL = "https://timds.com";

const NOTES_HELP = `Usage:
  timds consumer notes [--root PATH] [--app NAME] [--pull-request N] [--all] [--json] [--portal-url URL]
  timds consumer notes resolve ID [ID...] [--commit SHA] [--dismiss] [--root PATH] [--portal-url URL]

Lists the designer's notes on this pull request's preview (open ones unless
--all), grouped by page, with the element and source line each one points at.
resolve marks notes addressed at a commit (default HEAD) after the fix is
pushed; --dismiss marks them dismissed instead. Needs TIMDS_ACCESS_TOKEN or
\`timds auth login\`.`;

// ---------------------------------------------------------------------------
// Small helpers

function run(command, args, cwd) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => resolve({ code: -1, stdout, stderr: error.message }));
    child.on("close", (code) => resolve({ code: Number(code ?? -1), stdout, stderr }));
  });
}

async function commandValue(command, args, cwd) {
  const result = await run(command, args, cwd);
  return result.code === 0 ? result.stdout.trim() || null : null;
}

function portalEndpoint(portalUrl, pathname) {
  let base;
  try {
    base = new URL(String(portalUrl || DEFAULT_PORTAL_URL));
  } catch {
    throw new Error(`TimDS portal URL ${portalUrl} is not a valid URL`);
  }
  if (!["http:", "https:"].includes(base.protocol)) throw new Error("TimDS portal URL must use HTTP or HTTPS");
  return new URL(pathname, `${base.origin}/`);
}

async function portalToken(portalUrl, options) {
  const token = await resolveAccessToken(portalUrl, options);
  if (!token) throw new Error("Set TIMDS_ACCESS_TOKEN or sign in with `timds auth login` to read designer notes");
  return token;
}

async function portalJson(fetchImpl, url, token, init = {}) {
  const response = await fetchImpl(url.toString(), {
    ...init,
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
      ...(init.body ? { "Content-Type": "application/json" } : {}),
    },
  });
  const payload = await response.json().catch(() => ({}));
  return { payload, response };
}

function portalError(action, response, payload) {
  const detail = String(payload?.error || payload?.message || response.statusText || "no detail");
  if (response.status === 401 || response.status === 403) {
    return new Error(`${action} was refused (${response.status}): ${detail}. Check that TIMDS_ACCESS_TOKEN belongs to the client that owns this repository.`);
  }
  return new Error(`${action} failed (${response.status}): ${detail}`);
}

// ---------------------------------------------------------------------------
// Read

/**
 * GET the notes for one repository, app, and pull request. Open notes only
 * unless `all`. Returns `{ notes }` exactly as the portal sent the list.
 */
export async function fetchConsumerNotes({ repository, app, pullRequest, all = false, portalUrl, fetchImpl = fetch, ...options } = {}) {
  if (!repository) throw new Error("fetchConsumerNotes needs repository (OWNER/REPO)");
  if (!app) throw new Error("fetchConsumerNotes needs app");
  if (!pullRequest) throw new Error("fetchConsumerNotes needs pullRequest");
  const portal = portalUrl || process.env.TIMDS_PORTAL_URL || DEFAULT_PORTAL_URL;
  const token = await portalToken(portal, options);
  const url = portalEndpoint(portal, CONSUMER_NOTES_PATH);
  url.searchParams.set("repository", repository);
  url.searchParams.set("app", app);
  url.searchParams.set("pullRequest", String(pullRequest));
  if (!all) url.searchParams.set("status", "open");
  const { payload, response } = await portalJson(fetchImpl, url, token, { method: "GET" });
  if (!response.ok) throw portalError("Reading designer notes", response, payload);
  if (!Array.isArray(payload?.notes)) throw new Error("The portal returned no notes list");
  return { notes: payload.notes };
}

/** PATCH one note to `addressed` (or `dismissed`) at `commit`. Returns the portal's note when it sends one. */
export async function resolveConsumerNote(id, { commit, dismiss = false, portalUrl, fetchImpl = fetch, ...options } = {}) {
  const noteId = String(id || "").trim();
  if (!noteId) throw new Error("A note id is required");
  const portal = portalUrl || process.env.TIMDS_PORTAL_URL || DEFAULT_PORTAL_URL;
  const token = await portalToken(portal, options);
  const url = portalEndpoint(portal, `${CONSUMER_NOTES_PATH}/${encodeURIComponent(noteId)}`);
  const body = { status: dismiss ? "dismissed" : "addressed", commit: commit || null };
  const { payload, response } = await portalJson(fetchImpl, url, token, { method: "PATCH", body: JSON.stringify(body) });
  if (!response.ok) throw portalError(`Resolving note ${noteId}`, response, payload);
  return payload?.note ?? { id: noteId, ...body };
}

/**
 * The notes array carried by a portal PR comment: the comment holds the
 * marker `<!-- timds-designer-request -->` and a fenced ```json block whose
 * content is either an array of notes or `{ "notes": [...] }`. Returns null
 * when the comment is not a designer request; throws when it is one whose
 * json block is missing or unreadable.
 */
export function parseNotesComment(body) {
  const text = String(body ?? "").replace(/\r\n/g, "\n");
  const markerAt = text.indexOf(DESIGNER_REQUEST_MARKER);
  if (markerAt === -1) return null;
  const match = text.slice(markerAt).match(/```json[^\n]*\n([\s\S]*?)\n```/);
  if (!match) throw new Error("The designer request comment has no ```json block with its notes");
  let value;
  try {
    value = JSON.parse(match[1]);
  } catch (error) {
    throw new Error(`The designer request comment's json block is not valid JSON: ${error.message}`);
  }
  const notes = Array.isArray(value) ? value : value?.notes;
  if (!Array.isArray(notes)) throw new Error("The designer request comment's json block must be an array of notes or { \"notes\": [...] }");
  return notes;
}

// ---------------------------------------------------------------------------
// Format

function oneLine(value, limit = 160) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function sourceLocation(source) {
  if (!source || !source.file) return null;
  return [source.file, source.line, source.line && source.column ? source.column : null].filter((part) => part !== null && part !== undefined && part !== "").join(":");
}

/**
 * Plain text for an agent: notes grouped by route, each with its id, viewport
 * and scheme, the element's source file:line, selector and text, and the
 * designer's words verbatim; ends with the resolve command.
 */
export function formatConsumerNotes(notes, { repository, app, pullRequest, all = false } = {}) {
  const list = Array.isArray(notes) ? notes : [];
  const scope = [repository, app ? `app ${app}` : null, pullRequest ? `pull request #${pullRequest}` : null].filter(Boolean).join(", ");
  const kind = all ? "designer note" : "open designer note";
  if (!list.length) return `No ${kind}s${scope ? ` for ${scope}` : ""}.`;
  const lines = [`${list.length} ${kind}${list.length === 1 ? "" : "s"}${scope ? ` for ${scope}` : ""}.`];
  const routes = new Map();
  for (const note of list) {
    const route = String(note?.route || "(no route)");
    if (!routes.has(route)) routes.set(route, []);
    routes.get(route).push(note);
  }
  for (const [route, entries] of routes) {
    lines.push("", `Page ${route}`);
    for (const note of entries) {
      const where = [note.viewport, note.scheme, all ? note.status : null].filter(Boolean).join(", ");
      lines.push(`- Note ${note.id}${where ? ` (${where})` : ""}${note.authorName ? ` from ${oneLine(note.authorName, 80)}` : ""}`);
      const element = note.element;
      if (element) {
        const source = sourceLocation(element.source);
        lines.push(`  Source: ${source || "unknown (the preview build carries no source stamps; find it from the selector and text)"}`);
        if (element.selector) lines.push(`  Element: ${oneLine(element.selector, 200)}${element.tag ? ` <${element.tag}>` : ""}`);
        if (element.text) lines.push(`  Text: "${oneLine(element.text)}"`);
      } else if (note.point) {
        lines.push(`  Point: x ${note.point.x}, y ${note.point.y} on the ${note.viewport || "page"} capture (no element under it)`);
      }
      const words = String(note.body ?? "").replace(/\r\n/g, "\n").trimEnd();
      lines.push("  Designer:");
      for (const line of (words || "(no text)").split("\n")) lines.push(`    > ${line}`);
    }
  }
  const ids = list.filter((note) => !note.status || note.status === "open" || note.status === "sent").map((note) => note.id);
  if (ids.length) {
    lines.push("", "After pushing the fix, resolve only the notes you addressed:", `  npm run timds -- consumer notes resolve ${ids.join(" ")}`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Context resolution

async function repositoryName(repoRoot, env = process.env) {
  return normalizeRepository(await commandValue("git", ["remote", "get-url", "origin"], repoRoot))
    || normalizeRepository(env.GITHUB_REPOSITORY ? `https://github.com/${env.GITHUB_REPOSITORY}` : "");
}

async function pullRequestNumber(flag, repoRoot, env = process.env) {
  const resolved = resolvePullRequest(flag, env);
  if (resolved) return resolved;
  const viewed = await commandValue("gh", ["pr", "view", "--json", "number", "--jq", ".number"], repoRoot);
  if (viewed && /^\d+$/.test(viewed)) return Number(viewed);
  throw new Error("Could not tell which pull request to read notes for: pass --pull-request N (or push the branch and open its pull request so `gh pr view` finds it)");
}

// ---------------------------------------------------------------------------
// CLI

const BOOLEAN_FLAGS = new Set(["all", "dismiss", "help", "json"]);
const VALUE_FLAGS = new Set(["app", "commit", "portalUrl", "pullRequest", "root"]);

function parseNotesArguments(argv) {
  const options = { positionals: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith("-")) {
      options.positionals.push(value);
      continue;
    }
    const [rawName, inlineValue] = value.replace(/^--?/, "").split("=", 2);
    const name = rawName.replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
    if (BOOLEAN_FLAGS.has(name)) {
      options[name] = true;
      continue;
    }
    if (!VALUE_FLAGS.has(name)) throw new Error(`Unknown option --${rawName}\n${NOTES_HELP}`);
    const next = inlineValue ?? argv[index + 1];
    if (next === undefined || next === "" || String(next).startsWith("-")) throw new Error(`--${rawName} requires a value`);
    options[name] = next;
    if (inlineValue === undefined) index += 1;
  }
  return options;
}

/** `timds consumer notes [resolve ID...] ...` (raw args after `notes`). */
export async function runConsumerNotes(args = [], { output = (line) => process.stdout.write(`${line}\n`), env = process.env, ...overrides } = {}) {
  const options = parseNotesArguments(args);
  if (options.help) {
    output(NOTES_HELP);
    return null;
  }
  const [action, ...ids] = options.positionals;
  const root = options.root || process.cwd();

  if (action === "resolve") {
    if (!ids.length) throw new Error(`Name the notes to resolve: timds consumer notes resolve ID [ID...]\n${NOTES_HELP}`);
    const commit = options.commit || await commandValue("git", ["rev-parse", "HEAD"], root);
    if (!commit) throw new Error("Could not read HEAD; pass --commit SHA");
    const resolved = [];
    for (const id of ids) {
      resolved.push(await resolveConsumerNote(id, { ...overrides, commit, dismiss: Boolean(options.dismiss), portalUrl: options.portalUrl }));
      output(`Note ${id} marked ${options.dismiss ? "dismissed" : "addressed"} at ${commit.slice(0, 12)}.`);
    }
    return { notes: resolved };
  }
  if (action !== undefined) throw new Error(`Unexpected argument ${action}\n${NOTES_HELP}`);
  if (options.commit || options.dismiss) throw new Error("--commit and --dismiss belong to `timds consumer notes resolve`");

  const consumer = await loadConsumer(root);
  const app = resolveConsumerApp(consumer, options.app);
  const repository = await repositoryName(consumer.repoRoot, env);
  if (!repository) throw new Error("Could not tell the repository from `git remote get-url origin`; add the GitHub remote as origin");
  const pullRequest = await pullRequestNumber(options.pullRequest, consumer.repoRoot, env);
  const result = await fetchConsumerNotes({ ...overrides, repository, app: app.name, pullRequest, all: Boolean(options.all), portalUrl: options.portalUrl });
  if (options.json) output(JSON.stringify({ notes: result.notes }, null, 2));
  else output(formatConsumerNotes(result.notes, { repository, app: app.name, pullRequest, all: Boolean(options.all) }));
  return { ...result, repository, app: app.name, pullRequest };
}
