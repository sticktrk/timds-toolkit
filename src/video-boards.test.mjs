import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  BOARDS_SCHEMA_VERSION,
  boardCatalogSummary,
  boardKindSchemas,
  describeBoardCadence,
  resolveBoardKind,
  validateBoardCadence,
  validateBoardCatalog,
  validateBoardComponents,
  validateBoardCues,
  validateBoardVisual,
} from "./video-boards.mjs";
import { DEFAULT_BOARD_KINDS } from "../video/boards.mjs";

const templatePath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "templates", "video", "boards.json");
const template = async () => JSON.parse(await fs.readFile(templatePath, "utf8"));
const catalogWith = async (patch = {}) => validateBoardCatalog({ ...(await template()), ...patch });
const clone = (value) => JSON.parse(JSON.stringify(value));

const constrainedCatalog = async () => {
  const raw = await template();
  raw.formats.short = true;
  raw.kinds.flow.overFootage = "optional";
  raw.kinds.flow.schema.properties.nodes.maxItems = 4;
  raw.kinds.flow.maxWords = 24;
  raw.kinds.flow.constraints = [
    {when: {overFootage: true}, maxWords: 16, fields: {nodes: {maxItems: 3}}},
    {when: {format: "short"}, maxWords: 16, fields: {nodes: {maxItems: 3}}},
  ];
  raw.kinds["chapter-title"].formats = ["longform"];
  return validateBoardCatalog(raw);
};

test("context limits reject an oversized footage board while preserving its larger full-frame layout", async () => {
  const catalog = await constrainedCatalog();
  assert.deepEqual(validateBoardCatalog(catalog), catalog);
  const visual = {kind: "flow", nodes: Array.from({length: 4}, () => ({label: "A step"}))};
  const check = (format, overFootage) => validateBoardVisual({catalog, visual, format, overFootage});
  assert.doesNotThrow(() => check("horizontal", false));
  for (const [format, overFootage] of [["horizontal", true], ["short", false], ["short", true]]) {
    assert.throws(() => check(format, overFootage), /nodes allows at most 3 items \(4\)/u);
  }
  for (const format of ["horizontal", "short"]) {
    const flow = boardKindSchemas(catalog, {format}).find((entry) => entry.properties.kind.const === "flow");
    assert.equal(flow.properties.nodes.maxItems, 3, "the drafting schema is safe before footage is chosen");
    assert.match(flow.description, /At most 16 visible words/u);
  }
  assert.equal(resolveBoardKind(catalog, "flow", {format: "horizontal", overFootage: false}).schema.properties.nodes.maxItems, 4);
  assert.equal(resolveBoardKind(catalog, "flow", {format: "short", overFootage: false}).maxWords, 16);
  const summary = boardCatalogSummary(catalog).kinds.find((kind) => kind.id === "flow");
  assert.deepEqual(summary.constraints, catalog.kinds.flow.constraints);
});

test("context word budgets and kind formats are enforced before rendering", async () => {
  const catalog = await constrainedCatalog();
  const visual = {kind: "flow", nodes: Array.from({length: 3}, () => ({label: "One two three four"})), outcome: "One two three four five"};
  assert.doesNotThrow(() => validateBoardVisual({catalog, visual, format: "horizontal", overFootage: false}));
  assert.throws(() => validateBoardVisual({catalog, visual, format: "horizontal", overFootage: true}), /holds 17 words.*at most 16/u);
  assert.throws(() => validateBoardVisual({catalog, visual: {kind: "chapter-title", number: 1, title: "Start"}, format: "short", overFootage: false}), /not available in short/u);
  assert.ok(!boardKindSchemas(catalog, {format: "short"}).some((entry) => entry.properties.kind.const === "chapter-title"));
});

test("constraint selectors and field limits are strict and cannot loosen a kind", async () => {
  const catalog = await constrainedCatalog();
  for (const [rule, error] of [
    [{when: {}, maxWords: 16}, /needs format or overFootage/u],
    [{when: {format: "portrait"}, maxWords: 16}, /must be longform or short/u],
    [{when: {overFootage: "yes"}, maxWords: 16}, /must be a boolean/u],
    [{when: {vertical: true}, maxWords: 16}, /unknown field vertical/u],
    [{when: {overFootage: true}, fields: {missing: {maxItems: 2}}}, /unknown schema field missing/u],
    [{when: {overFootage: true}, fields: {nodes: {maxItems: 5}}}, /must not loosen/u],
    [{when: {overFootage: true}, fields: {nodes: {maxLength: 3}}}, /unsupported schema keyword maxLength for type array/u],
    [{when: {overFootage: true}, fields: {nodes: {maxItems: 1}}}, /minItems must not exceed/u],
  ]) {
    const broken = clone(catalog);
    broken.kinds.flow.constraints = [rule];
    assert.throws(() => validateBoardCatalog(broken), error);
  }
});

