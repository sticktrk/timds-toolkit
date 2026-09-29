// The board catalog: a Design System's vocabulary of graphic boards, read from
// its client-owned video/boards.json. TimDS owns the mechanism — the catalog
// schema, the authoring-contract merge, compile-time validation, cadence, and
// cue checks — and nothing here knows a client's kinds, copy, or motifs.
//
// Each kind carries a JSON-Schema subset for its data plus guidance metadata.
// The subset is deliberately small so one in-toolkit walker can enforce it and
// the same schema can be handed to a drafting model unchanged.

import { sceneAssetKeys } from "../video/footage.mjs";
import { normalizeCueWord } from "../video/boards.mjs";

export const BOARDS_SCHEMA_VERSION = 1;

/** Board kinds the producer inserts itself; a model never authors them. */
export const COMPILER_OWNED_BOARD_KINDS = Object.freeze(["subscribe"]);

const SLUG = /^[a-z0-9][a-z0-9-]*$/u;
const TYPES = ["object", "array", "string", "integer", "number", "boolean"];
const OVER_FOOTAGE = ["never", "optional", "always"];
const COMMON_KEYWORDS = ["type", "enum", "const", "description"];
const TYPE_KEYWORDS = {
  object: ["properties", "required", "additionalProperties"],
  array: ["items", "minItems", "maxItems"],
  string: ["minLength", "maxLength", "x-timds-maxWords", "x-timds-motif", "x-timds-cue", "x-timds-substringOf"],
  integer: ["minimum"],
  number: ["minimum"],
  boolean: [],
};

const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const words = (value) => String(value ?? "").trim().split(/\s+/u).filter(Boolean);
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);

const requireObject = (value, label) => {
  if (!isObject(value)) throw new Error(`${label} must be a JSON object`);
  return value;
};
const requireText = (value, label) => {
  const result = String(value ?? "").replace(/\s+/gu, " ").trim();
  if (!result) throw new Error(`${label} is required`);
  return result;
};
const optionalPositiveInteger = (value, label) => {
  if (value === undefined || value === null) return null;
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be a positive integer`);
  return value;
};
const optionalBoolean = (value, label, fallback) => {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "boolean") throw new Error(`${label} must be a boolean`);
  return value;
};
const nonNegativeInteger = (value, label) => {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer`);
  return value;
};

