import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  loginWithDevice,
  readCredentials,
  removeAccessToken,
  resolveAccessToken,
  saveAccessToken,
} from "./auth.mjs";

async function temporaryCredentials(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "timds-auth-"));
  t.after(() => fs.rm(directory, { force: true, recursive: true }));
  return path.join(directory, "credentials.json");
}

test("stores portal access tokens outside the repository with owner-only permissions", async (t) => {
  const credentialsPath = await temporaryCredentials(t);
  await saveAccessToken("https://timds.test/path", "timds_test_secret", { credentialsPath });
  assert.equal(
    await resolveAccessToken("https://timds.test", { credentialsPath }),
    "timds_test_secret",
  );
  assert.equal((await fs.stat(credentialsPath)).mode & 0o777, 0o600);
  const removed = await removeAccessToken("https://timds.test", { credentialsPath });
  assert.equal(removed.removed, true);
  assert.deepEqual((await readCredentials({ credentialsPath })).portals, {});
});

test("completes the TimDS operator device authorization flow", async (t) => {
  const credentialsPath = await temporaryCredentials(t);
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    if (String(url).endsWith("/device/authorize")) {
      return Response.json({
        deviceCode: "device-secret",
        expiresIn: 600,
        pollInterval: 1,
        userCode: "ABCD-EFGH",
        verificationUrl: "https://timds.test/operator/timds-access?code=ABCD-EFGH",
      });
    }
    return Response.json({ accessToken: "timds_device_secret", expiresAt: null });
  };
  let displayedCode = "";
  const result = await loginWithDevice("https://timds.test", {
    credentialsPath,
    fetchImpl,
    onAuthorization: (authorization) => { displayedCode = authorization.userCode; },
    pollImmediately: true,
    sleep: async () => {},
  });
  assert.equal(displayedCode, "ABCD-EFGH");
  assert.equal(result.portal, "https://timds.test");
  assert.equal(await resolveAccessToken("https://timds.test", { credentialsPath }), "timds_device_secret");
  assert.equal(calls.length, 2);
});
