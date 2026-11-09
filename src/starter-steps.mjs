// Starter steps: the numbered, declared changes that move a starter-based
// Design System from one starter level to the next.
//
// A step is data (see `starterSteps` in src/starter.mjs and the `starterSteps`
// block of `describeToolkitRelease()`), built from a closed vocabulary, and
// this module is the one interpreter that applies it. Because the toolkit's
// own sync and migrate run every step through `evaluateStarterStep`, the JSON
// a release declares and what an upgrade writes cannot diverge, and a host
// can verify a candidate change without knowing any step in particular.
//
// Operations:
//   remove-file     the file leaves only when its bytes (sha256 of the exact
//                   bytes, lowercase hex) are one of `sha256`; an absent file
//                   needs nothing; any other content is a conflict.
//   set-site-field  a top-level src/site.json field moves to `value` when its
//                   current value is in `from` (null means absent); otherwise
//                   it is kept and reported.
//   set-page-field  the same for one field of page `page` (`view` for the
//                   view's own page, or `view/slug`).
// Requirements:
//   stock-file      the file's bytes equal this release's managed bytes.
//   authored-page   the page is declared and not planned.
//   page-field      the page's field equals `equals`.
//
// Each step is evaluated on the tree as it stands after the sync and the
// earlier steps:
//   1. For another starter kind or layer, or with a requirement that does
//      not hold, it does not apply and settles with nothing written
//      (`skipped`).
//   2. Otherwise its effective operations are a remove-file whose file
//      exists and a field move whose current value is in `from`; a field
//      holding any other value is kept and reported.
//   3. A remove-file whose file exists with any other content is the only
//      conflict; the level stops there.
//   4. With no effective operation the step settles (`applied`, nothing
//      changed).
//   5. With effective operations a step that is not visible applies them and
//      settles (`applied`).
//   6. With effective operations a visible step needs a decision: applied
//      only when accepted, settled as `declined` when declined (declinable
//      steps only); otherwise the level stops there and it is pending.
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

export const STARTER_STEP_OPERATIONS = Object.freeze(["remove-file", "set-site-field", "set-page-field"]);
export const STARTER_STEP_REQUIREMENTS = Object.freeze(["stock-file", "authored-page", "page-field"]);
export const STARTER_STEP_LAYERS = Object.freeze(["code", "defaults"]);

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/** The page `view` or `view/slug` in a site model, or null. */
export function findSitePage(site, id) {
  for (const view of Array.isArray(site?.views) ? site.views : []) {
    for (const page of Array.isArray(view?.pages) ? view.pages : []) {
      const slug = page?.slug ?? "";
      if ((slug ? `${view.id}/${slug}` : view.id) === id) return page;
    }
  }
  return null;
}

/** The fragment that renders page `id`: src/pages/<view>/index.html or src/pages/<view>/<slug>.html. */
export function sitePageFile(id) {
  const [view, ...rest] = id.split("/");
  return `src/pages/${view}/${rest.length ? rest.join("/") : "index"}.html`;
}

