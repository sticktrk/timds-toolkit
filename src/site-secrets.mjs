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
    help: { type: "boolean", short: "h" },
  } });
  if (values.help || !positionals.length) return output(help);
  const [resource, action, name, extra] = positionals;
  const sourceId = values["source-id"];
  const retry = values["operation-id"];
  const retrySite = values["site-id"];
  if (resource !== "secrets" || !["status", "set", "unset"].includes(action)
    || !uuid.test(sourceId ?? "") || extra || (values.stdin && action !== "set")
    || ((retry !== undefined || retrySite !== undefined)
      && (action === "status" || !uuid.test(retry ?? "") || !uuid.test(retrySite ?? "")))
    || (action === "status" ? name !== undefined : !names.includes(name))) throw new Error(help);

  const credentials = { credentialsPath: values["credentials-path"] };
  const selected = values["portal-url"] || process.env.TIMDS_PORTAL_URL || await savedPortalUrl(credentials);
  if (!selected) throw new Error("Select a host with --portal-url or sign in with timds auth login.");
  const url = cleanPortalUrl(selected);
  if (!url.startsWith("https://") && !["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname)) {
    throw new Error("Site credentials require an HTTPS host.");
  }
  const host = createHostProvider({ url, resolveToken: extra => resolveAccessToken(url, { ...credentials, ...extra }) });
  // Bind an intent to the site observed by this command, including after a
  // replacement between the status read and the mutation.
  let result = await host.siteSecrets(sourceId);
  if (!uuid.test(typeof result.siteId === "string" ? result.siteId : "")) throw new Error("The host did not return a site identity.");
  if (retrySite && retrySite !== result.siteId) throw new Error("The source now has a different site.");
  if (action !== "status") {
    const value = action === "set" ? await readSecret(name, values.stdin) : undefined;
    if (action === "set" && (!value || value.length > 4096 || !/^[!-~]+$/.test(value))) throw new Error("Expected one nonempty secret value without whitespace.");
    const operationId = retry ?? randomUUID();
    try { result = await host.changeSiteSecret(sourceId, { siteId: result.siteId, operationId, action, name, ...(value === undefined ? {} : { value }) }); }
    catch (error) {
      if ([400, 403, 404, 409].includes(error.status)) throw error;
      throw new Error(`Site secret change could not be confirmed. Retry with --operation-id ${operationId} --site-id ${result.siteId}.`);
    }
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
