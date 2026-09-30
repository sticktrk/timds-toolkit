import assert from "node:assert/strict";
import test from "node:test";
import {assertRuntimeCompatibility, assertVideoContractRuntime, runtimeIdentity, sharedRuntimeRequirements} from "./runtime.mjs";
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

test("explicit runtime requirements require contract schema 2 so old hosts reject them", () => {
  assert.doesNotThrow(() => assertVideoContractRuntime({schemaVersion:1}));
  assert.throws(() => assertVideoContractRuntime({schemaVersion:1,runtime:sharedRuntimeRequirements()}), /schemaVersion 2 so older hosts reject/u);
  assert.throws(() => assertVideoContractRuntime({schemaVersion:2}), /requires explicit runtime/u);
  assert.doesNotThrow(() => assertVideoContractRuntime({schemaVersion:2,runtime:sharedRuntimeRequirements()}));
});