test("string character limits reach validation and the authoring schema", async () => {
  const raw = await template();
  raw.kinds.statement.schema.properties.text.maxLength = 5;
  const catalog = validateBoardCatalog(raw);
  assert.throws(() => validateBoardVisual({catalog, visual: {kind: "statement", text: "123456"}}), /at most 5 characters/u);
  assert.equal(boardKindSchemas(catalog).find((entry) => entry.properties.kind.const === "statement").properties.text.maxLength, 5);
});

test("the default catalog declares exactly the default board kinds and validates idempotently", async () => {
  const raw = await template();
  const catalog = validateBoardCatalog(raw);
  assert.equal(catalog.schemaVersion, BOARDS_SCHEMA_VERSION);
  assert.deepEqual(Object.keys(catalog.kinds), [...DEFAULT_BOARD_KINDS]);
  assert.deepEqual(catalog.formats, { longform: true, short: false });
  assert.deepEqual(catalog.cadence, { maxConsecutiveFootageFree: 3, chapterReturnsToFootage: true, minimumChapters: 3, maxBoardWords: 28 });
  assert.equal(catalog.motifs, undefined, "a fresh system has no motif mount");
  assert.deepEqual(validateBoardCatalog(catalog), catalog);
  assert.equal(catalog.kinds.subscribe.once, true);
  assert.equal(catalog.kinds["chapter-title"].overFootage, "never");
  assert.equal(catalog.kinds.cards.schema.additionalProperties, false);
});

test("rejects a malformed catalog with the field at fault", async () => {
  const raw = await template();
  const broken = (mutate) => { const copy = clone(raw); mutate(copy); return copy; };
  assert.throws(() => validateBoardCatalog({ ...raw, schemaVersion: 2 }), /schemaVersion must be 1/u);
  assert.throws(() => validateBoardCatalog({ ...raw, extra: true }), /unknown field extra/u);
  assert.throws(() => validateBoardCatalog({ ...raw, kinds: {} }), /at least one board kind/u);
  assert.throws(() => validateBoardCatalog(broken((c) => { c.kinds.Cards = c.kinds.cards; })), /kind id "Cards" must use lowercase/u);
  assert.throws(() => validateBoardCatalog(broken((c) => { c.kinds.cards.overFootage = "sometimes"; })), /cards\.overFootage must be one of never, optional, always/u);
  assert.throws(() => validateBoardCatalog(broken((c) => { c.kinds.cards.schema.properties.kind = { type: "string" }; })), /cards\.schema must not declare kind/u);
  assert.throws(() => validateBoardCatalog(broken((c) => { c.kinds.cards.schema.properties.title.pattern = "^a"; })), /cards\.schema\.properties\.title uses unsupported schema keyword pattern/u);
  assert.throws(() => validateBoardCatalog(broken((c) => { c.kinds.cards.schema.properties.title.minItems = 1; })), /unsupported schema keyword minItems for type string/u);
  assert.throws(() => validateBoardCatalog(broken((c) => { c.kinds.cards.schema.required.push("missing"); })), /required names missing, which is not a declared property/u);
  assert.throws(() => validateBoardCatalog(broken((c) => { c.kinds.cards.schema.properties.items.minItems = 6; })), /minItems must not exceed maxItems/u);
  assert.throws(() => validateBoardCatalog(broken((c) => { c.kinds.statement.schema.properties.goldPhrase["x-timds-substringOf"] = "nope"; })), /x-timds-substringOf must name a sibling string property/u);
  assert.throws(() => validateBoardCatalog(broken((c) => { c.kinds.cards.use = " "; })), /cards\.use is required/u);
  assert.throws(() => validateBoardCatalog(broken((c) => { c.cadence.maxBoardWords = 0; })), /maxBoardWords must be a positive integer/u);
  assert.throws(() => validateBoardCatalog(broken((c) => { c.cadence.everyOther = true; })), /unknown rule everyOther/u);
  assert.throws(() => validateBoardCatalog(broken((c) => { c.formats.square = true; })), /unknown format square/u);
  assert.throws(() => validateBoardCatalog(broken((c) => { c.kinds.cards.schema = { type: "array", items: { type: "string" } }; })), /schema must describe an object/u);
});

