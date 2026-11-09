// Starter sync: the recurring migration that keeps a starter-based Design
// System on the current scaffold structure, the way a CMS update keeps its
// core files current without touching a site's own content.
//
// The starter has two layers, and the line between them is recorded in
// .timds/starter.json rather than guessed:
//
// - Plumbing: the viewer, build, dev, check, and browser composer scripts,
//   and the viewer and canvas stylesheets. Who owns a local change to them is the record's
//   `plumbing` mode. A system scaffolded by `init` is `"toolkit"`: the
//   plumbing is the toolkit's outright, so every sync brings it to stock,
//   replacing a local change and saying so, without halting and without
//   anyone naming files. A system adopted later with `starter sync` is
//   `"recorded"`: the stock hash of each file is recorded when it is
//   written, a file that still matches is refreshed, and a changed one is
//   reported as customized and replaced only by `timds starter sync --force
//   <path>`, which names each file it gives up, never by `upgrade`. The
//   record keeps the hash the toolkit last wrote for a customized file, so
//   reverting to that version is recognized again. Either mode is switched
//   by editing `plumbing` in the record.
// - Structure catalogs the client extends: the views and pages in
//   src/site.json and the asset formats in src/formats.json. The record keeps
//   the stock catalogs the system was last synced against, and each sync is a
//   three-way merge against them: entries the client lacks are appended
//   (pages as planned), entries still equal to the old baseline advance to
//   the new one, and anything the client changed is kept. A kept edit is
//   reported when the stock value is news (it differs from every baseline),
//   not on every sync. Nothing is removed, reordered, or retitled.
// - Authored fragments the ordinary starter ships and manages (the
//   Digital, Social, and Print overviews) and the toolkit's own Use pages
//   (Start, Compose with every way to consume a system, and Install),
//   rendered by the stock viewer. They are written when the sync adds their
//   page and refreshed only while they still match what the toolkit wrote. A
//   fragment that differs is this system's own page and is never replaced,
//   --force included. The viewer, build and check scripts are one renderer:
//   while any of them is customized and kept, the others' refreshes and every
//   refreshed or new stock fragment wait (`skipped`, with a note naming the
//   kept file). A stock page the kept renderer has never seen may use
//   placeholders it cannot build, and a stock check script expects the stock
//   viewer beside it; either would fail the sync's own check and roll the
//   whole upgrade back, where holding them lets the dependency, skill and
//   record changes land.
//   The brand kit manages no fragment: its pages are seed-only, written once
//   by `init --starter brand-kit` from templates/brand-kit/ and authored from
//   then on on the published kit parent (the toolkit keeps code, the parent
//   keeps design). No sync or upgrade refreshes, writes, records, guards or
//   reports a kit page; a view or page the kit's catalog gains is appended
//   as planned, with no fragment written for it.
//   Every other fragment, tokens.json, the system stylesheet, and the layout
//   shell are the client's; the layout only gains a missing stylesheet link
//   and the changelog link on its version chip.
//
// The sync rewrites the catalogs and the layout whole, so a CLI refuses to
// run it over uncommitted changes to the files it writes (`starterSyncPaths`)
// and the sync's own diff stays reviewable on its own.
//
// A system scaffolded before the record existed, or whose files lag its record,
// is recognized from the stock versions earlier releases shipped:
// `legacyStarterFileHashes` below and the
// catalog snapshots under templates/starter-history/. `init` writes the
// record for a fresh scaffold, `timds starter sync` adopts an existing system,
// and `upgrade` runs the sync on every adopted system from then on. The sync
// ends with the workspace check and rolls back everything it wrote when that
// check fails, so it never leaves a system broken.
// An offshoot carries .timds/parent.json: its catalogs come from `feed`, so
// ordinary starter sync and upgrade refresh only the toolkit plumbing and
// preserve both structural baselines and every parent-record byte.
import { createHash } from "node:crypto";
import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { readFileSync } from "node:fs";
import { readParentRecord } from "./offshoot-contract.mjs";
import { brandKitStockPaths } from "./brand-kit.mjs";
import { findSitePage, runStarterSteps, starterStepApplies, validateStarterSteps } from "./starter-steps.mjs";

const templatesRoot = fileURLToPath(new URL("../templates/", import.meta.url));

export const STARTER_RECORD_FILE = ".timds/starter.json";
export const STARTER_SITE_FILE = "src/site.json";
export const STARTER_FORMATS_FILE = "src/formats.json";
export const STARTER_LAYOUT_FILE = "src/layout.html";

/** The record's `plumbing` modes: who a local change to a stock script or stylesheet belongs to. */
export const STARTER_PLUMBING_MODES = Object.freeze(["toolkit", "recorded"]);

export const STARTER_KINDS = Object.freeze(["starter", "brand-kit"]);

/** Select only a shipped scaffold; absent records keep the original starter. */
export function starterKind(value = "starter") {
  if (!STARTER_KINDS.includes(value)) throw new Error(`Unknown starter ${JSON.stringify(value)}; choose ${STARTER_KINDS.join(" or ")}`);
  return value;
}

/**
 * Plumbing the sync replaces by hash: [design-system path, template name].
 * The three scripts are stubs that call the renderer in the package
 * (@dtconcepts/timds/viewer); the renderer itself is no longer copied.
 */
export const starterPlumbingFiles = Object.freeze([
  ["scripts/build.mjs", "starter/scripts/build.mjs"],
  ["scripts/check.mjs", "starter/scripts/check.mjs"],
  ["scripts/dev.mjs", "starter/scripts/dev.mjs"],
  ["src/scripts/compose.js", "starter/src/scripts/compose.js"],
  ["src/styles/canvas.css", "starter/src/styles/canvas.css"],
  ["src/styles/viewer.css", "starter/src/styles/viewer.css"],
]);

/**
 * Authored fragments the starter ships and manages, and the Use
 * pages the toolkit owns (Start, the front page; Compose, the composer and how
 * a system is consumed: browser, llms.txt, the derived layer, MCP, a product
 * pin, the designs; and Install). Each renders
 * the page its path names (src/pages/<view>/index.html is the view's own
 * page, src/pages/<view>/<slug>.html the page <view>/<slug>). A fragment is
 * written when the sync adds its page and refreshed while it is unmodified.
 */
export const starterManagedFragments = Object.freeze([
  ["src/pages/digital/index.html", "starter/src/pages/digital/index.html"],
  ["src/pages/print/index.html", "starter/src/pages/print/index.html"],
  ["src/pages/social/index.html", "starter/src/pages/social/index.html"],
  ["src/pages/use/index.html", "starter/src/pages/use/index.html"],
  ["src/pages/use/compose.html", "starter/src/pages/use/compose.html"],
  ["src/pages/use/install.html", "starter/src/pages/use/install.html"],
]);

/**
 * The copied renderer earlier releases shipped, which the `renderer-package`
 * step removes: [design-system path, path in the toolkit repository, last
 * release that shipped it]. Their released hashes stay in
 * `legacyStarterFileHashes`; scripts/check-starter-history.mjs checks the
 * releases up to the last one.
 */
export const retiredStarterFiles = Object.freeze([
  ["scripts/viewer.mjs", "templates/starter/scripts/viewer.mjs", "0.1.496"],
  ["scripts/brand-kit.mjs", "src/brand-kit.mjs", "0.1.496"],
]);

/**
 * The renderer: the stub scripts and the copied files they replaced. While any
 * of them is this system's own and kept, the system keeps its whole copied
 * renderer, which builds exactly as it did: the other renderer files are not
 * refreshed or removed, the stock fragments wait, and the `renderer-package`
 * step reports the `renderer_kept` conflict.
 */
export const starterRendererFiles = Object.freeze(["scripts/build.mjs", "scripts/check.mjs", "scripts/dev.mjs", ...retiredStarterFiles.map(([relative]) => relative)]);

/**
 * The managed fragments of a starter kind. The ordinary starter's overviews
 * and Use pages are managed; the brand kit's pages are seed-only (written once
 * by init, authored on the published kit parent, never refreshed by sync), so
 * the kit has none and its record lists plumbing only.
 */
