import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

test("the site contact CLI configures and redrives a webhook over HTTP", async () => {
  const siteId = randomUUID();
  const sourceId = randomUUID();
  const operationId = randomUUID();
  const job = "webhook/" + randomUUID();
  const endpoint = "https://receiver.example/contact";
  const header = "X-Webhook-Token";
  const value = "Bearer synthetic-webhook-token";
  const base = `/api/timds/sources/${sourceId}/site/contact/`;
  const requests = [];
  let status = "unset";
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
    requests.push({ method: request.method, url: request.url, body, authorization: request.headers.authorization });
    let result;
    switch (request.url) {
      case base + "status":
        result = { pending: 0, failed: 1, oldestPendingAgeMs: null, lastSuccessAt: null, failedJobs: [{ id: job, failure: "destination_changed" }] };
        break;
      case base + "redrive":
        result = { accepted: true };
        break;
      case base + "webhook":
        if (request.method === "POST") status = body.action === "set" ? "applied" : "unset";
        result = { siteId, status };
        break;
      default:
        response.writeHead(404).end();
        return;
    }
    response.writeHead(request.method === "POST" ? 202 : 200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ apiVersion: 1, ...result }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const portal = `http://127.0.0.1:${server.address().port}`;
  const binary = fileURLToPath(new URL("../bin/timds.mjs", import.meta.url));
  const run = async (args, input) => {
    const child = spawn(process.execPath, [binary, "site", ...args, "--source-id", sourceId, "--portal-url", portal, "--json"], {
      env: { ...process.env, TIMDS_ACCESS_TOKEN: "synthetic-cli-token" },
      signal: AbortSignal.timeout(10_000),
    });
    const result = [];
    const errors = [];
    child.stdout.on("data", chunk => result.push(chunk));
    child.stderr.on("data", chunk => errors.push(chunk));
    child.stdin.end(input);
    const [code] = await once(child, "close");
    const stdout = Buffer.concat(result).toString("utf8");
    const stderr = Buffer.concat(errors).toString("utf8");
    assert.equal(code, 0, stderr);
    assert.ok(!stdout.includes(value) && !stderr.includes(value));
    return JSON.parse(stdout);
  };
  try {
    assert.deepEqual(await run(["webhook", "status"]), { status: "unset" });
    assert.deepEqual(await run([
      "webhook", "set", "--endpoint", endpoint, "--header", header,
      "--stdin", "--operation-id", operationId, "--site-id", siteId,
    ], value + "\n"), { status: "applied" });
    assert.deepEqual(requests.at(-1).body, { siteId, operationId, action: "set", value, endpoint, header, apiVersion: 1 });
    assert.deepEqual(await run(["webhook", "status"]), { status: "applied" });
    assert.deepEqual((await run(["contact", "status"])).failedJobs, [{ id: job, failure: "destination_changed" }]);
    assert.equal((await run(["contact", "redrive", job])).accepted, true);
    assert.deepEqual(requests.at(-1).body, { job, apiVersion: 1 });
    assert.deepEqual(await run(["webhook", "unset"]), { status: "unset" });
    const removal = requests.at(-1).body;
    assert.deepEqual(removal, { siteId, operationId: removal.operationId, action: "unset", apiVersion: 1 });
    assert.notEqual(removal.operationId, operationId);
    assert.ok(requests.every(request => request.authorization === "Bearer synthetic-cli-token"));
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