/** Validate a declared step list: ascending levels, known vocabulary, nothing a host could misread. */
export function validateStarterSteps(steps) {
  let previous = 0;
  const ids = new Set();
  const keys = { step: ["level", "id", "layer", "visible", "declinable", "starters", "requires", "operations"], "remove-file": ["op", "path", "sha256"], "set-site-field": ["op", "field", "value", "from"], "set-page-field": ["op", "page", "field", "value", "from"], "stock-file": ["check", "path"], "authored-page": ["check", "page"], "page-field": ["check", "page", "field", "equals"] };
  const exact = (object, expected, label) => {
    if (Object.keys(object).join() !== expected.join()) throw new Error(`${label} must have exactly ${expected.join(", ")}, in that order`);
  };
  for (const step of steps) {
    exact(step, keys.step, `Starter step ${step.id}`);
    for (const requirement of step.requires) exact(requirement, keys[requirement.check] ?? [], `Starter step ${step.id} requirement ${requirement.check}`);
    for (const operation of step.operations) exact(operation, keys[operation.op] ?? [], `Starter step ${step.id} operation ${operation.op}`);
    if (!Number.isInteger(step.level) || step.level !== previous + 1) throw new Error(`Starter step ${step.id} must have level ${previous + 1}`);
    previous = step.level;
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(step.id ?? "") || ids.has(step.id)) throw new Error(`Starter step id ${JSON.stringify(step.id)} must be unique lowercase words joined by hyphens`);
    ids.add(step.id);
    if (!STARTER_STEP_LAYERS.includes(step.layer)) throw new Error(`Starter step ${step.id} has an unknown layer ${JSON.stringify(step.layer)}`);
    if (typeof step.visible !== "boolean" || typeof step.declinable !== "boolean") throw new Error(`Starter step ${step.id} must say whether it is visible and declinable`);
    if (!Array.isArray(step.starters) || !step.starters.length) throw new Error(`Starter step ${step.id} must name the starters it applies to`);
    for (const requirement of step.requires) {
      if (!STARTER_STEP_REQUIREMENTS.includes(requirement.check)) throw new Error(`Starter step ${step.id} has an unknown requirement ${JSON.stringify(requirement.check)}`);
    }
    for (const operation of step.operations) {
      if (!STARTER_STEP_OPERATIONS.includes(operation.op)) throw new Error(`Starter step ${step.id} has an unknown operation ${JSON.stringify(operation.op)}`);
      if (operation.op === "remove-file" && (!Array.isArray(operation.sha256) || operation.sha256.some((hash) => !/^[0-9a-f]{64}$/.test(hash)))) throw new Error(`Starter step ${step.id} removes ${operation.path} without its stock hashes`);
      if (operation.op !== "remove-file" && !Array.isArray(operation.from)) throw new Error(`Starter step ${step.id} sets ${operation.field} without the values it moves from`);
      if (operation.op !== "remove-file" && (operation.value === null || operation.value === undefined)) throw new Error(`Starter step ${step.id} sets ${operation.field} to nothing; a step never clears a field`);
      if (operation.op === "set-site-field" && operation.field === "views") throw new Error(`Starter step ${step.id} may not replace views`);
      if (operation.op === "set-page-field" && ["slug", "pages"].includes(operation.field)) throw new Error(`Starter step ${step.id} may not set a page's ${operation.field}`);
    }
  }
  return steps;
}

/** Whether a step is for this system at all: its starter kind, and only `code` steps for an offshoot. */
export function starterStepApplies(step, { starter = "starter", offshoot = false } = {}) {
  return step.starters.includes(starter) && (!offshoot || step.layer === "code");
}

/** A value in `from`, where null stands for an absent field. */
const listed = (from, current) => from.some((candidate) => (candidate === null ? current === undefined || current === null : isDeepStrictEqual(candidate, current)));

/** Whether every requirement of a step holds on `state`; the first that does not, as `{ check, ... }`, or null. */
export function failedStarterRequirement(step, state) {
  for (const requirement of step.requires) {
    if (requirement.check === "stock-file") {
      const current = state.read(requirement.path);
      const stock = state.stock(requirement.path);
      if (current === null || stock === null || !Buffer.from(current).equals(Buffer.from(stock))) return requirement;
    } else if (requirement.check === "authored-page") {
      const page = findSitePage(state.site, requirement.page);
      if (!page || page.planned === true) return requirement;
    } else if (requirement.check === "page-field") {
      const page = findSitePage(state.site, requirement.page);
      if (!page || !isDeepStrictEqual(page[requirement.field], requirement.equals)) return requirement;
    }
  }
  return null;
}

/**
 * Evaluate one applicable step on a system state without touching disk.
 * `state` is `{ site, read(path) -> Buffer|null, stock(path) -> Buffer|null }`:
 * the parsed src/site.json, the system's current bytes, and this release's
 * managed bytes. `force` names files a remove-file may remove whatever their
 * content (an explicit `starter sync --force PATH`); `reason`, when given,
 * names every conflict (such as renderer_kept). Returns `skipped` when a
 * requirement fails, `conflict`, or the effective operations as `effective`
 * with the site they produce, the files they remove, and the fields kept.
 */
