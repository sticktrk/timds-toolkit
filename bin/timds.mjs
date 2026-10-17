#!/usr/bin/env node

import { runCli } from "../src/core.mjs";

runCli(process.argv.slice(2)).catch((caught) => {
  if (["SIGINT", "SIGTERM", "SIGHUP"].includes(caught?.signal)) {
    process.kill(process.pid, caught.signal);
    return;
  }
  const message = caught instanceof Error ? caught.message : String(caught);
  process.stderr.write(`TimDS: ${message}\n`);
  process.exitCode = 1;
});
