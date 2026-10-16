import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { hostedSkillPlaceholders as placeholders } from "./skills-install.mjs";

// The hosted contribution skill is filled by a TimDS host (served to Studio)
// and by `timds skills install`; both supply these placeholders and nothing
// else. The CLI workflow it teaches is asserted in skills-install.test.mjs.

test("the hosted design-system skill is a complete template with only the served placeholders", async () => {
  const source = await fs.readFile(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "skills", "timds-hosted-design-system", "SKILL.md"), "utf8");
  assert.match(source, /^---\nname: __SKILL_NAME__\ndescription: .+\n---\n/);
  for (const placeholder of placeholders) assert.ok(source.includes(placeholder), placeholder);
  const unknown = [...source.matchAll(/__[A-Z_]+__/g)].map((match) => match[0]).filter((name) => !placeholders.includes(name));
  assert.deepEqual(unknown, []);
  assert.deepEqual(placeholders, ["__SKILL_NAME__", "__SYSTEM_NAME__", "__SYSTEM_ID__", "__HOST_ORIGIN__", "__STUDIO_URL__"], "a placeholder change needs the host's fill changed with it");
});
