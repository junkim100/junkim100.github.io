import { byId, formatDate, indexData, revisionText, validateInterface } from "./core.mjs";

export const PAGE_SIZES = [25, 50, 100];
export const DEFAULT_PAGE_SIZE = 50;

const ROUTES = {
  ledger: { defaultSort: "date", sorts: ["date", "name", "lab", "coverage"] },
  history: { defaultSort: "date", sorts: ["date", "benchmark", "release", "status", "lab"] },
  evidence: { defaultSort: "date", sorts: ["date", "source", "benchmark", "release", "lab"] },
};

function element(name, attributes = {}, children = []) {
  const node = document.createElement(name);
  for (const [key, value] of Object.entries(attributes)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === "text") node.textContent = String(value);
    else if (key === "className") node.className = String(value);
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else if (value === true) node.setAttribute(key, "");
    else node.setAttribute(key, String(value));
  }
  for (const child of Array.isArray(children) ? children : [children]) {
    if (child !== null && child !== undefined) node.append(child);
  }
  return node;
}

function normalizedText(value) {
  return String(value || "").toLocaleLowerCase("en");
}

export function safeSourceHref(indexed, source) {
  try {
    const url = new URL(source?.url);
    const lab = indexed.labs.get(source?.lab_id);
    const host = url.hostname.toLowerCase().replace(/\.$/, "");
    const allowed = lab?.official_domains || [];
    return url.protocol === "https:" && !url.username && !url.password
      && allowed.some((domain) => host === domain || host.endsWith(`.${domain}`))
      ? url.href
      : null;
  } catch (_) {
    return null;
  }
}

function safePage(value) {
  const page = Number.parseInt(value, 10);
  return Number.isSafeInteger(page) && page > 0 ? page : 1;
}

export function parseRouteState(route, search = "") {
  const config = ROUTES[route];
  if (!config) throw new Error(`Unsupported data route: ${route}`);
  const params = new URLSearchParams(search);
  const sort = params.get("sort");
  const direction = params.get("dir");
  const size = Number.parseInt(params.get("size") || "", 10);
  return {
    query: (params.get("q") || "").trim().slice(0, 200),
    lab: (params.get("lab") || "").trim(),
    status: (params.get("status") || "").trim(),
    sort: config.sorts.includes(sort) ? sort : config.defaultSort,
    direction: direction === "asc" || direction === "desc" ? direction : "desc",
    pageSize: PAGE_SIZES.includes(size) ? size : DEFAULT_PAGE_SIZE,
    page: safePage(params.get("page")),
    view: route === "evidence" && params.get("view") === "occurrences" ? "occurrences" : "sources",
  };
}

export function paginate(records, page, pageSize) {
  const totalPages = Math.max(1, Math.ceil(records.length / pageSize));
  const currentPage = Math.min(Math.max(1, page), totalPages);
  const start = (currentPage - 1) * pageSize;
  return { currentPage, totalPages, start, rows: records.slice(start, start + pageSize) };
}

function canonicalSearch(route, state) {
  const params = new URLSearchParams();
  const config = ROUTES[route];
  if (state.query) params.set("q", state.query);
  if (state.lab) params.set("lab", state.lab);
  if (state.status) params.set("status", state.status);
  if (state.sort !== config.defaultSort) params.set("sort", state.sort);
  if (state.direction !== "desc") params.set("dir", state.direction);
  if (state.pageSize !== DEFAULT_PAGE_SIZE) params.set("size", String(state.pageSize));
  if (state.page > 1) params.set("page", String(state.page));
  if (route === "evidence" && state.view !== "sources") params.set("view", state.view);
  const query = params.toString();
  return query ? `?${query}` : "";
}

function updateRoute(route, state, changes = {}) {
  const next = { ...state, ...changes };
  const url = new URL(window.location.href);
  url.search = canonicalSearch(route, next);
  history.pushState({}, "", url);
  return next;
}

async function loadData() {
  const params = new URLSearchParams(window.location.search);
  if (params.get("fixture") === "ui") {
    const { fixture } = await import("./tests/ui/fixture.mjs");
    return fixture;
  }
  const response = await fetch("./public/observatory.json", { cache: "no-store" });
  if (!response.ok) throw new Error(`Generated ledger request failed with HTTP ${response.status}.`);
  return response.json();
}