function normalizeSchemaNode(input, label) {
  const node = requireObject(input, label);
  const type = node.type;
  if (!TYPES.includes(type)) throw new Error(`${label}.type must be one of ${TYPES.join(", ")}`);
  const allowed = new Set([...COMMON_KEYWORDS, ...TYPE_KEYWORDS[type]]);
  for (const key of Object.keys(node)) {
    if (!allowed.has(key)) {
      throw new Error(`${label} uses unsupported schema keyword ${key}${Object.values(TYPE_KEYWORDS).flat().includes(key) ? ` for type ${type}` : ""}; board schemas accept only ${[...allowed].join(", ")}`);
    }
  }
  const result = { type };
  if (node.description !== undefined) result.description = requireText(node.description, `${label}.description`);
  if (node.enum !== undefined) {
    if (!Array.isArray(node.enum) || !node.enum.length) throw new Error(`${label}.enum must be a non-empty array`);
    result.enum = [...node.enum];
  }
  if (node.const !== undefined) result.const = node.const;
  if (type === "object") {
    const properties = requireObject(node.properties ?? {}, `${label}.properties`);
    result.properties = Object.fromEntries(Object.entries(properties).map(([key, value]) => [key, normalizeSchemaNode(value, `${label}.properties.${key}`)]));
    const required = node.required ?? [];
    if (!Array.isArray(required) || required.some((key) => typeof key !== "string")) throw new Error(`${label}.required must be an array of property names`);
    for (const key of required) if (!result.properties[key]) throw new Error(`${label}.required names ${key}, which is not a declared property`);
    result.required = [...new Set(required)];
    // Boards are closed by default: a drafting model's structured output needs
    // additionalProperties: false, and an unknown field is a typo, not data.
    result.additionalProperties = optionalBoolean(node.additionalProperties, `${label}.additionalProperties`, false);
    for (const [key, value] of Object.entries(result.properties)) {
      const sibling = value["x-timds-substringOf"];
      if (sibling === undefined) continue;
      if (typeof sibling !== "string" || sibling === key || result.properties[sibling]?.type !== "string") {
        throw new Error(`${label}.properties.${key}.x-timds-substringOf must name a sibling string property`);
      }
    }
  }
  if (type === "array") {
    if (node.items === undefined) throw new Error(`${label}.items is required for an array`);
    result.items = normalizeSchemaNode(node.items, `${label}.items`);
    if (node.minItems !== undefined) result.minItems = nonNegativeInteger(node.minItems, `${label}.minItems`);
    if (node.maxItems !== undefined) result.maxItems = nonNegativeInteger(node.maxItems, `${label}.maxItems`);
    if (result.minItems !== undefined && result.maxItems !== undefined && result.minItems > result.maxItems) {
      throw new Error(`${label}.minItems must not exceed maxItems`);
    }
  }
  if (type === "string") {
    if (node.minLength !== undefined) result.minLength = nonNegativeInteger(node.minLength, `${label}.minLength`);
    if (node.maxLength !== undefined) result.maxLength = nonNegativeInteger(node.maxLength, `${label}.maxLength`);
    if (result.minLength !== undefined && result.maxLength !== undefined && result.minLength > result.maxLength) throw new Error(`${label}.minLength must not exceed maxLength`);
    if (node["x-timds-maxWords"] !== undefined) result["x-timds-maxWords"] = optionalPositiveInteger(node["x-timds-maxWords"], `${label}.x-timds-maxWords`);
    for (const flag of ["x-timds-motif", "x-timds-cue"]) {
      if (node[flag] === undefined) continue;
      if (node[flag] !== true) throw new Error(`${label}.${flag} must be true when present`);
      result[flag] = true;
    }
    if (result["x-timds-motif"] && result["x-timds-cue"]) throw new Error(`${label} cannot be both a motif and a cue`);
    if (node["x-timds-substringOf"] !== undefined) result["x-timds-substringOf"] = node["x-timds-substringOf"];
  }
  if (type === "integer" || type === "number") {
    if (node.minimum !== undefined) {
      if (!Number.isFinite(node.minimum)) throw new Error(`${label}.minimum must be a number`);
      result.minimum = node.minimum;
    }
  }
  return result;
}

const LIMIT_KEYS = ["minItems", "maxItems", "minLength", "maxLength", "x-timds-maxWords"];
const catalogFormat = (format) => (format === "short" ? "short" : "longform");

function schemaField(schema, path, label) {
  let node = schema;
  for (const key of path.split(".")) {
    if (node.type !== "object" || !Object.hasOwn(node.properties, key)) throw new Error(`${label} names unknown schema field ${path}`);
    node = node.properties[key];
  }
  return node;
}

function normalizeConstraint(input, schema, label) {
  const rule = requireObject(input, label);
  for (const key of Object.keys(rule)) if (!["when", "maxWords", "fields"].includes(key)) throw new Error(`${label} has unknown field ${key}`);
  const when = requireObject(rule.when, `${label}.when`);
  for (const key of Object.keys(when)) if (!["format", "overFootage"].includes(key)) throw new Error(`${label}.when has unknown field ${key}`);
  if (when.format === undefined && when.overFootage === undefined) throw new Error(`${label}.when needs format or overFootage`);
  if (when.format !== undefined && !["longform", "short"].includes(when.format)) throw new Error(`${label}.when.format must be longform or short`);
  if (when.overFootage !== undefined && typeof when.overFootage !== "boolean") throw new Error(`${label}.when.overFootage must be a boolean`);
  const fields = requireObject(rule.fields ?? {}, `${label}.fields`);
  for (const [path, limits] of Object.entries(fields)) {
    const node = schemaField(schema, path, label);
    requireObject(limits, `${label}.fields.${path}`);
    if (!Object.keys(limits).length) throw new Error(`${label}.fields.${path} needs a limit`);
    for (const [key, value] of Object.entries(limits)) {
      if (!LIMIT_KEYS.includes(key)) throw new Error(`${label}.fields.${path} has unsupported limit ${key}`);
      if (node[key] !== undefined && (key.startsWith("min") ? value < node[key] : value > node[key])) throw new Error(`${label}.fields.${path}.${key} must not loosen the base schema`);
    }
    normalizeSchemaNode({...node, ...limits}, `${label}.fields.${path}`);
  }
  const maxWords = optionalPositiveInteger(rule.maxWords, `${label}.maxWords`);
  if (!maxWords && !Object.keys(fields).length) throw new Error(`${label} needs maxWords or field limits`);
  return {when: {...when}, ...(maxWords ? {maxWords} : {}), ...(Object.keys(fields).length ? {fields: structuredClone(fields)} : {})};
}