export function starterFragments(kind = "starter") {
  return starterKind(kind) === "starter" ? starterManagedFragments : [];
}

/** Kit pages earlier releases recorded as managed fragments; a sync drops their stale hashes from any record. */
const retiredKitFragments = new Set(brandKitStockPaths.filter((relative) => relative.startsWith("src/pages/")));
const retiredFragmentPaths = (kind) => (kind === "brand-kit" ? retiredKitFragments : new Set());

/** Every file the selected sync may write or remove, for clean-tree guards and rollback. */
export function starterPaths(kind = "starter") {
  return [
    ...starterPlumbingFiles.map(([relative]) => relative),
    ...retiredStarterFiles.map(([relative]) => relative),
    ...starterFragments(kind).map(([relative]) => relative),
    STARTER_SITE_FILE, STARTER_FORMATS_FILE, STARTER_LAYOUT_FILE, STARTER_RECORD_FILE,
  ];
}

/** The original starter boundary, retained for existing callers. */
export const starterSyncPaths = Object.freeze(starterPaths());

/** The stylesheet links the sync adds to a layout that lacks them. */
const starterLayoutStylesheets = Object.freeze(["/styles/canvas.css", "/styles/viewer.css"]);

/**
 * sha256 of every earlier stock version a release shipped for a managed file,
 * plumbing and fragments alike. The record's hash covers a system whose files
 * are what the toolkit last wrote, but a record can move past its files: a
 * hosted repair that reverted a page write kept the newer hash, and a file
 * still at an older release's bytes then read as customized for good, so a
 * stock Use page never gained the composer. Any byte-identical release version
 * is the toolkit's and is refreshed. When a template changes, its previous
 * released version belongs here: `node scripts/check-starter-history.mjs`
 * walks the release tags, fails on a gap, and `--print` lists the entries.
 */
export const legacyStarterFileHashes = new Map([
  ["scripts/build.mjs", [
    "9fcddb635f5738f2e722e711483bbde182518e68a2ab6da97b097aaf567b2001",
    "1bac8e95f8ee166d4f7b1e5f080dd78dd056afe9f4be7967b5c8e755d71f1479",
    "de4552daa3059f6481441ef0507ed94535491dcfa8f53368704a5e89858e6419",
    "67eef4a0e882e16585aa1b35044c627e97f61aec7c5fe27def00fb44b15deb12", // v0.1.496, before the stub
  ]],
  ["scripts/check.mjs", [
    "ea176b0e884fd01a8222412d52ac8dedb87bfb8921e9fd2f7b70c822832f6b55",
    "7a18bd314c23b4a9220f6a507354458d6c6dee61aa97ad5938cdda1804e3b15c",
    "dc008e0ea93a7480edd819329a057b38c9ebc692f75ba2069556723ec3c5e88c",
    "a82178a68f7ba13aeeff2625bb8c7937bd84638e2688de83b1f92af10a6eee56", // v0.1.496, before the stub
  ]],
  ["scripts/dev.mjs", [
    "5f44ab1709f40b2542714b1f2092c6ac535914431066c25ac8e2631aa1cb6926",
    "f870c565d4b1e45797346ce9086626f7c56ebc3a64b197cdcd230262f703e795",
    "6b8c65eef62f1a15ee3e86ca90fad1dd03fd8053fb4c2a619063733bf90a5024",
    "b06770e2ede899a2ea409c73144a35d94308e07115319fc86e5895565cee3a40", // v0.1.496, before the stub
  ]],
  ["scripts/viewer.mjs", [
    "7c534a20e242f2ba51f86907233684ae3b61161d8ba1dbcc92665d379968b721",
    "673344052d11194f219bc32ba724ad4c5cd954b19ba95be684b7001774074bc9",
    "e8d44a94a49d01abbd379d98ddc224f4cba0fc3445782523550263f562e605f7",
    "bdf9cf64d28cc26980f2d9678b59336eca6e9fef8a842fb8a686b51cdd370514", // v0.1.461
    "61e1c5f962426ace33f14ea6501defc35bc012af16be70fb183f0e856def4b6b", // v0.1.462
    "55ccb241300fcadb0a3bf0e980ef2a13b2bb4a3dd455df441d0bf7633ae2cb26", // v0.1.464
    "b5417f9082603d6ff8c0a7aa1a40dbc2e8fd4d4590cae8a244d7208582494f2b", // v0.1.481
    "1c21909153c4aa85dddf8bec19f06ea162bab637d1975ee007cbd70ec48b5299", // v0.1.485
    "3f04b52e5efac581dc69c05298d4626a370f617db46fa4512e8bb7c90b1150b0", // v0.1.487
    "abb08b8533800379e2d0805d5067e0babb174a7eef329f387b387d3b30d46afc", // v0.1.490
    "f9e15c77e9593279402ae2554c1ece963af8688f944cada74c5144a701b04737", // v0.1.496, the last copied viewer
  ]],
  ["src/styles/canvas.css", [
    "dd0413554f9308cf3b1c6daedfb51ebb18c464672766b815eebbe77f0c3c6d98",
    "c01549fcb01e1f1c44493d4c4a60864beaf3919cc2c570e5ea2d3aaed16e3d38", // v0.1.485
  ]],
  ["src/styles/viewer.css", [
    "2813d7d4635c74786b275e2df298974d806ac415d87c6de7f28bf85fca685971", // v0.1.491
    "bb9a4ff63a56bcdea1a91b7322e4b7a480c57af6597a332a774cdbe8c9d98c63",
    "89c7ba85c684a91a0cbf8b7269529da767d25a9c8f4b069c531f36443af74574", // v0.1.461
    "afc438a5474fdb6e63f70ffd9330fde1e636b18ba714b61bda32bf9ef00b2fdd", // v0.1.464
    "b9d437b8d8df332d765ed65a1cd7f35e25f011efa94c3090aade69917e5b9940", // v0.1.481
    "8f95580c4578921acbcb6f312cf037e59a5758de494faa4d0e37776a8b2c590f", // v0.1.485
    "e16affb7ede1627f69c9c220ecea12f6649dcde7564c7b18fef1665e0c9ae12a", // v0.1.487
    "436b9438b927fda8fea59f1ab18275653db7cb53dc678ae70c1337d768029da3", // v0.1.490
  ]],
  ["scripts/brand-kit.mjs", [
    "644ade30ac144dc71cb43a127fc456ece032be105ce325d1e9498fa54942d07b", // v0.1.485
    "8eb530135ce7789ba386414d2646e0a672118a836db6103097016a45585c19f6", // v0.1.487
    "89b43dd0a1dc5e2a6c8ef598b9ae0581ceb37bd554754aeff942b048e0b12965", // v0.1.496, the last copied helper
  ]],
  ["src/pages/use/index.html", [
    "573b6e515900155d96b066900304d8a41b6c1fb26f181e5a51fc457c7264e863", // v0.1.461
    "393e955a544050532430b750481101d32d06e6c06beaef55007227b8f1c36ca2", // v0.1.481
    "49651882b5243054760986a11a892ca3a186b5037510ef3f2732775c863525f6", // v0.1.484
    "2c4daf4d051e4b0f728673b44edb0da44a83fdc7e48e1d5ff2bbeb6abf6dff74", // v0.1.485
    "3fcd8b43e6a0894ef53a52df96b5ea747d12667ea3aec90833bfb28f8eced50b", // v0.1.485
  ]],
  ["src/scripts/compose.js", [
    "9966794077af73ee209dd8fd0ef5030788ec93236766a373e45f4af53ce996e8", // v0.1.485
  ]],
  ["src/pages/use/install.html", [
    "2f592695615a656474cf8034b3d757662fb3468ae5c674f0825b13982a378371", // v0.1.481
    "b03eb3fad31a447052de5a8e6a4f0fd75e919d5de126cee9762eaf9471cab6ae", // v0.1.484
    "31835d1a617c2a86ef27c7354b0367357ffb516ec7508130cfcc6d2e3db1debd", // v0.1.485
    "d624265f40b4220641ae050b2ffa152da7a97fc3ffc6843fb9e6ab0c255778cb", // v0.1.485
  ]],
  ["src/pages/digital/index.html", [
    "6db0f5c312100e4df3dca3e022da8959633d3efac5a05de7d01af2af4593c717", // v0.1.451
  ]],
  ["src/pages/print/index.html", [
    "3beb96006d13ad20ec6b50ba39ebab1e2b4ea6be1b7c3b4618d2a88061fa1e50", // v0.1.451
    "a1259b108ce77b645c959af3412aacb546b2d875c3b2bb8a2b667814759e98c8", // v0.1.485
  ]],
  ["src/pages/social/index.html", [
    "fa10c0442225ec7f67a3b88e2d8277793186e27036dbc257b39432b903e3fbe4", // v0.1.451
    "2056c921e5828bda290a4abce5feb171ba1c5939690e6dd9240ea7bf0d637d26", // v0.1.485
  ]],
  ["src/pages/use/compose.html", [
    "b13c74cb4e280e4726cbfa11abcfa42ac998034c6b52cb9d22f8d6e7abed2bdf", // v0.1.490, v0.1.491
  ]],
]);

