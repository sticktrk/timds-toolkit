// `timds skills install`: put the toolkit's bundled agent skills where the
// designer's agent reads them.
//
// Designers contribute to a Design System through Studio and this CLI, with
// an AI agent running the CLI on their behalf. The agent learns the workflow
// from skills, so this command copies the designer skills out of the
// installed package into the agent skill directories of the current folder
// (`.agents/skills/`, `.claude/skills/`, `.cursor/skills/`) or, with
// `--global`, of the home folder. With `--portal-url` and `--system-id` it
// also renders the hosted skill (`skills/timds-hosted-design-system`) for that
// system, filling the same placeholders the host fills when Studio serves the
// skill (`hostedSkillPlaceholders`); without them the system-independent
// skills are installed and the output says so. The consumer skills belong to
// `timds consumer init` and are never installed here.
//
// Every written file's sha256 is recorded in `.timds/skills.json` beside the
// destinations (or `$XDG_CONFIG_HOME/timds/skills.json`, default
// `~/.config/timds/skills.json`, for `--global`), the way consumer init
// records its managed files, so a rerun at `@latest` refreshes files nobody
// edited, keeps a person's edits (reported, replaced only with `--force`),
// re-renders the hosted skills recorded here, and removes files a newer
// release no longer ships when they are unmodified. A destination that is a
// link to another destination (a repository's `.claude/skills ->
// ../.agents/skills`) is written once.
//
// Boundary: this command never runs inside a Design System or consumer
// repository, whose skills `timds init`/`upgrade` manage by their own record,
// nor inside a hosted session workspace, where the files would be submitted
// with the system. It writes only under the skill directories and the record.

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { runtimeIdentity } from "./runtime.mjs";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The agent skill directories, relative to the folder (or home) they are installed under. */
export const SKILL_DIRECTORIES = Object.freeze([".agents/skills", ".claude/skills", ".cursor/skills"]);
/** The system-independent designer skills `skills install` copies as they ship. */
export const INSTALLABLE_SKILL_NAMES = Object.freeze(["timds-edit-design-system", "design-start", "design-media", "design-ship", "design-handoff"]);
/** The template folder of the hosted skill, rendered per system under `hostedSkillName`. */
export const HOSTED_SKILL_TEMPLATE = "timds-hosted-design-system";
/** The placeholders the hosted skill template may carry; the host's fill and this one supply exactly these. */
export const hostedSkillPlaceholders = Object.freeze(["__SKILL_NAME__", "__SYSTEM_NAME__", "__SYSTEM_ID__", "__HOST_ORIGIN__", "__STUDIO_URL__"]);
export const SKILLS_RECORD_FILE = ".timds/skills.json";
export const SKILLS_HELP = "Usage: timds skills install [--root PATH | --global] [--portal-url URL --system-id ID [--system-name NAME] [--studio-url URL]] [--force]";

const sha256 = (content) => createHash("sha256").update(content).digest("hex");

async function readText(filePath) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function exists(filePath) {
  try {
    await fs.lstat(filePath);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function writeFile(filePath, content) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf8");
}

/** The record file for `--global`, beside the credentials file. */
export function globalSkillsRecordPath({ homeDirectory = os.homedir(), env = process.env } = {}) {
  const configRoot = String(env.XDG_CONFIG_HOME || "").trim() ? path.resolve(env.XDG_CONFIG_HOME) : path.join(homeDirectory, ".config");
  return path.join(configRoot, "timds", "skills.json");
}

/** `example/core` becomes the skill folder `timds-core`, the name the host gives the same skill. */
export function hostedSkillName(systemId) {
  const folder = String(systemId || "").split("/").pop().replace(/[^a-z0-9-]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase();
  return `timds-${folder || "design-system"}`;
}

function hostOrigin(portalUrl) {
  let url;
  try {
    url = new URL(String(portalUrl));
  } catch {
    throw new Error(`--portal-url ${portalUrl} is not a valid URL`);
  }
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("--portal-url must use HTTP or HTTPS");
  return url.origin;
}

function validateSystemId(systemId) {
  const value = String(systemId || "").trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]{1,159}$/.test(value)) throw new Error(`--system-id ${systemId} must be a Design System id such as client/core`);
  return value;
}

