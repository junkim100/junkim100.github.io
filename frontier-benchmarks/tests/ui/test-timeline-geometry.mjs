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
  const production = JSON.parse(await readFile(resolve(routeRoot, "public/observatory.json"), "utf8"));
  const capBenchmarkIds = production.benchmarks.filter((benchmark) => !benchmark.identity_status || benchmark.identity_status === "canonical").slice(0, 7).map((benchmark) => benchmark.id);
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
  for (const [width, height] of [[360, 800], [390, 844], [768, 900], [1280, 900], [1920, 1080]]) {
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
  const trendViewports = [];
  for (const [width, height] of [[360, 800], [390, 844], [768, 900], [1280, 900], [1920, 1080]]) {
    await command("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
    await command("Page.navigate", { url: `http://127.0.0.1:${serverPort}/frontier-benchmarks/index.html?benchmark=benchmark_terminal_bench_2_0` });
    const geometry = await waitFor(async () => {
      const result = await command("Runtime.evaluate", { expression: `(() => {
        const input = document.querySelector("#benchmark-picker-input");
        const lane = document.querySelector(".trends-lane");
        const markers = [...document.querySelectorAll(".trends-marker")];
        if (!input || !lane || markers.length !== 21) return null;
        const chipButton = document.querySelector(".trends-chip button");
        chipButton.scrollIntoView({ behavior: "instant", block: "center", inline: "nearest" });
        const chipBounds = chipButton.getBoundingClientRect();
        const markerBounds = markers.map((marker) => marker.getBoundingClientRect());
        return {
          overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          lanes: document.querySelectorAll(".trends-lane").length,
          markers: markers.length,
          occurrenceIds: new Set(markers.map((marker) => marker.dataset.occurrenceId)).size,
          chipTarget: {
            width: chipBounds.width,
            height: chipBounds.height,
            insideViewport: chipBounds.left >= 0 && chipBounds.top >= 0 && chipBounds.right <= innerWidth && chipBounds.bottom <= innerHeight,
            centerHit: document.elementFromPoint(chipBounds.left + chipBounds.width / 2, chipBounds.top + chipBounds.height / 2)?.closest("button") === chipButton,
          },
          inputTarget: input.getBoundingClientRect().height,
          minMarkerTarget: Math.min(...markerBounds.map((bounds) => bounds.height)),
          laneLabelWidth: lane.querySelector(".trends-lane-label").getBoundingClientRect().width,
          frameScrollable: document.querySelector(".trends-frame").scrollWidth >= document.querySelector(".trends-frame").clientWidth,
        };
      })()`, returnByValue: true });
      return result.result.value;
    }, `Terminal-Bench 2.0 trends at ${width}px`, 20000);
    assert.ok(geometry.overflow <= 0, `the ${width}px landing has no document-level horizontal overflow`);
    assert.deepEqual({ lanes: geometry.lanes, markers: geometry.markers, occurrenceIds: geometry.occurrenceIds }, { lanes: 1, markers: 21, occurrenceIds: 21 }, `the ${width}px default lane preserves all Terminal-Bench 2.0 occurrences`);
    assert.ok(geometry.chipTarget.width >= 44 && geometry.chipTarget.height >= 44, `the ${width}px selected-chip remove control is at least 44x44 CSS px`);
    assert.equal(geometry.chipTarget.insideViewport && geometry.chipTarget.centerHit, true, `the ${width}px selected-chip remove control is unclipped and not overlapped: ${JSON.stringify(geometry.chipTarget)}`);
    assert.ok(geometry.inputTarget >= 44 && geometry.minMarkerTarget >= 44, `the ${width}px picker and marker controls meet 44px touch targets`);
    assert.ok(geometry.laneLabelWidth >= 120, `the ${width}px lane label remains legible`);
    assert.equal(geometry.frameScrollable, true, `the ${width}px internal trend frame remains reachable`);
    await command("Runtime.evaluate", { expression: `document.querySelector(".trends-marker").click()` });
    const closeTarget = await waitFor(async () => {
      const result = await command("Runtime.evaluate", { expression: `(() => {
        const panel = document.querySelector("#trends-detail:not([hidden])");
        const close = panel?.querySelector(".detail-close");
        if (!close || document.activeElement !== close) return null;
        close.scrollIntoView({ behavior: "instant", block: "center", inline: "nearest" });
        const bounds = close.getBoundingClientRect();
        const panelBounds = panel.getBoundingClientRect();
        return {
          width: bounds.width,
          height: bounds.height,
          insideViewport: bounds.left >= 0 && bounds.top >= 0 && bounds.right <= innerWidth && bounds.bottom <= innerHeight,
          insidePanel: bounds.left >= panelBounds.left && bounds.top >= panelBounds.top && bounds.right <= panelBounds.right && bounds.bottom <= panelBounds.bottom,
          centerHit: document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2)?.closest("button") === close,
        };
      })()`, returnByValue: true });
      return result.result.value;
    }, `focused trend detail close control at ${width}px`);
    assert.ok(closeTarget.width >= 44 && closeTarget.height >= 44, `the ${width}px detail close control is at least 44x44 CSS px`);
    assert.equal(closeTarget.insideViewport && closeTarget.insidePanel && closeTarget.centerHit, true, `the ${width}px detail close control is unclipped and not overlapped: ${JSON.stringify(closeTarget)}`);
    trendViewports.push({ viewport: `${width}x${height}`, markers: geometry.markers, lanes: geometry.lanes, overflow: geometry.overflow, chipTarget: geometry.chipTarget, closeTarget });
  }

  const themeControlState = await command("Runtime.evaluate", { expression: `(() => {
    const root = document.documentElement;
    const toggle = document.querySelector(".theme-toggle");
    const beforePaper = getComputedStyle(root).getPropertyValue("--paper").trim();
    const beforePressed = toggle.getAttribute("aria-pressed");
    const before = { theme: root.dataset.theme || (beforePressed === "true" ? "dark" : "light"), pressed: beforePressed };
    toggle.click();
    const chip = document.querySelector(".trends-chip button").getBoundingClientRect();
    const close = document.querySelector(".detail-close").getBoundingClientRect();
    const after = { theme: root.dataset.theme, pressed: toggle.getAttribute("aria-pressed") };
    const colorsChanged = getComputedStyle(root).getPropertyValue("--paper").trim() !== beforePaper;
    toggle.click();
    return {
      before,
      after,
      restored: { theme: root.dataset.theme, pressed: toggle.getAttribute("aria-pressed") },
      colorsChanged,
      chip: { width: chip.width, height: chip.height },
      close: { width: close.width, height: close.height },
    };
  })()`, returnByValue: true });
  const themeControls = themeControlState.result.value;
  assert.notEqual(themeControls.after.theme, themeControls.before.theme, "theme toggle changes the explicit theme");
  assert.notEqual(themeControls.after.pressed, themeControls.before.pressed, "theme toggle changes its pressed state");
  assert.deepEqual(themeControls.restored, themeControls.before, "a second theme toggle restores the original theme state");
  assert.deepEqual({ colorsChanged: themeControls.colorsChanged, chip: themeControls.chip, close: themeControls.close }, { colorsChanged: true, chip: { width: 44, height: 44 }, close: { width: 44, height: 44 } }, "theme switching preserves both corrected touch targets");

  await command("Emulation.setDeviceMetricsOverride", { width: 768, height: 900, deviceScaleFactor: 1, mobile: false });
  await command("Page.navigate", { url: `http://127.0.0.1:${serverPort}/frontier-benchmarks/index.html?q=discard&lab=discard&benchmark=benchmark_terminal_bench_2_1&benchmark=unknown&benchmark=benchmark_terminal_bench` });
  const pickerContract = await waitFor(async () => {
    const result = await command("Runtime.evaluate", { expression: `(() => {
      const input = document.querySelector("#benchmark-picker-input");
      if (!input || document.querySelectorAll(".trends-lane").length !== 2) return null;
      input.focus();
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
      const listbox = document.querySelector("#benchmark-picker-options");
      const options = [...listbox.querySelectorAll('[role="option"]')];
      const active = document.getElementById(input.getAttribute("aria-activedescendant"));
      return {
        search: location.search,
        role: input.getAttribute("role"),
        expanded: input.getAttribute("aria-expanded"),
        controls: input.getAttribute("aria-controls"),
        active: input.getAttribute("aria-activedescendant"),
        optionCount: options.length,
        selectedOptions: options.filter((option) => option.getAttribute("aria-selected") === "true").length,
        listRole: listbox.getAttribute("role"),
        multiselect: listbox.getAttribute("aria-multiselectable"),
        activeVisible: active.offsetTop >= listbox.scrollTop && active.offsetTop + active.offsetHeight <= listbox.scrollTop + listbox.clientHeight + 1,
        optionTarget: options[0].getBoundingClientRect().height,
      };
    })()`, returnByValue: true });
    return result.result.value;
  }, "canonical trends picker", 20000);
  assert.equal(pickerContract.search, "?benchmark=benchmark_terminal_bench&benchmark=benchmark_terminal_bench_2_1", "initial state drops obsolete keys and canonicalizes repeated benchmark IDs");
  assert.deepEqual({ role: pickerContract.role, expanded: pickerContract.expanded, controls: pickerContract.controls, optionCount: pickerContract.optionCount, selectedOptions: pickerContract.selectedOptions, listRole: pickerContract.listRole, multiselect: pickerContract.multiselect, activeVisible: pickerContract.activeVisible }, { role: "combobox", expanded: "true", controls: "benchmark-picker-options", optionCount: 803, selectedOptions: 2, listRole: "listbox", multiselect: "true", activeVisible: true });
  assert.match(pickerContract.active, /^benchmark-option-benchmark_/);
  assert.ok(pickerContract.optionTarget >= 44, "picker options meet the minimum touch target");

  const finalInvariant = await command("Runtime.evaluate", { expression: `(() => {
    history.replaceState(null, "", "?benchmark=benchmark_terminal_bench_2_0");
    window.dispatchEvent(new PopStateEvent("popstate"));
    document.querySelector(".trends-chip button").click();
    return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve({ chips: document.querySelectorAll(".trends-chip").length, status: document.querySelector('[aria-live="polite"]').textContent, focus: document.activeElement.id }))));
  })()`, awaitPromise: true, returnByValue: true });
  assert.deepEqual(finalInvariant.result.value, { chips: 1, status: "Terminal-Bench 2.0 remains selected. Choose a replacement before removing the final benchmark.", focus: "benchmark-picker-input" });

  const pickerInteractions = await command("Runtime.evaluate", { expression: `(() => {
    const input = document.querySelector("#benchmark-picker-input");
    input.value = "Terminal-Bench 2.1";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    const option = document.querySelector('[role="option"][data-benchmark-id="benchmark_terminal_bench_2_1"]');
    option.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "touch" }));
    option.click();
    const afterAdd = { chips: document.querySelectorAll(".trends-chip").length, focus: document.activeElement.id, search: location.search };
    document.querySelector('.trends-chip button[data-remove-benchmark="benchmark_terminal_bench_2_0"]').click();
    return new Promise((resolve) => requestAnimationFrame(() => resolve({ afterAdd, afterRemove: { chips: document.querySelectorAll(".trends-chip").length, focusedChip: document.activeElement.dataset.removeBenchmark || "", search: location.search } })));
  })()`, awaitPromise: true, returnByValue: true });
  assert.deepEqual(pickerInteractions.result.value, {
    afterAdd: { chips: 2, focus: "benchmark-picker-input", search: "?benchmark=benchmark_terminal_bench_2_0&benchmark=benchmark_terminal_bench_2_1" },
    afterRemove: { chips: 1, focusedChip: "benchmark_terminal_bench_2_1", search: "?benchmark=benchmark_terminal_bench_2_1" },
  }, "touch selection, deterministic pushState, and nearest-chip focus use the same state rules");

  const escapeState = await command("Runtime.evaluate", { expression: `(() => {
    const input = document.querySelector("#benchmark-picker-input");
    input.focus();
    input.value = "no-such-benchmark";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    const empty = document.querySelector(".trends-option-empty").textContent;
    const before = location.search;
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    return { empty, before, after: location.search, expanded: input.getAttribute("aria-expanded"), query: input.value };
  })()`, returnByValue: true });
  assert.deepEqual(escapeState.result.value, { empty: "No benchmarks match this search.", before: "?benchmark=benchmark_terminal_bench_2_1", after: "?benchmark=benchmark_terminal_bench_2_1", expanded: "false", query: "no-such-benchmark" }, "Escape closes without hidden selection or query mutation");

  const backspaceState = await command("Runtime.evaluate", { expression: `(() => {
    const input = document.querySelector("#benchmark-picker-input");
    input.value = "Terminal-Bench 2.0";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    document.querySelector('[role="option"][data-benchmark-id="benchmark_terminal_bench_2_0"]').click();
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace", bubbles: true }));
    return { chips: [...document.querySelectorAll(".trends-chip")].map((chip) => chip.title), search: location.search, focus: document.activeElement.id };
  })()`, returnByValue: true });
  assert.deepEqual(backspaceState.result.value, { chips: ["Terminal-Bench 2.0"], search: "?benchmark=benchmark_terminal_bench_2_0", focus: "benchmark-picker-input" }, "Backspace on an empty input removes the final canonical chip only when another remains");

  await command("Runtime.evaluate", { expression: `document.querySelector("#benchmark-picker-input").focus()` });
  await command("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
  await command("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
  const tabState = await waitFor(async () => {
    const result = await command("Runtime.evaluate", { expression: `document.querySelector("#benchmark-picker-input").getAttribute("aria-expanded") === "false" && !document.querySelector("#trends-picker").contains(document.activeElement)`, returnByValue: true });
    return result.result.value;
  }, "Tab closes the picker");
  assert.equal(tabState, true);

  const capSearch = capBenchmarkIds.slice(0, 6).map((id) => `benchmark=${encodeURIComponent(id)}`).join("&");
  await command("Page.navigate", { url: `http://127.0.0.1:${serverPort}/frontier-benchmarks/index.html?${capSearch}` });
  const capState = await waitFor(async () => {
    const result = await command("Runtime.evaluate", { expression: `(() => {
      const input = document.querySelector("#benchmark-picker-input");
      if (!input || document.querySelectorAll(".trends-chip").length !== 6) return null;
      input.focus();
      input.value = ${JSON.stringify(production.benchmarks.find((benchmark) => benchmark.id === capBenchmarkIds[6]).name)};
      input.dispatchEvent(new Event("input", { bubbles: true }));
      document.querySelector('[role="option"][data-benchmark-id="${capBenchmarkIds[6]}"]').click();
      return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve({ chips: document.querySelectorAll(".trends-chip").length, status: document.querySelector('[aria-live="polite"]').textContent }))));
    })()`, awaitPromise: true, returnByValue: true });
    return result.result.value;
  }, "six-selection cap", 20000);
  assert.deepEqual(capState, { chips: 6, status: "Six benchmarks are already selected. Remove one before adding another." });

  await command("Page.navigate", { url: `http://127.0.0.1:${serverPort}/frontier-benchmarks/index.html?benchmark=zero_occurrence_fixture&fixture=ui` });
  const emptyState = await waitFor(async () => {
    const result = await command("Runtime.evaluate", { expression: `(() => {
      const empty = document.querySelector(".trends-empty");
      if (!empty) return null;
      return { heading: empty.querySelector("h3").textContent, lanes: document.querySelectorAll(".trends-lane").length, markers: document.querySelectorAll(".trends-marker").length };
    })()`, returnByValue: true });
    return result.result.value;
  }, "occurrence-backed empty state", 20000);
  assert.deepEqual(emptyState, { heading: "No reviewed occurrences", lanes: 1, markers: 0 });

  await command("Page.navigate", { url: `http://127.0.0.1:${serverPort}/frontier-benchmarks/index.html?benchmark=benchmark_terminal_bench&benchmark=benchmark_terminal_bench_2_0&benchmark=benchmark_terminal_bench_2_1` });
  const terminalMarkerCount = await waitFor(async () => {
    const result = await command("Runtime.evaluate", { expression: `document.querySelectorAll(".trends-marker").length`, returnByValue: true });
    return result.result.value === 38 ? result.result.value : null;
  }, "7/21/10 Terminal-Bench marks", 20000);
  assert.equal(terminalMarkerCount, 38, "three Terminal-Bench lanes expose exact 7/21/10 occurrence marks");

  await command("Page.navigate", { url: `http://127.0.0.1:${serverPort}/frontier-benchmarks/index.html?benchmark=reasoning_atlas&benchmark=code_harbor&fixture=ui` });
  const linkedRelease = await waitFor(async () => {
    const result = await command("Runtime.evaluate", { expression: `(() => {
      const markers = [...document.querySelectorAll(".trends-marker")];
      if (!markers.length) return null;
      const counts = markers.reduce((map, marker) => map.set(marker.dataset.releaseId, (map.get(marker.dataset.releaseId) || 0) + 1), new Map());
      const releaseId = [...counts].find(([, count]) => count > 1)?.[0];
      if (!releaseId) return null;
      const linked = markers.filter((marker) => marker.dataset.releaseId === releaseId);
      linked[0].focus();
      return { releaseId, linked: linked.length, highlighted: linked.filter((marker) => marker.classList.contains("is-highlighted")).length, labelsHaveModelAndRelease: linked.every((marker) => marker.getAttribute("aria-label").split(",").length >= 5) };
    })()`, returnByValue: true });
    return result.result.value;
  }, "linked fixture marks", 20000);
  assert.ok(linkedRelease.linked > 1 && linkedRelease.highlighted === linkedRelease.linked && linkedRelease.labelsHaveModelAndRelease, "focus links every same-release mark across lanes and labels model plus release");

  await command("Runtime.evaluate", { expression: `document.querySelector('.trends-marker[data-release-id="${linkedRelease.releaseId}"]').click()` });
  const trendDetail = await waitFor(async () => {
    const result = await command("Runtime.evaluate", { expression: `(() => {
      const panel = document.querySelector("#trends-detail:not([hidden])");
      if (!panel || document.activeElement !== panel.querySelector(".detail-close")) return null;
      return { title: panel.querySelector("h2").textContent, bylineParts: panel.querySelector(".detail-byline").textContent.split(" · ").length, benchmarks: panel.querySelectorAll(".trends-detail-benchmarks li").length, sources: [...panel.querySelectorAll(".trends-detail-sources a")].map((link) => ({ text: link.textContent, href: link.href, rel: link.rel })) };
    })()`, returnByValue: true });
    return result.result.value;
  }, "accessible trend detail");
  assert.ok(trendDetail.title && trendDetail.bylineParts === 3 && trendDetail.benchmarks > 1 && trendDetail.sources.length === trendDetail.benchmarks);
  assert.ok(trendDetail.sources.every((source) => /^Source \d+$/.test(source.text) && source.href.startsWith("https://") && source.rel === "noopener noreferrer"));

  const layeredEscape = await command("Runtime.evaluate", { expression: `(() => {
    const input = document.querySelector("#benchmark-picker-input");
    input.focus();
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    return { pickerExpanded: input.getAttribute("aria-expanded"), detailOpen: !document.querySelector("#trends-detail").hidden, focus: document.activeElement.id };
  })()`, returnByValue: true });
  assert.deepEqual(layeredEscape.result.value, { pickerExpanded: "false", detailOpen: true, focus: "benchmark-picker-input" }, "picker Escape consumes one layer without closing pinned detail or moving focus");
  await command("Runtime.evaluate", { expression: `document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))` });
  const restoredFocus = await waitFor(async () => {
    const result = await command("Runtime.evaluate", { expression: `document.querySelector("#trends-detail").hidden && document.activeElement?.dataset.releaseId === "${linkedRelease.releaseId}"`, returnByValue: true });
    return result.result.value;
  }, "detail Escape focus restoration");
  assert.equal(restoredFocus, true);

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

  assert.deepEqual(browserErrors, [], "trends, Releases, and data-route browser coverage has no runtime, console, network, or HTTP errors");
  console.log(JSON.stringify({ result: "PASS", browserErrors: browserErrors.length, pickerOptions: pickerContract.optionCount, terminalMarkers: terminalMarkerCount, detailSources: trendDetail.sources.length, focusRestored: restoredFocus, historyAutoSearch: historySearch.empty, themeControlState: themeControlState.result.value, releaseViewports: geometries.map((geometry) => `${geometry.viewport}:172/6/bounded/latest`), trendViewports }));
  socket.close();
} finally {
  if (browser) {
    const exited = browser.exitCode === null ? new Promise((resolveExit) => browser.once("exit", resolveExit)) : Promise.resolve();
    browser.kill();
    await Promise.race([exited, sleep(2000)]);
  }
  if (profile) await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  await closeServer();
}
