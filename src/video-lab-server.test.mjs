import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import test from "node:test";
import { createVideoAuthoringContract } from "./video-producer.mjs";
import { loadVideoWorkspace } from "./video.mjs";
import { labFixture, registerVerticalMetadata } from "./video.fixture.mjs";
import {
  buildDraftMessages,
  compileVideoLabInput,
  describeFootageCatalog,
  createRenderJobs,
  createVideoLabServer,
  describeVideoLabState,
  draftVideoLabInput,
  hasClaudeCredentials,
  loadDesignSystemIndex,
  saveVideoLabInput,
  slugify,
  stripSchemaExtensions,
} from "./video-lab-server.mjs";

const recordsInput = {
  schemaVersion: 1,
  slug: "records",
  outputFormat: "horizontal",
  exactQuestion: "Should I keep these records?",
  topic: { label: "important records", engagementQuestion: "Are you keeping these records?", coverEmotion: "concern" },
  answerBeats: [
    { id: "keep", role: "rule", narration: "Keep the records together and preserve every page, even the routine ones.", summary: "Keep every record together" },
    { id: "copies", role: "process", narration: "Ask for copies before anything is filed.", summary: "Ask for copies first" },
  ],
};

async function serve(t, workspace, options) {
  const server = createVideoLabServer(workspace, options);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, route, body) => {
    const response = await fetch(`${base}${route}`, { method, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
    const type = response.headers.get("content-type") || "";
    return { status: response.status, body: type.includes("json") ? await response.json() : await response.text() };
  };
  return { base, call };
}

test("describes the design system, producer, catalog, and lab inputs for the UI", async (t) => {
  const workspace = await labFixture(t);
  const state = await describeVideoLabState(workspace);
  assert.deepEqual(state.designSystem, { id: "example/core", name: "Example", version: "1.2.3" });
  assert.equal(state.contract.brand.series, "Answers");
  assert.deepEqual(Object.keys(state.contract.producer.roleEyebrows), ["hook", "rule", "risk", "process", "exception", "answer"]);
  assert.equal(state.contract.producer.engagement.requireYesNoQuestion, true);
  // The UI decides from this whether to offer the Solution field, so the block ships even while the board is off.
  assert.equal(state.contract.producer.subscribe.enabled, false);
  assert.equal(state.contract.producer.subscribe.requireSolution, true);
  assert.deepEqual(state.catalog, { footage: 3, covers: 1 });
  assert.deepEqual(state.lab, { directory: "video/lab", inputs: ["records"] });
  assert.deepEqual(state.productions, ["sample-topic"]);
  assert.equal(state.drafting.model, "claude-opus-5");
  assert.equal(typeof state.drafting.credentials, "boolean");
});

test("compiles a request into a plan the UI can show, and saves it as a lab input", async (t) => {
  const workspace = await labFixture(t);
  const plan = await compileVideoLabInput(workspace, recordsInput);
  assert.equal(plan.renderable, true);
  assert.equal(plan.warning, null);
  assert.deepEqual(plan.scenes.map((scene) => scene.id), ["intro", "keep", "copies", "engage", "outro"]);
  assert.equal(plan.scenes[0].footage, "card");
  assert.equal(plan.scenes[0].footageLabel, "card");
  assert.ok(plan.scenes[1].footage.length >= 1);
  assert.equal(plan.scenes[1].footageLabel, plan.scenes[1].footage.join(" → "), "the UI shows the same footage line the CLI prints");
  assert.equal(plan.cover.subject, "cover-subject-concern");
  assert.ok(plan.totalSeconds > 0);
  assert.match(plan.text, /records · horizontal/u);

  const saved = await saveVideoLabInput(workspace, { ...recordsInput, slug: "records-two" });
  assert.equal(saved.name, "records-two");
  assert.equal(saved.path, path.join("video", "lab", "records-two.json"));
  const written = JSON.parse(await fs.readFile(path.join(workspace.designSystemRoot, saved.path), "utf8"));
  assert.equal(written.exactQuestion, recordsInput.exactQuestion);

  await assert.rejects(saveVideoLabInput(workspace, { ...recordsInput, slug: "Bad Slug" }), /lowercase letters, digits, and hyphens/u);
  await assert.rejects(compileVideoLabInput(workspace, { ...recordsInput, answerBeats: [] }), (caught) => caught.status === 400);
});

test("reports a plan that cannot finalize yet instead of failing the compile", async (t) => {
  const workspace = await labFixture(t);
  await fs.writeFile(path.join(workspace.designSystemRoot, "media.json"), JSON.stringify({ schemaVersion: 2, assets: [] }), "utf8");
  const plan = await compileVideoLabInput(workspace, recordsInput);
  assert.equal(plan.renderable, false);
  assert.match(String(plan.warning), /footage|cover/iu);
  assert.equal(plan.text, null);
  assert.equal(plan.scenes.length, 5);
});

test("the Shorts API exposes a specific blocker and enables rendering when the client permits cropping", async (t) => {
  const workspace = await labFixture(t);
  const { call } = await serve(t, workspace);
  const input = { ...recordsInput, outputFormat: "short" };
  const blocked = await call("POST", "/api/compile", { input });
  assert.equal(blocked.body.renderable, false);
  assert.match(blocked.body.warning, /no eligible Shorts footage/u);
  const contractPath = path.join(workspace.designSystemRoot, "video/contract.json");
  const contract = JSON.parse(await fs.readFile(contractPath, "utf8"));
  contract.producer.footage.allowShortCrop = true;
  await fs.writeFile(contractPath, JSON.stringify(contract));
  const unreviewed = await call("POST", "/api/compile", { input });
  assert.equal(unreviewed.body.renderable, false);
  assert.match(unreviewed.body.warning, /reviewed crops/u);
  await registerVerticalMetadata(workspace);
  const saved = await call("POST", "/api/inputs", { input });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.plan.renderable, true);
  assert.equal(saved.body.plan.warning, null);
});

