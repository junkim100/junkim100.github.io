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
    if (!frame || !host || releases.length !== 172 || Math.abs(frame.scrollLeft - (frame.scrollWidth - frame.clientWidth)) > 1) return null;
    const frameRect = frame.getBoundingClientRect();
    const verticallyClippedControls = releases.filter((node) => {
      const rect = node.getBoundingClientRect();
      return rect.top < frameRect.top || rect.bottom > frameRect.bottom;
    });
    const controlBounds = releases.map((node) => node.getBoundingClientRect());
    return {
      document: { clientHeight: document.documentElement.clientHeight, scrollHeight: document.documentElement.scrollHeight },
      frame: { clientHeight: frame.clientHeight, scrollHeight: frame.scrollHeight, scrollLeft: frame.scrollLeft, maxScroll: frame.scrollWidth - frame.clientWidth, top: frameRect.top, bottom: frameRect.bottom, overflowY: getComputedStyle(frame).overflowY },
      hostHeight: host.getBoundingClientRect().height,
      laneHeights: [...document.querySelectorAll(".timeline-lane")].map((lane) => lane.getBoundingClientRect().height),
      releases: releases.length,
      distinctNames: new Set(releases.map((node) => node.textContent.trim())).size,
      internalIdLabels: releases.filter((node) => /^release_/i.test(node.textContent.trim())).length,
      circularNodes: releases.filter((node) => getComputedStyle(node).borderRadius !== "0px").length,
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
    assert.equal(geometry.distinctNames, 172, `all ${width}px release controls expose distinct human names`);
    assert.equal(geometry.internalIdLabels, 0, `the ${width}px timeline does not show internal release identifiers`);
    assert.equal(geometry.circularNodes, 0, `the ${width}px timeline uses non-circular release controls`);
    assert.ok(Math.abs(geometry.frame.scrollLeft - geometry.frame.maxScroll) <= 1, `the ${width}px default visit starts at the latest edge`);
    if (width === 360) assert.ok(geometry.laneHeights.every((laneHeight) => laneHeight >= 21), "each 360px lane can contain its release control");
    geometries.push({ viewport: `${width}x${height}`, ...geometry });
  }
  await command("Emulation.setDeviceMetricsOverride", { width: 768, height: 900, deviceScaleFactor: 1, mobile: false });
  await command("Page.navigate", { url: `http://127.0.0.1:${serverPort}/frontier-benchmarks/index.html?fixture=ui` });
  const landing = await waitFor(async () => {
    const result = await command("Runtime.evaluate", { expression: `(() => {
      const frame = document.querySelector(".timeline-frame");
      const host = document.querySelector("#timeline-host");
      const releases = [...document.querySelectorAll(".release-node")];
      if (!frame || releases.length !== 12) return null;
      return {
        hostHeight: host.getBoundingClientRect().height,
        scrollLeft: frame.scrollLeft,
        maxScroll: frame.scrollWidth - frame.clientWidth,
        fullscreenActions: document.querySelectorAll("#timeline-fullscreen-button").length,
        historyScroll: history.state?.timelineScroll,
      };
    })()`, returnByValue: true });
    const value = result.result.value;
    return value && Math.abs(value.scrollLeft - value.maxScroll) <= 1 ? value : null;
  }, "landing default latest-edge position");
  assert.equal(Math.round(landing.hostHeight), 560, "the desktop landing timeline is 560px high");
  assert.equal(landing.fullscreenActions, 1, "the landing exposes one fullscreen action");
  assert.equal(landing.historyScroll, landing.scrollLeft, "finite timeline scroll is persisted in history state");

  const detail = await command("Runtime.evaluate", { expression: `(() => {
    document.querySelector(".release-node").click();
    return true;
  })()`, returnByValue: true });
  assert.equal(detail.result.value, true);
  const detailContract = await waitFor(async () => {
    const result = await command("Runtime.evaluate", { expression: `(() => {
      const panel = document.querySelector("#release-detail-host:not([hidden])");
      if (!panel) return null;
      return {
        sources: [...panel.querySelectorAll("a")].map((link) => ({ text: link.textContent, href: link.href, rel: link.rel })),
        text: panel.textContent,
        closeVisible: panel.querySelector(".detail-close").getBoundingClientRect().top >= panel.getBoundingClientRect().top,
      };
    })()`, returnByValue: true });
    return result.result.value;
  }, "pinned detail");
  assert.equal(detailContract.sources.length, 5, "each displayed occurrence has a Source link");
  assert.ok(detailContract.sources.every((source) => source.text === "Source" && source.href.startsWith("https://") && source.rel === "noopener noreferrer"));
  assert.equal(detailContract.closeVisible, true, "the sticky close control remains visible");
  for (const forbidden of ["release_", "Model", "Lineage", "Coverage", "Evaluation setup", "Revision", "Locator", "Record", "Review state", "Source type", "Open exact first-party source"]) assert.equal(detailContract.text.includes(forbidden), false, `detail omits ${forbidden}`);

  const comboboxContract = await command("Runtime.evaluate", { expression: `(() => {
    const input = document.querySelector("#timeline-category");
    input.focus();
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
    const options = [...document.querySelectorAll("#timeline-category-listbox [role=option]")];
    return {
      role: input.getAttribute("role"),
      expanded: input.getAttribute("aria-expanded"),
      active: input.getAttribute("aria-activedescendant"),
      optionCount: options.length,
      listRole: document.querySelector("#timeline-category-listbox").getAttribute("role"),
    };
  })()`, returnByValue: true });
  assert.deepEqual(comboboxContract.result.value, { role: "combobox", expanded: "true", active: "timeline-category-listbox-option-8", optionCount: 9, listRole: "listbox" });

  await command("Runtime.evaluate", { expression: `(() => {
    const input = document.querySelector("#timeline-q");
    input.value = "CH tasks";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  })()` });
  const debouncedSearch = await waitFor(async () => {
    const result = await command("Runtime.evaluate", { expression: `(() => ({ query: new URL(location.href).searchParams.get("q"), releases: document.querySelectorAll(".release-node").length }))()`, returnByValue: true });
    return result.result.value.query === "CH tasks" ? result.result.value : null;
  }, "debounced timeline search");
  assert.ok(debouncedSearch.releases > 0 && debouncedSearch.releases < 12, "timeline search updates automatically after its debounce");

  await command("Page.navigate", { url: `http://127.0.0.1:${serverPort}/frontier-benchmarks/index.html?fixture=ui&q=CH%20tasks&category=coding&lab=openai&from=2024-01-01&to=2026-09-01&zoom=2&release=openai_release_1` });
  await waitFor(async () => {
    const result = await command("Runtime.evaluate", { expression: `Boolean(document.querySelector("#timeline-fullscreen-button") && document.querySelector(".release-node"))`, returnByValue: true });
    return result.result.value;
  }, "stateful landing timeline");
  const fullscreenSuccess = await command("Runtime.evaluate", { expression: `(() => {
    const target = document.querySelector("#timeline-workspace");
    const button = document.querySelector("#timeline-fullscreen-button");
    let inClick = false;
    button.addEventListener("click", () => { inClick = true; queueMicrotask(() => { inClick = false; }); }, { capture: true });
    Object.defineProperty(document, "fullscreenEnabled", { configurable: true, value: true });
    Object.defineProperty(document, "fullscreenElement", { configurable: true, get: () => window.__fullscreenTarget || null });
    target.requestFullscreen = () => {
      window.__requestInGesture = inClick;
      window.__fullscreenTarget = target;
      document.dispatchEvent(new Event("fullscreenchange"));
      return Promise.resolve();
    };
    button.click();
    return new Promise((resolve) => queueMicrotask(() => resolve({ requested: window.__requestInGesture, text: button.textContent, pressed: button.getAttribute("aria-pressed") })));
  })()`, awaitPromise: true, returnByValue: true });
  assert.deepEqual(fullscreenSuccess.result.value, { requested: true, text: "Exit fullscreen", pressed: "true" }, "fullscreen request runs in the click gesture and updates the same control");

  await command("Runtime.evaluate", { expression: `(() => {
    window.__fullscreenTarget = null;
    document.dispatchEvent(new Event("fullscreenchange"));
    const target = document.querySelector("#timeline-workspace");
    target.requestFullscreen = () => Promise.reject(new Error("fixture rejection"));
    document.querySelector("#timeline-fullscreen-button").click();
  })()` });
  const fallbackState = await waitFor(async () => {
    const result = await command("Runtime.evaluate", { expression: `(() => {
      if (!location.pathname.endsWith("/timeline.html")) return null;
      return Object.fromEntries(new URL(location.href).searchParams);
    })()`, returnByValue: true });
    return result.result.value;
  }, "fullscreen rejection fallback");
  assert.deepEqual(fallbackState, { q: "CH tasks", category: "coding", lab: "openai", from: "2024-01-01", to: "2026-09-01", zoom: "2", release: "openai_release_1", fixture: "ui" }, "fullscreen rejection uses the same tab and carries the complete sanitized state");

  await command("Page.navigate", { url: `http://127.0.0.1:${serverPort}/frontier-benchmarks/history.html?fixture=ui` });
  await waitFor(async () => {
    const result = await command("Runtime.evaluate", { expression: `document.querySelectorAll("#history-host tbody tr").length`, returnByValue: true });
    return result.result.value;
  }, "history rows");
  await command("Runtime.evaluate", { expression: `(() => {
    const input = document.querySelector("#route-query");
    input.value = "legitimate-zero-result-query";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  })()` });
  const historySearch = await waitFor(async () => {
    const result = await command("Runtime.evaluate", { expression: `(() => ({ query: new URL(location.href).searchParams.get("q"), empty: Boolean(document.querySelector("#history-empty-title")) }))()`, returnByValue: true });
    return result.result.value.query ? result.result.value : null;
  }, "debounced history search");
  assert.deepEqual(historySearch, { query: "legitimate-zero-result-query", empty: true }, "history search updates without a submit action");

  assert.deepEqual(browserErrors, [], "timeline and data-route browser coverage has no runtime, console, network, or HTTP errors");
  console.log(JSON.stringify({ result: "PASS", browserErrors: browserErrors.length, landingHeight: landing.hostHeight, defaultAtLatest: landing.scrollLeft === landing.maxScroll, persistedScroll: landing.historyScroll, detailSources: detailContract.sources.length, fallbackStateKeys: Object.keys(fallbackState).length, historyAutoSearch: historySearch.empty, viewports: geometries.map((geometry) => `${geometry.viewport}:172/6/bounded/latest`) }));
  socket.close();
} finally {
  if (browser) browser.kill();
  if (profile) await rm(profile, { recursive: true, force: true });
  await closeServer();
}