/**
 * The starter level a fresh scaffold of this release starts at, and the
 * oldest level it still builds. Raise the floor only once the systems that
 * matter have settled the steps below it.
 */
export const STARTER_FLOOR = 0;

/**
 * The numbered starter steps, as data. Each is declared once, here, and
 * applied by the one interpreter in src/starter-steps.mjs; the release
 * metadata publishes this same list (`describeToolkitRelease().starterSteps`), so a
 * host verifies a candidate against exactly what the toolkit applies. A
 * system records the level it reached in .timds/starter.json: below a step's
 * level an absent or earlier stock value is an old default, at or above it a
 * choice. `code` steps apply to every system, offshoots included; `defaults`
 * steps only to the starters they name, and not to an offshoot, whose
 * structure comes from its parent through `feed`. A visible step changes what
 * visitors see: upgrade and starter sync never apply it, and only
 * `starter migrate --accept` does. A new operation or requirement raises
 * `hostContract` in package.json.
 */
export const starterSteps = Object.freeze(validateStarterSteps([
  {
    level: 1, id: "renderer-package", layer: "code", visible: false, declinable: false,
    starters: ["starter", "brand-kit"],
    // A customized build, check or dev script may still import the copied
    // renderer: syncStarter holds this step as the renderer_kept conflict
    // while one is kept, so the step never removes a renderer still in use.
    requires: [],
    operations: retiredStarterFiles.map(([relative]) => ({ op: "remove-file", path: relative, sha256: [...legacyStarterFileHashes.get(relative)] })),
  },
  {
    level: 2, id: "use-start-title", layer: "defaults", visible: false, declinable: false,
    starters: ["starter"],
    requires: [{ check: "stock-file", path: "src/pages/use/index.html" }],
    // The Use view's own page as earlier releases shipped it: "Using the
    // system" (v0.1.461 to v0.1.484) and "Compose" (v0.1.485 to v0.1.489),
    // each with its summary; the landing layout arrived with "Start" (v0.1.490).
    operations: [
      { op: "set-page-field", page: "use", field: "title", value: "Start", from: ["Using the system", "Compose"] },
      { op: "set-page-field", page: "use", field: "summary", value: "The front page: what the system makes, the formats by type, the kit behind them, how a piece is made, and every other way in.", from: [
        "Every way in: the pages, one URL for any AI tool, the machine-readable layer, MCP, a pinned bundle, and the website designs.",
        "Make a post, an ad, or an email on brand in a chat, then every way in: the pages, one URL for any AI tool, the machine-readable layer, MCP, a pinned bundle, and the website designs.",
      ] },
      { op: "set-page-field", page: "use", field: "layout", value: "landing", from: [null] },
    ],
  },
  {
    level: 3, id: "home-landing", layer: "defaults", visible: true, declinable: true,
    starters: ["starter"],
    requires: [
      { check: "authored-page", page: "use" },
      { check: "page-field", page: "use", field: "layout", equals: "landing" },
    ],
    operations: [{ op: "set-site-field", field: "home", value: "use", from: [null] }],
  },
]));

/**
 * The reason a step's conflicts report, for a step whose every failure means
 * one thing. Kept beside the steps, not in them: the published step JSON has
 * exactly the contract's keys.
 */
export const starterStepConflictReasons = Object.freeze({ "renderer-package": "renderer_kept" });

/** The level a fresh scaffold of this release starts at: every step settled. */
export const STARTER_LEVEL = starterSteps.at(-1).level;

/** The `starterSteps` block of the release metadata: the level, the floor and every step, as plain JSON. */
export function describeStarterSteps() {
  return structuredClone({ level: STARTER_LEVEL, floor: STARTER_FLOOR, steps: starterSteps });
}

/** Stock catalogs earlier releases scaffolded, for a system without a record. */
async function historicalSiteSnapshots(kind) {
  const directory = `starter-history/${starterKind(kind)}`;
  const files = (await fs.readdir(path.join(templatesRoot, directory))).filter(name => /^site-\d+\.json$/.test(name)).sort();
  return Promise.all(files.map(async name => parseJson(await template(`${directory}/${name}`), `${directory}/${name}`)));
}

const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const pageId = (view, slug) => (slug ? `${view}/${slug}` : view);

/** Every hash at which `relative` is still the toolkit's: the legacy table plus what the record says was last written. */
export function knownStarterHashes(relative, record) {
  const recorded = record?.files?.[relative];
  return [...(legacyStarterFileHashes.get(relative) ?? []), ...(typeof recorded === "string" ? [recorded] : [])];
}

export async function template(name) {
  return fs.readFile(path.join(templatesRoot, name), "utf8");
}

/** The absolute path of the stock template behind a plumbing or fragment file, for a diff against it. */
export function stockTemplatePath(relative, kind = "starter") {
  const entry = [...starterPlumbingFiles, ...starterFragments(kind)].find(([candidate]) => candidate === relative);
  if (!entry) throw new Error(`${relative} is not a starter file the toolkit writes`);
  return path.join(templatesRoot, entry[1]);
}

async function readOptional(file) {
  try {
    return await fs.readFile(file, "utf8");
  } catch (caught) {
    if (caught?.code !== "ENOENT") throw caught;
    return null;
  }
}

function readOptionalSync(file) {
  try {
    return readFileSync(file, "utf8");
  } catch (caught) {
    if (caught?.code !== "ENOENT") throw caught;
    return null;
  }
}

async function readOptionalBytes(file) {
  try {
    return await fs.readFile(file);
  } catch (caught) {
    if (caught?.code !== "ENOENT") throw caught;
    return null;
  }
}

function readOptionalBytesSync(file) {
  try {
    return readFileSync(file);
  } catch (caught) {
    if (caught?.code !== "ENOENT") throw caught;
    return null;
  }
}

function parseJson(text, label) {
  try {
    return JSON.parse(text);
  } catch (caught) {
    throw new Error(`${label} could not be read as JSON: ${caught.message}`);
  }
}

/**
 * Decide what to do with one toolkit-written file. `created` when absent,
 * `current` when identical to the stock text, `updated` when it matches a
 * known stock hash (or --force), otherwise `customized` and left alone. The
 * caller writes; this only plans.
 */
export async function planStockFile(target, desired, { force = false, knownHashes = [] } = {}) {
  const current = await readOptional(target);
  if (current === null) return { current, status: "created", write: true };
  if (current === desired) return { current, status: "current", write: false };
  const hash = sha256(current);
  if (knownHashes.includes(hash)) return { current, status: "updated", write: true };
  if (force) return { current, forced: true, status: "updated", write: true };
  return { current, status: "customized", write: false };
}

/** True when `value` equals the field in any baseline, both-absent included. */
function unchanged(value, baselines, pick) {
  return baselines.some((baseline) => isDeepStrictEqual(pick(baseline), value));
}

function assign(target, field, value) {
  if (value === undefined) delete target[field];
  else target[field] = value;
}