// Unknown footage at authoring time uses the intersection of the applicable
// limits. Compile and video check pass the actual scene context, preserving
// larger boards in layouts that permit them without offering unsafe drafts.
function boardLimits(kind, {format, overFootage} = {}) {
  const schema = structuredClone(kind.schema);
  let maxWords = kind.maxWords ?? null;
  const footage = overFootage ?? (kind.overFootage === "never" ? false : kind.overFootage === "always" ? true : undefined);
  for (const rule of kind.constraints ?? []) {
    if (format !== undefined && rule.when.format !== undefined && rule.when.format !== catalogFormat(format)) continue;
    if (footage !== undefined && rule.when.overFootage !== undefined && rule.when.overFootage !== footage) continue;
    if (rule.maxWords) maxWords = Math.min(maxWords ?? Infinity, rule.maxWords);
    for (const [path, limits] of Object.entries(rule.fields ?? {})) {
      const node = schemaField(schema, path, `board ${kind.id}`);
      for (const [key, value] of Object.entries(limits)) node[key] = node[key] === undefined ? value : key.startsWith("min") ? Math.max(node[key], value) : Math.min(node[key], value);
    }
  }
  return {schema: normalizeSchemaNode(schema, `board ${kind.id} effective schema`), maxWords};
}

function normalizeKind(id, input, label) {
  if (!SLUG.test(id)) throw new Error(`${label} kind id ${JSON.stringify(id)} must use lowercase letters, numbers, and hyphens`);
  const kind = requireObject(input, `${label}.kinds.${id}`);
  const known = new Set(["label", "use", "avoid", "overFootage", "once", "schema", "formats", "maxWords", "constraints"]);
  for (const key of Object.keys(kind)) {
    // A normalized kind carries its own id; accept it back so validation stays idempotent.
    if (key === "id" && kind.id === id) continue;
    if (!known.has(key)) throw new Error(`${label}.kinds.${id} has unknown field ${key}`);
  }
  const overFootage = kind.overFootage ?? "optional";
  if (!OVER_FOOTAGE.includes(overFootage)) throw new Error(`${label}.kinds.${id}.overFootage must be one of ${OVER_FOOTAGE.join(", ")}`);
  const schema = normalizeSchemaNode(kind.schema, `${label}.kinds.${id}.schema`);
  if (schema.type !== "object") throw new Error(`${label}.kinds.${id}.schema must describe an object`);
  if (schema.properties.kind) throw new Error(`${label}.kinds.${id}.schema must not declare kind; the catalog supplies it`);
  if (kind.formats !== undefined && (!Array.isArray(kind.formats) || !kind.formats.length || kind.formats.some((format) => !["longform", "short"].includes(format)))) throw new Error(`${label}.kinds.${id}.formats must contain longform or short`);
  if (kind.constraints !== undefined && !Array.isArray(kind.constraints)) throw new Error(`${label}.kinds.${id}.constraints must be an array`);
  const maxWords = optionalPositiveInteger(kind.maxWords, `${label}.kinds.${id}.maxWords`);
  const result = {
    id,
    label: requireText(kind.label, `${label}.kinds.${id}.label`),
    use: requireText(kind.use, `${label}.kinds.${id}.use`),
    avoid: requireText(kind.avoid, `${label}.kinds.${id}.avoid`),
    overFootage,
    once: optionalBoolean(kind.once, `${label}.kinds.${id}.once`, false),
    schema,
    ...(kind.formats ? {formats: [...new Set(kind.formats)]} : {}),
    ...(maxWords ? {maxWords} : {}),
    ...(kind.constraints ? {constraints: kind.constraints.map((rule, index) => normalizeConstraint(rule, schema, `${label}.kinds.${id}.constraints[${index}]`))} : {}),
  };
  for (const format of result.formats ?? ["longform", "short"]) {
    for (const overFootage of [false, true, undefined]) boardLimits(result, {format, overFootage});
  }
  return result;
}

