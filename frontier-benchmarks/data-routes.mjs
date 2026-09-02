import { createSearchableCombobox, formatDate, indexData, validateInterface } from "./core.mjs";

export const PAGE_SIZES = [25, 50, 100];
export const DEFAULT_PAGE_SIZE = 50;
export const SEARCH_DEBOUNCE_MS = 150;

const ROUTES = {
  ledger: { defaultSort: "date", sorts: ["date", "name", "lab", "coverage"] },
  history: { defaultSort: "date", sorts: ["date", "benchmark", "release", "status", "lab"] },
};

export function eventTypeForAttribute(name) {
  return typeof name === "string" && name.startsWith("on") && name.length > 2 ? name.slice(2).toLowerCase() : null;
}

function element(name, attributes = {}, children = []) {
  const node = document.createElement(name);
  for (const [key, value] of Object.entries(attributes)) {
    if (value === null || value === undefined || value === false) continue;
    const eventType = eventTypeForAttribute(key);
    if (key === "text") node.textContent = String(value);
    else if (key === "className") node.className = String(value);
    else if (eventType) node.addEventListener(eventType, value);
    else if (value === true) node.setAttribute(key, "");
    else node.setAttribute(key, String(value));
  }
  for (const child of Array.isArray(children) ? children : [children]) if (child !== null && child !== undefined) node.append(child);
  return node;
}

const normalizedText = (value) => String(value || "").toLocaleLowerCase("en");

export function safeSourceHref(indexed, source) {
  try {
    const url = new URL(source?.url);
    const lab = indexed.labs.get(source?.lab_id);
    const host = url.hostname.toLowerCase().replace(/\.$/, "");
    const allowed = lab?.official_domains || [];
    return url.protocol === "https:" && !url.username && !url.password && allowed.some((domain) => host === domain || host.endsWith(`.${domain}`)) ? url.href : null;
  } catch (_) {
    return null;
  }
}

function safePage(value) {
  const text = String(value ?? "");
  if (!/^\d+$/.test(text)) return 1;
  const page = Number(text);
  return Number.isSafeInteger(page) && page > 0 ? page : 1;
}

function routeDefaults(route) {
  const config = ROUTES[route];
  if (!config) throw new Error(`Unsupported data route: ${route}`);
  return {
    query: "",
    benchmark: "",
    lab: "",
    status: "",
    from: "",
    to: "",
    sort: config.defaultSort,
    direction: "desc",
    pageSize: DEFAULT_PAGE_SIZE,
    page: 1,
  };
}

const routeValue = (value) => String(value || "").trim().slice(0, 200);

export function isRealIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

const isCorpusDate = (value, window) => isRealIsoDate(value) && value >= window.start && value <= window.end;

export function parseRouteState(route, search = "") {
  const defaults = routeDefaults(route);
  const params = new URLSearchParams(search);
  const size = Number(params.get("size"));
  return {
    ...defaults,
    query: routeValue(params.get("q")),
    benchmark: routeValue(params.get("benchmark")),
    lab: routeValue(params.get("lab")),
    status: routeValue(params.get("status")),
    from: routeValue(params.get("from")),
    to: routeValue(params.get("to")),
    sort: ROUTES[route].sorts.includes(params.get("sort")) ? params.get("sort") : defaults.sort,
    direction: ["asc", "desc"].includes(params.get("dir")) ? params.get("dir") : defaults.direction,
    pageSize: PAGE_SIZES.includes(size) ? size : defaults.pageSize,
    page: safePage(params.get("page")),
  };
}

export function sanitizeRouteState(route, state, indexed) {
  const defaults = routeDefaults(route);
  const validValue = (candidate, records) => records.has(candidate) ? candidate : "";
  const validCoverage = new Set(indexed.data.coverage.map((record) => record.review_status));
  let from = isCorpusDate(routeValue(state.from), indexed.data.corpus.publication_window) ? routeValue(state.from) : "";
  let to = isCorpusDate(routeValue(state.to), indexed.data.corpus.publication_window) ? routeValue(state.to) : "";
  if (from && to && from > to) [from, to] = ["", ""];
  return {
    ...defaults,
    query: routeValue(state.query),
    benchmark: route === "history" ? validValue(routeValue(state.benchmark), indexed.benchmarks) : "",
    lab: validValue(routeValue(state.lab), indexed.labs),
    status: route === "history" ? validValue(routeValue(state.status), indexed.definitions) : validValue(routeValue(state.status), validCoverage),
    from,
    to,
    sort: ROUTES[route].sorts.includes(state.sort) ? state.sort : defaults.sort,
    direction: ["asc", "desc"].includes(state.direction) ? state.direction : defaults.direction,
    pageSize: PAGE_SIZES.includes(state.pageSize) ? state.pageSize : defaults.pageSize,
    page: safePage(state.page),
  };
}