/**
 * Advance `target[field]` to `stock` when it still equals a baseline; keep it
 * otherwise. A kept edit is reported only when the stock value is news, that
 * is, no baseline already had it: an edit the client made against a stock
 * value that has not moved was reported when it first diverged and would
 * otherwise be repeated on every sync. An entry no baseline knows (a view or
 * format the client declared before the scaffold did) is reported in full
 * once; the next record then holds it.
 */
function advanceOrKeep(changes, target, field, stock, candidates, label) {
  if (isDeepStrictEqual(target[field], stock)) return;
  const pick = (candidate) => candidate?.[field];
  if (unchanged(target[field], candidates, pick)) {
    assign(target, field, stock);
    changes.advanced.push(label);
    return;
  }
  if (!unchanged(stock, candidates, pick)) changes.kept.push({ current: target[field], path: label, stock });
}

/**
 * Merge the stock site model into the client's. Views the client lacks are
 * appended with every page planned unless its fragment exists; pages a
 * declared view lacks are inserted after the last of their stock predecessors
 * the view has, planned the same way, so the client's own order never moves.
 * A label, blurb, title, group, summary, layout or promotion still equal to a
 * baseline advances to stock; one the client changed is kept and reported when the
 * stock value moved. `planned` is never changed on a declared page except for
 * the ids in `authoredPages`, whose fragments the caller writes. `home` stays
 * the system's routing choice, including its absence: moving it would break
 * links in authored pages that the merge must preserve.
 */
export function mergeSiteModel(current, next, baselines, { fragmentExists = () => false, authoredPages = new Set() } = {}) {
  const site = isObject(current) ? structuredClone(current) : {};
  if (!Array.isArray(site.views)) site.views = [];
  const changes = { addedPages: [], addedViews: [], advanced: [], kept: [] };
  const plannedCopy = (view, page) => {
    const copy = structuredClone(page);
    const id = pageId(view, page.slug ?? "");
    if (copy.planned !== true && !fragmentExists(id)) copy.planned = true;
    return copy;
  };

  for (const nextView of next.views) {
    const view = site.views.find((candidate) => candidate?.id === nextView.id);
    if (!view) {
      site.views.push({ ...structuredClone(nextView), pages: nextView.pages.map((page) => plannedCopy(nextView.id, page)) });
      changes.addedViews.push(nextView.id);
      continue;
    }
    const baseViews = baselines.map((baseline) => baseline?.views?.find((candidate) => candidate?.id === nextView.id)).filter(Boolean);
    for (const field of ["label", "blurb"]) advanceOrKeep(changes, view, field, nextView[field], baseViews, `${nextView.id}.${field}`);
    if (!Array.isArray(view.pages)) view.pages = [];
    let anchor = -1;
    for (const nextPage of nextView.pages) {
      const slug = nextPage.slug ?? "";
      const id = pageId(nextView.id, slug);
      const index = view.pages.findIndex((candidate) => (candidate?.slug ?? "") === slug);
      if (index === -1) {
        view.pages.splice(anchor + 1, 0, plannedCopy(nextView.id, nextPage));
        anchor += 1;
        changes.addedPages.push(id);
        continue;
      }
      anchor = Math.max(anchor, index);
      const page = view.pages[index];
      const basePages = baseViews.map((baseView) => baseView.pages?.find((candidate) => (candidate?.slug ?? "") === slug)).filter(Boolean);
      for (const field of ["title", "group", "summary", "layout", "promote"]) advanceOrKeep(changes, page, field, nextPage[field], basePages, `${id}.${field}`);
      if (authoredPages.has(id) && page.planned === true) {
        delete page.planned;
        changes.advanced.push(`${id}.planned`);
      }
    }
  }
  return { changes, site };
}

/** Every page id the site model declares, for the format catalog's `page` references. */
export function declaredPageIds(site) {
  const ids = new Set();
  for (const view of Array.isArray(site?.views) ? site.views : []) {
    for (const page of Array.isArray(view?.pages) ? view.pages : []) ids.add(pageId(view.id, page?.slug ?? ""));
  }
  return ids;
}

/**
 * Merge the stock format catalog into the client's. A format is added only
 * when its page is declared and its id is unused, since the viewer rejects
 * both; a field still equal to a baseline advances, a changed one is kept
 * and reported when the stock value moved.
 */
export function mergeFormatCatalog(current, next, baselines, declaredPages) {
  const catalog = isObject(current) ? structuredClone(current) : {};
  const changes = { addedFormats: [], addedGroups: [], advanced: [], kept: [], skipped: [] };
  const owners = new Map();
  for (const [group, entry] of Object.entries(catalog)) {
    if (group.startsWith("$") || !isObject(entry)) continue;
    for (const id of Object.keys(isObject(entry.formats) ? entry.formats : {})) owners.set(id, group);
  }
  const admit = (group, id, format) => {
    if (!declaredPages.has(format?.page)) {
      changes.skipped.push({ id: `${group}.${id}`, reason: `its page ${JSON.stringify(format?.page)} is not declared in ${STARTER_SITE_FILE}` });
      return false;
    }
    if (owners.has(id)) {
      changes.skipped.push({ id: `${group}.${id}`, reason: `the id is already used by the ${owners.get(id)} group` });
      return false;
    }
    return true;
  };

  for (const [group, stock] of Object.entries(next)) {
    if (group.startsWith("$")) {
      // A catalog the sync creates starts with the stock notes; an existing
      // one keeps or advances them like any other field.
      if (!isObject(current)) catalog[group] = structuredClone(stock);
      else advanceOrKeep(changes, catalog, group, stock, baselines, group);
      continue;
    }
    const entry = catalog[group];
    const baseGroups = baselines.map((baseline) => baseline?.[group]).filter(isObject);
    if (!isObject(entry)) {
      const formats = {};
      for (const [id, format] of Object.entries(isObject(stock.formats) ? stock.formats : {})) {
        if (!admit(group, id, format)) continue;
        formats[id] = structuredClone(format);
        owners.set(id, group);
        changes.addedFormats.push(`${group}.${id}`);
      }
      if (!Object.keys(formats).length) {
        changes.skipped.push({ id: group, reason: "none of its formats has a declared page" });
        continue;
      }
      catalog[group] = { ...structuredClone(stock), formats };
      changes.addedGroups.push(group);
      continue;
    }
    for (const field of Object.keys(stock)) {
      if (field === "formats") continue;
      advanceOrKeep(changes, entry, field, stock[field], baseGroups, `${group}.${field}`);
    }
    if (!isObject(entry.formats)) entry.formats = {};
    for (const [id, format] of Object.entries(isObject(stock.formats) ? stock.formats : {})) {
      const existing = entry.formats[id];
      if (!isObject(existing)) {
        if (!admit(group, id, format)) continue;
        entry.formats[id] = structuredClone(format);
        owners.set(id, group);
        changes.addedFormats.push(`${group}.${id}`);
        continue;
      }
      const baseFormats = baseGroups.map((baseGroup) => baseGroup.formats?.[id]).filter(isObject);
      for (const field of Object.keys(format)) {
        if (field === "page" && !declaredPages.has(format.page)) continue;
        advanceOrKeep(changes, existing, field, format[field], baseFormats, `${group}.${id}.${field}`);
      }
    }
  }
  return { catalog, changes };
}

/**
 * Add the stock stylesheet links a layout lacks, each on its own line beside
 * the nearest stock link the layout already has. A layout with none of the
 * neighbours is left alone and reported, since its head is not the starter's.
 */
export function insertStylesheetLinks(layout, templateLayout, hrefs = starterLayoutStylesheets) {
  const linkPattern = /<link\b[^>]*\brel="stylesheet"[^>]*\bhref="([^"]+)"[^>]*>/g;
  const stock = [...templateLayout.matchAll(linkPattern)].map((match) => ({ href: match[1], tag: match[0] }));
  // A link counts whatever its quoting or cache-busting query, so a layout
  // that links /styles/viewer.css?v=3 is not given a second viewer link.
  const linked = (href) => new RegExp(`href=["']${href.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:[?#][^"']*)?["']`);
  const has = (lines, href) => lines.findIndex((line) => linked(href).test(line));
  const lines = layout.split("\n");
  const inserted = [];
  const unplaced = [];
  stock.forEach(({ href, tag }, position) => {
    if (!hrefs.includes(href) || has(lines, href) !== -1) return;
    const following = stock.slice(position + 1).find((link) => has(lines, link.href) !== -1);
    const preceding = stock.slice(0, position).reverse().find((link) => has(lines, link.href) !== -1);
    const anchor = following ?? preceding;
    if (!anchor) {
      unplaced.push(href);
      return;
    }
    const index = has(lines, anchor.href);
    const indent = lines[index].match(/^\s*/)[0];
    lines.splice(following ? index : index + 1, 0, `${indent}${tag}`);
    inserted.push(href);
  });
  return { html: lines.join("\n"), inserted, unplaced };
}

