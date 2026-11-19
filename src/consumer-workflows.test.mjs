import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Evaluator, Lexer, Parser, data } from "@actions/expressions";
import { parse } from "yaml";
import { consumerManagedFiles } from "./consumer-init.mjs";

const preview = parse(await fs.readFile(new URL("../templates/timds-consumer-preview.yml", import.meta.url), "utf8"));
const designer = parse(await fs.readFile(new URL("../templates/timds-designer-change.yml", import.meta.url), "utf8"));

function expressionData(value) {
  if (value === null || value === undefined) return new data.Null();
  if (typeof value === "boolean") return new data.BooleanData(value);
  if (typeof value === "string") return new data.StringData(value);
  return new data.Dictionary(...Object.entries(value).map(([key, item]) => ({ key, value: expressionData(item) })));
}

// Evaluate the expressions shipped in the templates with GitHub's evaluator,
// including its empty-property and string-comparison behavior.
function evaluate(source, context, cancelled = false) {
  const expression = source.trim().replace(/^\$\{\{\s*|\s*\}\}$/g, "");
  const functions = new Map([["cancelled", {
    name: "cancelled", minArgs: 0, maxArgs: 0, call: () => new data.BooleanData(cancelled),
  }]]);
  const tokens = new Lexer(expression).lex().tokens;
  const parsed = new Parser(tokens, Object.keys(context), [...functions.values()]).parse();
  return new Evaluator(parsed, expressionData(context), functions).evaluate().coerceString();
}

function condition(source, context, cancelled = false) {
  const expression = source.trim().replace(/^\$\{\{\s*|\s*\}\}$/g, "");
  return evaluate(`!!(${expression})`, context, cancelled) === "true";
}

async function scratchDirectory(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "timds-consumer-workflows-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return fs.realpath(directory);
}

test("consumer previews allocate no runner without opt-in and no expensive jobs without a token", async (t) => {
  const { gate, check } = preview.jobs;
  assert.equal(gate["timeout-minutes"], 1);
  assert.deepEqual(Object.keys(preview.on), ["pull_request_target", "workflow_call"]);
  const token = gate.steps[0];
  assert.equal(token.uses, undefined);
  assert.deepEqual(Object.keys(token.env), ["HAS_ACCESS_TOKEN"], "the gate must receive presence, not credentials");
  assert.equal(evaluate(gate.outputs.enabled, { steps: { [token.id]: { outputs: { enabled: "true" } } } }), "true");
  assert.equal(check.needs, "gate");
  assert.equal(preview.jobs.preview.needs, "check");
  const scenarios = [
    { name: "unset flag", flag: undefined, token: "test-token", gate: false, enabled: false },
    { name: "false flag", flag: "false", token: "test-token", gate: false, enabled: false },
    { name: "enabled without token", flag: "true", token: "", gate: true, enabled: false },
    { name: "enabled with token", flag: "true", token: "test-token", gate: true, enabled: true },
    { name: "enabled with service token", flag: "true", service: true, host: "https://host.example.com", gate: true, enabled: true },
    { name: "service token without origin", flag: "true", service: true, gate: true, enabled: false },
    { name: "incomplete service token", flag: "true", partial: true, host: "https://host.example.com", gate: true, enabled: false },
    { name: "reusable call from product branch", call: true, ref: "feature", flag: "true", token: "test-token", gate: false, enabled: false },
    { name: "fork pull request", flag: "true", token: "test-token", fork: true, gate: false, enabled: false },
    { name: "reusable call without opt-in", call: true, flag: undefined, token: "test-token", gate: false, enabled: false },
    { name: "reusable call without token", call: true, flag: "true", token: "", gate: true, enabled: false },
    { name: "reusable call with opt-in and token", call: true, flag: "true", token: "test-token", gate: true, enabled: true },
  ];
  for (const scenario of scenarios) await t.test(scenario.name, async (t) => {
    const context = {
      vars: scenario.flag === undefined ? {} : { TIMDS_PREVIEWS_ENABLED: scenario.flag },
      inputs: scenario.call ? { pull_request: "12" } : {},
      github: {
        repository: "example/product",
        event_name: scenario.call ? "issue_comment" : "pull_request_target",
        ref_name: scenario.ref || "main", ref_type: "branch",
        event: { repository: { default_branch: "main" }, pull_request: { head: { repo: { full_name: scenario.fork ? "example/fork" : "example/product" } } } },
      },
    };
    const gateRuns = condition(gate.if, context);
    assert.equal(gateRuns, scenario.gate);
    let enabled = "";
    if (gateRuns) {
      const directory = await scratchDirectory(t);
      const outputPath = path.join(directory, "outputs");
      const output = execFileSync("bash", ["-c", token.run], {
        cwd: directory,
        env: {
          PATH: process.env.PATH,
          GITHUB_OUTPUT: outputPath,
          HAS_ACCESS_TOKEN: evaluate(token.env.HAS_ACCESS_TOKEN, {
            vars: { TIMDS_PORTAL_URL: scenario.host }, secrets: {
              TIMDS_ACCESS_TOKEN: scenario.token, CF_ACCESS_CLIENT_ID: scenario.service || scenario.partial ? "test-id" : "",
              CF_ACCESS_CLIENT_SECRET: scenario.service ? "test-secret" : "",
            },
          }),
        },
        encoding: "utf8",
      });
      const outputs = await fs.readFile(outputPath, "utf8");
      enabled = outputs.match(/^enabled=(true|false)$/m)?.[1];
      assert.equal(enabled, String(scenario.enabled));
      assert.doesNotMatch(output + outputs, /test-token/);
      if (!scenario.enabled) assert.match(output, /skipping previews/);
    }
    assert.equal(condition(check.if, { needs: { gate: { outputs: { enabled } } } }), scenario.enabled);
  });
});