export function paginate(records, page, pageSize) {
  const totalPages = Math.max(1, Math.ceil(records.length / pageSize));
  const currentPage = Math.min(Math.max(1, page), totalPages);
  const start = (currentPage - 1) * pageSize;
  return { currentPage, totalPages, start, rows: records.slice(start, start + pageSize) };
}

export function canonicalSearch(route, state) {
  const params = new URLSearchParams();
  const config = ROUTES[route];
  if (state.query) params.set("q", state.query);
  if (route === "history" && state.benchmark) params.set("benchmark", state.benchmark);
  if (state.lab) params.set("lab", state.lab);
  if (state.status) params.set("status", state.status);
  if (state.from) params.set("from", state.from);
  if (state.to) params.set("to", state.to);
  if (state.sort !== config.defaultSort) params.set("sort", state.sort);
  if (state.direction !== "desc") params.set("dir", state.direction);
  if (state.pageSize !== DEFAULT_PAGE_SIZE) params.set("size", String(state.pageSize));
  if (state.page > 1) params.set("page", String(state.page));
  const query = params.toString();
  return query ? `?${query}` : "";
}

function writeRouteState(route, state, method = "pushState") {
  const url = new URL(window.location.href);
  const fixture = url.searchParams.get("fixture");
  url.search = canonicalSearch(route, state);
  if (fixture === "ui") url.searchParams.set("fixture", fixture);
  history[method]({}, "", url);
}

async function loadData() {
  const params = new URLSearchParams(window.location.search);
  if (params.get("fixture") === "ui" && ["localhost", "127.0.0.1"].includes(window.location.hostname)) return (await import("./tests/ui/fixture.mjs")).fixture;
  const response = await fetch("./public/observatory.json", { cache: "no-store" });
  if (!response.ok) throw new Error(`Generated data request failed with HTTP ${response.status}.`);
  return response.json();
}

function sortRecords(records, key, direction) {
  const factor = direction === "asc" ? 1 : -1;
  return [...records].sort((left, right) => {
    const primary = String(left.sortValues[key] || "").localeCompare(String(right.sortValues[key] || ""), "en", { sensitivity: "base", numeric: true });
    return primary ? primary * factor : String(left.id).localeCompare(String(right.id), "en") * factor;
  });
}

export function filterRecords(route, records, state) {
  const query = normalizedText(state.query);
  return records
    .filter((record) => !state.lab || record.labId === state.lab)
    .filter((record) => !state.status || record.statusIds.includes(state.status))
    .filter((record) => !state.from || record.publicationDate >= state.from)
    .filter((record) => !state.to || record.publicationDate <= state.to)
    .filter((record) => route !== "history" || !state.benchmark || record.benchmarkId === state.benchmark)
    .filter((record) => !query || normalizedText(record.searchText).includes(query));
}

function releaseRecords(indexed) {
  return indexed.data.releases.map((release) => {
    const review = indexed.coverage.get(release.coverage_id);
    const lab = indexed.labs.get(release.lab_id);
    const occurrences = indexed.occurrencesByRelease.get(release.id) || [];
    const coverageText = review?.review_status?.replaceAll("_", " ") || "unavailable";
    return {
      id: release.id,
      labId: release.lab_id,
      publicationDate: release.publication_date,
      statusIds: [review?.review_status || "unavailable"],
      searchText: [release.name, lab?.name, release.publication_date, coverageText].join(" "),
      sortValues: { date: release.publication_date, name: release.name, lab: lab?.name || "", coverage: coverageText },
      cells: [formatDate(release.publication_date), lab?.name || "Unknown lab", release.name, coverageText, String(occurrences.length)],
    };
  });
}

function historyRecords(indexed) {
  const occurrences = new Map(indexed.data.occurrences.map((occurrence) => [occurrence.id, occurrence]));
  return indexed.data.derived_statuses.map((status) => {
    const benchmark = indexed.benchmarks.get(status.benchmark_id);
    const release = indexed.releases.get(status.release_id);
    const lab = indexed.labs.get(status.lab_id);
    const labels = status.status_ids.map((id) => indexed.definitions.get(id)?.label || id.replaceAll("_", " "));
    const occurrence = status.occurrence_id ? occurrences.get(status.occurrence_id) : null;
    const source = occurrence ? indexed.sources.get(occurrence.source_id) : null;
    const sourceHref = source ? safeSourceHref(indexed, source) : null;
    return {
      id: status.id,
      benchmarkId: status.benchmark_id,
      labId: status.lab_id,
      publicationDate: status.publication_date,
      statusIds: status.status_ids,
      searchText: [benchmark?.name, release?.name, lab?.name, labels.join(" "), status.publication_date].join(" "),
      sortValues: { date: status.publication_date, benchmark: benchmark?.name || "", release: release?.name || "", status: labels.join(" "), lab: lab?.name || "" },
      cells: [formatDate(status.publication_date), lab?.name || "Unknown lab", benchmark?.name || "Unnamed benchmark", release?.name || "Unnamed release", labels.join(", ")],
      sourceHref,
    };
  });
}