test("builds the draft prompt from the client's authoring contract and strips TimDS schema annotations", async (t) => {
  const workspace = await labFixture(t);
  const loaded = await loadVideoWorkspace(workspace);
  const { index, source } = await loadDesignSystemIndex(workspace);
  assert.equal(source, null);
  const authoring = createVideoAuthoringContract({ contract: loaded.video.contract, manifest: workspace.manifest, designSystemIndex: index, provenance: { commit: "0".repeat(40), version: "1.2.3" }, outputFormat: "horizontal" });
  const { system, user } = buildDraftMessages(authoring, { question: "Should I keep these records?", topicLabel: "important records", notes: "Records matter.", engagementQuestion: "", slug: "records" });
  assert.match(system, /Example video producer/u);
  assert.match(system, /complete standalone micro-headline/u);
  assert.match(system, /"headlineWords":8/u);
  assert.match(user, /Exact question \(use verbatim as exactQuestion\): Should I keep these records\?/u);
  assert.match(user, /Engagement question \(must be answerable yes or no\): write one/u);
  assert.match(user, /Records matter\./u);
  const stripped = JSON.stringify(stripSchemaExtensions(authoring.inputSchema));
  assert.doesNotMatch(stripped, /x-timds/u);
  assert.match(JSON.stringify(authoring.inputSchema), /x-timds/u);
  assert.doesNotMatch(system, /Footage catalog/u);

  // With the catalogs, the prompt lists every clip the draft may name per beat.
  const media = JSON.parse(await fs.readFile(path.join(workspace.designSystemRoot, "media.json"), "utf8"));
  const withCatalog = createVideoAuthoringContract({
    contract: loaded.video.contract, manifest: workspace.manifest, designSystemIndex: index, provenance: { commit: "0".repeat(40), version: "1.2.3" }, outputFormat: "horizontal",
    assetCatalog: loaded.video.assets, mediaCatalog: media, verticalMetadata: loaded.video.verticalMetadata,
  });
  assert.deepEqual(withCatalog.footage.clips.map((clip) => clip.key), ["footage-one", "footage-three", "footage-two"]);
  const catalogPrompt = buildDraftMessages(withCatalog, { question: "Should I keep these records?", topicLabel: "important records", notes: "", engagementQuestion: "", slug: "records" }).system;
  assert.match(catalogPrompt, /Footage catalog \(3 clips\)\. Set each answer beat's footage to 1–3 of these keys/u);
  assert.match(catalogPrompt, /^- footage-two: two · 6s$/mu);
  assert.equal(describeFootageCatalog({ maximumPerBeat: 3, clips: [{ key: "dash-1", title: "Night rear-end", tags: ["rain", "night"], durationSeconds: 6.042 }] }), "Footage catalog (1 clips). Set each answer beat's footage to 1–3 of these keys, best match first:\n- dash-1: Night rear-end (rain, night) · 6.042s");
});

test("offers the subscribe board's solution to the draft and carries it onto the compiled board", async (t) => {
  const workspace = await labFixture(t);
  const contractPath = path.join(workspace.designSystemRoot, "video/contract.json");
  const contract = JSON.parse(await fs.readFile(contractPath, "utf8"));
  contract.structure = { ...contract.structure, longform: { ...contract.structure?.longform, graphicScenes: true } };
  contract.producer.subscribe = { enabled: true, afterBeat: 1, narrationTemplate: "Subscribe to learn how to {{solution}}." };
  await fs.writeFile(contractPath, JSON.stringify(contract));
  const state = await describeVideoLabState(workspace);
  assert.equal(state.contract.producer.subscribe.enabled, true, "the lab UI offers the Solution field from this");
  assert.deepEqual(state.contract.producer.subscribe.formats, ["horizontal"]);
  const loaded = await loadVideoWorkspace(workspace);
  const { index } = await loadDesignSystemIndex(workspace);
  const authoring = createVideoAuthoringContract({ contract: loaded.video.contract, manifest: workspace.manifest, designSystemIndex: index, provenance: { commit: "0".repeat(40), version: "1.2.3" }, outputFormat: "horizontal" });
  assert.ok(authoring.inputSchema.properties.topic.required.includes("solution"));
  const { system, user } = buildDraftMessages(authoring, { question: "Should I keep these records?", topicLabel: "important records", notes: "", engagementQuestion: "", solution: "", slug: "records" });
  assert.match(system, /topic\.solution/u);
  assert.match(user, /Solution the subscribe board promises \(topic\.solution, a short verb phrase\): write one/u);
  const supplied = buildDraftMessages(authoring, { question: "Should I keep these records?", topicLabel: "important records", notes: "", engagementQuestion: "", solution: "keep the records that matter", slug: "records" }).user;
  assert.match(supplied, /a short verb phrase\): keep the records that matter/u);

  const drafted = { ...recordsInput, topic: { ...recordsInput.topic, solution: "keep the records that matter" } };
  const client = { beta: { messages: { create: async () => ({ model: "claude-opus-5", stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(drafted) }] }) } } };
  const result = await draftVideoLabInput(workspace, { outputFormat: "horizontal", question: "Should I keep these records?", solution: "keep the records that matter", slug: "records" }, { client });
  const board = result.plan.scenes.find((scene) => scene.id === "subscribe");
  assert.equal(board.visual, "subscribe");
  assert.equal(board.narration, "Subscribe to learn how to keep the records that matter.");
  assert.deepEqual(board.footage, []);
  assert.deepEqual(result.plan.scenes.map((scene) => scene.id).slice(0, 3), ["intro", "keep", "subscribe"]);
  // A draft that leaves the solution out is refused by the producer, not rendered without its board.
  const bare = { beta: { messages: { create: async () => ({ model: "claude-opus-5", stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(recordsInput) }] }) } } };
  await assert.rejects(draftVideoLabInput(workspace, { outputFormat: "horizontal", question: "Should I keep these records?", slug: "records" }, { client: bare }), (caught) => caught.status === 400 && /topic\.solution/u.test(caught.message));
});

