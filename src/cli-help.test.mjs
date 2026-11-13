import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../bin/timds.mjs", import.meta.url));

test("CLI help works outside a workspace without creating the requested root", async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "timds-help-smoke-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const missingRoot = path.join(directory, "not-created");
  const cases = [
    [["--help"], /TimDS design-system workflow/],
    [["-h"], /TimDS design-system workflow/],
    [["run", "--help"], /Usage: timds-cli run/],
    [["run", "-h"], /Usage: timds-cli run/],
    [["consumer", "init", "-h", "--root", missingRoot], /timds consumer init/],
    [["consumer", "scaffold", "emdash", "--workspace", "--help", "--root", missingRoot], /timds consumer scaffold emdash/],
    [["video", "components", "migrate", "-h", "--root", missingRoot], /TimDS video workflow/],
  ];
  for (const [args, expected] of cases) {
    const result = spawnSync(process.execPath, [cli, ...args], {
      cwd: directory,
      encoding: "utf8",
      timeout: 10_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    assert.equal(result.status, 0, `${args.join(" ")}: ${result.error?.message || result.stderr}`);
    assert.match(result.stdout, expected);
    assert.match(result.stdout, /Usage:/);
  }
  await assert.rejects(fs.access(missingRoot), { code: "ENOENT" });
});