test("the walker enforces types, required fields, item counts, closed objects, budgets, and motifs", async () => {
  const catalog = await catalogWith();
  const check = (visual, motifs = null) => validateBoardVisual({ catalog, visual, label: "answer beat x.visual", motifs });
  const cards = { kind: "cards", title: "Three records to keep", items: [{ label: "The deed", cue: "deed" }, { label: "The will", note: "signed and dated" }] };
  assert.deepEqual(check(cards), { kind: "cards", words: 11, cues: [{ path: "answer beat x.visual.items[0].cue", value: "deed" }] });
  assert.throws(() => check({ ...cards, kind: "timeline" }), /answer beat x\.visual\.kind timeline is not declared in the board catalog/u);
  assert.throws(() => check({ ...cards, items: [cards.items[0]] }), /answer beat x\.visual\.items needs at least 2 items \(1\)/u);
  assert.throws(() => check({ ...cards, items: Array(6).fill(cards.items[1]) }), /allows at most 5 items \(6\)/u);
  assert.throws(() => check({ ...cards, colour: "red" }), /answer beat x\.visual has unknown field colour/u);
  assert.throws(() => check({ kind: "cards", title: "x" }), /answer beat x\.visual needs items/u);
  assert.throws(() => check({ ...cards, title: "one two three four five six seven eight nine" }), /answer beat x\.visual\.title exceeds 8 words \(9\)/u);
  assert.throws(() => check({ ...cards, items: [{ label: "A" }, { label: 7 }] }), /items\[1\]\.label must be a string/u);
  assert.throws(() => check({ ...cards, items: [{ label: "A", cue: "two words" }, { label: "B" }] }), /items\[0\]\.cue must be one spoken word/u);
  assert.throws(() => check({ kind: "chapter-title", number: 0, title: "Start" }), /number must be at least 1/u);
  assert.throws(() => check({ kind: "chapter-title", number: 1.5, title: "Start" }), /number must be an integer/u);
  assert.throws(() => check({ kind: "statement", text: "Keep the deed", goldPhrase: "the will" }), /goldPhrase must be an exact part of answer beat x\.visual\.text/u);
  assert.equal(check({ kind: "statement", text: "Keep the deed", goldPhrase: "THE DEED" }).words, 3);
  // Motifs are free text until a mount is known, then a closed list.
  assert.equal(check({ ...cards, motif: "house" }).kind, "cards");
  assert.equal(check({ ...cards, motif: "house" }, ["house", "will"]).kind, "cards");
  assert.throws(() => check({ ...cards, motif: "boat" }, ["house", "will"]), /names motif "boat", which is not a mounted motif \(available: house, will\)/u);
});

test("a board's total words across budgeted fields is held to maxBoardWords", async () => {
  const catalog = await catalogWith({ cadence: { maxBoardWords: 10 } });
  const visual = { kind: "steps", title: "Three steps", steps: [{ label: "Pull the deed", note: "from the county" }, { label: "Read it" }, { label: "Match the will" }] };
  assert.throws(() => validateBoardVisual({ catalog, visual, label: "scene steps.visual" }), /scene steps\.visual \(steps\) holds 13 words; the catalog allows at most 10 per board/u);
});

const footage = (id, extra = {}) => ({ id, headline: "Footage", asset: `footage-${id}`, ...extra });
const board = (id, visual, extra = {}) => ({ id, visual, ...extra });
const statement = { kind: "statement", text: "One rule" };

test("cadence limits footage-free runs and reads compiled and finalized scene shapes", async () => {
  const catalog = await catalogWith();
  const run = [{ id: "intro", intro: true }, board("a", statement), board("b", statement), board("c", statement), board("d", statement), footage("e")];
  assert.throws(() => validateBoardCadence({ catalog, scenes: run, label: "sample longform" }), /sample longform scenes a, b, c, d are 4 footage-free boards in a row; the catalog allows at most 3/u);
  // A board over footage breaks the run: finalized scenes name asset(s)...
  const finalized = [...run.slice(0, 3), board("c", statement, { assets: ["footage-x", "footage-y"] }), board("d", statement), footage("e")];
  assert.doesNotThrow(() => validateBoardCadence({ catalog, scenes: finalized }));
  // ...and compiled scenes name their picks in footage; a plain compiled beat plays footage later.
  const compiled = [board("a", statement), board("b", statement), board("c", statement, { footage: ["footage-one"] }), board("d", statement), { id: "plain", role: "rule", narration: "x" }, board("f", statement)];
  assert.doesNotThrow(() => validateBoardCadence({ catalog, scenes: compiled }));
});