test("drafts through an injected Claude client and validates the result through the producer", async (t) => {
  const workspace = await labFixture(t);
  const calls = [];
  const client = { beta: { messages: { create: async (params) => {
    calls.push(params);
    return { model: "claude-opus-5", stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 20 }, content: [{ type: "text", text: JSON.stringify({ ...recordsInput, slug: "drafted" }) }] };
  } } } };
  const result = await draftVideoLabInput(workspace, { outputFormat: "horizontal", question: "Should I keep these records?", topicLabel: "important records", notes: "Keep them.", slug: "drafted" }, { client });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].model, "claude-opus-5");
  assert.equal(calls[0].output_config.format.type, "json_schema");
  assert.deepEqual(calls[0].betas, ["server-side-fallback-2026-07-01"]);
  assert.equal(calls[0].fallbacks, "default");
  assert.equal(result.input.slug, "drafted");
  assert.equal(result.input.schemaVersion, 1);
  assert.equal(result.plan.renderable, true);
  assert.deepEqual(result.usage, { input_tokens: 10, output_tokens: 20 });

  const refusing = { beta: { messages: { create: async () => ({ stop_reason: "refusal", stop_details: { category: "other" }, content: [] }) } } };
  await assert.rejects(draftVideoLabInput(workspace, { question: "Should I keep these records?" }, { client: refusing }), /declined to draft/u);
  await assert.rejects(draftVideoLabInput(workspace, { question: "" }, { client }), /question is required/u);
});