/** Normalize one hosted system the skill is rendered for; Studio defaults to the host's `/studio/`. */
export function hostedSkillSystem({ portalUrl, systemId, systemName = null, studioUrl = null }) {
  const origin = hostOrigin(portalUrl);
  const id = validateSystemId(systemId);
  const studio = studioUrl ? new URL(String(studioUrl)).href : new URL("/studio/", `${origin}/`).href;
  return { portalUrl: origin, systemId: id, systemName: String(systemName || "").trim() || id, studioUrl: studio, skill: hostedSkillName(id) };
}

/** Every file under `skills/<name>` in the package as `{ relative, content }`, sorted. */
async function bundledSkillFiles(name) {
  const skillRoot = path.join(packageRoot, "skills", name);
  const files = [];
  async function walk(directory) {
    for (const entry of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(absolute);
      else if (entry.isFile()) files.push({ relative: path.relative(skillRoot, absolute).split(path.sep).join("/"), content: await fs.readFile(absolute, "utf8") });
    }
  }
  await walk(skillRoot);
  return files;
}

/**
 * The hosted skill's files rendered for one system: `[{ relative, content }]`
 * under the folder `system.skill`. Refuses a template placeholder this fill
 * does not know, so the template and the host's fill stay in step.
 */
export async function renderHostedSkillFiles(system) {
  const resolved = hostedSkillSystem(system);
  const values = {
    __SKILL_NAME__: resolved.skill,
    __SYSTEM_NAME__: resolved.systemName,
    __SYSTEM_ID__: resolved.systemId,
    __HOST_ORIGIN__: resolved.portalUrl,
    __STUDIO_URL__: resolved.studioUrl,
  };
  return (await bundledSkillFiles(HOSTED_SKILL_TEMPLATE)).map((file) => ({
    relative: file.relative,
    content: file.content.replace(/__[A-Z_]+__/g, (placeholder) => {
      if (!(placeholder in values)) throw new Error(`Unfilled hosted skill placeholder ${placeholder} in skills/${HOSTED_SKILL_TEMPLATE}/${file.relative}`);
      return values[placeholder];
    }),
  }));
}

/** Every skill folder to install, as `{ skill, files }`: the shipped designer skills, then one hosted skill per system. */
export async function installableSkills(systems = []) {
  const skills = [];
  for (const name of INSTALLABLE_SKILL_NAMES) skills.push({ skill: name, files: await bundledSkillFiles(name) });
  for (const system of systems) skills.push({ skill: system.skill, files: await renderHostedSkillFiles(system) });
  return skills;
}

/**
 * The skill directories under `base` with duplicates folded: a directory that
 * already resolves to another listed one (a link) is reported, not written.
 */
