#!/usr/bin/env node
// Push a build and its local publication stamp. Promotion is timds publish's
// separate authenticated step, after this ref is available for discovery.
import { loadWorkspace } from "../src/core.mjs";
import { publishArtifactRef } from "../src/publish.mjs";

await publishArtifactRef(await loadWorkspace());
