import { setTimeout as delay } from "node:timers/promises";
import { stripVTControlCharacters } from "node:util";

export const SITE_USAGE = `  timds site show [--source-id UUID] [--wait [--commit SHA] [--timeout-seconds N]] [--root PATH] [--portal-url URL] [--json]
  timds site retry [--source-id UUID] [--root PATH] [--portal-url URL] [--json]`;
export const siteUuid = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i;
export const siteCommit = /^[a-f\d]{40}$/;
const defaultTimeoutSeconds = 30 * 60;
const pollIntervalMs = 5_000;

export function siteTimeoutMs(seconds = String(defaultTimeoutSeconds)) {
  if (!/^[1-9]\d*$/.test(seconds) || Number(seconds) > 2_147_483) {
    throw new Error("--timeout-seconds must be a positive whole number of seconds (maximum 2147483).");
  }
  return Number(seconds) * 1000;
}

export async function readSite(host, sourceId, signal = AbortSignal.timeout(30_000)) {
  const result = await host.site(sourceId, { signal });
  if (result.site !== null && (result.site?.sourceId !== sourceId || !Array.isArray(result.site?.deployments))) {
    throw new Error("The host returned an invalid site receipt.");
  }
  return result;
}

const removing = site => ["deleting", "deleted"].includes(site.status) || site.stage?.startsWith("delete");

export async function retrySite(host, sourceId) {
  const { site } = await readSite(host, sourceId);
  if (!site || removing(site)) throw new Error("No hosted site deployment is available to retry.");
  if (!siteUuid.test(site.operationId ?? "")) throw new Error("The host did not return the recorded site operation ID.");
  return { ...await host.retrySite(sourceId, { operationId: site.operationId }), operationId: site.operationId };
}

function observeSite(site, commit) {
  const observation = { sourceCommit: commit ?? null };
  if (!site || removing(site)) return { ...observation, status: "unavailable", error: "No hosted site deployment is available." };
  // A publication can finish before the site receives its commit. The site's
  // overall status may still describe an earlier commit during that window.
  const deployment = commit && site.deployments.find(item => item.sourceCommit === commit);
  const current = commit === site.sourceCommit;
  if (deployment?.status === "failed" && (!current || site.status === "failed")) {
    return { ...observation, status: "failed", stage: deployment.stage, error: deployment.error || "Site deployment failed." };
  }
  if (commit && site.deployedCommit === commit) return { ...observation, status: "ready" };
  if (deployment?.status === "superseded") return { ...observation, status: "superseded", error: "Site deployment was superseded." };
  if (!commit && !site.sourceCommit && site.status === "failed") {
    return { ...observation, status: "failed", stage: site.stage, error: site.error || "Hosted site failed before a commit was requested." };
  }
  return { ...observation, status: "pending" };
}

function siteWait(timeoutMs = siteTimeoutMs()) {
  const deadline = performance.now() + timeoutMs;
  return {
    signal: AbortSignal.timeout(timeoutMs),
    remaining: () => Math.max(0, deadline - performance.now()),
    timeout: sourceCommit => ({ sourceCommit: sourceCommit ?? null, status: "timeout",
      error: `Timed out after ${timeoutMs / 1000} seconds waiting for the site deployment.` }),
  };
}

export async function followSite(host, sourceId, { commit, initial, timeoutMs, wait = siteWait(timeoutMs) } = {}) {
  let result = initial;
  while (!wait.signal.aborted && wait.remaining()) {
    try { result = initial ?? await readSite(host, sourceId, wait.signal); }
    catch (error) {
      if (!wait.signal.aborted) throw error;
      break;
    }
    initial = undefined;
    commit ||= result.site?.sourceCommit || undefined;
    const siteDeployment = observeSite(result.site, commit);
    if (siteDeployment.status !== "pending") return { ...result, siteDeployment };
    await delay(Math.min(pollIntervalMs, wait.remaining()));
  }
  return { apiVersion: 1, ...result, siteDeployment: wait.timeout(commit) };
}

