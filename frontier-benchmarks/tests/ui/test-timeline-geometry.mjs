import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, extname, resolve, sep } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const routeRoot = resolve(here, "../..");
const siteRoot = resolve(routeRoot, "..");
const chrome = process.env.CHROME_BIN || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const mimeTypes = { ".css": "text/css", ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json", ".csv": "text/csv" };

const sleep = (milliseconds) => new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
const waitFor = async (probe, label, timeout = 10000) => {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(50);
  }
  throw new Error(`Timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ""}`);
};

const server = createServer(async (request, response) => {
  const pathname = new URL(request.url, "http://localhost").pathname;
  const relative = pathname === "/" ? "index.html" : pathname.slice(1);
  const file = resolve(siteRoot, relative);
  if (!file.startsWith(`${siteRoot}${sep}`)) {
    response.writeHead(403).end();
    return;
  }
  try {
    response.writeHead(200, { "content-type": mimeTypes[extname(file)] || "application/octet-stream" });
    response.end(await readFile(file));
  } catch {
    if (!response.headersSent) response.writeHead(404);
    if (!response.writableEnded) response.end();
  }
});

const listen = () => new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
const closeServer = () => new Promise((resolveClose) => server.close(resolveClose));

let browser;
let profile;
try {
  await listen();
  const serverPort = server.address().port;
  profile = await mkdtemp(resolve(tmpdir(), "observatory-chrome-"));
  browser = spawn(chrome, ["--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
  const [debugPort] = (await waitFor(async () => (await readFile(resolve(profile, "DevToolsActivePort"), "utf8")).trim().split("\n"), "Chrome DevTools port"));
  const target = await (await fetch(`http://127.0.0.1:${debugPort}/json/new?${encodeURIComponent(`http://127.0.0.1:${serverPort}/frontier-benchmarks/timeline.html`)}`, { method: "PUT" })).json();
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolveOpen, rejectOpen) => {
    socket.addEventListener("open", resolveOpen, { once: true });
    socket.addEventListener("error", rejectOpen, { once: true });
  });
  let commandId = 0;
  const pending = new Map();
  const browserErrors = [];
  socket.addEventListener("message", ({ data }) => {
    const message = JSON.parse(data);
    if (message.method === "Runtime.exceptionThrown") browserErrors.push(`runtime: ${message.params.exceptionDetails.text}`);
    if (message.method === "Log.entryAdded" && message.params.entry.level === "error") browserErrors.push(`console: ${message.params.entry.text}`);
    if (message.method === "Network.loadingFailed" && !message.params.canceled) browserErrors.push(`network: ${message.params.errorText}`);
    if (message.method === "Network.responseReceived" && message.params.response.status >= 400) browserErrors.push(`http: ${message.params.response.status} ${message.params.response.url}`);
    if (!message.id) return;
    const command = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) command.reject(new Error(message.error.message));
    else command.resolve(message.result);
  });
  const command = (method, params = {}) => new Promise((resolveCommand, rejectCommand) => {
    const id = ++commandId;
    pending.set(id, { resolve: resolveCommand, reject: rejectCommand });
    socket.send(JSON.stringify({ id, method, params }));
  });
  await command("Page.enable");
  await command("Runtime.enable");
  await command("Log.enable");
  await command("Network.enable");
  const expression = `(() => {
    const frame = document.querySelector(".timeline-frame");
    const host = document.querySelector("#timeline-host");
    const toolbar = document.querySelector("#timeline-controls");
    const releases = [...document.querySelectorAll(".release-node")];
    if (!frame || !host || releases.length !== 172) return null;
    const frameRect = frame.getBoundingClientRect();
    const verticallyClippedControls = releases.filter((node) => {
      const rect = node.getBoundingClientRect();
      return rect.top < frameRect.top || rect.bottom > frameRect.bottom;
    });
    const controlBounds = releases.map((node) => node.getBoundingClientRect());
    return {
      document: { clientHeight: document.documentElement.clientHeight, scrollHeight: document.documentElement.scrollHeight },
      frame: { clientHeight: frame.clientHeight, scrollHeight: frame.scrollHeight, top: frameRect.top, bottom: frameRect.bottom, overflowY: getComputedStyle(frame).overflowY },
      hostHeight: host.getBoundingClientRect().height,
      laneHeights: [...document.querySelectorAll(".timeline-lane")].map((lane) => lane.getBoundingClientRect().height),
      releases: releases.length,
      keyboardFocusableReleases: releases.filter((node) => !node.disabled && node.tabIndex >= 0).length,
      verticallyClippedControls: verticallyClippedControls.length,
      controlBounds: { top: Math.min(...controlBounds.map((rect) => rect.top)), bottom: Math.max(...controlBounds.map((rect) => rect.bottom)) },
      toolbar: { clientHeight: toolbar.clientHeight, scrollHeight: toolbar.scrollHeight, interactiveControls: toolbar.querySelectorAll("button, input, select").length },
      bodyOverflow: getComputedStyle(document.body).overflow,
    };
  })()`;
  const geometries = [];
  for (const [width, height] of [[360, 800], [768, 900], [1280, 900], [1920, 1080]]) {
    await command("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
    if (!geometries.length) await command("Page.navigate", { url: `http://127.0.0.1:${serverPort}/frontier-benchmarks/timeline.html` });
    const geometry = await waitFor(async () => {
      const result = await command("Runtime.evaluate", { expression, returnByValue: true });
      return result.result.value;
    }, `172 rendered release controls at ${width}px`);
    assert.equal(geometry.document.scrollHeight, geometry.document.clientHeight, `the ${width}px full timeline route remains viewport bounded`);
    assert.equal(geometry.bodyOverflow, "hidden", `the ${width}px full timeline route avoids ordinary document scrolling`);
    assert.equal(geometry.frame.scrollHeight, geometry.frame.clientHeight, `the ${width}px visualization frame has no vertical scrolling or hidden overflow`);
    assert.equal(geometry.laneHeights.length, 6, `the ${width}px full timeline renders six lanes`);
    assert.equal(geometry.keyboardFocusableReleases, 172, `all ${width}px release controls remain keyboard focusable`);
    assert.equal(geometry.verticallyClippedControls, 0, `all ${width}px release controls remain inside reachable timeline frame bounds`);
    if (width === 360) assert.ok(geometry.laneHeights.every((laneHeight) => laneHeight >= 21), "each 360px lane can contain its release control");
    geometries.push({ viewport: `${width}x${height}`, ...geometry });
  }
  assert.deepEqual(browserErrors, [], "timeline browser coverage has no runtime, console, network, or HTTP errors");
  console.log(JSON.stringify({ result: "PASS", browserErrors, viewports: geometries }));
  socket.close();
} finally {
  if (browser) browser.kill();
  if (profile) await rm(profile, { recursive: true, force: true });
  await closeServer();
}
