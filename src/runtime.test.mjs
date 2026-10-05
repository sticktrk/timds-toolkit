import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { isBuiltin } from "node:module";
import test from "node:test";
import {acceptsToolkitReleaseRange, assertRuntimeCompatibility, assertVideoContractRuntime, declaredReleaseLine, runtimeIdentity, sharedRuntimeRequirements, toolkitReleaseRange} from "./runtime.mjs";
import {releaseLineOf, runtimeIdentityFor} from "../video/runtime-compat.mjs";
import {createVideoAuthoringContract, createVideoProducer} from "./video-producer.mjs";

test("runtime requirements accept tested shared contracts and reject incompatible hosts before drafting", () => {
  const requirements = sharedRuntimeRequirements();
  assert.equal(assertRuntimeCompatibility(requirements), runtimeIdentity);
  for (const incompatible of [{componentApi: 99}, {videoSchema: 99}, {features: ["unknown-feature"]}, {minimumVersion: "0.1.999999"}, {releaseLine: "0.2.x"}, {testedVersions: ["0.1.0"]}]) {
    const runtime = {...requirements, ...incompatible};
    assert.throws(() => assertRuntimeCompatibility(runtime), /runtime compatibility.*installed/u);
    assert.throws(() => createVideoProducer({contract: {runtime}}), /runtime compatibility/u);
    assert.throws(() => createVideoAuthoringContract({contract: {runtime}}), /runtime compatibility/u);
  }
  assert.equal(assertRuntimeCompatibility(undefined), runtimeIdentity, "legacy contracts retain their existing behavior");
  assert.equal(assertRuntimeCompatibility({...requirements, testedVersions: [runtimeIdentity.version]}), runtimeIdentity);
});

test("the release line is derived from the executing version, never written down", () => {
  const [major, minor] = runtimeIdentity.version.split(".");
  assert.equal(runtimeIdentity.releaseLine, `${major}.${minor}.x`);
  assert.equal(sharedRuntimeRequirements().releaseLine, runtimeIdentity.releaseLine);
  assert.equal(releaseLineOf("0.2.7"), "0.2.x");
  assert.equal(runtimeIdentityFor({name: "@dtconcepts/timds", version: "0.2.0"}).releaseLine, "0.2.x");
  assert.throws(() => releaseLineOf("0.2"), /exact stable release/u);
  // A contract written by a 0.2.0 host is accepted by a 0.2.0 host and rejected by this one.
  const next = runtimeIdentityFor({name: runtimeIdentity.name, version: "0.2.0"});
  const written = {...sharedRuntimeRequirements(), releaseLine: next.releaseLine, minimumVersion: next.version};
  assert.equal(assertRuntimeCompatibility(written, next), next);
  assert.throws(() => assertRuntimeCompatibility(written), /requires release line 0\.2\.x/u);
  assert.equal(toolkitReleaseRange({version: "1.4.2"}), "1.4.x");
  assert.equal(declaredReleaseLine("0.1.x"), "0.1.x");
  assert.equal(declaredReleaseLine("^0.3.12"), "0.3.x");
  for (const invalid of ["latest", "0.1.5", "^0.1.x", "~0.1.2", "", undefined]) assert.equal(declaredReleaseLine(invalid), null, JSON.stringify(invalid));
  const identity = {version: "0.1.10"};
  assert.equal(acceptsToolkitReleaseRange("0.1.x", identity), true);
  assert.equal(acceptsToolkitReleaseRange("^0.1.10", identity), true);
  assert.equal(acceptsToolkitReleaseRange("^0.1.11", identity), false, "a caret above the installed patch cannot resolve to it");
  assert.equal(acceptsToolkitReleaseRange("0.2.x", identity), false);
  assert.equal(acceptsToolkitReleaseRange("^1.0.0", {version: "1.0.0"}), false, "a caret on 1.x spans the whole major");
});

test("explicit runtime requirements require contract schema 2 so old hosts reject them", () => {
  assert.doesNotThrow(() => assertVideoContractRuntime({schemaVersion:1}));
  assert.doesNotThrow(() => assertVideoContractRuntime({schemaVersion:"1"}), "contracts that spelled the version as a string keep validating");
  assert.doesNotThrow(() => assertVideoContractRuntime({schemaVersion:"2",runtime:sharedRuntimeRequirements()}));
  assert.throws(() => assertVideoContractRuntime({schemaVersion:1,runtime:sharedRuntimeRequirements()}), /schemaVersion 2 so older hosts reject/u);
  assert.throws(() => assertVideoContractRuntime({schemaVersion:2}), /requires explicit runtime/u);
  assert.doesNotThrow(() => assertVideoContractRuntime({schemaVersion:2,runtime:sharedRuntimeRequirements()}));
});

test("modules a render bundle reaches never import a Node built-in", async () => {
  // A client's render components import the Remotion defaults and, for
  // resolveBoardKind, the producer; webpack bundles everything they reach for
  // the browser and fails the whole render on a single `node:` specifier.
  const root = new URL("../", import.meta.url);
  const manifest = JSON.parse(await fs.readFile(new URL("package.json", root), "utf8"));
  const entries = ["./video/remotion", "./video/producer", "./video/transport", "./video/boards", "./video/footage", "./video/board-layouts"];
  const pending = entries.map((entry) => new URL(manifest.exports[entry], root).href);
  const seen = new Set(), offenders = [];
  while (pending.length) {
    const file = pending.pop();
    if (seen.has(file) || file.endsWith(".json")) continue;
    seen.add(file);
    const source = await fs.readFile(new URL(file), "utf8");
    for (const [, specifier] of source.matchAll(/^\s*(?:import|export)\b[^"'`;]*?["']([^"']+)["']/gmu)) {
      if (specifier.startsWith(".")) pending.push(new URL(specifier, file).href);
      else if (isBuiltin(specifier)) offenders.push(`${file.slice(root.href.length)} imports ${specifier}`);
    }
  }
  assert.ok(seen.size > entries.length, "the walk follows relative imports");
  assert.deepEqual(offenders, []);
});
