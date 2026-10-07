import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Evaluator, Lexer, Parser, data } from "@actions/expressions";
import { parse } from "yaml";

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
  return directory;
}

test("consumer previews allocate no runner without opt-in and no expensive jobs without a token", async (t) => {
  const { gate, check } = preview.jobs;
  assert.equal(gate["timeout-minutes"], 1);
  assert.equal(gate.steps.length, 1, "the gate must only check token presence");
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
        event: scenario.call ? {} : { pull_request: { head: { repo: { full_name: scenario.fork ? "example/fork" : "example/product" } } } },
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
          HAS_ACCESS_TOKEN: evaluate(token.env.HAS_ACCESS_TOKEN, { secrets: { TIMDS_ACCESS_TOKEN: scenario.token } }),
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

test("CI preview rendering always publishes and has no artifact-only token fallback", async (t) => {
  const directory = await scratchDirectory(t);
  const bin = path.join(directory, "bin");
  await fs.mkdir(bin);
  await fs.writeFile(path.join(bin, "npm"), '#!/bin/sh\nprintf "%s\\n" "$@" >> "$TEST_NPM_LOG"\n');
  await fs.chmod(path.join(bin, "npm"), 0o755);
  const build = preview.jobs.preview.steps.find((step) => step.id === "preview");
  for (const token of ["", "test-token"]) {
    const log = path.join(directory, `npm-${token ? "present" : "missing"}.log`);
    execFileSync("bash", ["-c", build.run], {
      cwd: directory,
      env: { PATH: `${bin}:${process.env.PATH}`, APP: "web", BASE_REF: "main", PULL_REQUEST: "12", TIMDS_ACCESS_TOKEN: token, TEST_NPM_LOG: log },
    });
    assert.deepEqual((await fs.readFile(log, "utf8")).trim().split("\n"), [
      "run", "timds", "--", "consumer", "preview", "--app", "web", "--base", "origin/main", "--publish", "--pull-request", "12",
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
    for (const token of ["", "test-token"]) await t.test(`${flag ?? "unset"} flag, ${token ? "present" : "missing"} token`, async (t) => {
      const directory = await scratchDirectory(t);
      const outputPath = path.join(directory, "outputs");
      const context = { vars: flag === undefined ? {} : { TIMDS_PREVIEWS_ENABLED: flag }, secrets: { TIMDS_ACCESS_TOKEN: token } };
      execFileSync("bash", ["-c", step.run], {
        cwd: directory,
        env: {
          PATH: process.env.PATH, GITHUB_OUTPUT: outputPath, RUNNER_TEMP: directory,
          APP: "web", BRANCH: "design/example", DEFAULT_BRANCH: "main", DISPATCH_REQUEST: "Adjust the heading",
          EVENT_NAME: "workflow_dispatch", ISSUE: "", PULL_REQUEST: "12", REPOSITORY: "example/product",
          HAS_NOTES_TOKEN: evaluate(step.env.HAS_NOTES_TOKEN, context),
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
      assert.equal(prompt.includes("consumer notes --json"), Boolean(token), "note handling stays independent of previews");
      assert.doesNotMatch(prompt, /test-token/);
    });
  }
});