/**
 * The viewer's version chip opens the changelog page TimDS renders. A layout
 * still carrying the plain chip gains the link; any other chip is the client's.
 */
export function linkVersionChip(layout) {
  const chip = /<span class="appbar__version">(\s*v?\{\{\s*version\s*\}\}\s*)<\/span>/;
  const match = chip.exec(layout);
  if (!match) return { html: layout, linked: false };
  return { html: layout.replace(chip, `<a class="appbar__version" href="/changelog/" title="Changelog">${match[1]}</a>`), linked: true };
}

// The catalogs are written in the starter's own style, one page or format per
// line, so a sync produces a reviewable diff instead of reflowing the file.
function inline(value) {
  if (Array.isArray(value)) return `[${value.map(inline).join(", ")}]`;
  if (isObject(value)) {
    const entries = Object.entries(value).map(([key, entry]) => `${JSON.stringify(key)}: ${inline(entry)}`);
    return entries.length ? `{ ${entries.join(", ")} }` : "{}";
  }
  return JSON.stringify(value);
}

export function formatSiteJson(site) {
  const lines = ["{"];
  const keys = Object.keys(site);
  keys.forEach((key, position) => {
    const comma = position < keys.length - 1 ? "," : "";
    if (key !== "views" || !Array.isArray(site.views)) {
      lines.push(`  ${JSON.stringify(key)}: ${inline(site[key])}${comma}`);
      return;
    }
    lines.push('  "views": [');
    site.views.forEach((view, viewPosition) => {
      lines.push("    {");
      const fields = Object.keys(view);
      fields.forEach((field, fieldPosition) => {
        const fieldComma = fieldPosition < fields.length - 1 ? "," : "";
        if (field !== "pages" || !Array.isArray(view.pages)) {
          lines.push(`      ${JSON.stringify(field)}: ${inline(view[field])}${fieldComma}`);
          return;
        }
        lines.push('      "pages": [');
        view.pages.forEach((page, pagePosition) => {
          lines.push(`        ${inline(page)}${pagePosition < view.pages.length - 1 ? "," : ""}`);
        });
        lines.push(`      ]${fieldComma}`);
      });
      lines.push(`    }${viewPosition < site.views.length - 1 ? "," : ""}`);
    });
    lines.push(`  ]${comma}`);
  });
  lines.push("}");
  return `${lines.join("\n")}\n`;
}

export function formatFormatsJson(catalog) {
  const lines = ["{"];
  const keys = Object.keys(catalog);
  keys.forEach((key, position) => {
    const comma = position < keys.length - 1 ? "," : "";
    const group = catalog[key];
    if (key.startsWith("$") || !isObject(group)) {
      lines.push(`  ${JSON.stringify(key)}: ${inline(group)}${comma}`);
      return;
    }
    lines.push(`  ${JSON.stringify(key)}: {`);
    const fields = Object.keys(group);
    fields.forEach((field, fieldPosition) => {
      const fieldComma = fieldPosition < fields.length - 1 ? "," : "";
      if (field !== "formats" || !isObject(group.formats)) {
        lines.push(`    ${JSON.stringify(field)}: ${inline(group[field])}${fieldComma}`);
        return;
      }
      lines.push('    "formats": {');
      const ids = Object.keys(group.formats);
      ids.forEach((id, idPosition) => {
        lines.push(`      ${JSON.stringify(id)}: ${inline(group.formats[id])}${idPosition < ids.length - 1 ? "," : ""}`);
      });
      lines.push(`    }${fieldComma}`);
    });
    lines.push(`  }${comma}`);
  });
  lines.push("}");
  return `${lines.join("\n")}\n`;
}

export async function readStarterRecord(designSystemRoot) {
  const text = await readOptional(path.join(designSystemRoot, STARTER_RECORD_FILE));
  if (text === null) return null;
  const record = parseJson(text, STARTER_RECORD_FILE);
  if (!isObject(record) || !isObject(record.files) || !isObject(record.baseline)) {
    throw new Error(`${STARTER_RECORD_FILE} is not a TimDS starter record; restore it from git or delete it and rerun timds starter sync`);
  }
  if (record.plumbing !== undefined && !STARTER_PLUMBING_MODES.includes(record.plumbing)) {
    throw new Error(`${STARTER_RECORD_FILE} has plumbing ${JSON.stringify(record.plumbing)}; it must be ${STARTER_PLUMBING_MODES.map((mode) => JSON.stringify(mode)).join(" or ")}`);
  }
  starterKind(record.starter);
  if (record.level !== undefined && (!Number.isInteger(record.level) || record.level < 0)) throw new Error(`${STARTER_RECORD_FILE} has level ${JSON.stringify(record.level)}; it must be a whole number (absent means 0)`);
  if (record.declined !== undefined && (!Array.isArray(record.declined) || record.declined.some((id) => typeof id !== "string"))) throw new Error(`${STARTER_RECORD_FILE} has declined ${JSON.stringify(record.declined)}; it must be a list of step ids`);
  return record;
}

async function writeStarterRecord(designSystemRoot, record) {
  const file = path.join(designSystemRoot, STARTER_RECORD_FILE);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  return file;
}

/** The stock catalogs, managed file texts, and their hashes of the installed toolkit's starter, each template read once. */
async function stockStarter(kind = "starter") {
  kind = starterKind(kind);
  const files = {};
  const texts = {};
  for (const [relative, templateName] of [...starterPlumbingFiles, ...starterFragments(kind)]) {
    texts[relative] = await template(templateName);
    files[relative] = sha256(texts[relative]);
  }
  return {
    files,
    formats: parseJson(await template(`${kind}/src/formats.json`), "the starter formats template"),
    site: parseJson(await template(`${kind}/src/site.json`), "the starter site template"),
    texts,
  };
}

/**
 * Record a fresh scaffold as adopted: every managed file at its stock hash and
 * the stock catalogs as the baseline, so the first `upgrade` already knows
 * what the toolkit wrote, with the plumbing the toolkit's outright.
 */
export async function recordFreshStarter(designSystemRoot, version, kind = "starter") {
  kind = starterKind(kind);
  const stock = await stockStarter(kind);
  return writeStarterRecord(designSystemRoot, {
    baseline: { formats: stock.formats, site: stock.site },
    declined: [],
    files: stock.files,
    level: STARTER_LEVEL,
    plumbing: "toolkit",
    schemaVersion: 1,
    starter: kind,
    version,
  });
}

/**
 * Note files another command wrote at their stock text (`designs init`
 * replacing the build and viewer scripts) in an existing record, so the next
 * sync recognizes them as the toolkit's rather than as customized.
 */
export async function recordStarterFiles(designSystemRoot, record, writtenTexts) {
  const files = { ...record.files };
  for (const [relative, text] of Object.entries(writtenTexts)) files[relative] = sha256(text);
  return writeStarterRecord(designSystemRoot, { ...record, files });
}

/** Whether this Design System is starter-based at all: it has the starter's site model. */
export async function isStarterSystem(designSystemRoot) {
  return (await readOptional(path.join(designSystemRoot, STARTER_SITE_FILE))) !== null;
}

/** The customized files in a sync report that `starter sync --force <path>` would replace (plumbing) or remove (the copied renderer); never a fragment. */
export function forceReplaceable(report) {
  const plumbing = new Set([...starterPlumbingFiles, ...retiredStarterFiles].map(([relative]) => relative));
  return report.files.filter((file) => file.status === "customized" && plumbing.has(file.path)).map((file) => file.path);
}