function sortRecords(records, key, direction) {
  const factor = direction === "asc" ? 1 : -1;
  return [...records].sort((left, right) => {
    const primary = String(left.sortValues[key] || "").localeCompare(String(right.sortValues[key] || ""), "en", { sensitivity: "base", numeric: true });
    if (primary) return primary * factor;
    return String(left.id).localeCompare(String(right.id), "en") * factor;
  });
}

function filterRecords(records, state) {
  const query = normalizedText(state.query);
  return records
    .filter((record) => !state.lab || record.labId === state.lab)
    .filter((record) => !state.status || record.statusIds.includes(state.status))
    .filter((record) => !query || normalizedText(record.searchText).includes(query));
}

function releaseRecords(indexed) {
  const coverage = byId(indexed.data.coverage);
  return indexed.data.releases.map((release) => {
    const review = coverage.get(release.coverage_id);
    const lab = indexed.labs.get(release.lab_id);
    const occurrences = indexed.occurrencesByRelease.get(release.id) || [];
    const coverageText = review?.review_status?.replaceAll("_", " ") || "unavailable";
    return {
      id: release.id,
      labId: release.lab_id,
      statusIds: [review?.review_status || "unavailable"],
      searchText: [release.id, release.name, lab?.name, release.publication_date, coverageText].join(" "),
      sortValues: { date: release.publication_date, name: release.name, lab: lab?.name || release.lab_id, coverage: coverageText },
      cells: [formatDate(release.publication_date), lab?.name || release.lab_id, release.name, coverageText, String(occurrences.length)],
    };
  });
}

function historyRecords(indexed) {
  return indexed.data.derived_statuses.map((status) => {
    const benchmark = indexed.benchmarks.get(status.benchmark_id);
    const release = indexed.releases.get(status.release_id);
    const lab = indexed.labs.get(status.lab_id);
    const labels = status.status_ids.map((id) => indexed.definitions.get(id)?.label || id.replaceAll("_", " "));
    return {
      id: status.id,
      labId: status.lab_id,
      statusIds: status.status_ids,
      searchText: [status.id, benchmark?.name, release?.name, lab?.name, labels.join(" "), status.publication_date].join(" "),
      sortValues: { date: status.publication_date, benchmark: benchmark?.name || status.benchmark_id, release: release?.name || status.release_id, status: labels.join(" "), lab: lab?.name || status.lab_id },
      cells: [formatDate(status.publication_date), lab?.name || status.lab_id, benchmark?.name || status.benchmark_id, release?.name || status.release_id, labels.join(", ")],
    };
  });
}

function sourceRecords(indexed) {
  const occurrenceCounts = new Map();
  for (const occurrence of indexed.data.occurrences) {
    occurrenceCounts.set(occurrence.source_id, (occurrenceCounts.get(occurrence.source_id) || 0) + 1);
  }
  return indexed.data.sources.map((source) => {
    const lab = indexed.labs.get(source.lab_id);
    const revision = revisionText(source.revision);
    return {
      id: source.id,
      labId: source.lab_id,
      statusIds: [source.source_type],
      searchText: [source.id, source.url, source.source_type, lab?.name, source.publication_date, revision].join(" "),
      sortValues: { date: source.publication_date, source: source.url, benchmark: "", release: "", lab: lab?.name || source.lab_id },
      cells: [formatDate(source.publication_date), lab?.name || source.lab_id, source.source_type.replaceAll("_", " "), revision, String(occurrenceCounts.get(source.id) || 0)],
      href: safeSourceHref(indexed, source),
    };
  });
}

function occurrenceRecords(indexed) {
  return indexed.data.occurrences.map((occurrence) => {
    const benchmark = indexed.benchmarks.get(occurrence.benchmark_id);
    const release = indexed.releases.get(occurrence.release_id);
    const lab = indexed.labs.get(occurrence.lab_id);
    const source = indexed.sources.get(occurrence.source_id);
    return {
      id: occurrence.id,
      labId: occurrence.lab_id,
      statusIds: [occurrence.review_status],
      searchText: [occurrence.id, benchmark?.name, release?.name, lab?.name, occurrence.summary, occurrence.locator?.kind, occurrence.locator?.value, source?.url].join(" "),
      sortValues: { date: occurrence.publication_date, source: source?.url || occurrence.source_id, benchmark: benchmark?.name || occurrence.benchmark_id, release: release?.name || occurrence.release_id, lab: lab?.name || occurrence.lab_id },
      cells: [formatDate(occurrence.publication_date), lab?.name || occurrence.lab_id, benchmark?.name || occurrence.benchmark_id, release?.name || occurrence.release_id, `${occurrence.locator?.kind || "locator"}: ${occurrence.locator?.value || "unavailable"}`, occurrence.review_status.replaceAll("_", " ")],
      href: safeSourceHref(indexed, source),
    };
  });
}

