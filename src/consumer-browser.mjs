// Headless Chrome for consumer previews, driven over the DevTools Protocol.
//
// The package already ships a Chrome through Remotion (`@remotion/renderer`,
// installed with `@remotion/cli`). Remotion's own `openBrowser` returns its
// internal Puppeteer fork, whose page API needs Remotion render context and
// has no media emulation or screenshot surface meant for outside callers, so
// this module uses Remotion only to locate (or download) the executable via
// `ensureBrowser` and speaks CDP itself over Node's built-in `WebSocket`.
//
// Boundary: this is a capture driver, nothing more. It opens a URL at a given
// viewport and color scheme, waits for the network to settle, and returns a
// full-page PNG and the rendered DOM. It knows nothing about routes, apps, or
// the preview layout; `consumer-preview.mjs` owns those.

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const require = createRequire(import.meta.url);

/** Tallest full-page capture, in CSS pixels; longer pages are clipped to keep PNGs reviewable. */
export const MAX_CAPTURE_HEIGHT = 16_384;

function loadRemotionRenderer() {
  // @remotion/renderer arrives through @remotion/cli; resolve it from there so
  // a nested (non-hoisted) install still works.
  try {
    return createRequire(require.resolve("@remotion/cli/package.json"))("@remotion/renderer");
  } catch {
    return require("@remotion/renderer");
  }
}

/**
 * Path to a Chrome executable: `browserExecutable`, else `TIMDS_BROWSER_EXECUTABLE`,
 * else Remotion's headless shell (downloaded on first use unless `allowDownload` is false).
 */
export async function resolveBrowserExecutable({ allowDownload = true, browserExecutable } = {}) {
  const explicit = String(browserExecutable || process.env.TIMDS_BROWSER_EXECUTABLE || "").trim();
  if (explicit) {
    await fs.access(explicit).catch(() => {
      throw new Error(`Browser executable ${explicit} does not exist`);
    });
    return explicit;
  }
  const { ensureBrowser } = loadRemotionRenderer();
  const status = await ensureBrowser({
    logLevel: "error",
    ...(allowDownload ? {} : {
      onBrowserDownload: () => {
        throw new Error("No headless Chrome is installed and downloading it was not allowed");
      },
    }),
  });
  if (!status?.path) throw new Error("Remotion could not provide a headless Chrome executable");
  return status.path;
}

class CdpConnection {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Set();
    this.closed = false;
    socket.addEventListener("message", (event) => this.receive(event.data));
    socket.addEventListener("close", () => {
      this.closed = true;
      for (const { reject } of this.pending.values()) reject(new Error("The browser connection closed"));
      this.pending.clear();
    });
  }

  static async open(url) {
    if (typeof globalThis.WebSocket !== "function") {
      throw new Error("Consumer preview captures need Node 22 or newer (built-in WebSocket)");
    }
    const socket = new globalThis.WebSocket(url);
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", () => reject(new Error(`Could not connect to the browser at ${url}`)), { once: true });
    });
    return new CdpConnection(socket);
  }

  receive(data) {
    let message;
    try {
      message = JSON.parse(typeof data === "string" ? data : Buffer.from(data).toString("utf8"));
    } catch {
      return;
    }
    if (message.id !== undefined) {
      const waiter = this.pending.get(message.id);
      if (!waiter) return;
      this.pending.delete(message.id);
      if (message.error) waiter.reject(new Error(`${waiter.method}: ${message.error.message}`));
      else waiter.resolve(message.result || {});
      return;
    }
    for (const listener of this.listeners) listener(message);
  }

  send(method, params = {}, sessionId) {
    if (this.closed) return Promise.reject(new Error("The browser connection is closed"));
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { method, reject, resolve });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  on(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close() {
    try {
      this.socket.close();
    } catch {
      // Already closed.
    }
  }
}

function waitForDevtoolsUrl(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    let stderr = "";
    const timer = setTimeout(() => finish(new Error(`Chrome did not start within ${timeoutMs}ms${stderr.trim() ? `: ${stderr.trim().slice(-500)}` : ""}`)), timeoutMs);
    const onData = (chunk) => {
      stderr += chunk;
      const match = stderr.match(/DevTools listening on (ws:\/\/\S+)/);
      if (match) finish(null, match[1]);
    };
    const onExit = (code) => finish(new Error(`Chrome exited with code ${code} before it was ready${stderr.trim() ? `: ${stderr.trim().slice(-500)}` : ""}`));
    function finish(error, url) {
      clearTimeout(timer);
      child.stderr.off("data", onData);
      child.off("exit", onExit);
      if (error) reject(error);
      else resolve(url);
    }
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", onData);
    child.on("exit", onExit);
    child.on("error", (error) => finish(error));
  });
}

/**
 * Launch headless Chrome and connect to it. Returns `{ capture, close }`;
 * always call `close()`, which kills the process and removes its profile.
 */