/**
 * Validate and normalize a board catalog. Idempotent: a normalized catalog
 * validates to itself, so a producer can accept either the raw boards.json or
 * the catalog a workspace already loaded.
 */
export function validateBoardCatalog(input, { label = "video boards" } = {}) {
  const catalog = requireObject(input, label);
  const known = new Set(["schemaVersion", "formats", "cadence", "motifs", "kinds"]);
  for (const key of Object.keys(catalog)) if (!known.has(key)) throw new Error(`${label} has unknown field ${key}`);
  if (catalog.schemaVersion !== BOARDS_SCHEMA_VERSION) throw new Error(`${label} schemaVersion must be ${BOARDS_SCHEMA_VERSION}`);
  const formats = requireObject(catalog.formats ?? {}, `${label}.formats`);
  for (const key of Object.keys(formats)) if (!["longform", "short"].includes(key)) throw new Error(`${label}.formats has unknown format ${key}`);
  const cadence = requireObject(catalog.cadence ?? {}, `${label}.cadence`);
  for (const key of Object.keys(cadence)) {
    if (!["maxConsecutiveFootageFree", "chapterReturnsToFootage", "minimumChapters", "maxBoardWords"].includes(key)) throw new Error(`${label}.cadence has unknown rule ${key}`);
  }
  let motifs = null;
  if (catalog.motifs !== undefined && catalog.motifs !== null) {
    const raw = requireObject(catalog.motifs, `${label}.motifs`);
    for (const key of Object.keys(raw)) if (key !== "mount") throw new Error(`${label}.motifs has unknown field ${key}`);
    motifs = { mount: requireText(raw.mount, `${label}.motifs.mount`).replace(/^\/+|\/+$/gu, "") };
  }
  const kinds = requireObject(catalog.kinds, `${label}.kinds`);
  if (!Object.keys(kinds).length) throw new Error(`${label}.kinds must declare at least one board kind`);
  const normalizedKinds = Object.fromEntries(Object.entries(kinds).map(([id, kind]) => [id, normalizeKind(id, kind, label)]));
  // A motif field without a mount is allowed: a fresh system can declare the
  // field before it has an illustration library, and the walker then accepts
  // any motif name until the mount lands.
  return {
    schemaVersion: BOARDS_SCHEMA_VERSION,
    formats: {
      longform: optionalBoolean(formats.longform, `${label}.formats.longform`, true),
      short: optionalBoolean(formats.short, `${label}.formats.short`, false),
    },
    cadence: {
      maxConsecutiveFootageFree: optionalPositiveInteger(cadence.maxConsecutiveFootageFree, `${label}.cadence.maxConsecutiveFootageFree`),
      chapterReturnsToFootage: optionalBoolean(cadence.chapterReturnsToFootage, `${label}.cadence.chapterReturnsToFootage`, false),
      minimumChapters: optionalPositiveInteger(cadence.minimumChapters, `${label}.cadence.minimumChapters`),
      maxBoardWords: optionalPositiveInteger(cadence.maxBoardWords, `${label}.cadence.maxBoardWords`),
    },
    ...(motifs ? { motifs } : {}),
    kinds: normalizedKinds,
  };
}

/** Whether the catalog offers boards in a producer output format (horizontal/short) or a catalog format (longform/short). */
export const boardFormatEnabled = (catalog, format) => Boolean(catalog?.formats?.[catalogFormat(format)]);

const maximumWordsPattern = (maximum) => `^\\S+(?:\\s+\\S+){0,${maximum - 1}}$`;

function authoringNode(node, motifs) {
  const result = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === "properties") result.properties = Object.fromEntries(Object.entries(value).map(([name, child]) => [name, authoringNode(child, motifs)]));
    else if (key === "items") result.items = authoringNode(value, motifs);
    else result[key] = value;
  }
  if (node.type === "string") {
    const notes = [];
    if (node["x-timds-maxWords"]) {
      result.pattern = maximumWordsPattern(node["x-timds-maxWords"]);
      notes.push(`at most ${node["x-timds-maxWords"]} words`);
    }
    if (node["x-timds-motif"] && Array.isArray(motifs) && motifs.length && !node.enum) {
      result.enum = [...motifs];
      notes.push("one of the Design System's motifs");
    }
    if (node["x-timds-cue"]) {
      result.pattern = "^\\S+$";
      notes.push("one word the narration of this beat speaks; the item appears when it is said");
    }
    if (node["x-timds-substringOf"]) notes.push(`an exact phrase from ${node["x-timds-substringOf"]}`);
    if (notes.length && !node.description) result.description = notes.join("; ");
  }
  return result;
}