test("cadence enforces chapter footage, minimum chapters, once, overFootage, and formats", async () => {
  const catalog = await catalogWith();
  const title = (number) => ({ kind: "chapter-title", number, title: `Chapter ${number}` });
  const chapters = (ids) => ids.flatMap((id, index) => [board(`${id}-title`, title(index + 1), { chapter: id }), footage(`${id}-body`, { chapter: id })]);
  assert.doesNotThrow(() => validateBoardCadence({ catalog, scenes: chapters(["one", "two", "three"]) }));
  assert.throws(() => validateBoardCadence({ catalog, scenes: chapters(["one", "two"]), label: "p" }), /p sets 2 chapters \(one, two\); a production that uses chapters needs at least 3/u);
  assert.doesNotThrow(() => validateBoardCadence({ catalog, scenes: chapters(["one", "two"]), chapters: false }), "a Short skips chapter rules");
  const dry = [...chapters(["one", "two"]), board("three-title", title(3), { chapter: "three" }), board("three-card", statement, { chapter: "three" })];
  assert.throws(() => validateBoardCadence({ catalog, scenes: dry, label: "p" }), /p chapter three \(scenes three-title, three-card\) never returns to footage/u);
  const lenient = await catalogWith({ cadence: { minimumChapters: 3 } });
  assert.doesNotThrow(() => validateBoardCadence({ catalog: lenient, scenes: dry }));

  const subscribe = { kind: "subscribe", topic: "records", solution: "keep them" };
  assert.throws(() => validateBoardCadence({ catalog, scenes: [board("s1", subscribe), footage("x"), board("s2", subscribe)], label: "p" }), /p uses the subscribe board 2 times \(scenes s1, s2\); the catalog allows it once per production/u);
  assert.throws(() => validateBoardCadence({ catalog, scenes: [board("t", title(1), { asset: "footage-a" })], label: "p" }), /p scene t is a chapter-title board, which never sits over footage; remove its footage/u);
  const always = clone(await template());
  always.kinds.statement.overFootage = "always";
  assert.throws(() => validateBoardCadence({ catalog: validateBoardCatalog(always), scenes: [board("s", statement)], label: "p" }), /p scene s is a statement board, which always sits over footage; give it footage/u);
  assert.throws(() => validateBoardCadence({ catalog, scenes: [board("s", statement)], label: "p short x", format: "short" }), /p short x scene s is a statement board, but the board catalog does not enable short boards/u);
  assert.doesNotThrow(() => validateBoardCadence({ catalog, scenes: [footage("a")], format: "short" }), "a short without boards passes");
});

test("every cue must be spoken in its scene; a line without measured words is skipped", async () => {
  const catalog = await catalogWith();
  const scenes = [board("records", { kind: "cards", items: [{ label: "The deed", cue: "Deed," }, { label: "The will", cue: "will" }] })];
  const said = (...texts) => [{ id: "records", durationMs: 3000, words: texts.map((text, index) => ({ text, startMs: index * 100, endMs: index * 100 + 90 })) }];
  assert.doesNotThrow(() => validateBoardCues({ catalog, scenes, lines: said("Your", "deed.", "and", "WILL") }));
  assert.throws(() => validateBoardCues({ catalog, scenes, lines: said("Your", "deed", "matters"), label: "finalize sample" }),
    /finalize sample scene records: cue "will" \(visual\.items\[1\]\.cue\) is never spoken; the take says: Your deed matters/u);
  assert.doesNotThrow(() => validateBoardCues({ catalog, scenes, lines: [{ id: "records", durationMs: 3000 }] }), "no words, no take to check");
  assert.doesNotThrow(() => validateBoardCues({ catalog, scenes: [board("x", { kind: "custom" })], lines: [] }), "an undeclared compiler board is not the catalog's to cue");
});