export async function launchBrowser({ allowDownload = true, browserExecutable, launchTimeoutMs = 30_000 } = {}) {
  const executablePath = await resolveBrowserExecutable({ allowDownload, browserExecutable });
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), "timds-preview-chrome-"));
  const args = [
    "--headless=new",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-default-apps",
    "--disable-extensions",
    "--disable-sync",
    "--hide-scrollbars",
    "--mute-audio",
    "--force-color-profile=srgb",
    ...(process.platform === "linux" ? ["--no-sandbox", "--disable-dev-shm-usage"] : []),
    "about:blank",
  ];
  const child = spawn(executablePath, args, { stdio: ["ignore", "ignore", "pipe"] });
  let connection;
  const close = async () => {
    connection?.close();
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.kill("SIGKILL");
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5_000))]);
    }
    await fs.rm(profile, { force: true, recursive: true }).catch(() => {});
  };
  try {
    const url = await waitForDevtoolsUrl(child, launchTimeoutMs);
    // Keep draining stderr so Chrome never blocks on a full pipe.
    child.stderr.resume();
    connection = await CdpConnection.open(url);
  } catch (error) {
    await close();
    throw error;
  }
  return {
    executablePath,
    capture: (options) => capturePage(connection, options),
    close,
  };
}

function waitForEvent(connection, sessionId, method, timeoutMs) {
  let off;
  let timer;
  const promise = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms waiting for ${method}`)), timeoutMs);
    off = connection.on((message) => {
      if (message.sessionId === sessionId && message.method === method) resolve(message.params);
    });
  });
  return promise.finally(() => {
    clearTimeout(timer);
    off();
  });
}

function trackNetwork(connection, sessionId) {
  const inflight = new Set();
  let lastChange = Date.now();
  const off = connection.on((message) => {
    if (message.sessionId !== sessionId) return;
    const id = message.params?.requestId;
    if (message.method === "Network.requestWillBeSent") {
      // A redirect reuses the request id; it stays in flight.
      inflight.add(id);
      lastChange = Date.now();
    } else if (message.method === "Network.loadingFinished" || message.method === "Network.loadingFailed") {
      inflight.delete(id);
      lastChange = Date.now();
    }
  });
  return {
    off,
    async idle({ quietMs, timeoutMs }) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (inflight.size === 0 && Date.now() - lastChange >= quietMs) return true;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      // Long-polling or streaming pages never go quiet; capture what is there.
      return false;
    },
  };
}

/**
 * Open `url` in a fresh tab at `width`×`height` with `prefers-color-scheme: scheme`,
 * wait for load and network idle, and return `{ png, html, contentHeight, status }`.
 */
export async function capturePage(connection, {
  url,
  width,
  height,
  scheme = "light",
  timeoutMs = 60_000,
  quietMs = 500,
  maxHeight = MAX_CAPTURE_HEIGHT,
}) {
  const { targetId } = await connection.send("Target.createTarget", { url: "about:blank" });
  try {
    const { sessionId } = await connection.send("Target.attachToTarget", { flatten: true, targetId });
    const send = (method, params) => connection.send(method, params, sessionId);
    await send("Page.enable");
    await send("Network.enable");
    await send("Runtime.enable");
    await send("Emulation.setDeviceMetricsOverride", { deviceScaleFactor: 1, height, mobile: width < 768, width });
    await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scheme }] });
    let status = null;
    const offResponse = connection.on((message) => {
      if (message.sessionId === sessionId && message.method === "Network.responseReceived" && message.params?.type === "Document" && status === null) {
        status = message.params.response?.status ?? null;
      }
    });
    const network = trackNetwork(connection, sessionId);
    try {
      const loaded = waitForEvent(connection, sessionId, "Page.loadEventFired", timeoutMs);
      const navigation = await send("Page.navigate", { url });
      if (navigation.errorText) {
        loaded.catch(() => {});
        throw new Error(`Could not load ${url}: ${navigation.errorText}`);
      }
      await loaded;
      await network.idle({ quietMs, timeoutMs: Math.min(timeoutMs, 30_000) });
      await send("Runtime.evaluate", {
        awaitPromise: true,
        expression: "document.fonts ? document.fonts.ready.then(() => true) : true",
        timeout: 10_000,
      }).catch(() => {});
    } finally {
      network.off();
      offResponse();
    }
    const metrics = await send("Page.getLayoutMetrics");
    const content = metrics.cssContentSize || metrics.contentSize || { height, width };
    const contentHeight = Math.max(height, Math.ceil(content.height));
    const captureHeight = Math.min(contentHeight, maxHeight);
    const shot = await send("Page.captureScreenshot", {
      captureBeyondViewport: true,
      clip: { height: captureHeight, scale: 1, width, x: 0, y: 0 },
      format: "png",
    });
    const dom = await send("Runtime.evaluate", { expression: "document.documentElement.outerHTML", returnByValue: true });
    const doctype = await send("Runtime.evaluate", {
      expression: "document.doctype ? new XMLSerializer().serializeToString(document.doctype) : ''",
      returnByValue: true,
    });
    const html = `${doctype.result?.value ? `${doctype.result.value}\n` : ""}${dom.result?.value ?? ""}`;
    return { contentHeight, height: captureHeight, html, png: Buffer.from(shot.data, "base64"), status, width };
  } finally {
    await connection.send("Target.closeTarget", { targetId }).catch(() => {});
  }
}
