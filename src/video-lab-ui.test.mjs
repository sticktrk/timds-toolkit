import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const html = await readFile(new URL("../video/lab-ui.html", import.meta.url), "utf8");
const script = html.match(/<script>([\s\S]*?)<\/script>/u)[1];
const tick = () => new Promise((resolve) => setImmediate(resolve));

// Run the shipped UI script with deferred HTTP responses. Only the DOM methods
// it uses are stubbed; load/compile/save handlers and revision checks are real.
async function labUi() {
  const elements = new Map();
  const element = () => {
    const fields = new Map();
    const listeners = new Map();
    let markup = "";
    const el = {
      value: "", disabled: true, textContent: "", dataset: {}, options: [], children: [],
      addEventListener(type, listener) { listeners.set(type, listener); },
      emit(type, event = {}) { return listeners.get(type)?.({ target: el, ...event }); },
      setAttribute() {},
      add(option) { this.options.push(option); },
      appendChild(child) { this.children.push(child); },
      closest() { return el; },
      querySelector(selector) {
        if (!fields.has(selector)) fields.set(selector, element());
        return fields.get(selector);
      },
      get innerHTML() { return markup; },
      set innerHTML(value) { markup = value; this.children = []; },
    };
    return el;
  };
  const $ = (id) => {
    if (!elements.has(id)) elements.set(id, element());
    return elements.get(id);
  };
  const formats = ["horizontal", "short"].map((format) => ({ ...element(), dataset: { format } }));
  const pending = [];
  const meta = {
    designSystem: { name: "Example", version: "1" },
    contract: { name: "Video", brand: { series: "Answers" }, copy: {}, producer: { roleEyebrows: {}, engagement: {} } },
    catalog: {}, drafting: {}, lab: { inputs: ["ready", "blocked"] },
  };
  const response = (body, ok = true) => ({ ok, json: async () => body });
  vm.runInNewContext(script, {
    document: {
      getElementById: $,
      createElement: element,
      documentElement: { style: { setProperty() {} } },
      querySelectorAll(selector) {
        if (selector === "[data-format]") return formats;
        if (selector === ".beat") return $("beats").children;
        return [];
      },
    },
    fetch: (url, options) => url === "/api/state" ? Promise.resolve(response(meta)) : new Promise((resolve) => {
      pending.push({ url, body: options.body && JSON.parse(options.body), reply: (body, ok) => resolve(response(body, ok)) });
    }),
    Option: function (text, value) { this.text = text; this.value = value; },
    setTimeout,
  });
  await tick();
  const take = (url) => {
    const index = pending.findIndex((request) => request.url === url);
    assert.notEqual(index, -1, `expected request ${url}`);
    return pending.splice(index, 1)[0];
  };
  const input = (slug) => ({ slug, outputFormat: "short", exactQuestion: `Load ${slug}?`, topic: { label: "example topic" }, answerBeats: [] });
  const load = async (name) => {
    $("load-input").value = name;
    const done = $("load-input").emit("change");
    take(`/api/inputs/${name}`).reply(input(name));
    await tick();
    return { done, compile: take("/api/compile") };
  };
  return { $, take, load, input, pending };
}

const plan = (slug, renderable) => ({ slug, renderable, warning: renderable ? null : "no eligible Shorts footage", outputFormat: "short", scenes: [], totalSeconds: 2 });

test("rendering requests narration unless the user selects a silent preview", async () => {
  const ui = await labUi();
  const loaded = await ui.load("ready");
  loaded.compile.reply(plan("ready", true));
  await loaded.done;
  for (const [choice, silent] of [["narrated", false], ["silent", true]]) {
    ui.$("render-audio").value = choice;
    const rendered = ui.$("btn-render").emit("click");
    const request = ui.take("/api/render");
    assert.deepEqual(request.body, { name: "ready", silent });
    request.reply({ id: "audio-job" });
    await tick();
    ui.take("/api/jobs/audio-job").reply({ name: "ready", status: "done", log: [], output: { video: "/ready.mp4", thumbnail: "/cover.jpg", directory: "out" } });
    await rendered;
  }
});

