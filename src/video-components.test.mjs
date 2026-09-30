// The client-owned component snapshot `timds video components init` writes:
// it must typecheck against the published declarations and register every
// default board kind, importing the board rules rather than copying them.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { tsImport } from "tsx/esm/api";
import { DEFAULT_BOARD_KINDS } from "../video/boards.mjs";
import { videoFixture } from "./video.fixture.mjs";
import { initializeVideoComponents } from "./video.mjs";
import {planComponentMigration} from "./video-migration.mjs";

const packageRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

test("the generated component snapshot registers every default board and typechecks", async (t) => {
  const workspace = await videoFixture(t);
  const result = await initializeVideoComponents(workspace);
  const generated = await fs.readFile(result.components, "utf8");

  assert.match(generated, /import \{DEFAULT_BOARD_KINDS, revealFrame\} from "@dtconcepts\/timds\/video\/boards";/u);
  assert.doesNotMatch(generated, /from "\.\/boards\.mjs"/u, "the toolkit-relative import stays outside the snapshot");
  assert.match(generated, /VideoProjectBoardProps,/u);
  assert.match(generated, /Boards: defaultBoards,/u);
  assert.match(generated, /revealFrame\(\{cue, words: line\.words/u);
  for (const name of ["ChapterTitleBoard", "StatementBoard", "CardsBoard", "CompareBoard", "FlowBoard", "StepsBoard", "DocumentBoard", "SubscribeBoard"]) {
    assert.match(generated, new RegExp(`export \\{[^}]*\\b${name}\\b`, "u"), `${name} is exported`);
  }

  // Self-referencing @dtconcepts/timds resolves only inside this package, so
  // the check copies the snapshot into a scratch directory under the root.
  const scratch = await fs.mkdtemp(path.join(packageRoot, ".components-check-"));
  t.after(() => fs.rm(scratch, { force: true, recursive: true }));
  const entry = path.join(scratch, "remotion.tsx");
  await fs.writeFile(entry, generated, "utf8");
  await fs.writeFile(path.join(scratch, "tsconfig.json"), JSON.stringify({ extends: "../tsconfig.json", include: ["remotion.tsx"] }), "utf8");
  const tsc = path.join(path.dirname(require.resolve("typescript/package.json")), "bin", "tsc");
  await promisify(execFile)(process.execPath, [tsc, "--noEmit", "-p", scratch], { cwd: packageRoot }).catch((error) => {
    assert.fail(`generated snapshot failed to typecheck:\n${error.stdout}${error.stderr}`);
  });

  const snapshot = await tsImport(entry, import.meta.url);
  assert.deepEqual(Object.keys(snapshot.default.Boards), [...DEFAULT_BOARD_KINDS]);
  assert.equal(snapshot.CardsBoard, snapshot.default.Boards.cards);
  const plan = await planComponentMigration(generated.replace("const badge = vertical ? 76 : 72;", "const badge = vertical ? 74 : 70;"));
  assert.equal(plan.status, "overrides");
  await fs.writeFile(path.join(scratch, "overrides.tsx"), plan.source);
  await fs.writeFile(path.join(scratch, "tsconfig.json"), JSON.stringify({extends: "../tsconfig.json", include: ["remotion.tsx", "overrides.tsx"]}));
  await promisify(execFile)(process.execPath, [tsc, "--noEmit", "-p", scratch], {cwd: packageRoot}).catch((error) => assert.fail(`migrated overrides failed to typecheck:\n${error.stdout}${error.stderr}`));
  const overrides = await tsImport(path.join(scratch, "overrides.tsx"), import.meta.url);
  assert.deepEqual(Object.keys(overrides.default.Boards), ["steps"]);
  assert.equal(overrides.default.Scene, undefined);
});