/** Kinds a model may author in this catalog: every declared kind except the compiler's own. */
export const authorableBoardKinds = (catalog, format) => Object.values(catalog.kinds).filter((kind) => !COMPILER_OWNED_BOARD_KINDS.includes(kind.id)
  && (format === undefined || !kind.formats || kind.formats.includes(catalogFormat(format))));

/** The same effective schema a client component may use for its layout budgets. */
export function resolveBoardKind(input, kindId, context) {
  const catalog = validateBoardCatalog(input);
  const kind = catalog.kinds[kindId];
  if (!kind) throw new Error(`board kind ${kindId} is not declared in the catalog`);
  if (context?.format !== undefined && kind.formats && !kind.formats.includes(catalogFormat(context.format))) throw new Error(`board kind ${kindId} is not available in ${catalogFormat(context.format)}`);
  const limits = boardLimits(kind, context);
  const maximum = Math.min(catalog.cadence.maxBoardWords ?? Infinity, limits.maxWords ?? Infinity);
  return {...kind, schema: limits.schema, ...(Number.isFinite(maximum) ? {maxWords: maximum} : {})};
}

/**
 * The `oneOf` entries the authoring contract offers for `answerBeats[].visual`:
 * one closed object per authorable kind with a `kind` const, its data fields,
 * and its use/avoid guidance as the description. Motif fields become an enum
 * when the mounted motif list is known.
 */
export function boardKindSchemas(catalog, { motifs = null, format } = {}) {
  return authorableBoardKinds(catalog, format).map((kind) => {
    const {schema, maxWords} = boardLimits(kind, {format});
    const data = authoringNode(schema, motifs);
    return {
      type: "object",
      additionalProperties: false,
      required: [...kind.schema.required, "kind"],
      properties: { kind: { const: kind.id }, ...data.properties },
      description: `${kind.label}: ${kind.use} Avoid: ${kind.avoid}${maxWords ? ` At most ${Math.min(maxWords, catalog.cadence.maxBoardWords ?? Infinity)} visible words across this board.` : ""}`,
    };
  });
}

function walk(node, value, pathLabel, state) {
  const fail = (message) => { throw new Error(`${pathLabel} ${message}`); };
  const typeOk = {
    object: () => isObject(value),
    array: () => Array.isArray(value),
    string: () => typeof value === "string",
    integer: () => Number.isSafeInteger(value),
    number: () => typeof value === "number" && Number.isFinite(value),
    boolean: () => typeof value === "boolean",
  }[node.type]();
  if (!typeOk) fail(`must be ${node.type === "integer" ? "an integer" : node.type === "object" || node.type === "array" ? `an ${node.type}` : `a ${node.type}`}`);
  if (node.const !== undefined && !same(node.const, value)) fail(`must be ${JSON.stringify(node.const)}`);
  if (node.enum && !node.enum.some((entry) => same(entry, value))) fail(`must be one of ${node.enum.map((entry) => JSON.stringify(entry)).join(", ")}`);
  if (node.type === "string") {
    if (!value.trim()) fail("must not be blank");
    if (node.minLength !== undefined && value.length < node.minLength) fail(`must be at least ${node.minLength} characters`);
    if (node.maxLength !== undefined && value.length > node.maxLength) fail(`allows at most ${node.maxLength} characters (${value.length})`);
    const maximum = node["x-timds-maxWords"];
    if (maximum) {
      const count = words(value).length;
      if (count > maximum) fail(`exceeds ${maximum} words (${count})`);
      state.words += count;
    }
    if (node["x-timds-motif"] && Array.isArray(state.motifs) && !state.motifs.includes(value)) {
      fail(`names motif ${JSON.stringify(value)}, which is not a mounted motif (available: ${state.motifs.join(", ") || "none"})`);
    }
    if (node["x-timds-cue"]) {
      if (words(value).length !== 1 || !normalizeCueWord(value)) fail("must be one spoken word");
      state.cues.push({ path: pathLabel, value });
    }
  }
  if ((node.type === "integer" || node.type === "number") && node.minimum !== undefined && value < node.minimum) fail(`must be at least ${node.minimum}`);
  if (node.type === "array") {
    if (node.minItems !== undefined && value.length < node.minItems) fail(`needs at least ${node.minItems} items (${value.length})`);
    if (node.maxItems !== undefined && value.length > node.maxItems) fail(`allows at most ${node.maxItems} items (${value.length})`);
    value.forEach((entry, index) => walk(node.items, entry, `${pathLabel}[${index}]`, state));
  }
  if (node.type === "object") {
    for (const key of node.required) if (value[key] === undefined || value[key] === null) fail(`needs ${key}`);
    for (const [key, entry] of Object.entries(value)) {
      if (entry === undefined) continue;
      const child = node.properties[key];
      if (!child) {
        if (node.additionalProperties === false) fail(`has unknown field ${key}`);
        continue;
      }
      if (entry === null && !node.required.includes(key)) continue;
      walk(child, entry, `${pathLabel}.${key}`, state);
      const sibling = child["x-timds-substringOf"];
      if (sibling && typeof value[sibling] === "string" && !value[sibling].toLocaleLowerCase().includes(entry.toLocaleLowerCase())) {
        throw new Error(`${pathLabel}.${key} must be an exact part of ${pathLabel}.${sibling}`);
      }
    }
  }
}