test("the preview matrix requires a successful check and apps whose look can change", () => {
  for (const result of ["success", "failure", "skipped", "cancelled"]) {
    // A successful check emits an apps array; failed/skipped checks may not
    // emit anything and must never reach fromJSON or allocate a runner.
    for (const apps of result === "success" ? ["[]", '["web"]'] : ["[]", '["web"]', ""]) {
      const runs = condition(preview.jobs.preview.if, { needs: { check: { result, outputs: { apps } } } });
      assert.equal(runs, result === "success" && apps !== "[]", `${result}: ${apps}`);
    }
  }
});

test("CI preview builds an artifact without credentials and uses a trusted runner to publish", async (t) => {
  const directory = await scratchDirectory(t);
  const bin = path.join(directory, "bin");
  await fs.mkdir(bin);
  await fs.writeFile(path.join(bin, "npm"), '#!/bin/sh\nprintf "%s\\n" "$@" >> "$TEST_NPM_LOG"\n');
  await fs.chmod(path.join(bin, "npm"), 0o755);
  const build = preview.jobs.preview.steps.find((step) => step.id === "preview");
  for (const job of [preview.jobs.preview, preview.jobs.check, designer.jobs.change]) {
    assert.doesNotMatch(JSON.stringify(job), /"CF_ACCESS_CLIENT_(ID|SECRET)"|"TIMDS_ACCESS_TOKEN"/);
  }
  for (const job of [preview.jobs.publish, designer.jobs.resolve, designer.jobs.gate]) {
    assert.equal(job.environment, "timds-pipeline");
    const checkout = job.steps.find(step => step.uses === "actions/checkout@v5");
    assert.equal(checkout.with.ref, "${{ github.workflow_sha }}");
    assert.equal(checkout.with["sparse-checkout"], ".github/timds/consumer-pipeline.mjs");
    assert.doesNotMatch(JSON.stringify(job.steps), /npm run|npm ci/);
  }
  assert.equal(preview.jobs.publish.steps.find(step => step.id === "publish").run, "node .github/timds/consumer-pipeline.mjs upload");
  assert.equal(designer.jobs.resolve.steps.at(-1).run, "node .github/timds/consumer-pipeline.mjs resolve");
  {
    const log = path.join(directory, "npm.log");
    execFileSync("bash", ["-c", build.run], {
      cwd: directory,
      env: { PATH: `${bin}:${process.env.PATH}`, APP: "web", BASE_REF: "main", PULL_REQUEST: "12", RUNNER_TEMP: directory, TEST_NPM_LOG: log },
    });
    assert.deepEqual((await fs.readFile(log, "utf8")).trim().split("\n"), [
      "run", "timds", "--", "consumer", "preview", "--app", "web", "--base", "origin/main", "--pull-request", "12", "--output", path.join(directory, "review"),
    ]);
  }
});