async function resolveDestinations(base) {
  const destinations = [];
  const seen = new Map();
  for (const relative of SKILL_DIRECTORIES) {
    const absolute = path.join(base, ...relative.split("/"));
    let real = absolute;
    try {
      real = await fs.realpath(absolute);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const duplicateOf = seen.get(real);
    if (duplicateOf) destinations.push({ relative, absolute, linkedTo: duplicateOf });
    else {
      seen.set(real, relative);
      destinations.push({ relative, absolute });
    }
  }
  return destinations;
}

/** Refuse the folders whose skills another TimDS record owns, or that a session would submit. */
async function refuseManagedFolder(base) {
  const command = "timds skills install";
  if (await exists(path.join(base, ".timds", "session.json")) || await exists(path.join(base, ".timds", "start.json"))) {
    throw new Error(`${base} is a hosted TimDS session workspace; skills installed here would be submitted with the design system.\nRun ${command} from the folder your agent works in (for example --root ..), or with --global.`);
  }
  if (await exists(path.join(base, "timds.json")) || await exists(path.join(base, "design-system", "timds.json")) || await exists(path.join(base, ".timds", "installation.json"))) {
    throw new Error(`${base} is a TimDS Design System repository; its skills are installed by timds init and refreshed by timds upgrade.\nRun ${command} from another folder, or with --global.`);
  }
  if (await exists(path.join(base, "timds.consumer.json"))) {
    throw new Error(`${base} is a TimDS consumer repository; its skills are installed by timds consumer init and refreshed by timds upgrade.\nRun ${command} from another folder, or with --global.`);
  }
}

async function readRecord(recordPath) {
  const text = await readText(recordPath);
  if (text === null) return null;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`${recordPath} is not valid JSON: ${error.message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${recordPath} must hold a JSON object`);
  return parsed;
}

function recordedSystems(record) {
  return Array.isArray(record?.systems) ? record.systems.filter((system) => system && typeof system === "object" && system.portalUrl && system.systemId) : [];
}

/**
 * Plan every write under `base` for `skills` into `destinations`, against the
 * recorded digests: `unchanged`, `created`, `refreshed` (the file still
 * matches a digest a previous install wrote), `kept` (edited by hand; `force`
 * turns it into `replaced`), and `removed` or `kept` for recorded files this
 * release no longer ships.
 */
async function planWrites(base, destinations, skills, recorded, force) {
  const writes = [];
  const statuses = [];
  const planned = new Set();
  for (const destination of destinations.filter((entry) => !entry.linkedTo)) {
    for (const { skill, files } of skills) {
      for (const file of files) {
        const relative = `${destination.relative}/${skill}/${file.relative}`;
        planned.add(relative);
        const current = await readText(path.join(base, ...relative.split("/")));
        if (current === file.content) {
          statuses.push({ path: relative, status: "unchanged" });
          continue;
        }
        if (current !== null && sha256(current) !== recorded[relative]) {
          if (!force) {
            statuses.push({ path: relative, status: "kept" });
            continue;
          }
          statuses.push({ path: relative, status: "replaced" });
        } else statuses.push({ path: relative, status: current === null ? "created" : "refreshed" });
        writes.push({ path: relative, content: file.content });
      }
    }
  }
  const removals = [];
  for (const [relative, digest] of Object.entries(recorded)) {
    // Only files under the skill directories this command owns are ever removed.
    if (planned.has(relative) || relative.split("/").includes("..") || !SKILL_DIRECTORIES.some((directory) => relative.startsWith(`${directory}/`))) continue;
    const current = await readText(path.join(base, ...relative.split("/")));
    if (current === null) continue;
    if (force || sha256(current) === digest) removals.push(relative);
    statuses.push({ path: relative, status: force || sha256(current) === digest ? "removed" : "kept" });
  }
  return { writes, removals, statuses };
}

/**
 * Install the designer skills under `root` (or the home folder with
 * `global`), rendering the hosted skill for `portalUrl` + `systemId` when
 * given and for every system a previous install recorded here. Returns the
 * base, the destinations, the systems, every file's status, and the record.
 */