/**
 * Validate one board against its declared kind: types, required fields,
 * enums, item counts, closed objects, per-field word budgets, motifs, and the
 * catalog's per-board word total. Returns the kind, the board's word total
 * (the sum over every budgeted field), and each cue value with its path.
 */
export function validateBoardVisual({ catalog, visual, label = "visual", motifs = null, format, overFootage }) {
  const board = requireObject(visual, label);
  const kindId = typeof board.kind === "string" ? board.kind.trim() : "";
  if (!SLUG.test(kindId)) throw new Error(`${label}.kind must use lowercase letters, numbers, and hyphens`);
  const kind = catalog.kinds[kindId];
  if (!kind) throw new Error(`${label}.kind ${kindId} is not declared in the board catalog (declared: ${Object.keys(catalog.kinds).join(", ")})`);
  if (format !== undefined && kind.formats && !kind.formats.includes(catalogFormat(format))) throw new Error(`${label}.kind ${kindId} is not available in ${catalogFormat(format)}`);
  const { kind: _kind, ...data } = board;
  const state = { words: 0, cues: [], motifs };
  const limits = format === undefined && overFootage === undefined ? {schema: kind.schema, maxWords: kind.maxWords} : boardLimits(kind, {format, overFootage});
  walk(limits.schema, data, label, state);
  const maximum = Math.min(catalog.cadence.maxBoardWords ?? Infinity, limits.maxWords ?? Infinity);
  if (maximum && state.words > maximum) throw new Error(`${label} (${kindId}) holds ${state.words} words; the catalog allows at most ${maximum} per board`);
  return { kind: kindId, words: state.words, cues: state.cues };
}

const isBoard = (scene) => Boolean(scene && !scene.intro && !scene.outro && isObject(scene.visual));
// A compiled scene names its clips in `footage`; a finalized or committed
// scene in `asset`/`assets`. Either shape answers whether a board sits over
// footage.
const sceneFootageKeys = (scene) => (Array.isArray(scene.footage) && scene.footage.length ? scene.footage : sceneAssetKeys(scene));
const footageFree = (scene) => isBoard(scene) && !sceneFootageKeys(scene).length;
// A content scene that is not a footage-free board plays footage: finalized
// scenes carry their clips, and a compiled plain beat receives them at finalize.
const playsFootage = (scene) => Boolean(scene && !scene.intro && !scene.outro && !footageFree(scene));

/**
 * Enforce the catalog across one scene list (compiled or finalized): kinds
 * the format allows, overFootage, once, the longest run of footage-free
 * boards, every chapter containing footage, and the minimum chapter count
 * once any chapter is set. Compiler-inserted boards the catalog does not
 * declare are still counted as footage-free boards. `chapters: false` skips
 * the chapter rules for a scene list that is a cut of a larger production,
 * such as a Short harvested from a long-form.
 */
