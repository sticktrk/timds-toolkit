import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// The hosted contribution skill is served by a TimDS host's MCP server
// (get_skill), which fills these placeholders and nothing else.
const placeholders = ["__SKILL_NAME__", "__SYSTEM_NAME__", "__SYSTEM_ID__", "__HOST_ORIGIN__", "__MCP_URL__", "__STUDIO_URL__"];

test("the hosted design-system skill is a complete template with only the served placeholders", async () => {
  const source = await fs.readFile(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "skills", "timds-hosted-design-system", "SKILL.md"), "utf8");
  assert.match(source, /^---\nname: __SKILL_NAME__\ndescription: .+\n---\n/);
  for (const placeholder of placeholders) assert.ok(source.includes(placeholder), placeholder);
  const unknown = [...source.matchAll(/__[A-Z_]+__/g)].map((match) => match[0]).filter((name) => !placeholders.includes(name));
  assert.deepEqual(unknown, []);
  for (const tool of ["get_system", "get_active_work", "join_session", "start_session", "get_editing_guide", "claim_session", "update_session", "run_check", "submit_session", "publish_submission"]) assert.ok(source.includes(`\`${tool}\``), tool);
});