/**
 * Bring a starter-based Design System up to the installed toolkit's scaffold
 * and starter level. Plans every change first, writes them together, records
 * what it wrote, and runs `check`; if the check fails, every file is restored
 * (removed ones included) and the error says what failed, so the system is
 * never left between two structures. `force` lists the plumbing files to
 * replace, and the retired renderer files to remove, even though they are
 * customized (moot for the stubs when the record's plumbing mode is
 * "toolkit", which replaces them all); it never reaches a fragment, which is
 * the system's own page once it differs. `decideCustomized`, when given, is
 * asked about each remaining customized plumbing file with `{ path, file,
 * current, desired, templatePath }` and answers "replace" or "keep", which is
 * how an interactive CLI lets a person choose without knowing the file names
 * up front. A caller that already read the record passes it as `record` (null
 * for none); otherwise the sync reads it.
 *
 * After the plumbing, catalogs and fragments are planned, the starter steps
 * above the recorded level run on that planned state (see starter-steps.mjs):
 * `accept` names visible steps to apply and `decline` declinable steps to
 * settle by decision; with neither, as in `upgrade`, no visible step is ever
 * applied. `dryRun` plans and reports without writing anything.
 */
export async function syncStarter({ designSystemRoot, version, check = null, decideCustomized = null, force = [], record = undefined, parent = undefined, accept = [], decline = [], dryRun = false }) {
  const resolve = (relative) => path.join(designSystemRoot, ...relative.split("/"));
  const siteText = await readOptional(resolve(STARTER_SITE_FILE));
  if (siteText === null) {
    throw new Error(`${designSystemRoot} has no ${STARTER_SITE_FILE}, so it is not a starter-based Design System; starter sync only applies to systems scaffolded by timds init`);
  }
  if (record === undefined) record = await readStarterRecord(designSystemRoot);
  // An offshoot's structural stock comes from its parent, through `feed`.
  // A toolkit upgrade still keeps its engine current, but must not append
  // the seed's catalogs or author its fragments into the child's structure.
  if (parent === undefined) parent = await readParentRecord(designSystemRoot);
  const kind = starterKind(record?.starter);
  const stock = await stockStarter(kind);
  const level = record?.level ?? 0;
  const declined = [...(record?.declined ?? [])];
  const knownSteps = new Map(starterSteps.map((step) => [step.id, step]));
  for (const id of [...accept, ...decline]) {
    if (!knownSteps.has(id)) throw Object.assign(new Error(`Unknown starter step ${JSON.stringify(id)}; this release declares ${starterSteps.map((step) => step.id).join(", ")}`), { failureCode: "unknown_step" });
  }
  for (const id of decline) {
    if (!knownSteps.get(id).declinable) throw Object.assign(new Error(`The starter step ${id} cannot be declined; only ${starterSteps.filter((step) => step.declinable).map((step) => step.id).join(", ") || "none"} can`), { failureCode: "not_declinable" });
    if (accept.includes(id)) throw Object.assign(new Error(`The starter step ${id} is both accepted and declined; choose one`), { failureCode: "conflicting_decision" });
    if (knownSteps.get(id).level <= level && !declined.includes(id)) throw Object.assign(new Error(`The starter step ${id} is already applied at level ${level}; there is nothing to decline`), { failureCode: "already_settled" });
    if (!declined.includes(id)) declined.push(id);
  }
  for (const id of accept) {
    if (declined.includes(id) && !decline.includes(id)) throw Object.assign(new Error(`The starter step ${id} was declined; remove it from declined in ${STARTER_RECORD_FILE} to accept it`), { failureCode: "already_declined" });
  }
  const files = [];
  const writes = [];
  // An offshoot keeps the hashes it was recorded with, except the kit pages
  // earlier releases recorded as managed: they are seed-only now, so a kit
  // child's record drops them like any kit system's.
  const recordedFiles = parent ? Object.fromEntries(Object.entries(record?.files ?? {}).filter(([relative]) => !retiredFragmentPaths(kind).has(relative))) : {};
  const plan = (relative, status, content, current, note) => {
    files.push(note ? { note, path: relative, status } : { path: relative, status });
    if (content !== null && content !== undefined && content !== current) writes.push({ content, current, file: resolve(relative), relative });
  };
  // A file the toolkit wrote is recorded at the stock hash; a customized one
  // keeps the hash last written for it, so a revert to that version is still
  // recognized as stock instead of staying customized until --force.
  const recordFile = (relative, planned) => {
    if (planned.status !== "customized" && planned.status !== "skipped") recordedFiles[relative] = stock.files[relative];
    else if (typeof record?.files?.[relative] === "string") recordedFiles[relative] = record.files[relative];
  };

  // 1. Plumbing, by hash; or outright when the toolkit owns it.
  const plumbingMode = record?.plumbing ?? "recorded";
  const plumbingPlans = [];
  for (const [relative] of starterPlumbingFiles) {
    const desired = stock.texts[relative];
    let planned = await planStockFile(resolve(relative), desired, { force: plumbingMode === "toolkit" || force.includes(relative), knownHashes: knownStarterHashes(relative, record) });
    let note = planned.forced ? (plumbingMode === "toolkit" ? "the toolkit's in this system; a local change was replaced" : "replaced with --force") : undefined;
    if (planned.status === "customized" && decideCustomized) {
      const choice = await decideCustomized({ current: planned.current, desired, file: resolve(relative), path: relative, templatePath: stockTemplatePath(relative, kind) });
      if (choice === "replace") {
        planned = { ...planned, forced: true, status: "updated", write: true };
        note = "replaced at the prompt";
      } else {
        note = "kept at the prompt";
      }
    }
    plumbingPlans.push({ relative, desired, planned, note });
  }
  // The copied renderer files a pending step would remove, by the hashes that
  // step declares. One that is neither absent, stock nor named by --force is
  // this system's own.
  const retiring = new Map();
  let copiedRenderer = false;
  for (const step of starterSteps) {
    if (step.level <= level || !starterStepApplies(step, { starter: kind, offshoot: Boolean(parent) })) continue;
    for (const operation of step.operations) {
      if (operation.op !== "remove-file" || !starterRendererFiles.includes(operation.path)) continue;
      copiedRenderer = true;
      const bytes = await readOptionalBytes(resolve(operation.path));
      if (bytes === null) continue;
      const isStock = operation.sha256.includes(sha256(bytes));
      retiring.set(operation.path, { bytes, isStock, customized: !isStock && !force.includes(operation.path) });
    }
  }
  // The stub scripts and the copied renderer are one renderer. While one of
  // them is this system's own and kept, the system keeps its whole copied
  // renderer, so it builds exactly as before: a stub beside a kept build
  // script or viewer would bypass it. In the toolkit's own plumbing mode the
  // stubs are always written, so a kept copy is only left unused and reported.
  const rendererKept = [
    ...plumbingPlans.filter(({ relative, planned }) => starterRendererFiles.includes(relative) && planned.status === "customized").map(({ relative }) => relative),
    ...[...retiring].filter(([, entry]) => entry.customized).map(([relative]) => relative),
  ];
  // Once the copied renderer is gone (the step that removes it settled), a
  // customized stub is ordinary kept plumbing that still calls the package.
  const holdBack = plumbingMode === "recorded" && copiedRenderer && rendererKept.length > 0;
  const heldBack = (what) => `held back: ${rendererKept.join(" and ")} ${rendererKept.length === 1 ? "is" : "are"} this system's own and ${what}; port the renderer, or run timds starter sync --force ${rendererKept.join(" ")} to replace it`;
  for (const entry of plumbingPlans) {
    if (holdBack && starterRendererFiles.includes(entry.relative) && (entry.planned.status === "updated" || entry.planned.status === "created")) {
      entry.planned = { ...entry.planned, status: "skipped", write: false };
      entry.note = heldBack("the stock version expects the stock renderer beside it");
    }
    recordFile(entry.relative, entry.planned);
    plan(entry.relative, entry.planned.status, entry.planned.write ? entry.desired : null, entry.planned.current, entry.note);
  }

  // 2. The catalogs. The site model is merged first because formats and
  //    fragments both refer to its pages. A system without a record is
  //    merged against the catalogs earlier releases scaffolded; the current
  //    stock is never a baseline, since a field equal to it needs no merge
  //    and a kept edit is only news when the stock moved away from what the
  //    client could have synced from.
  let merged = { changes: { addedPages: [], addedViews: [], advanced: [], kept: [] } };
  let mergedFormats = { changes: { addedFormats: [], addedGroups: [], advanced: [], kept: [], skipped: [] } };
  const currentSite = parseJson(siteText, STARTER_SITE_FILE);
  let siteForSteps = currentSite;
  let planSite = null;
  const fragmentPlans = new Map();
  if (!parent) {
    const siteBaselines = record?.baseline.site ? [record.baseline.site] : await historicalSiteSnapshots(kind);
    const fragmentPages = new Map(starterFragments(kind).map(([relative]) => {
      const id = relative.slice("src/pages/".length, -".html".length).replace(/\/index$/, "");
      return [id, { relative }];
    }));
    const declaredBefore = declaredPageIds(currentSite);
    const fragmentsToWrite = new Set();
    const authoredPages = new Set();
    // The stock pages are rendered by the stock viewer. While the viewer, or
    // the build that drives it, is this system's own, a stock page it has not
    // seen may use placeholders it cannot render; writing it would fail the
    // sync's own check and roll the upgrade back, so the page waits instead.
    for (const [id, { relative }] of fragmentPages) {
      const desired = stock.texts[relative];
      const planned = await planStockFile(resolve(relative), desired, { knownHashes: knownStarterHashes(relative, record) });
      if (holdBack && (planned.status === "updated" || planned.status === "created")) {
        fragmentPlans.set(relative, { desired, planned: { ...planned, status: "skipped", write: false }, note: heldBack("may not render the stock page") });
        continue;
      }
      if (planned.status !== "created") {
        // A fragment that exists is an authored page, whatever the site model
        // still says: the viewer refuses a planned page whose file exists.
        if (findSitePage(currentSite, id)?.planned === true) authoredPages.add(id);
        fragmentPlans.set(relative, { desired, planned });
        continue;
      }
      // An absent fragment is written when the sync adds its page, and when the
      // page is declared but still planned: a planned page has no content to
      // lose, and the stock overview is the primitive the view starts from (the
      // client's own title and summary stay). A page the client declares as
      // authored keeps whatever fragment plans they have.
      const stockPage = findSitePage(stock.site, id);
      const declaredPage = findSitePage(currentSite, id);
      if (stockPage?.planned !== true && (!declaredBefore.has(id) || declaredPage?.planned === true)) {
        fragmentsToWrite.add(id);
        if (declaredBefore.has(id)) authoredPages.add(id);
        fragmentPlans.set(relative, { desired, planned });
      } else {
        fragmentPlans.set(relative, { desired, planned: { ...planned, status: "skipped", write: false } });
      }
    }
    const fragmentExists = (id) => {
      if (fragmentsToWrite.has(id)) return true;
      const [view, ...rest] = id.split("/");
      return existsSync(resolve(`src/pages/${view}/${rest.length ? rest.join("/") : "index"}.html`));
    };
    merged = mergeSiteModel(currentSite, stock.site, siteBaselines, { authoredPages, fragmentExists });
    siteForSteps = merged.site;
    planSite = (site) => {
      const siteChanged = !isDeepStrictEqual(site, currentSite);
      plan(STARTER_SITE_FILE, siteChanged ? "updated" : "current", siteChanged ? formatSiteJson(site) : null, siteText);

      const formatsText = readOptionalSync(resolve(STARTER_FORMATS_FILE));
      const currentFormats = formatsText === null ? null : parseJson(formatsText, STARTER_FORMATS_FILE);
      const formatBaselines = record ? [record.baseline.formats] : [];
      mergedFormats = mergeFormatCatalog(currentFormats, stock.formats, formatBaselines, declaredPageIds(site));
      const formatsChanged = currentFormats === null || !isDeepStrictEqual(mergedFormats.catalog, currentFormats);
      plan(STARTER_FORMATS_FILE, currentFormats === null ? "created" : formatsChanged ? "updated" : "current", formatsChanged ? formatFormatsJson(mergedFormats.catalog) : null, formatsText);

      // 3. Fragments, now that the site model says which pages exist. A
      //    customized fragment is this system's own page: kept, --force or not.
      for (const [relative, { desired, planned, note: heldBackNote }] of fragmentPlans) {
        if (planned.status !== "skipped") recordFile(relative, planned);
        const note = heldBackNote ?? (planned.status === "skipped"
          ? "its page is declared as authored by this system; copy the stock fragment by hand if wanted"
          : planned.status === "customized" ? "this system's own page; never replaced, --force included" : undefined);
        plan(relative, planned.status, planned.write ? desired : null, planned.current, note);
      }
    };
  }

  // 4. The starter steps above the recorded level, on the state the plan
  //    above leaves: the planned plumbing and fragment bytes, the merged site.
  const plannedBytes = new Map();
  for (const { relative, planned, desired } of plumbingPlans) {
    if (planned.write) plannedBytes.set(relative, Buffer.from(desired));
  }
  for (const [relative, { planned, desired }] of fragmentPlans) {
    if (planned.write) plannedBytes.set(relative, Buffer.from(desired));
  }
  // While the renderer is kept, the step that removes the copied renderer
  // stops with the renderer_kept conflict, naming each kept file.
  const hold = holdBack ? Object.fromEntries(starterSteps.filter((step) => step.level > level && step.operations.some((operation) => operation.op === "remove-file" && starterRendererFiles.includes(operation.path)))
    .map((step) => [step.id, rendererKept.map((relative) => ({ step: step.id, path: relative, reason: starterStepConflictReasons[step.id] ?? "customized" }))])) : {};
  const steps = runStarterSteps(starterSteps, {
    site: siteForSteps,
    read: (relative) => plannedBytes.get(relative) ?? readOptionalBytesSync(resolve(relative)),
    stock: (relative) => (Object.hasOwn(stock.texts, relative) ? Buffer.from(stock.texts[relative]) : null),
  }, { level, declined, accept: new Set(accept), starter: kind, offshoot: Boolean(parent), force: new Set(force), reasons: starterStepConflictReasons, hold });
  if (planSite) planSite(steps.site);
  for (const [relative, entry] of retiring) {
    const removed = steps.remove.includes(relative);
    if (removed) {
      files.push({ path: relative, status: "removed", ...(entry.isStock ? {} : { note: "removed with --force" }) });
      writes.push({ remove: true, current: entry.bytes, file: resolve(relative), relative });
      delete recordedFiles[relative];
    } else {
      files.push(entry.customized
        ? { note: "this system's own copy of the renderer; kept until the renderer is ported to timds.json workspace.after.build and timds starter sync --force names it", path: relative, status: "customized" }
        : { note: "kept with the copied renderer until the renderer-package step settles", path: relative, status: "skipped" });
      if (typeof record?.files?.[relative] === "string") recordedFiles[relative] = record.files[relative];
    }
  }

  // 5. The layout shell gains the links it lacks (stylesheets, the changelog on its version chip) and nothing else.
  const layoutText = await readOptional(resolve(STARTER_LAYOUT_FILE));
  if (layoutText === null) {
    plan(STARTER_LAYOUT_FILE, "skipped", null, null, "absent");
  } else {
    const links = insertStylesheetLinks(layoutText, await template(`${kind}/src/layout.html`));
    const chip = linkVersionChip(links.html);
    const changed = links.inserted.length > 0 || chip.linked;
    const status = changed ? "updated" : links.unplaced.length ? "customized" : "current";
    const notes = [];
    if (links.inserted.length) notes.push(`linked ${links.inserted.join(", ")}`);
    if (chip.linked) notes.push("the version chip now opens /changelog/");
    if (links.unplaced.length) notes.push(`could not place ${links.unplaced.join(", ")}; link it in <head> by hand`);
    plan(STARTER_LAYOUT_FILE, status, changed ? chip.html : null, layoutText, notes.length ? notes.join("; ") : undefined);
  }

  // 6. Write, record, check; roll everything back when the check fails.
  // A decline is recorded unless the step settled otherwise in this run
  // (it had nothing to change); a decision recorded earlier stays.
  const settledOtherwise = new Set(steps.results.filter((result) => result.outcome === "applied" || result.outcome === "skipped").map((result) => result.step));
  const nextDeclined = starterSteps.map((step) => step.id).filter((id) => declined.includes(id) && ((record?.declined ?? []).includes(id) || !settledOtherwise.has(id)));
  const nextRecord = { baseline: parent ? record?.baseline ?? parent.baseline : { formats: stock.formats, site: stock.site }, declined: nextDeclined, files: recordedFiles, level: steps.level, ...(record?.plumbing ? { plumbing: record.plumbing } : {}), schemaVersion: 1, starter: kind, version };
  const recordPath = resolve(STARTER_RECORD_FILE);
  const previousRecordText = await readOptional(recordPath);
  const recordChanged = previousRecordText !== `${JSON.stringify(nextRecord, null, 2)}\n`;
  const report = {
    adopted: record === null,
    check: null,
    designSystemRoot,
    files,
    formats: mergedFormats.changes,
    plumbing: plumbingMode,
    starter: kind,
    record: recordPath,
    recordWritten: recordChanged,
    site: merged.changes,
    written: writes.map((write) => write.relative),
    levels: {
      previous: level,
      level: steps.level,
      declined: nextDeclined,
      steps: steps.results,
      stopped: steps.stopped,
      conflicts: steps.conflicts,
    },
    renderer: { kept: rendererKept },
  };
  const copied = [...retiring.keys()].some((relative) => !steps.remove.includes(relative));
  report.renderer.copied = copied;
  report.status = describeStarterStatus({ starter: kind, plumbing: plumbingMode, level: steps.level, declined: nextDeclined }, { kept: rendererKept, copied, conflicts: steps.conflicts, offshoot: Boolean(parent) });
  if (dryRun || (!writes.length && !recordChanged)) return report;
  for (const write of writes) {
    if (write.remove) {
      await fs.rm(write.file, { force: true });
      continue;
    }
    await fs.mkdir(path.dirname(write.file), { recursive: true });
    await fs.writeFile(write.file, write.content, "utf8");
  }
  if (recordChanged) await writeStarterRecord(designSystemRoot, nextRecord);
  if (writes.length && check) {
    try {
      report.check = await check();
    } catch (caught) {
      for (const write of writes) {
        if (write.current === null) await fs.rm(write.file, { force: true });
        else await fs.writeFile(write.file, write.current, typeof write.current === "string" ? "utf8" : undefined);
      }
      if (previousRecordText === null) await fs.rm(recordPath, { force: true });
      else await fs.writeFile(recordPath, previousRecordText, "utf8");
      const customized = forceReplaceable({ files });
      // `failureCode` lets a machine-readable caller tell a failed check from a refusal.
      throw Object.assign(new Error(`Starter sync was rolled back because the workspace check failed afterwards: ${caught.message}${customized.length
        ? `\nCustomized files were kept (${customized.join(", ")}); the new pages may need their stock versions. Port your changes, or run timds starter sync --force ${customized.join(" ")} to replace them.`
        : ""}`), { failureCode: "check_failed" });
    }
  }
  return report;
}