export function validateBoardCadence({ catalog, scenes, label = "scenes", format = "horizontal", chapters: checkChapters = true }) {
  const list = Array.isArray(scenes) ? scenes : [];
  const counts = new Map();
  for (const scene of list) {
    if (!isBoard(scene)) continue;
    const kind = catalog.kinds[scene.visual.kind];
    // The compiler's own boards follow producer.subscribe.formats, not the
    // catalog's formats; they still count toward footage-free runs below.
    if (!boardFormatEnabled(catalog, format) && !COMPILER_OWNED_BOARD_KINDS.includes(scene.visual.kind)) throw new Error(`${label} scene ${scene.id} is a ${scene.visual.kind} board, but the board catalog does not enable ${catalogFormat(format)} boards`);
    if (!kind) continue;
    const overFootage = sceneFootageKeys(scene).length > 0;
    if (kind.overFootage === "never" && overFootage) throw new Error(`${label} scene ${scene.id} is a ${kind.id} board, which never sits over footage; remove its footage`);
    if (kind.overFootage === "always" && !overFootage) throw new Error(`${label} scene ${scene.id} is a ${kind.id} board, which always sits over footage; give it footage`);
    counts.set(kind.id, [...(counts.get(kind.id) || []), scene.id]);
  }
  for (const [kindId, ids] of counts) {
    if (catalog.kinds[kindId].once && ids.length > 1) throw new Error(`${label} uses the ${kindId} board ${ids.length} times (scenes ${ids.join(", ")}); the catalog allows it once per production`);
  }
  const maximum = catalog.cadence.maxConsecutiveFootageFree;
  if (maximum) {
    let run = [];
    for (const scene of list) {
      if (scene.intro || scene.outro) continue;
      if (footageFree(scene)) {
        run.push(scene.id);
        if (run.length > maximum) throw new Error(`${label} scenes ${run.join(", ")} are ${run.length} footage-free boards in a row; the catalog allows at most ${maximum} before footage returns`);
      } else run = [];
    }
  }
  if (!checkChapters) return;
  const chapters = [];
  for (const scene of list) {
    if (typeof scene.chapter !== "string" || !scene.chapter) continue;
    let chapter = chapters.find((entry) => entry.id === scene.chapter);
    if (!chapter) chapters.push(chapter = { id: scene.chapter, scenes: [] });
    chapter.scenes.push(scene);
  }
  if (catalog.cadence.chapterReturnsToFootage) {
    for (const chapter of chapters) {
      if (!chapter.scenes.some(playsFootage)) throw new Error(`${label} chapter ${chapter.id} (scenes ${chapter.scenes.map((scene) => scene.id).join(", ")}) never returns to footage; give one of its beats footage instead of a footage-free board`);
    }
  }
  const minimum = catalog.cadence.minimumChapters;
  if (minimum && chapters.length && chapters.length < minimum) {
    throw new Error(`${label} sets ${chapters.length} chapter${chapters.length === 1 ? "" : "s"} (${chapters.map((chapter) => chapter.id).join(", ")}); a production that uses chapters needs at least ${minimum}`);
  }
}

/**
 * Every `x-timds-cue` value must be spoken in its own scene: it must equal
 * one normalized caption word of the scene's line. A line without a `words`
 * array carries no measured take, so its scene is skipped; enforcement starts
 * when words are present.
 */
export function validateBoardCues({ catalog, scenes, lines, label = "scenes", format }) {
  const byId = new Map((Array.isArray(lines) ? lines : []).filter(Boolean).map((line) => [line.id, line]));
  for (const scene of Array.isArray(scenes) ? scenes : []) {
    if (!isBoard(scene) || !catalog.kinds[scene.visual.kind]) continue;
    const { cues } = validateBoardVisual({ catalog, visual: scene.visual, label: `${label} scene ${scene.id}.visual`, ...(format !== undefined ? {format, overFootage: sceneFootageKeys(scene).length > 0} : {}) });
    if (!cues.length) continue;
    const line = byId.get(scene.id);
    if (!line || !Array.isArray(line.words)) continue;
    const spoken = new Set(line.words.map((word) => normalizeCueWord(word?.text)).filter(Boolean));
    for (const cue of cues) {
      if (!spoken.has(normalizeCueWord(cue.value))) {
        const said = line.words.map((word) => word?.text).filter(Boolean).join(" ");
        throw new Error(`${label} scene ${scene.id}: cue ${JSON.stringify(cue.value)} (${cue.path.replace(/^.*?\.visual/u, "visual")}) is never spoken; the take says: ${said || "(no words)"}`);
      }
    }
  }
}