export function recordsForRoute(route, indexed) {
  if (route === "ledger") return releaseRecords(indexed);
  if (route === "history") return historyRecords(indexed);
  throw new Error(`Unsupported data route: ${route}`);
}

function headersFor(route) {
  if (route === "ledger") return [["Date", "date"], ["Lab", "lab"], ["Release", "name"], ["Coverage", "coverage"], ["Occurrences", ""]];
  return [["Date", "date"], ["Lab", "lab"], ["Benchmark", "benchmark"], ["Release", "release"], ["Reporting status", "status"], ["Source", ""]];
}

function selectField(name, label, value, options, onChange) {
  const select = element("select", { id: `route-${name}`, name, onChange });
  options.forEach(([optionValue, optionLabel]) => select.append(element("option", { value: optionValue, text: optionLabel, selected: optionValue === value })));
  return element("div", { className: "field" }, [element("label", { for: select.id, text: label }), select]);
}

function dateField(name, label, value, min, max, onChange) {
  const input = element("input", { id: `route-${name}`, name, type: "date", value, min, max, onChange });
  return element("div", { className: "field" }, [element("label", { for: input.id, text: label }), input]);
}

const namedOptions = (records) => [...records].sort((left, right) => left.name.localeCompare(right.name, "en") || left.id.localeCompare(right.id, "en")).map((record) => ({ value: record.id, label: record.name }));

function renderControls(route, state, indexed, rerender) {
  const controls = document.querySelector(`[data-route-controls="${route}"]`);
  const update = (changes, resetPage = true) => rerender({ ...state, ...changes, ...(resetPage ? { page: 1 } : {}) });
  const panel = element("div", { className: "route-filter-panel", role: "group", "aria-label": `${route} filters` });
  const query = element("input", { id: "route-query", name: "q", type: "search", value: state.query, maxlength: 200, autocomplete: "off", placeholder: "Search this view" });
  let timer;
  query.addEventListener("input", () => {
    window.clearTimeout(timer);
    const status = document.querySelector(`#${route}-status`);
    if (status) status.textContent = "Updating results…";
    timer = window.setTimeout(() => update({ query: query.value }), SEARCH_DEBOUNCE_MS);
  });
  panel.append(element("div", { className: "field field-search" }, [element("label", { for: "route-query", text: "Search" }), query]));
  if (route === "history") {
    const benchmark = createSearchableCombobox({
      id: "route-benchmark",
      label: "Benchmark",
      value: state.benchmark,
      options: [{ value: "", label: "All benchmarks" }, ...namedOptions(indexed.benchmarks.values())],
      emptyLabel: "All benchmarks",
      placeholder: "Find a benchmark",
      onChange: (value) => update({ benchmark: value }),
    });
    panel.append(benchmark.element);
  }
  const labs = namedOptions(indexed.labs.values()).map((option) => [option.value, option.label]);
  const statuses = route === "history"
    ? [...indexed.definitions.values()].sort((left, right) => left.label.localeCompare(right.label, "en")).map((item) => [item.id, item.label])
    : [...new Set(indexed.data.coverage.map((item) => item.review_status))].sort().map((item) => [item, item.replaceAll("_", " ")]);
  panel.append(selectField("lab", "Lab", state.lab, [["", "All labs"], ...labs], (event) => update({ lab: event.target.value })));
  panel.append(selectField("status", route === "ledger" ? "Coverage" : "Status", state.status, [["", "All states"], ...statuses], (event) => update({ status: event.target.value })));
  const { start, end } = indexed.data.corpus.publication_window;
  panel.append(dateField("from", "From", state.from, start, end, (event) => update({ from: event.target.value })));
  panel.append(dateField("to", "To", state.to, start, end, (event) => update({ to: event.target.value })));
  const config = ROUTES[route];
  panel.append(selectField("sort", "Sort", state.sort, config.sorts.map((key) => [key, key[0].toUpperCase() + key.slice(1)]), (event) => update({ sort: event.target.value }, false)));
  panel.append(selectField("dir", "Direction", state.direction, [["desc", "Descending"], ["asc", "Ascending"]], (event) => update({ direction: event.target.value }, false)));
  panel.append(selectField("size", "Rows per page", String(state.pageSize), PAGE_SIZES.map((size) => [String(size), String(size)]), (event) => update({ pageSize: Number(event.target.value) })));
  const reset = element("button", { className: "button button-quiet", type: "button", text: "Reset", onclick: () => rerender(routeDefaults(route)) });
  panel.append(element("div", { className: "filter-actions" }, [reset]));
  controls.replaceChildren(panel, element("p", { className: "route-status", id: `${route}-status`, role: "status", "aria-live": "polite" }));
}

