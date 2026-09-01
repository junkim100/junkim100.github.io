import {
  SETUP_FIELDS,
  datePosition,
  disclosureText,
  formatDate,
  indexData,
  matchingBenchmarkIds,
  normalize,
  orderedReleaseOccurrences,
  revisionText,
  statusesForOccurrence,
  timelineTicks,
  validateInterface,
} from "./core.mjs";

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const labColors = ["#2948d7", "#9a3f19", "#18755b", "#7c3ea2", "#9b6511", "#b02458"];
const labShapes = ["50%", "2px", "35% 65% 35% 65%", "0 50% 50% 50%", "20%", "50% 10% 50% 10%"];
let indexed;
let timelineZoom = 1;
let activeDialogTrigger = null;

function element(tag, options = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(options)) {
    if (value == null) continue;
    if (key === "className") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key === "dataset") Object.assign(node.dataset, value);
    else if (key === "style") Object.assign(node.style, value);
    else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2).toLowerCase(), value);
    else node.setAttribute(key, value);
  }
  for (const child of Array.isArray(children) ? children : [children]) {
    if (child != null) node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

function replaceChildren(target, children = []) {
  target.replaceChildren(...children);
  return target;
}

function setupTheme() {
  const button = $(".theme-toggle");
  if (!button) return;
  const isDark = () => document.documentElement.dataset.theme === "dark" ||
    (!document.documentElement.dataset.theme && matchMedia("(prefers-color-scheme: dark)").matches);
  button.setAttribute("aria-pressed", String(isDark()));
  button.addEventListener("click", () => {
    const next = isDark() ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    button.setAttribute("aria-pressed", String(next === "dark"));
    try { localStorage.setItem("theme", next); } catch (_) {}
  });
}

function setLoadState(message, type = "loading") {
  const panel = $("#load-state");
  if (!panel) return;
  panel.hidden = type === "ready";
  panel.classList.toggle("error", type === "error");
  panel.setAttribute("aria-busy", String(type === "loading"));
  if (type !== "ready") {
    const content = [element("span", { className: "state-mark", "aria-hidden": "true" }), element("p", { text: message })];
    if (type === "error") content.push(element("button", { className: "button", type: "button", text: "Retry", onclick: () => location.reload() }));
    replaceChildren(panel, content);
  }
}

async function loadData() {
  const params = new URLSearchParams(location.search);
  const fixtureRequested = params.get("fixture") === "ui" && ["localhost", "127.0.0.1"].includes(location.hostname);
  if (fixtureRequested) {
    const module = await import("./tests/ui/fixture.mjs");
    return validateInterface(module.fixture);
  }
  const response = await fetch("./public/observatory.json", { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`Generated ledger request failed with HTTP ${response.status}.`);
  return validateInterface(await response.json());
}

function populateStats(data) {
  $("#stat-window").textContent = `${data.corpus.publication_window.start} to ${data.corpus.publication_window.end}, inclusive`;
  $("#stat-labs").textContent = String(data.labs.length);
  $("#stat-releases").textContent = String(data.releases.length);
  $("#stat-occurrences").textContent = String(data.occurrences.length);
}

function setupFilters(data) {
  const params = new URLSearchParams(location.search);
  const query = $("#benchmark-filter");
  const category = $("#category-filter");
  const from = $("#from-date");
  const to = $("#to-date");
  query.value = params.get("q") || "";
  from.min = to.min = data.corpus.publication_window.start;
  from.max = to.max = data.corpus.publication_window.end;
  from.value = params.get("from") || data.corpus.publication_window.start;
  to.value = params.get("to") || data.corpus.publication_window.end;
  timelineZoom = Math.max(1, Math.min(3, Number(params.get("zoom")) || 1));

  replaceChildren($("#benchmark-options"), data.benchmarks.flatMap((benchmark) => [
    element("option", { value: benchmark.name }),
    ...(benchmark.aliases || []).map((alias) => element("option", { value: alias })),
  ]));
  for (const item of data.categories) category.append(element("option", { value: item.id, text: item.name }));
  category.value = params.get("category") || "";

  $("#filters").addEventListener("submit", (event) => {
    event.preventDefault();
    if (from.value > to.value) {
      $("#filter-summary").textContent = "The inclusive start date must not be later than the end date.";
      from.focus();
      return;
    }
    serializeTimelineState();
    renderTimeline();
  });
  $("#reset-filters").addEventListener("click", () => {
    query.value = "";
    category.value = "";
    from.value = data.corpus.publication_window.start;
    to.value = data.corpus.publication_window.end;
    timelineZoom = 1;
    serializeTimelineState();
    renderTimeline();
  });
  $("#zoom-in").addEventListener("click", () => {
    timelineZoom = Math.min(3, timelineZoom + 0.5);
    serializeTimelineState();
    renderTimeline(true);
  });
  $("#zoom-out").addEventListener("click", () => {
    timelineZoom = Math.max(1, timelineZoom - 0.5);
    serializeTimelineState();
    renderTimeline(true);
  });
}

function serializeTimelineState() {
  const params = new URLSearchParams(location.search);
  const fields = {
    q: $("#benchmark-filter").value.trim(),
    category: $("#category-filter").value,
    from: $("#from-date").value,
    to: $("#to-date").value,
    zoom: timelineZoom === 1 ? "" : String(timelineZoom),
  };
  for (const [key, value] of Object.entries(fields)) value ? params.set(key, value) : params.delete(key);
  history.replaceState(null, "", `${location.pathname}${params.size ? `?${params}` : ""}${location.hash}`);
}

function renderTimeline(preserveScroll = false) {
  const frame = $("#timeline-frame");
  const previousRatio = preserveScroll && frame.scrollWidth > frame.clientWidth
    ? frame.scrollLeft / (frame.scrollWidth - frame.clientWidth)
    : 0;
  const start = $("#from-date").value;
  const end = $("#to-date").value;
  const query = $("#benchmark-filter").value;
  const categoryId = $("#category-filter").value;
  const matchingIds = matchingBenchmarkIds(indexed, query, categoryId);
  const activeFilter = Boolean(normalize(query) || categoryId);
  const releasesInRange = indexed.data.releases.filter((release) => release.publication_date >= start && release.publication_date <= end);
  const matchingOccurrenceCount = indexed.data.occurrences.filter((occurrence) =>
    occurrence.publication_date >= start && occurrence.publication_date <= end && matchingIds.has(occurrence.benchmark_id),
  ).length;

  const canvas = element("div", {
    className: "timeline-canvas",
    style: { width: "100%", minWidth: `${Math.round(1120 * timelineZoom)}px` },
  });
  const axis = element("div", { className: "timeline-axis", "aria-hidden": "true" });
  for (const tick of timelineTicks(start, end, timelineZoom > 1.5 ? 12 : 8)) {
    axis.append(element("span", {
      className: "axis-tick",
      style: { left: `${datePosition(tick, start, end)}%` },
    }, element("span", { text: formatDate(tick) })));
  }
  canvas.append(axis);

  indexed.data.labs.forEach((lab, labIndex) => {
    const labReleases = releasesInRange
      .filter((release) => release.lab_id === lab.id)
      .sort((a, b) => a.publication_date.localeCompare(b.publication_date) || a.name.localeCompare(b.name));
    const lane = element("div", {
      className: "timeline-lane",
      style: { "--lab-color": labColors[labIndex % labColors.length], "--lab-shape": labShapes[labIndex % labShapes.length] },
    });
    lane.append(element("div", { className: "lab-label" }, [
      element("span", { className: "lab-code", text: `L${labIndex + 1}`, "aria-hidden": "true" }),
      element("span", { text: lab.name }),
    ]));
    const track = element("div", { className: "lab-track" });
    labReleases.forEach((release, releaseIndex) => {
      const allOccurrences = orderedReleaseOccurrences(indexed, release.id);
      const shownOccurrences = orderedReleaseOccurrences(indexed, release.id, activeFilter ? matchingIds : null);
      const muted = activeFilter && shownOccurrences.length === 0;
      const position = datePosition(release.publication_date, start, end);
      const edgeClass = position < 8 ? " edge-start" : position > 92 ? " edge-end" : "";
      const point = element("div", {
        className: `release-point${muted ? " is-muted" : ""}${edgeClass}`,
        style: { left: `${position}%` },
      });
      const node = element("button", {
        className: "release-node",
        type: "button",
        "aria-haspopup": "dialog",
        "aria-expanded": "false",
        "aria-label": `${release.name}, ${formatDate(release.publication_date)}. Open ${allOccurrences.length} evidence occurrence${allOccurrences.length === 1 ? "" : "s"}.`,
        style: { top: `${0.55 + (releaseIndex % 2) * 1.15}rem` },
      }, [element("span", { text: release.name }), element("span", { className: "release-date", text: formatDate(release.publication_date) })]);
      node.addEventListener("mouseenter", () => previewRelease(release));
      node.addEventListener("focus", () => previewRelease(release));
      node.addEventListener("click", () => openReleaseDialog(release, node));
      point.append(node);
      const stack = element("div", { className: "benchmark-stack", style: { top: `${4 + (releaseIndex % 2) * 1.15}rem` } });
      shownOccurrences.slice(0, 3).forEach((occurrence) => stack.append(element("span", {
        className: "benchmark-label",
        text: indexed.benchmarks.get(occurrence.benchmark_id).name,
      })));
      if (shownOccurrences.length > 3) {
        stack.append(element("button", {
          className: "overflow-button",
          type: "button",
          text: `+${shownOccurrences.length - 3} more`,
          "aria-label": `Open all ${shownOccurrences.length} matching occurrences for ${release.name}`,
          onclick: () => openReleaseDialog(release, node),
        }));
      }
      point.append(stack);
      track.append(point);
    });
    lane.append(track);
    canvas.append(lane);
  });

  replaceChildren($("#timeline-chart"), [canvas]);
  $("#timeline-empty").hidden = !activeFilter || matchingOccurrenceCount > 0;
  const filterText = activeFilter ? `${matchingOccurrenceCount} matching occurrence${matchingOccurrenceCount === 1 ? "" : "s"}; ` : "";
  $("#filter-summary").textContent = `${filterText}${releasesInRange.length} named releases across ${indexed.data.labs.length} labeled lab lines, ${formatDate(start)} through ${formatDate(end)}, inclusive.`;
  $("#zoom-label").textContent = timelineZoom === 1 ? "Standard scale" : `${timelineZoom.toFixed(1)}× detail`;
  requestAnimationFrame(() => {
    if (preserveScroll && frame.scrollWidth > frame.clientWidth) frame.scrollLeft = previousRatio * (frame.scrollWidth - frame.clientWidth);
  });
}

function previewRelease(release) {
  const lab = indexed.labs.get(release.lab_id);
  const coverage = indexed.coverage.get(release.coverage_id);
  const count = (indexed.occurrencesByRelease.get(release.id) || []).length;
  replaceChildren($("#release-inspector"), [
    element("p", { className: "kicker", text: "Release preview" }),
    element("p", { className: "inspector-title", text: release.name }),
    element("p", { className: "inspector-meta", text: `${lab.name} · ${formatDate(release.publication_date)} · ${coverage?.review_status || "coverage unavailable"} source review · ${count} named occurrence${count === 1 ? "" : "s"}` }),
  ]);
}

function occurrenceDetail(occurrence) {
  const benchmark = indexed.benchmarks.get(occurrence.benchmark_id);
  const source = indexed.sources.get(occurrence.source_id);
  const statuses = statusesForOccurrence(indexed, occurrence);
  const statusLabels = statuses.map((id) => indexed.definitions.get(id)?.label || id.replaceAll("_", " ")).join(", ") || "Verified occurrence";
  const setup = element("ul", { className: "setup-list" });
  SETUP_FIELDS.forEach(([key, label]) => setup.append(element("li", { text: `${label}: ${disclosureText(occurrence.evaluation_setup[key])}` })));
  return element("article", { className: "dialog-record" }, [
    element("h3", { text: benchmark.name }),
    element("p", { text: occurrence.summary }),
    element("dl", { className: "meta-grid" }, [
      meta("Reporting state", statusLabels),
      meta("Review state", occurrence.review_status.replaceAll("_", " ")),
      meta("Source type", occurrence.source_type.replaceAll("_", " ")),
      meta("Revision", revisionText(source.revision)),
      meta("Locator", `${occurrence.locator.kind}: ${occurrence.locator.value}`),
      meta("Record", occurrence.id),
    ]),
    element("h4", { text: "Evaluation setup" }),
    setup,
    element("p", {}, element("a", { href: source.url, target: "_blank", rel: "noopener noreferrer", text: "Open exact first-party source ↗" })),
  ]);
}

function meta(label, value) {
  return element("div", {}, [element("dt", { text: label }), element("dd", { text: value })]);
}

function openReleaseDialog(release, trigger) {
  const dialog = $("#detail-dialog");
  const occurrences = orderedReleaseOccurrences(indexed, release.id);
  activeDialogTrigger?.setAttribute("aria-expanded", "false");
  activeDialogTrigger = trigger;
  trigger?.setAttribute("aria-expanded", "true");
  $("#dialog-title").textContent = release.name;
  const intro = element("p", { text: `${indexed.labs.get(release.lab_id).name} · ${formatDate(release.publication_date)} · ${occurrences.length} verified occurrence${occurrences.length === 1 ? "" : "s"} in reviewed public reporting.` });
  const content = [intro];
  if (occurrences.length) content.push(...occurrences.map(occurrenceDetail));
  else content.push(element("p", { text: "No qualifying benchmark occurrence was found in this release’s reviewed source bundle. This is not evidence that the lab did not run an evaluation." }));
  replaceChildren($("#dialog-content"), content);
  dialog.showModal();
  $("#close-dialog").focus();
}

function setupDialog() {
  const dialog = $("#detail-dialog");
  const close = () => dialog.close();
  $("#close-dialog").addEventListener("click", close);
  dialog.addEventListener("click", (event) => { if (event.target === dialog) close(); });
  dialog.addEventListener("close", () => {
    activeDialogTrigger?.setAttribute("aria-expanded", "false");
    activeDialogTrigger?.focus();
    activeDialogTrigger = null;
  });
}

function renderLedger() {
  const rows = [...indexed.data.releases]
    .sort((a, b) => b.publication_date.localeCompare(a.publication_date) || a.name.localeCompare(b.name))
    .map((release) => {
      const coverage = indexed.coverage.get(release.coverage_id);
      const lineage = indexed.lineages.get(release.lineage_id);
      const occurrenceCount = (indexed.occurrencesByRelease.get(release.id) || []).length;
      const row = element("tr");
      [
        element("time", { datetime: release.publication_date, text: formatDate(release.publication_date) }),
        indexed.labs.get(release.lab_id).name,
        release.name,
        lineage?.name || release.lineage_id,
        `${release.modality_class.replaceAll("_", " ")} · ${release.use_class}`,
      ].forEach((value) => row.append(element("td", {}, value)));
      row.append(element("td", {}, element("span", { className: `status ${coverage?.review_status || "incomplete"}`, text: coverage?.review_status || "unavailable" })));
      row.append(element("td", { text: String(occurrenceCount) }));
      return row;
    });
  replaceChildren($("#ledger-body"), rows);
}

function renderHistory(benchmarkId) {
  const benchmark = indexed.benchmarks.get(benchmarkId);
  const statuses = indexed.data.derived_statuses
    .filter((status) => status.benchmark_id === benchmarkId)
    .sort((a, b) => a.publication_date.localeCompare(b.publication_date) || a.release_id.localeCompare(b.release_id));
  const list = element("div", { className: "history-list" });
  if (!statuses.length) {
    list.append(element("p", { text: `No reviewed public-reporting sequence is present for ${benchmark.name}.` }));
  } else {
    statuses.forEach((status) => {
      const labels = status.status_ids.map((id) => indexed.definitions.get(id)?.label || id.replaceAll("_", " ")).join(" · ");
      list.append(element("article", { className: "history-item" }, [
        element("time", { datetime: status.publication_date, text: formatDate(status.publication_date) }),
        element("strong", { text: `${indexed.labs.get(status.lab_id).name} · ${indexed.releases.get(status.release_id).name}` }),
        element("span", { className: "history-state", text: labels }),
      ]));
    });
  }
  replaceChildren($("#history-content"), [list]);
}

function setupHistory() {
  const select = $("#history-benchmark");
  const benchmarks = [...indexed.data.benchmarks].sort((a, b) => a.name.localeCompare(b.name));
  replaceChildren(select, benchmarks.map((benchmark) => element("option", { value: benchmark.id, text: benchmark.name })));
  select.addEventListener("change", () => renderHistory(select.value));
  if (benchmarks.length) renderHistory(benchmarks[0].id);
}

function renderEvidence() {
  const cards = [...indexed.data.occurrences]
    .sort((a, b) => b.publication_date.localeCompare(a.publication_date) || a.id.localeCompare(b.id))
    .map((occurrence) => {
      const benchmark = indexed.benchmarks.get(occurrence.benchmark_id);
      const release = indexed.releases.get(occurrence.release_id);
      const source = indexed.sources.get(occurrence.source_id);
      const details = element("details", { className: "evidence-card" });
      details.append(element("summary", {}, [
        element("strong", { text: benchmark.name }),
        element("span", { text: `${indexed.labs.get(occurrence.lab_id).name} · ${release.name}` }),
        element("time", { datetime: occurrence.publication_date, text: formatDate(occurrence.publication_date) }),
      ]));
      const body = element("div", { className: "evidence-body" }, [
        element("p", { text: occurrence.summary }),
        element("dl", { className: "meta-grid" }, [
          meta("Revision", revisionText(source.revision)),
          meta("Locator", `${occurrence.locator.kind}: ${occurrence.locator.value}`),
          meta("Review state", occurrence.review_status.replaceAll("_", " ")),
        ]),
        element("p", {}, element("a", { href: source.url, target: "_blank", rel: "noopener noreferrer", text: "Open exact first-party source ↗" })),
      ]);
      details.append(body);
      return details;
    });
  replaceChildren($("#evidence-list"), cards.length ? cards : [element("p", { text: "No verified occurrence records are present in this generated ledger." })]);
}

function renderCoverage() {
  const grid = element("div", { className: "coverage-grid" });
  indexed.data.labs.forEach((lab) => {
    const records = indexed.data.coverage.filter((item) => item.lab_id === lab.id);
    const complete = records.filter((item) => item.review_status === "complete").length;
    const quarantined = indexed.data.quarantine.filter((item) => item.lab_id === lab.id).length;
    grid.append(element("div", {}, [
      element("strong", { text: lab.name }),
      element("span", { text: `${complete} complete of ${records.length} release reviews · ${quarantined} quarantined candidate${quarantined === 1 ? "" : "s"}` }),
    ]));
  });
  replaceChildren($("#coverage-summary"), [grid]);
}

function renderCompleteTable() {
  const rows = [...indexed.data.occurrences]
    .sort((a, b) => a.publication_date.localeCompare(b.publication_date) || a.id.localeCompare(b.id))
    .map((occurrence) => {
      const benchmark = indexed.benchmarks.get(occurrence.benchmark_id);
      const category = indexed.categories.get(benchmark.category_id);
      const release = indexed.releases.get(occurrence.release_id);
      const source = indexed.sources.get(occurrence.source_id);
      const row = element("tr");
      [
        element("time", { datetime: occurrence.publication_date, text: formatDate(occurrence.publication_date) }),
        indexed.labs.get(occurrence.lab_id).name,
        release.name,
        benchmark.name,
        category?.name || benchmark.category_id,
        statusesForOccurrence(indexed, occurrence).map((id) => indexed.definitions.get(id)?.label || id).join(", ") || occurrence.review_status,
      ].forEach((value) => row.append(element("td", {}, value)));
      row.append(element("td", {}, element("a", { href: source.url, target: "_blank", rel: "noopener noreferrer", text: `${occurrence.locator.kind}: ${occurrence.locator.value} ↗` })));
      return row;
    });
  replaceChildren($("#occurrence-table-body"), rows);
}

function renderDefinitions(data) {
  $("#definitions-version").textContent = data.definitions_version;
  const definitions = data.canonical_definitions.map((definition) => {
    const algorithm = `${definition.algorithm.kind.replaceAll("_", " ")} · scope: ${definition.algorithm.comparable_scope.replaceAll("_", " ")} · omission count: ${definition.algorithm.omission_count}`;
    return element("article", { className: "definition-card", id: definition.id }, [
      element("div", {}, [element("h3", { text: definition.label }), element("span", { className: "algorithm", text: algorithm })]),
      element("div", { className: "definition-detail" }, [
        element("p", { text: definition.description }),
        element("h4", { text: "Example" }),
        element("ul", {}, definition.examples.map((item) => element("li", { text: item }))),
        ...definition.cautions.map((item) => element("p", { className: "caution", text: item })),
        element("p", { className: "version-line", text: `Term version ${definition.version}` }),
      ]),
    ]);
  });
  replaceChildren($("#definition-list"), definitions);
}

function renderObservatory(data) {
  indexed = indexData(data);
  populateStats(data);
  setupFilters(data);
  setupDialog();
  renderTimeline();
  renderLedger();
  setupHistory();
  renderEvidence();
  renderCoverage();
  renderCompleteTable();
}

async function initialize() {
  setupTheme();
  setLoadState("Loading the validated generated ledger…");
  try {
    const data = await loadData();
    if (document.body.dataset.page === "definitions") renderDefinitions(data);
    else renderObservatory(data);
    setLoadState("", "ready");
  } catch (error) {
    console.error("Observatory initialization failed", error);
    setLoadState("The generated ledger could not be loaded. The data downloads and methodology remain available.", "error");
  }
}

initialize();