test("an older successful compile cannot enable rendering a newly loaded blocked input", async () => {
  const ui = await labUi();
  const older = await ui.load("ready");
  const current = await ui.load("blocked");
  current.compile.reply(plan("blocked", false));
  await current.done;
  older.compile.reply(plan("ready", true));
  await older.done;
  assert.equal(ui.$("btn-render").disabled, true);
  assert.match(ui.$("render-note").textContent, /no eligible Shorts footage/u);
  assert.match(ui.$("plan-warning").textContent, /no eligible Shorts footage/u);
  assert.equal(ui.$("slug").value, "blocked");
});

test("an older failed compile cannot disable the current renderable input", async () => {
  const ui = await labUi();
  const older = await ui.load("blocked");
  const current = await ui.load("ready");
  current.compile.reply(plan("ready", true));
  await current.done;
  older.compile.reply({ error: "old failure" }, false);
  await older.done;
  assert.equal(ui.$("btn-render").disabled, false);
  assert.equal(ui.$("script-error").textContent, "");
  assert.equal(ui.$("render-note").textContent, "Saved as ready.json");
});

test("a late GET cannot replace the newer saved input or start its compile", async () => {
  const ui = await labUi();
  ui.$("load-input").value = "blocked";
  const olderDone = ui.$("load-input").emit("change");
  const olderGet = ui.take("/api/inputs/blocked");
  const current = await ui.load("ready");
  current.compile.reply(plan("ready", true));
  await current.done;
  olderGet.reply(ui.input("blocked"));
  await olderDone;
  assert.equal(ui.$("slug").value, "ready");
  assert.equal(ui.$("btn-render").disabled, false);
  assert.equal(ui.pending.length, 0);
});

test("editing while compilation is pending keeps the input unsaved", async () => {
  const ui = await labUi();
  const load = await ui.load("ready");
  ui.$("question").value = "A different question?";
  ui.$("question").emit("input");
  load.compile.reply(plan("ready", true));
  await load.done;
  assert.equal(ui.$("btn-render").disabled, true);
  assert.match(ui.$("render-note").textContent, /save again/u);
});

test("a late save response cannot restore an input after loading another", async () => {
  const ui = await labUi();
  const ready = await ui.load("ready");
  ready.compile.reply(plan("ready", true));
  await ready.done;
  const saveDone = ui.$("btn-save").emit("click");
  const save = ui.take("/api/inputs");
  const blocked = await ui.load("blocked");
  blocked.compile.reply(plan("blocked", false));
  await blocked.done;
  save.reply({ name: "ready", path: "video/lab/ready.json", plan: plan("ready", true) });
  await saveDone;
  assert.equal(ui.$("btn-render").disabled, true);
  assert.match(ui.$("render-note").textContent, /no eligible Shorts footage/u);
});

for (const status of ["done", "failed"]) {
  test(`an older render finishing as ${status} cannot bypass the current input's blocker`, async () => {
    const ui = await labUi();
    const ready = await ui.load("ready");
    ready.compile.reply(plan("ready", true));
    await ready.done;
    const rendering = ui.$("btn-render").emit("click");
    ui.take("/api/render").reply({ id: "job" });
    await tick();
    const job = ui.take("/api/jobs/job");
    const blocked = await ui.load("blocked");
    blocked.compile.reply(plan("blocked", false));
    await blocked.done;
    job.reply({ name: "ready", status, log: [], output: { video: "/video.mp4", thumbnail: "/cover.jpg", directory: "out" } });
    await rendering;
    assert.equal(ui.$("btn-render").disabled, true);
    assert.match(ui.$("render-note").textContent, /no eligible Shorts footage/u);
  });
}
