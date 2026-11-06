import assert from "node:assert/strict";
import test from "node:test";
import { checkProseContract, codeSpans, commandGrammar, commandMentions, formatProblems, parseUsageGrammar, placeholders, registeredToolNames, usageTexts } from "./prose-contract.mjs";

test("the usage grammar expands alternatives and optional literals", () => {
  const grammar = parseUsageGrammar([
    "Usage:",
    "  timds pull|update|status|history [--root PATH] [--json]",
    "  timds update --resolve PATH[#KEY=mine|theirs] [--resolve ...] [--note INTENT]",
    "  timds mcp [edit] [--root PATH]",
    "  timds draft list|close [NAME] [--system-id ID]",
    "  timds-cli installation adopt --binary [--apply]",
    "  timds submit --message \"Change summary\" [--dry-run]",
  ].join("\n"));
  assert.deepEqual([...grammar.keys()].sort(), ["draft close", "draft list", "history", "installation adopt", "mcp", "mcp edit", "pull", "status", "submit", "update"]);
  assert.deepEqual([...grammar.get("update").flags].sort(), ["--json", "--note", "--resolve", "--root"]);
  assert.deepEqual([...grammar.get("mcp edit").flags], ["--root"]);
  assert.deepEqual([...grammar.get("submit").flags].sort(), ["--dry-run", "--message"]);
});

test("the real usage texts yield the commands the dispatcher documents", async () => {
  const grammar = await commandGrammar();
  for (const key of ["init", "check", "consumer notes resolve", "video lab", "starter sync", "assets add", "mcp read", "auth login"]) assert.ok(grammar.has(key), key);
  assert.ok(grammar.get("video lab").flags.has("--serve"));
  assert.ok(grammar.get("consumer update").flags.has("--draft"));
});

test("command mentions are read from inline code and fenced blocks in every invocation form", () => {
  const markdown = [
    "Run `npm run timds -- check --skip-build` then `timds dev --port 4322`.",
    "",
    "```bash",
    "npx --yes @dtconcepts/timds@latest consumer update 2026.10.12-1   # a named release",
    "__TIMDS_CLI__ assets add logo.svg --key brand/logo && timds-cli video check welcome",
    "```",
    "",
    "Prose mentions like timds check outside code are not invocations.",
  ].join("\n");
  const mentions = commandMentions(markdown).map(({ line, pathTokens, flags }) => ({ line, path: pathTokens.join(" "), flags }));
  assert.deepEqual(mentions, [
    { line: 1, path: "check", flags: ["--skip-build"] },
    { line: 1, path: "dev", flags: ["--port"] },
    { line: 4, path: "consumer update", flags: [] },
    { line: 5, path: "assets add", flags: ["--key"] },
    { line: 5, path: "video check welcome", flags: [] },
  ]);
  assert.equal(codeSpans(markdown).filter((span) => span.fenced).length, 1);
});

test("placeholders are collected once each", () => {
  assert.deepEqual(placeholders("__B__ and __A__ then __B__ but not __lower__"), ["__A__", "__B__"]);
});

test("the MCP registrars expose the hosted session tools the skills cite", () => {
  const names = registeredToolNames();
  for (const name of ["timds_start", "timds_join", "timds_sessions_close", "timds_draft_create", "describe_system", "list_designs", "read_design", "get_consumer_guide"]) assert.ok(names.has(name), name);
});

test("every instruction surface is in contract with the toolkit", async () => {
  const problems = await checkProseContract();
  assert.equal(problems.length, 0, `Prose drift:\n${formatProblems(problems)}\n\nFix the prose, or, for a fact the source cannot be read for, add a reviewed allowance in src/prose-contract.mjs.`);
});

test("every module's usage text is read, not only the public --help", async () => {
  const texts = await usageTexts();
  for (const module of ["src/core.mjs", "src/video.mjs", "src/consumer-init.mjs", "src/skills-install.mjs"]) assert.ok(texts.has(module), module);
  assert.match(texts.get("src/video.mjs"), /^timds video lab --serve/m);
});