test("serves the UI and the JSON API, and guards the render queue", async (t) => {
  const workspace = await labFixture(t);
  const started = [];
  const jobs = {
    ...createRenderJobs(workspace),
    start: async (name) => { started.push(name); return { id: "job-1", name, status: "running", log: [] }; },
    get: (id) => (id === "job-1" ? { id, name: "records", status: "running", log: ["Rendering"] } : null),
  };
  const { call } = await serve(t, workspace, { jobs, draft: async () => ({ input: recordsInput, plan: await compileVideoLabInput(workspace, recordsInput), model: "fake" }) });

  const home = await call("GET", "/");
  assert.equal(home.status, 200);
  assert.match(home.body, /<title>TimDS Video Lab<\/title>/u);

  const state = await call("GET", "/api/state");
  assert.equal(state.status, 200);
  assert.deepEqual(state.body.lab.inputs, ["records"]);

  const input = await call("GET", "/api/inputs/records");
  assert.equal(input.status, 200);
  assert.equal(input.body.slug, "records");
  assert.equal((await call("GET", "/api/inputs/missing")).status, 404);

  const compiled = await call("POST", "/api/compile", { input: recordsInput });
  assert.equal(compiled.status, 200);
  assert.equal(compiled.body.scenes.length, 5);

  const bad = await call("POST", "/api/compile", { input: { ...recordsInput, exactQuestion: "no question mark" } });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /question/iu);

  const saved = await call("POST", "/api/inputs", { input: { ...recordsInput, slug: "from-ui" } });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.name, "from-ui");

  const render = await call("POST", "/api/render", { name: "records" });
  assert.equal(render.status, 202);
  assert.deepEqual(started, ["records"]);
  assert.equal((await call("GET", "/api/jobs/job-1")).body.status, "running");
  assert.equal((await call("GET", "/api/jobs/nope")).status, 404);
  assert.equal((await call("GET", "/api/output/records/../etc")).status, 404);
  assert.equal((await call("GET", "/api/output/records/records.mp4")).status, 404);
  assert.equal((await call("GET", "/nothing")).status, 404);
});

test("render jobs refuse unknown inputs and run one at a time", async (t) => {
  const workspace = await labFixture(t);
  const jobs = createRenderJobs(workspace);
  await assert.rejects(jobs.start("missing"), (caught) => caught.status === 404);
  await assert.rejects(jobs.start("Bad Name"), (caught) => caught.status === 400);
});

test("web render jobs default to narration and preserve an explicit silent choice", async (t) => {
  const workspace = await labFixture(t);
  const calls = [];
  const jobs = createRenderJobs(workspace, { runLab: async (_workspace, name, options) => {
    calls.push({ name, options });
    return { outputRoot: path.join(workspace.designSystemRoot, "video-local/lab/records/out") };
  } });
  const { call } = await serve(t, workspace, { jobs });
  assert.equal((await call("POST", "/api/render", { name: "records" })).status, 202);
  assert.equal(calls[0].options.silent, false);
  assert.equal((await call("POST", "/api/render", { name: "records", silent: true })).status, 202);
  assert.equal(calls[1].options.silent, true);
  assert.equal((await call("POST", "/api/render", { name: "records", silent: "false" })).status, 400);
});

test("credential probe and slugify are conservative", () => {
  assert.equal(hasClaudeCredentials({ ANTHROPIC_API_KEY: "sk-test" }), true);
  assert.equal(hasClaudeCredentials({ ANTHROPIC_AUTH_TOKEN: "token" }), true);
  assert.equal(hasClaudeCredentials({ XDG_CONFIG_HOME: "/definitely/not/a/real/path" }, "/definitely/not/home"), false);
  assert.equal(slugify("Should I keep these records?"), "should-i-keep-these-records");
  assert.equal(slugify(""), "lab-input");
});
