import { randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { cleanPortalUrl, resolveAccessToken, savedPortalUrl } from "./auth.mjs";
import { createHostProvider } from "./hosted.mjs";

const names = ["RESEND_API_KEY", "META_CAPI_ACCESS_TOKEN", "TURNSTILE_SECRET_KEY"];
const uuid = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i;
const help = `Usage:
  timds site secrets status --source-id UUID [--portal-url URL] [--json]
  timds site secrets set NAME --source-id UUID [--stdin] [--operation-id UUID --site-id UUID] [--portal-url URL] [--json]
  timds site secrets unset NAME --source-id UUID [--operation-id UUID --site-id UUID] [--portal-url URL] [--json]
  timds site webhook status --source-id UUID [--portal-url URL] [--json]
  timds site webhook set --source-id UUID --endpoint URL --header NAME [--stdin] [--operation-id UUID --site-id UUID] [--portal-url URL] [--json]
  timds site webhook unset --source-id UUID [--operation-id UUID --site-id UUID] [--portal-url URL] [--json]
  timds site contact status --source-id UUID [--portal-url URL] [--json]
  timds site contact redrive JOB --source-id UUID [--portal-url URL] [--json]

Bindings: ${names.join(", ")}
`;

async function readSecret(name, piped) {
  if (piped) {
    if (process.stdin.isTTY) throw new Error("Pipe the secret into --stdin or use the hidden prompt.");
    const chunks = [];
    let size = 0;
    for await (const chunk of process.stdin) {
      size += chunk.length;
      if (size > 4098) throw new Error("Site secret exceeds the supported length.");
      chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
  }
  if (!process.stdin.isTTY) throw new Error("Pass --stdin to read a site secret from a pipe.");
  const muted = new Writable({ write(_chunk, _encoding, done) { done(); } });
  const prompt = createInterface({ input: process.stdin, output: muted, terminal: true });
  const abort = new AbortController();
  prompt.once("SIGINT", () => abort.abort());
  prompt.once("close", () => abort.abort());
  process.stderr.write(`Enter ${name}: `);
  try { return await prompt.question("", { signal: abort.signal }); }
  catch { throw new Error("Secret input ended."); }
  finally { prompt.close(); muted.destroy(); process.stderr.write("\n"); }
}

export async function runSiteSecrets(args, { output }) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    "source-id": { type: "string" }, "portal-url": { type: "string" }, "operation-id": { type: "string" }, "site-id": { type: "string" },
    "credentials-path": { type: "string" }, stdin: { type: "boolean" }, json: { type: "boolean" },
    endpoint: { type: "string" }, header: { type: "string" },
    help: { type: "boolean", short: "h" },
  } });
  if (values.help || !positionals.length) return output(help);
  const [resource, action, name, extra] = positionals;
  const sourceId = values["source-id"];
  const retry = values["operation-id"];
  const retrySite = values["site-id"];
  const isWebhook = resource === "webhook";
  const isContact = resource === "contact";
  const isMutation = action === "set" || action === "unset";
  if (!["secrets", "webhook", "contact"].includes(resource)
    || !(isContact ? ["status", "redrive"] : ["status", "set", "unset"]).includes(action)
    || !uuid.test(sourceId ?? "") || extra || (values.stdin && action !== "set")
    || ((retry !== undefined || retrySite !== undefined)
      && (!isMutation || !uuid.test(retry ?? "") || !uuid.test(retrySite ?? "")))
    || (isWebhook && action === "set" ? !values.endpoint || !values.header : values.endpoint !== undefined || values.header !== undefined)
    || (action === "redrive" ? !/^(?:resend|meta|test-resend|test-meta|webhook)\/[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/.test(name ?? "")
      : isWebhook || action === "status" ? name !== undefined : !names.includes(name))) throw new Error(help);

  const credentials = { credentialsPath: values["credentials-path"] };
  const selected = values["portal-url"] || process.env.TIMDS_PORTAL_URL || await savedPortalUrl(credentials);
  if (!selected) throw new Error("Select a host with --portal-url or sign in with timds auth login.");
  const url = cleanPortalUrl(selected);
  if (!url.startsWith("https://") && !["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname)) {
    throw new Error("Site credentials require an HTTPS host.");
  }
  const host = createHostProvider({ url, resolveToken: extra => resolveAccessToken(url, { ...credentials, ...extra }) });
  if (isContact) {
    const result = action === "status" ? await host.siteContactStatus(sourceId) : await host.redriveSiteContact(sourceId, name);
    if (values.json) output(JSON.stringify(result));
    else if (action === "redrive") output("Contact delivery queued.");
    else {
      output(`Pending  ${result.pending}`);
      output(`Failed  ${result.failed}`);
      if (result.oldestPendingAgeMs !== null) output(`Oldest pending  ${Math.floor(result.oldestPendingAgeMs / 1000)}s`);
      if (result.lastSuccessAt) output(`Last success  ${result.lastSuccessAt}`);
      for (const job of result.failedJobs) output(`${job.id}  ${job.failure}`);
    }
    return result;
  }

  // Bind an intent to the site observed by this command, including after a
  // replacement between the status read and the mutation.
  let result = await (isWebhook ? host.siteWebhook(sourceId) : host.siteSecrets(sourceId));
  if (!uuid.test(typeof result.siteId === "string" ? result.siteId : "")) throw new Error("The host did not return a site identity.");
  if (retrySite && retrySite !== result.siteId) throw new Error("The source now has a different site.");
  if (isMutation) {
    const value = action === "set" ? await readSecret(isWebhook ? "webhook header value" : name, values.stdin) : undefined;
    const pattern = isWebhook ? /^[!-~](?:[ -~]*[!-~])?$/ : /^[!-~]+$/;
    if (action === "set" && (!value || value.length > 4096 || !pattern.test(value))) throw new Error("Expected one nonempty secret value in the supported format.");
    const operationId = retry ?? randomUUID();
    const operation = { siteId: result.siteId, operationId, action, ...(value === undefined ? {} : { value }) };
    try {
      result = isWebhook
        ? await host.changeSiteWebhook(sourceId, { ...operation, ...(action === "set" ? { endpoint: values.endpoint, header: values.header } : {}) })
        : await host.changeSiteSecret(sourceId, { ...operation, name });
    } catch (error) {
      if ([400, 403, 404, 409].includes(error.status)) throw error;
      throw new Error(`Site credential change could not be confirmed. Retry with --operation-id ${operationId} --site-id ${result.siteId}.`);
    }
  }
  if (isWebhook) {
    if (!["unset", "applied", "pending", "failed"].includes(result.status)) throw new Error("The host returned invalid webhook status.");
    const { status } = result;
    output(values.json ? JSON.stringify({ status }) : `Webhook  ${status}`);
    return { status };
  }
  const bindings = names.map(name => {
    const status = Array.isArray(result.bindings) && result.bindings.find(item => item?.name === name)?.status;
    if (!["unset", "applied", "pending", "failed"].includes(status)) throw new Error("The host returned invalid site secret status.");
    return { name, status };
  });
  if (values.json) output(JSON.stringify({ bindings }));
  else for (const binding of bindings) output(`${binding.name}  ${binding.status}`);
  return { bindings };
}