function renderTable(route, page, records, state, rerender) {
  const host = document.querySelector(`[data-route-view="${route}"]`);
  const status = document.querySelector(`#${route}-status`);
  const label = route === "ledger" ? "releases" : "reporting statuses";
  host.dataset.total = String(records.length);
  host.dataset.pageSize = String(state.pageSize);
  host.dataset.currentPage = String(page.currentPage);
  const first = records.length ? page.start + 1 : 0;
  const last = records.length ? page.start + page.rows.length : 0;
  status.textContent = records.length ? `Showing ${first} to ${last} of ${records.length} ${label}. Page ${page.currentPage} of ${page.totalPages}.` : `No ${label} match the selected filters.`;
  if (!records.length) {
    host.replaceChildren(element("section", { className: "empty-state", "aria-labelledby": `${route}-empty-title` }, [element("h2", { id: `${route}-empty-title`, text: "No matching records" }), element("p", { text: "Remove or revise a filter to see the complete record set." })]));
    return;
  }
  const table = element("table");
  table.append(element("caption", { text: `Current page of ${label}. ${records.length} matching records remain reachable through pagination.` }));
  const head = element("thead");
  head.append(element("tr", {}, headersFor(route).map(([labelText, sort]) => element("th", { scope: "col", text: labelText, "aria-sort": sort ? (state.sort === sort ? (state.direction === "asc" ? "ascending" : "descending") : "none") : null }))));
  const body = element("tbody");
  page.rows.forEach((record) => {
    const row = element("tr");
    record.cells.forEach((cell) => row.append(element("td", { text: cell })));
    if (route === "history") {
      const sourceCell = element("td");
      if (record.sourceHref) sourceCell.append(element("a", { className: "source-link", href: record.sourceHref, target: "_blank", rel: "noopener noreferrer", text: "Source" }));
      row.append(sourceCell);
    }
    body.append(row);
  });
  table.append(head, body);
  const navigation = element("nav", { className: "route-pagination", "aria-label": `${label} pagination` });
  const button = (name, target, disabled) => element("button", { id: `${route}-page-${name.toLowerCase()}`, type: "button", text: name, disabled, "aria-label": `${name} page`, onclick: () => rerender({ ...state, page: target }) });
  navigation.append(
    button("First", 1, page.currentPage === 1),
    button("Previous", page.currentPage - 1, page.currentPage === 1),
    element("span", { className: "pagination-summary", "aria-hidden": "true", text: `Page ${page.currentPage} of ${page.totalPages}` }),
    button("Next", page.currentPage + 1, page.currentPage === page.totalPages),
    button("Last", page.totalPages, page.currentPage === page.totalPages),
  );
  host.replaceChildren(element("div", { className: "table-wrap" }, table), navigation);
}

function renderRoute(route, indexed, state, method = "pushState") {
  const focusId = document.activeElement?.id || "";
  const sanitized = sanitizeRouteState(route, state, indexed);
  const records = sortRecords(filterRecords(route, recordsForRoute(route, indexed), sanitized), sanitized.sort, sanitized.direction);
  const page = paginate(records, sanitized.page, sanitized.pageSize);
  const clamped = page.currentPage === sanitized.page ? sanitized : { ...sanitized, page: page.currentPage };
  writeRouteState(route, clamped, method);
  const rerender = (nextState) => renderRoute(route, indexed, nextState);
  renderControls(route, clamped, indexed, rerender);
  renderTable(route, page, records, clamped, rerender);
  if (focusId) {
    const focus = document.getElementById(focusId);
    focus?.focus({ preventScroll: true });
    if (focus instanceof HTMLInputElement && ["search", "text"].includes(focus.type)) focus.setSelectionRange(focus.value.length, focus.value.length);
  }
}

async function initialize() {
  const route = document.body?.dataset.page;
  if (!ROUTES[route]) return;
  const host = document.querySelector(`[data-route-view="${route}"]`);
  try {
    const indexed = indexData(validateInterface(await loadData()));
    const fromLocation = () => renderRoute(route, indexed, parseRouteState(route, window.location.search), "replaceState");
    window.addEventListener("popstate", fromLocation);
    fromLocation();
  } catch (error) {
    host?.replaceChildren(element("section", { className: "empty-state", role: "alert" }, [element("h2", { text: "Data unavailable" }), element("p", { text: "The Observatory records could not be loaded." })]));
    console.error(error);
  }
}

if (typeof document !== "undefined") void initialize();