export async function installSkills({ root = process.cwd(), global = false, force = false, portalUrl = null, systemId = null, systemName = null, studioUrl = null, homeDirectory = os.homedir(), env = process.env, recordPath = null, output = () => {} } = {}) {
  if (Boolean(portalUrl) !== Boolean(systemId)) throw new Error(`--portal-url and --system-id go together: both name the hosted design system the skill is rendered for.\n${SKILLS_HELP}`);
  if ((systemName || studioUrl) && !systemId) throw new Error(`--system-name and --studio-url apply with --portal-url and --system-id\n${SKILLS_HELP}`);
  const base = global ? path.resolve(homeDirectory) : path.resolve(root);
  if (!global) await refuseManagedFolder(base);
  const record = global ? globalSkillsRecordPath({ homeDirectory: base, env }) : path.join(base, ...SKILLS_RECORD_FILE.split("/"));
  const recordFile = recordPath ? path.resolve(recordPath) : record;
  const previous = await readRecord(recordFile);
  const recorded = previous?.managedFiles && typeof previous.managedFiles === "object" ? previous.managedFiles : {};

  // The system named now, then the ones recorded here, each rendered once.
  const systems = [];
  const requested = systemId ? hostedSkillSystem({ portalUrl, systemId, systemName, studioUrl }) : null;
  if (requested) systems.push(requested);
  for (const system of recordedSystems(previous)) {
    if (systems.some((known) => known.skill === hostedSkillName(system.systemId))) continue;
    try {
      systems.push(hostedSkillSystem(system));
    } catch {
      // A record this release cannot read is dropped from the rerender, never a failure.
    }
  }

  const destinations = await resolveDestinations(base);
  const skills = await installableSkills(systems);
  const { writes, removals, statuses } = await planWrites(base, destinations, skills, recorded, force);
  for (const write of writes) await writeFile(path.join(base, ...write.path.split("/")), write.content);
  for (const relative of removals) await fs.rm(path.join(base, ...relative.split("/")), { force: true });

  const managedFiles = {};
  for (const destination of destinations.filter((entry) => !entry.linkedTo)) {
    for (const { skill, files } of skills) {
      for (const file of files) managedFiles[`${destination.relative}/${skill}/${file.relative}`] = sha256(file.content);
    }
  }
  const installation = {
    name: runtimeIdentity.name,
    schemaVersion: 1,
    version: runtimeIdentity.version,
    scope: global ? "global" : "folder",
    skillDirectories: destinations.filter((entry) => !entry.linkedTo).map((entry) => entry.relative),
    systems: systems.map(({ portalUrl: host, systemId: id, systemName: name, studioUrl: studio, skill }) => ({ portalUrl: host, systemId: id, systemName: name, studioUrl: studio, skill })),
    managedFiles,
  };
  await writeFile(recordFile, `${JSON.stringify(installation, null, 2)}\n`);

  const previousVersion = typeof previous?.version === "string" ? previous.version : null;
  output(`TimDS skills installed under ${base} (toolkit ${previousVersion && previousVersion !== runtimeIdentity.version ? `${previousVersion} -> ` : ""}${runtimeIdentity.version})`);
  for (const destination of destinations) {
    if (destination.linkedTo) {
      output(`  ${destination.relative} is the same folder as ${destination.linkedTo}; written once.`);
      continue;
    }
    const counts = {};
    for (const entry of statuses.filter((status) => status.path.startsWith(`${destination.relative}/`))) counts[entry.status] = (counts[entry.status] || 0) + 1;
    output(`  ${destination.relative}: ${skills.map((entry) => entry.skill).join(", ")} (${Object.entries(counts).map(([status, count]) => `${count} ${status}`).join(", ") || "nothing to do"})`);
  }
  for (const entry of statuses.filter((status) => status.status === "kept")) output(`  kept      ${entry.path} (edited here; rerun with --force to replace it)`);
  for (const entry of statuses.filter((status) => status.status === "removed")) output(`  removed   ${entry.path} (no longer shipped by TimDS)`);
  if (systems.length) {
    for (const system of systems) output(`Hosted skill ${system.skill}: ${system.systemId}${system.systemName !== system.systemId ? ` (${system.systemName})` : ""} at ${system.portalUrl}${system === requested ? "" : " (recorded by an earlier install)"}`);
  } else {
    output("No hosted skill: these are the system-independent skills. Pass --portal-url URL and --system-id ID to add the skill for one hosted design system.");
  }
  output(`Recorded in ${recordFile}; rerun timds skills install at @latest to refresh.`);

  return { base, destinations, systems, files: statuses, installation, recordPath: recordFile };
}