export function recordsForRoute(route, indexed, state) {
  if (route === "ledger") return releaseRecords(indexed);
  if (route === "history") return historyRecords(indexed);
  if (route === "evidence") return state.view === "occurrences" ? occurrenceRecords(indexed) : sourceRecords(indexed);
  throw new Error(`Unsupported data route: ${route}`);
}

function headersFor(route, view) {
  if (route === "ledger") return ["Date", "Lab", "Release", "Coverage", "Occurrences"];
  if (route === "history") return ["Date", "Lab", "Benchmark", "Release", "Reporting status"];
  if (view === "sources") return ["Date", "Lab", "Source type", "Revision", "Occurrences"];
  return ["Date", "Lab", "Benchmark", "Release", "Locator", "Review state"];
}

function selectField(name, label, value, options, onChange) {
  const select = element("select", { id: `route-${name}`, name, onChange });
  for (const [optionValue, optionLabel] of options) {
    select.append(element("option", { value: optionValue, text: optionLabel, selected: optionValue === value }));
  }
  return element("p", { className: "field" }, [element("label", { for: `route-${name}`, text: label }), select]);
}

function renderControls(route, state, indexed, rerender) {
  const controls = document.querySelector(`[data-route-controls="${route}"]`);
  const labs = [...indexed.labs.values()].sort((left, right) => left.name.localeCompare(right.name, "en"));
  const statusOptions = route === "history"
    ? [...indexed.definitions.values()].map((definition) => [definition.id, definition.label])
    : route === "evidence" && state.view === "sources"
      ? [...new Set(indexed.data.sources.map((source) => source.source_type))].sort().map((value) => [value, value.replaceAll("_", " ")])
      : route === "evidence" ? [["verified", "Verified"]] : [["complete", "Complete"], ["incomplete", "Incomplete"]];
  const config = ROUTES[route];
  const form = element("form", { className: "route-filter-panel", onsubmit: (event) => {
    event.preventDefault();
    const query = new FormData(form).get("q")?.toString().trim().slice(0, 200) || "";
    rerender(updateRoute(route, state, { query, page: 1 }));
  } });
  const input = element("input", { id: "route-query", name: "q", type: "search", value: state.query, maxlength: 200, autocomplete: "off", placeholder: "Search this view" });
  form.append(element("p", { className: "field field-search" }, [element("label", { for: "route-query", text: "Search" }), input]));
  form.append(selectField("lab", "Lab", state.lab, [["", "All labs"], ...labs.map((lab) => [lab.id, lab.name])], (event) => rerender(updateRoute(route, state, { lab: event.target.value, page: 1 }))));
  if (statusOptions.length) form.append(selectField("status", route === "ledger" ? "Coverage" : "Status", state.status, [["", "All states"], ...statusOptions], (event) => rerender(updateRoute(route, state, { status: event.target.value, page: 1 }))));
  if (route === "evidence") form.append(selectField("view", "Evidence view", state.view, [["sources", "Sources"], ["occurrences", "Occurrences"]], (event) => rerender(updateRoute(route, state, { view: event.target.value, page: 1, status: "" }))));
  form.append(selectField("sort", "Sort", state.sort, config.sorts.map((sort) => [sort, sort[0].toUpperCase() + sort.slice(1)]), (event) => rerender(updateRoute(route, state, { sort: event.target.value, page: 1 }))));
  form.append(selectField("dir", "Direction", state.direction, [["desc", "Descending"], ["asc", "Ascending"]], (event) => rerender(updateRoute(route, state, { direction: event.target.value, page: 1 }))));
  form.append(selectField("size", "Rows per page", String(state.pageSize), PAGE_SIZES.map((size) => [String(size), String(size)]), (event) => rerender(updateRoute(route, state, { pageSize: Number(event.target.value), page: 1 }))));
  form.append(element("p", { className: "filter-actions" }, [element("button", { className: "button", type: "submit", text: "Apply search" }), element("button", { className: "button button-quiet", type: "button", text: "Reset", onclick: () => rerender(updateRoute(route, state, { ...parseRouteState(route), page: 1 })) })]));
  controls.replaceChildren(form, element("p", { className: "route-status", id: `${route}-status`, role: "status", "aria-live": "polite" }));
}