/**
 * The starter status a person, `doctor --json`, the upgrade report and a host
 * read: the recorded level against this release's, the floor, what is
 * pending, declined and in conflict, and whether the renderer is the
 * package's or a copy this system kept. `record` is `{ starter, plumbing,
 * level, declined }`; `kept` and `conflicts` come from a sync, real or dry.
 * Steps that do not apply to this system are not pending.
 */
export function describeStarterStatus(record, { kept = [], copied = false, conflicts = [], offshoot = false } = {}) {
  const starter = starterKind(record.starter);
  const level = record.level ?? 0;
  const declined = record.declined ?? [];
  return {
    starter,
    plumbing: record.plumbing ?? "recorded",
    level,
    current: STARTER_LEVEL,
    floor: STARTER_FLOOR,
    behind: Math.max(0, STARTER_LEVEL - level),
    // kept: a renderer file is this system's own; copied: the stock copied
    // renderer is still in the tree; package: the stubs call the package.
    renderer: kept.length ? "kept" : copied ? "copied" : "package",
    kept: [...kept],
    pending: starterSteps
      .filter((step) => step.level > level && !declined.includes(step.id) && starterStepApplies(step, { starter, offshoot }))
      .map((step) => ({ level: step.level, id: step.id, visible: step.visible, declinable: step.declinable })),
    declined: [...declined],
    conflicts: conflicts.map((entry) => ({ ...entry })),
  };
}

