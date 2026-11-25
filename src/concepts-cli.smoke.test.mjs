import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../bin/timds.mjs", import.meta.url));
const run = (root, ...args) => execFileSync(process.execPath, [cli, ...args, "--root", root], {
  encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
});
const read = (root, file) => fs.readFile(path.join(root, file), "utf8");

for (const starter of ["starter", "brand-kit"]) {
  test(`${starter} scaffolds, adopts and renders authored concepts through public commands`, async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "timds-concepts-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    execFileSync("git", ["init", "-q", "-b", "main", root]);
    run(root, "init", "--standalone", "--starter", starter, "--system-id", "example/system");
    run(root, "check");
    assert.match(await read(root, "dist/index.html"), /href="\/concepts\/">\s*<b>Concepts/);
    assert.match(await read(root, "dist/concepts/index.html"), /Field notes/);
    assert.match(await read(root, "dist/concepts/sample/index.html"), /sandbox/);
    const catalog = JSON.parse(run(root, "doctor", "--json")).concepts;
    assert.deepEqual(catalog, { setUp: true, concepts: 1 });

    const imported = path.join(root, "new-proposal");
    await fs.rename(path.join(root, "src/concepts/sample"), imported);
    await fs.rm(path.join(root, "src/concepts"), { recursive: true });
    run(root, "check");
    const landing = await read(root, "dist/index.html");
    if (starter === "brand-kit") {
      assert.match(landing, /href="\/concepts\/">\s*<b>Concepts/);
      assert.match(await read(root, "dist/concepts/index.html"), /src\/concepts\/|concepts (?:add|init)/);
    } else {
      assert.doesNotMatch(landing, /href="\/concepts\/">\s*<b>Concepts/);
    }
    run(root, "concepts", "init");
    const manifest = JSON.parse(await read(imported, "concept.json"));
    manifest.title = "Direction two";
    manifest.status = "approved";
    await fs.writeFile(path.join(imported, "concept.json"), JSON.stringify(manifest));
    run(root, "concepts", "add", imported, "--id", "direction-two");
    assert.throws(() => run(root, "concepts", "add", imported, "--id", "direction-two"), /already exists/);
    assert.throws(() => run(root, "concepts", "add", imported, "--id", "direction-three"), /approved/);

    const page = path.join(root, "src/pages/index.html");
    await fs.appendFile(page, '\n<section id="proposals">{{count:concepts}} {{concept:sample}} {{concepts:approved}} {{concepts}}</section>\n');
    run(root, "check");
    const overview = await read(root, "dist/overview/index.html");
    assert.match(overview, /id="proposals">2 /);
    assert.match(overview, /\/concepts\/direction-two\//);
    await fs.appendFile(page, "{{concept:missing}}");
    assert.throws(() => run(root, "check"), /src\/pages\/index.html.*missing/);
  });
}