test("designer changes call previews only after opt-in and a pushed pull request", () => {
  assert.equal(designer.jobs.preview.needs, "change");
  assert.equal(designer.jobs.preview.uses, "./.github/workflows/timds-consumer-preview.yml");
  assert.equal(designer.jobs.preview.secrets, "inherit");
  for (const flag of [undefined, "false", "true"]) {
    for (const pushed of ["false", "true"]) {
      for (const pull_request of ["", "12"]) {
        for (const cancelled of [false, true]) {
          const runs = condition(designer.jobs.preview.if, {
            vars: flag === undefined ? {} : { TIMDS_PREVIEWS_ENABLED: flag },
            needs: { change: { outputs: { pushed, pull_request } } },
          }, cancelled);
          assert.equal(runs, flag === "true" && pushed === "true" && pull_request !== "" && !cancelled);
        }
      }
    }
  }
  // The flag must not disable the requested change or access to existing notes.
  assert.equal(condition(designer.jobs.change.if, { needs: { gate: { outputs: { allowed: "true" } } } }), true);
});

test("designer instructions promise a published preview only with opt-in and a token", async (t) => {
  const step = designer.jobs.change.steps.find((step) => step.id === "prompt");
  for (const flag of [undefined, "false", "true"]) {
    for (const token of ["", "legacy", "service"]) await t.test(`${flag ?? "unset"} flag, ${token || "missing"} token`, async (t) => {
      const directory = await scratchDirectory(t);
      const outputPath = path.join(directory, "outputs");
      const vars = { TIMDS_PREVIEWS_ENABLED: flag, TIMDS_PORTAL_URL: "https://host.example.com" };
      const secrets = token === "service" ? { CF_ACCESS_CLIENT_ID: "test-id", CF_ACCESS_CLIENT_SECRET: "test-secret" } : { TIMDS_ACCESS_TOKEN: token };
      const configured = evaluate(designer.jobs.gate.steps.find(step => step.id === "notes_config").env.CONFIGURED, { vars, secrets });
      const context = { vars, needs: { gate: { outputs: { notes_artifact: configured === "true" ? "123" : "", pipeline_configured: configured } } } };
      execFileSync("bash", ["-c", step.run], {
        cwd: directory,
        env: {
          PATH: process.env.PATH, GITHUB_OUTPUT: outputPath, RUNNER_TEMP: directory,
          APP: "web", BRANCH: "design/example", DEFAULT_BRANCH: "main", DISPATCH_REQUEST: "Adjust the heading",
          EVENT_NAME: "workflow_dispatch", ISSUE: "", PULL_REQUEST: "12", REPOSITORY: "example/product",
          HAS_NOTES: evaluate(step.env.HAS_NOTES, context),
          PREVIEWS_ENABLED: evaluate(step.env.PREVIEWS_ENABLED, context),
        },
      });
      const outputs = await fs.readFile(outputPath, "utf8");
      const prompt = outputs.match(/^prompt<<([^\n]+)\n([\s\S]*?)\n\1\n/m)?.[2];
      assert.ok(prompt, "the instructions must be written as a multiline output");
      if (flag === "true" && token) {
        assert.match(prompt, /The preview workflow will publish the review page after this run/);
        assert.doesNotMatch(prompt, /Automatic previews are disabled/);
      } else {
        assert.match(prompt, /Automatic previews are disabled/);
        assert.match(prompt, /Describe the routes to review and state that visual checks were not performed/);
        assert.doesNotMatch(prompt, /will publish the review page/);
      }
      assert.equal(prompt.includes("designer-notes.json"), Boolean(token), "note handling stays independent of previews");
      assert.doesNotMatch(prompt, /test-token/);
    });
  }
});