/**
 * `timds starter status`: what a sync would do now, without writing. The
 * level is the recorded one; conflicts and the kept renderer are the ones a
 * sync with nothing accepted would meet.
 */
export async function starterStatus(options) {
  return (await starterStatusPlan(options)).status;
}

/** The starter status and the dry-run sync behind it (`plan.levels` says where a sync would stop). */
export async function starterStatusPlan({ designSystemRoot, version, record = undefined, parent = undefined }) {
  if (record === undefined) record = await readStarterRecord(designSystemRoot);
  if (!record) throw Object.assign(new Error(`${designSystemRoot} has not adopted the starter sync; run timds starter sync once`), { failureCode: "not_adopted" });
  if (parent === undefined) parent = await readParentRecord(designSystemRoot);
  const plan = await syncStarter({ designSystemRoot, version, record, parent, dryRun: true });
  // The tree as it stands: a copied renderer the sync would remove is still here.
  return { plan, status: describeStarterStatus(record, { kept: plan.renderer.kept, copied: [...plan.files].some((file) => starterRendererFiles.includes(file.path) && ["removed", "skipped"].includes(file.status) && retiredStarterFiles.some(([relative]) => relative === file.path)), conflicts: plan.levels.conflicts, offshoot: Boolean(parent) }) };
}

/** The per-file status table and merge summary a CLI prints for a sync report. */
export function describeStarterSync(report) {
  const lines = [];
  const width = Math.max(...report.files.map((file) => file.status.length));
  for (const file of report.files) {
    lines.push(`  ${file.status.padEnd(width)}  ${file.path}${file.note ? `  (${file.note})` : ""}`);
  }
  const { formats, site } = report;
  if (site.addedViews.length) lines.push(`Added views: ${site.addedViews.join(", ")} (every page planned until it is authored).`);
  if (site.addedPages.length) lines.push(`Added planned pages: ${site.addedPages.join(", ")}.`);
  if (site.advanced.length) lines.push(`Advanced unchanged stock fields: ${site.advanced.join(", ")}.`);
  const keptAs = (kept) => (kept.current === undefined ? "undeclared" : `as ${JSON.stringify(kept.current)}`);
  for (const kept of site.kept) lines.push(`Kept ${kept.path} ${keptAs(kept)}; the scaffold now says ${JSON.stringify(kept.stock)}.`);
  if (formats.addedGroups.length) lines.push(`Added format groups: ${formats.addedGroups.join(", ")}.`);
  if (formats.addedFormats.length) {
    const groups = [...new Set(formats.addedFormats.map((id) => id.split(".")[0]))];
    lines.push(`Added formats: ${formats.addedFormats.length} in ${groups.join(", ")}.`);
  }
  if (formats.advanced.length) lines.push(`Advanced unchanged stock format fields: ${formats.advanced.join(", ")}.`);
  for (const kept of formats.kept) lines.push(`Kept format field ${kept.path} ${keptAs(kept)}; the scaffold now says ${JSON.stringify(kept.stock)}.`);
  for (const skipped of formats.skipped) lines.push(`Skipped format ${skipped.id}: ${skipped.reason}.`);
  if (report.check) {
    const warnings = report.check.machine?.warnings ?? [];
    lines.push(`Check passed${warnings.length ? ` with ${warnings.length} warning${warnings.length === 1 ? "" : "s"}` : ""}.`);
    for (const warning of warnings) lines.push(`Warning: ${warning}`);
  }
  return lines;
}