test("components must draw every declared kind and register no undeclared kind", async () => {
  const catalog = await catalogWith();
  assert.doesNotThrow(() => validateBoardComponents({ catalog, defaults: DEFAULT_BOARD_KINDS }));
  assert.doesNotThrow(() => validateBoardComponents({ catalog, registered: [...DEFAULT_BOARD_KINDS] }));
  const extended = clone(await template());
  extended.kinds.timeline = { label: "Timeline", use: "Dates in order.", avoid: "Undated items.", schema: { type: "object", properties: { title: { type: "string" } } } };
  assert.throws(() => validateBoardComponents({ catalog: validateBoardCatalog(extended), defaults: DEFAULT_BOARD_KINDS, label: "video components video/remotion.tsx" }),
    /video components video\/remotion\.tsx disagree with the board catalog:\n {2}board kind timeline is declared in the catalog but no Boards component draws it/u);
  assert.throws(() => validateBoardComponents({ catalog, defaults: DEFAULT_BOARD_KINDS, registered: ["gallery"] }), /Boards registers gallery, which the board catalog does not declare/u);
});

test("authoring schemas are closed per kind with a kind const, guidance, and known motifs", async () => {
  const catalog = await catalogWith();
  const schemas = boardKindSchemas(catalog, { motifs: ["house", "will"] });
  assert.deepEqual(schemas.map((schema) => schema.properties.kind.const), DEFAULT_BOARD_KINDS.filter((kind) => kind !== "subscribe"));
  const cards = schemas.find((schema) => schema.properties.kind.const === "cards");
  assert.equal(cards.additionalProperties, false);
  assert.deepEqual(cards.required, ["items", "kind"]);
  assert.equal(cards.description, "Cards: A list of 2 to 5 parallel items. Avoid: Sequences, contrasts, or a single rule.");
  assert.deepEqual(cards.properties.motif.enum, ["house", "will"]);
  assert.equal(cards.properties.items.items.additionalProperties, false);
  assert.equal(cards.properties.title.pattern, "^\\S+(?:\\s+\\S+){0,7}$");
  assert.equal(cards.properties.items.items.properties.cue.pattern, "^\\S+$");
  assert.equal(boardKindSchemas(catalog).find((schema) => schema.properties.kind.const === "cards").properties.motif.enum, undefined);
});

test("the summary lists each kind's guidance and budgets for the index and MCP", async () => {
  const summary = boardCatalogSummary(await catalogWith({ motifs: { mount: "illustrations" } }));
  assert.equal(summary.schemaVersion, 1);
  assert.deepEqual(summary.motifs, { mount: "illustrations" });
  assert.deepEqual(summary.kinds.map((kind) => kind.id), [...DEFAULT_BOARD_KINDS]);
  const cards = summary.kinds.find((kind) => kind.id === "cards");
  assert.deepEqual(cards, {
    id: "cards",
    label: "Cards",
    use: "A list of 2 to 5 parallel items.",
    avoid: "Sequences, contrasts, or a single rule.",
    overFootage: "optional",
    once: false,
    compilerOwned: false,
    required: ["items"],
    budgets: { maxWords: 28, fields: { title: 8, "items[].label": 4, "items[].note": 6 } },
    cues: ["items[].cue"],
    motifs: ["motif"],
  });
  assert.equal(summary.kinds.find((kind) => kind.id === "subscribe").compilerOwned, true);
  assert.deepEqual(describeBoardCadence(await catalogWith()), [
    "Never place more than 3 footage-free boards in a row; footage must return after them.",
    "Every chapter must include at least one beat that plays footage.",
    "When you use chapters, use at least 3.",
    "A board holds at most 28 words across its fields.",
  ]);
});

test("the compiler's subscribe board follows the producer's formats, not the catalog's", async () => {
  const shortsClosed = await catalogWith();
  const subscribe = board("subscribe", { kind: "subscribe", topic: "records", solution: "keep them" });
  assert.doesNotThrow(() => validateBoardCadence({ catalog: shortsClosed, scenes: [footage("a"), subscribe, footage("b")], format: "short" }));
  const longClosed = await catalogWith({ formats: { longform: false, short: true } });
  assert.doesNotThrow(() => validateBoardCadence({ catalog: longClosed, scenes: [footage("a"), subscribe, footage("b")], format: "horizontal" }));
  assert.throws(() => validateBoardCadence({ catalog: longClosed, scenes: [board("s", statement)], format: "horizontal" }), /does not enable longform boards/u);
});