export async function reportPublishedSite(host, publication, { waitSite, timeoutMs }) {
  const sourceId = publication.sourceId ?? publication.result?.sourceId;
  if (!siteUuid.test(sourceId ?? "")) {
    return { siteDeployment: { status: "unknown", error: "The publication did not return a source ID." } };
  }
  const wait = waitSite ? siteWait(timeoutMs) : null;
  let view;
  let commit;
  try {
    view = await readSite(host, sourceId, wait?.signal);
    if (!view.site || view.site.status === "deleted") return { site: null };
    // The v1 publication receipt names the immutable release by ID. Reading
    // its commit from the release history also works after main advances.
    const { currentVersion, versions } = await host.source(sourceId, { signal: wait?.signal ?? AbortSignal.timeout(30_000) });
    const receipt = publication.result?.publication;
    const releaseId = receipt?.version_id ?? publication.id;
    commit = [currentVersion, ...(versions ?? [])].find(release => release?.id === releaseId)?.sourceCommit;
    if (!siteCommit.test(commit ?? "")) {
      commit = undefined;
      throw new Error("The published commit was not found in the source's release history.");
    }
    return wait ? await followSite(host, sourceId, { commit, initial: view, wait })
      : { ...view, siteDeployment: observeSite(view.site, commit) };
  } catch (error) {
    if (!view && error.status === 404 && error.details?.error === "Sites are not enabled") return { site: null };
    const siteDeployment = wait?.signal.aborted ? wait.timeout(commit)
      : { sourceCommit: commit ?? null, status: "unknown", error: error.message };
    return { ...view, siteDeployment };
  }
}

export function siteFollowCommand(cli, sourceId, portal, commit) {
  if (!siteUuid.test(sourceId ?? "")) return null;
  const quotedPortal = "'" + portal.replaceAll("'", "'\\''") + "'";
  return `${cli} site show --source-id ${sourceId} --portal-url ${quotedPortal}${commit ? ` --wait --commit ${commit}` : ""}`;
}

export const terminalText = value => stripVTControlCharacters(String(value)).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");

export function describeSite({ site, siteDeployment, operationId, siteFollowCommand }, { history = true } = {}) {
  const lines = [];
  if (operationId) lines.push(`Retry accepted for site operation ${operationId}.`);
  if (siteDeployment) {
    const { sourceCommit, status, stage, error } = siteDeployment;
    lines.push(`Site deployment${sourceCommit ? ` ${sourceCommit}` : ""}: ${status}${stage ? ` (${stage})` : ""}`);
    if (error) lines.push(error);
  }
  if (site) {
    lines.push(`Site: ${site.status}`, `URL: ${site.url || "—"}`, `Requested commit: ${site.sourceCommit || "—"}`,
      `Deployed commit: ${site.deployedCommit || "—"}`, `Stage: ${site.stage || "—"}`);
    if (site.error && site.error !== siteDeployment?.error) lines.push(`Error: ${site.error}`);
    const deployments = history ? site.deployments : site.deployments.filter(item => item.sourceCommit === siteDeployment?.sourceCommit);
    if (deployments.length) lines.push(history ? "Recent deployments:" : "Published commit's deployment:");
    for (const { sourceCommit, status, stage, updatedAt, error, buildOutput } of deployments) {
      lines.push(`  ${sourceCommit}  ${status}${stage ? ` (${stage})` : ""}${updatedAt ? `  ${updatedAt}` : ""}`);
      if (error) lines.push(`  ${error}`);
      if (status === "failed" && stage === "build" && buildOutput) lines.push("Build output:", buildOutput);
    }
  } else if (!siteDeployment) lines.push("No hosted site is provisioned for this source.");
  if (siteFollowCommand) lines.push(`Follow: ${siteFollowCommand}`);
  return lines.map(terminalText);
}

export function describeSessionDiagnostics({ state, startupError, dev, dependencyCache, siteDependencyCache, wakeStartedAt, wakePhases }) {
  const lines = [`Live runtime: ${state || "unknown"}`, `Site preview: ${dev?.site || "unreported"}`];
  if (startupError) lines.push(`Startup error: ${JSON.stringify(startupError)}`);
  if (dev?.state) lines.push(`Dev server: ${dev.state}${dev.reason ? ` (${dev.reason})` : ""}${dev.exitCode != null ? ` (exit ${dev.exitCode})` : ""}`);
  if (dependencyCache?.state) lines.push(`Dependency cache: ${dependencyCache.state}`);
  if (siteDependencyCache?.state) lines.push(`Site dependency cache: ${siteDependencyCache.state}`);
  if (wakeStartedAt) lines.push(`Last wake: ${wakeStartedAt}`);
  if (wakePhases && Object.keys(wakePhases).length) {
    lines.push("Wake phases:", ...Object.entries(wakePhases).map(([name, ms]) => `  ${name}: ${ms} ms`));
  }
  if (dev?.output) lines.push("Dev output:", dev.output);
  return lines.map(terminalText);
}