test("the workflow helper publishes built files and resolves only notes delivered for this pull request", async (t) => {
  const directory = await scratchDirectory(t);
  const helper = path.join(directory, "trusted-pipeline.mjs");
  const installed = await consumerManagedFiles({
    schemaVersion: 1, designSystem: { path: "design-system", systemId: "example/core" },
    apps: { web: { cwd: ".", designSurface: ["src/**"], preview: { build: ["npm", "run", "build"], output: "dist" } } },
  });
  await fs.writeFile(helper, installed.find(file => file.path === ".github/timds/consumer-pipeline.mjs").content);
  const selected = "00000000-0000-4000-8000-000000000001";
  const other = "00000000-0000-4000-8000-000000000002";
  const repo = "example/product";
  const sha = "a".repeat(40);
  const preview = { repository: repo, branch: "design/review", commit: sha, pullRequest: 12, app: "web", routes: [] };
  await fs.mkdir(path.join(directory, "review"));
  await fs.writeFile(path.join(directory, "review", "preview.json"), JSON.stringify(preview));
  await fs.writeFile(path.join(directory, "review", "index.html"), "<main>Example</main>");
  await fs.writeFile(path.join(directory, "consumer.json"), JSON.stringify({ apps: { web: {} } }));
  await fs.writeFile(path.join(directory, "event.json"), JSON.stringify({ comment: { body: "<!-- timds-designer-request -->\n```json\n" + JSON.stringify({ notes: [{ id: selected }] }) + "\n```" } }));
  const provider = path.join(directory, "provider.mjs");
  await fs.writeFile(provider, `
    import assert from "node:assert/strict";
    import { appendFile } from "node:fs/promises";
    globalThis.fetch = async (input, init) => {
      const url = new URL(input);
      assert.equal(url.origin, "https://host.example.com");
      assert.equal(init.redirect, "error");
      if (process.env.CF_ACCESS_CLIENT_ID) {
        assert.equal(init.headers["CF-Access-Client-Secret"], "service-secret");
        assert.equal(init.headers.Authorization, undefined);
      } else assert.equal(init.headers.Authorization, "Bearer legacy-token");
      const method = init.method || "GET";
      await appendFile(process.env.RECEIPT, method + " " + url.pathname + url.search + "\\n");
      if (method === "POST") {
        assert.equal(JSON.parse(Buffer.from(init.headers["x-timds-build-metadata"], "base64")).commit, process.env.SHA);
        return Response.json({ previewUrl: "https://share.example.com/p/1" });
      }
      if (method === "PATCH") {
        assert.equal(JSON.parse(init.body).commit, process.env.SHA);
        return Response.json({ note: {} });
      }
      return Response.json(url.searchParams.has("after")
        ? { notes: [{ id: "${selected}" }] } : { notes: [{ id: "${other}" }], nextCursor: "next" });
    };
  `);
  for (const mode of ["legacy", "service"]) {
    const env = {
      PATH: process.env.PATH, RUNNER_TEMP: directory, GITHUB_EVENT_PATH: path.join(directory, "event.json"),
      GITHUB_OUTPUT: path.join(directory, "output"), RECEIPT: path.join(directory, mode),
      APP: "web", BRANCH: preview.branch, SHA: sha, GITHUB_REPOSITORY: repo, PULL_REQUEST: "12",
      TIMDS_PORTAL_URL: "https://host.example.com", NOTE_IDS: JSON.stringify([selected]),
      ...(mode === "legacy" ? { TIMDS_ACCESS_TOKEN: "legacy-token" } : { CF_ACCESS_CLIENT_ID: "service-id", CF_ACCESS_CLIENT_SECRET: "service-secret" }),
    };
    const run = (action, overrides) => execFileSync(process.execPath, ["--import", provider, helper, action], { env: { ...env, ...overrides }, stdio: "pipe" });
    run("upload");
    run("read");
    await fs.mkdir(path.join(directory, "notes"), { recursive: true });
    await fs.rename(path.join(directory, "designer-notes.json"), path.join(directory, "notes", "designer-notes.json"));
    run("resolve");
    assert.throws(() => run("resolve", { NOTE_IDS: JSON.stringify([other]) }), /Unknown addressed note ID/);
    assert.throws(() => run("upload", { SHA: "b".repeat(40) }), /identity does not match/);
    const receipt = (await fs.readFile(env.RECEIPT, "utf8")).trim().split("\n");
    assert.equal(receipt.length, 4);
    assert.match(receipt[2], /after=next/);
    assert.equal(receipt[3], "PATCH /api/timds/consumer-previews/notes/" + selected);
  }
});