export function evaluateStarterStep(step, state, { force = new Set(), reason = null } = {}) {
  const base = { step: step.id, level: step.level };
  const failed = failedStarterRequirement(step, state);
  if (failed) return { ...base, outcome: "skipped", requirement: failed, site: state.site, remove: [], changes: [], kept: [], conflicts: [] };
  const conflicts = [];
  const site = structuredClone(state.site);
  const remove = [];
  const changes = [];
  const kept = [];
  for (const operation of step.operations) {
    if (operation.op === "remove-file") {
      const current = state.read(operation.path);
      if (current === null) continue;
      const stock = operation.sha256.includes(sha256(current));
      if (stock || force.has(operation.path)) {
        remove.push(operation.path);
        changes.push({ op: operation.op, path: operation.path, ...(stock ? {} : { forced: true }) });
      } else {
        conflicts.push({ step: step.id, path: operation.path, reason: reason ?? "customized" });
      }
      continue;
    }
    const target = operation.op === "set-site-field" ? site : findSitePage(site, operation.page);
    const label = operation.op === "set-site-field" ? operation.field : `${operation.page}.${operation.field}`;
    const current = target?.[operation.field];
    if (target && isDeepStrictEqual(current, operation.value)) continue;
    if (target && listed(operation.from, current)) {
      target[operation.field] = structuredClone(operation.value);
      changes.push({ op: operation.op, field: label, from: current ?? null, to: operation.value });
    } else {
      kept.push({ op: operation.op, field: label, current, value: operation.value });
    }
  }
  if (conflicts.length) return { ...base, outcome: "conflict", site: state.site, remove: [], changes: [], kept: [], conflicts };
  return { ...base, outcome: "effective", site, remove, changes, kept, conflicts: [] };
}

/**
 * Run the steps above `level` in order (rules 1 to 6 above) and return the
 * level reached, the resulting site, the files to remove, each step's result,
 * and where and why the run stopped. `hold` maps a step id to conflicts the
 * caller already knows (a kept renderer): the run stops there with them.
 * `state.read` sees files earlier steps of this run removed as absent.
 */
export function runStarterSteps(steps, state, { level = 0, declined = [], accept = new Set(), starter = "starter", offshoot = false, force = new Set(), reasons = {}, hold = {} } = {}) {
  const removed = new Set();
  let site = state.site;
  const read = (relative) => (removed.has(relative) ? null : state.read(relative));
  const results = [];
  let reached = level;
  let stopped = null;
  const settle = (result) => {
    results.push(result);
    reached = result.level;
  };
  for (const step of steps) {
    if (step.level <= level) continue;
    if (!starterStepApplies(step, { starter, offshoot })) {
      settle({ step: step.id, level: step.level, outcome: "skipped", changes: [], kept: [], conflicts: [] });
      continue;
    }
    if (hold[step.id]?.length) {
      results.push({ step: step.id, level: step.level, outcome: "conflict", changes: [], kept: [], conflicts: hold[step.id] });
      stopped = { step: step.id, reason: "conflict" };
      break;
    }
    const evaluated = evaluateStarterStep(step, { site, read, stock: state.stock }, { force, reason: reasons[step.id] ?? null });
    const { site: nextSite, remove, ...result } = evaluated;
    if (result.outcome === "conflict") {
      results.push(result);
      stopped = { step: step.id, reason: "conflict" };
      break;
    }
    if (result.outcome === "skipped" || (!result.changes.length)) {
      settle({ ...result, outcome: result.outcome === "skipped" ? "skipped" : "applied" });
      continue;
    }
    if (step.visible && !accept.has(step.id)) {
      if (step.declinable && declined.includes(step.id)) {
        settle({ ...result, outcome: "declined", changes: [] });
        continue;
      }
      results.push({ ...result, outcome: "pending" });
      stopped = { step: step.id, reason: "visible" };
      break;
    }
    site = nextSite;
    for (const relative of remove) removed.add(relative);
    settle({ ...result, outcome: "applied" });
  }
  return {
    level: reached,
    site,
    remove: [...removed],
    results,
    stopped,
    conflicts: results.flatMap((result) => result.conflicts ?? []),
  };
}
