#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { cp, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

function run(command, args, cwd) {
  execFileSync(command, args, { cwd, stdio: "inherit" });
}

const repoRoot = process.cwd();
const manifest = JSON.parse(readFileSync(path.join(repoRoot, "timds.json"), "utf8"));
const publishRef = String(manifest.artifact?.publishRef || "").trim();
const sourceCommit = String(process.env.GITHUB_SHA || "").trim();
const repository = String(process.env.GITHUB_REPOSITORY || "").trim();

if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(publishRef)) {
  throw new Error("timds.json artifact.publishRef must be a safe Git ref");
}
if (!/^[a-f0-9]{40}$/i.test(sourceCommit)) throw new Error("GITHUB_SHA is required");
if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error("GITHUB_REPOSITORY is required");

const publishRoot = mkdtempSync(path.join(os.tmpdir(), "timds-publish-"));
try {
  await cp(path.join(repoRoot, "dist"), publishRoot, { recursive: true });
  await mkdir(publishRoot, { recursive: true });
  writeFileSync(path.join(publishRoot, ".timds-artifact.json"), `${JSON.stringify({
    schemaVersion: 1,
    sourceCommit,
    version: String(manifest.version || "working"),
  }, null, 2)}\n`);

  run("git", ["init", "-b", publishRef], publishRoot);
  run("git", ["config", "user.name", "github-actions[bot]"], publishRoot);
  run("git", ["config", "user.email", "41898282+github-actions[bot]@users.noreply.github.com"], publishRoot);
  run("git", ["add", "--all"], publishRoot);
  run("git", ["commit", "-m", `Publish TimDS ${String(manifest.version || "working")} from ${sourceCommit.slice(0, 12)}`], publishRoot);
  run("git", ["remote", "add", "origin", `https://github.com/${repository}.git`], publishRoot);
  run("git", ["push", "--force", "origin", `HEAD:refs/heads/${publishRef}`], publishRoot);
} finally {
  rmSync(publishRoot, { force: true, recursive: true });
}