function renderTable(route, view, page, records, state, rerender) {
  const host = document.querySelector(`[data-route-view="${route}"]`);
  const status = document.querySelector(`#${route}-status`);
  const label = route === "ledger" ? "releases" : route === "history" ? "derived reporting statuses" : view === "sources" ? "first-party sources" : "evidence occurrences";
  host.dataset.total = String(records.length);
  host.dataset.pageSize = String(state.pageSize);
  host.dataset.currentPage = String(page.currentPage);
  const first = records.length ? page.start + 1 : 0;
  const last = records.length ? page.start + page.rows.length : 0;
  status.textContent = records.length ? `Showing ${first} to ${last} of ${records.length} ${label}. Page ${page.currentPage} of ${page.totalPages}.` : `No ${label} match the selected filters.`;
  if (!records.length) {
    host.replaceChildren(element("section", { className: "empty-state", "aria-labelledby": `${route}-empty-title` }, [element("h2", { id: `${route}-empty-title`, text: "No matching records" }), element("p", { text: "Remove or revise a filter to see the complete validated record set." })]));
    return;
  }
  const table = element("table");
  table.append(element("caption", { text: `Current page of ${label}. ${records.length} matching records remain reachable through pagination.` }));
  const head = element("thead");
  head.append(element("tr", {}, headersFor(route, view).map((header) => element("th", { scope: "col", text: header }))));
  const body = element("tbody");
  for (const record of page.rows) {
    const row = element("tr", { "data-record-id": record.id });
    record.cells.forEach((cell, index) => {
      const cellNode = element("td");
      if (record.href && (route === "evidence") && ((view === "sources" && index === 2) || (view === "occurrences" && index === 4))) {
        cellNode.append(element("a", { href: record.href, target: "_blank", rel: "noopener noreferrer", text: `${cell} ↗` }));
      } else cellNode.textContent = cell;
      row.append(cellNode);
    });
    body.append(row);
  }
  table.append(head, body);
  const navigation = element("nav", { className: "route-pagination", "aria-label": `${label} pagination` });
  const makeButton = (text, target, disabled, ariaLabel) => element("button", { type: "button", text, disabled, "aria-label": ariaLabel, onclick: () => rerender(updateRoute(route, state, { page: target })) });
  navigation.append(
    makeButton("First", 1, page.currentPage === 1, "First page"),
    makeButton("Previous", page.currentPage - 1, page.currentPage === 1, "Previous page"),
    element("span", { className: "pagination-summary", "aria-hidden": "true", text: `Page ${page.currentPage} of ${page.totalPages}` }),
    makeButton("Next", page.currentPage + 1, page.currentPage === page.totalPages, "Next page"),
    makeButton("Last", page.totalPages, page.currentPage === page.totalPages, "Last page"),
  );
  host.replaceChildren(element("div", { className: "table-wrap" }, table), navigation);
}

function renderRoute(route, indexed, state) {
  const view = route === "evidence" ? state.view : "";
  const records = recordsForRoute(route, indexed, state);
  const filtered = filterRecords(records, state);
  const sorted = sortRecords(filtered, state.sort, state.direction);
  const page = paginate(sorted, state.page, state.pageSize);
  const clampedState = page.currentPage === state.page ? state : { ...state, page: page.currentPage };
  const rerender = (nextState) => renderRoute(route, indexed, nextState);
  renderControls(route, clampedState, indexed, rerender);
  renderTable(route, view, page, sorted, clampedState, rerender);
}

async function initialize() {
  const route = document.body?.dataset.page;
  if (!ROUTES[route]) return;
  const host = document.querySelector(`[data-route-view="${route}"]`);
  try {
    const data = validateInterface(await loadData());
    const indexed = indexData(data);
    const renderFromLocation = () => renderRoute(route, indexed, parseRouteState(route, window.location.search));
    window.addEventListener("popstate", renderFromLocation);
    renderFromLocation();
  } catch (error) {
    if (host) host.replaceChildren(element("section", { className: "empty-state", role: "alert" }, [element("h2", { text: "Data route unavailable" }), element("p", { text: "The generated ledger could not be loaded. The validated JSON and CSV downloads remain available." })]));
    console.error(error);
  }
}

if (typeof document !== "undefined") void initialize();