/**
 * The catalog's registered components must match its kinds exactly: every
 * declared kind needs a component, and a component the client registered for
 * an undeclared kind is dead weight that hides a catalog typo. `defaults` are
 * the kinds the toolkit draws when the client registers nothing for them;
 * `registered` are the kinds the client's own Boards object names.
 */
export function validateBoardComponents({ catalog, registered = [], defaults = [], label = "video components" }) {
  const drawn = new Set([...defaults, ...registered]);
  const declared = Object.keys(catalog.kinds);
  const missing = declared.filter((kind) => !drawn.has(kind));
  const undeclared = [...new Set(registered)].filter((kind) => !catalog.kinds[kind]);
  const problems = [
    ...missing.map((kind) => `board kind ${kind} is declared in the catalog but no Boards component draws it`),
    ...undeclared.map((kind) => `Boards registers ${kind}, which the board catalog does not declare`),
  ];
  if (problems.length) throw new Error(`${label} disagree with the board catalog:\n  ${problems.join("\n  ")}`);
}

function fieldBudgets(node, pathLabel, budgets) {
  if (node.type === "object") for (const [key, child] of Object.entries(node.properties)) fieldBudgets(child, pathLabel ? `${pathLabel}.${key}` : key, budgets);
  if (node.type === "array") fieldBudgets(node.items, `${pathLabel}[]`, budgets);
  if (node.type === "string") {
    if (node["x-timds-maxWords"]) budgets.fields[pathLabel] = node["x-timds-maxWords"];
    if (node["x-timds-cue"]) budgets.cues.push(pathLabel);
    if (node["x-timds-motif"]) budgets.motifs.push(pathLabel);
  }
  return budgets;
}

/**
 * The shelf as plain data for the authoring contract, the machine index, and
 * MCP: formats, cadence, and each kind's guidance and budgets, without the
 * schemas themselves.
 */
export function boardCatalogSummary(catalog) {
  return {
    schemaVersion: catalog.schemaVersion,
    formats: { ...catalog.formats },
    cadence: { ...catalog.cadence },
    ...(catalog.motifs ? { motifs: { ...catalog.motifs } } : {}),
    kinds: Object.values(catalog.kinds).map((kind) => {
      const { fields, cues, motifs } = fieldBudgets(kind.schema, "", { fields: {}, cues: [], motifs: [] });
      return {
        id: kind.id,
        label: kind.label,
        use: kind.use,
        avoid: kind.avoid,
        overFootage: kind.overFootage,
        once: kind.once,
        ...(kind.formats ? {formats: [...kind.formats]} : {}),
        ...(kind.constraints ? {constraints: structuredClone(kind.constraints)} : {}),
        compilerOwned: COMPILER_OWNED_BOARD_KINDS.includes(kind.id),
        required: [...kind.schema.required],
        budgets: {
          ...(kind.maxWords || catalog.cadence.maxBoardWords ? { maxWords: Math.min(kind.maxWords ?? Infinity, catalog.cadence.maxBoardWords ?? Infinity) } : {}),
          fields,
        },
        ...(cues.length ? { cues } : {}),
        ...(motifs.length ? { motifs } : {}),
      };
    }),
  };
}

/** The catalog's cadence rules in words, for the drafting model's instructions. */
export function describeBoardCadence(catalog) {
  const { cadence } = catalog;
  return [
    cadence.maxConsecutiveFootageFree ? `Never place more than ${cadence.maxConsecutiveFootageFree} footage-free boards in a row; footage must return after them.` : "",
    cadence.chapterReturnsToFootage ? "Every chapter must include at least one beat that plays footage." : "",
    cadence.minimumChapters ? `When you use chapters, use at least ${cadence.minimumChapters}.` : "",
    cadence.maxBoardWords ? `A board holds at most ${cadence.maxBoardWords} words across its fields.` : "",
  ].filter(Boolean);
}
