import { byId, formatDate, indexData, revisionText, validateInterface } from "./core.mjs";

export const PAGE_SIZES = [25, 50, 100];
export const DEFAULT_PAGE_SIZE = 50;

const ROUTES = {
  ledger: { defaultSort: "date", sorts: ["date", "name", "lab", "coverage"] },
  history: { defaultSort: "date", sorts: ["date", "benchmark", "release", "status", "lab"] },
  evidence: { defaultSort: "date", sorts: ["date", "source", "benchmark", "release", "lab"] },
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
    category: "",
    lab: "",
    release: "",
    sourceType: "",
    status: "",
    from: "",
    to: "",
    sort: config.defaultSort,
    direction: "desc",
    pageSize: DEFAULT_PAGE_SIZE,
    page: 1,
    view: "sources",
  };
}

function routeValue(value) {
  return String(value || "").trim().slice(0, 200);
}

export function isRealIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function isCorpusDate(value, publicationWindow) {
  return isRealIsoDate(value)
    && isRealIsoDate(publicationWindow.start)
    && isRealIsoDate(publicationWindow.end)
    && value >= publicationWindow.start
    && value <= publicationWindow.end;
}

export function parseRouteState(route, search = "") {
  const defaults = routeDefaults(route);
  const params = new URLSearchParams(search);
  const sort = params.get("sort");
  const direction = params.get("dir");
  const size = Number(params.get("size"));
  return {
    ...defaults,
    query: routeValue(params.get("q")),
    benchmark: routeValue(params.get("benchmark")),
    category: routeValue(params.get("category")),
    lab: routeValue(params.get("lab")),
    release: routeValue(params.get("release")),
    sourceType: routeValue(params.get("source-type")),
    status: routeValue(params.get("status")),
    from: routeValue(params.get("from")),
    to: routeValue(params.get("to")),
    sort: ROUTES[route].sorts.includes(sort) ? sort : defaults.sort,
    direction: direction === "asc" || direction === "desc" ? direction : defaults.direction,
    pageSize: PAGE_SIZES.includes(size) ? size : defaults.pageSize,
    page: safePage(params.get("page")),
    view: route === "evidence" && (params.get("view") === "sources" || params.get("view") === "occurrences") ? params.get("view") : defaults.view,
  };
}

export function sanitizeRouteState(route, state, indexed) {
  const defaults = routeDefaults(route);
  const value = (candidate, ids) => ids.has(candidate) ? candidate : "";
  const validSourceTypes = new Set([...indexed.data.sources, ...indexed.data.occurrences].map((record) => record.source_type));
  const validCoverageStatuses = new Set(indexed.data.coverage.map((coverage) => coverage.review_status));
  const validEvidenceStatuses = new Set(indexed.data.occurrences.map((occurrence) => occurrence.review_status));
  const validDate = (candidate) => isCorpusDate(candidate, indexed.data.corpus.publication_window) ? candidate : "";
  let from = validDate(routeValue(state.from));
  let to = validDate(routeValue(state.to));
  if (from && to && from > to) [from, to] = ["", ""];
  return {
    ...defaults,
    query: routeValue(state.query),
    lab: value(routeValue(state.lab), indexed.labs),
    sort: ROUTES[route].sorts.includes(state.sort) ? state.sort : defaults.sort,
    direction: state.direction === "asc" || state.direction === "desc" ? state.direction : defaults.direction,
    pageSize: PAGE_SIZES.includes(state.pageSize) ? state.pageSize : defaults.pageSize,
    page: safePage(state.page),
    view: route === "evidence" && (state.view === "sources" || state.view === "occurrences") ? state.view : defaults.view,
    status: route === "history"
      ? value(routeValue(state.status), indexed.definitions)
      : route === "ledger"
        ? value(routeValue(state.status), validCoverageStatuses)
        : value(routeValue(state.status), validEvidenceStatuses),
    benchmark: route === "history" || route === "evidence" ? value(routeValue(state.benchmark), indexed.benchmarks) : "",
    category: route === "evidence" ? value(routeValue(state.category), indexed.categories) : "",
    release: route === "evidence" ? value(routeValue(state.release), indexed.releases) : "",
    sourceType: route === "evidence" ? value(routeValue(state.sourceType), validSourceTypes) : "",
    from: route === "ledger" || route === "history" || route === "evidence" ? from : "",
    to: route === "ledger" || route === "history" || route === "evidence" ? to : "",
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
  if (route === "ledger" || route === "history" || route === "evidence") {
    if ((route === "history" || route === "evidence") && state.benchmark) params.set("benchmark", state.benchmark);
    if (state.from) params.set("from", state.from);
    if (state.to) params.set("to", state.to);
  }
  if (route === "evidence") {
    if (state.category) params.set("category", state.category);
    if (state.release) params.set("release", state.release);
    if (state.sourceType) params.set("source-type", state.sourceType);
  }
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

function replaceCanonicalRoute(route, state) {
  const url = new URL(window.location.href);
  const fixture = url.searchParams.get("fixture");
  url.search = canonicalSearch(route, state);
  if (fixture === "ui") url.searchParams.set("fixture", fixture);
  if (url.search !== window.location.search) history.replaceState({}, "", url);
}

function updateRoute(route, state, changes = {}) {
  const next = { ...state, ...changes };
  const url = new URL(window.location.href);
  const fixture = url.searchParams.get("fixture");
  url.search = canonicalSearch(route, next);
  if (fixture === "ui") url.searchParams.set("fixture", fixture);
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

export function filterRecords(route, records, state) {
  const query = normalizedText(state.query);
  const matchesEvidenceAssociation = (association) => (!state.benchmark || association.benchmarkId === state.benchmark)
    && (!state.category || association.categoryId === state.category)
    && (!state.release || association.releaseId === state.release)
    && (!state.status || association.statusId === state.status);
  const matchesEvidenceFilters = (record) => {
    if (!state.benchmark && !state.category && !state.release && !state.status) return true;
    return (record.associations || [record]).some(matchesEvidenceAssociation);
  };
  return records
    .filter((record) => !state.lab || record.labId === state.lab)
    .filter((record) => route === "evidence" || !state.status || record.statusIds.includes(state.status))
    .filter((record) => !state.from || record.publicationDate >= state.from)
    .filter((record) => !state.to || record.publicationDate <= state.to)
    .filter((record) => route !== "history" || !state.benchmark || record.benchmarkId === state.benchmark)
    .filter((record) => route !== "evidence" || !state.sourceType || record.sourceType === state.sourceType)
    .filter((record) => route !== "evidence" || matchesEvidenceFilters(record))
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
      publicationDate: release.publication_date,
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
      benchmarkId: status.benchmark_id,
      labId: status.lab_id,
      publicationDate: status.publication_date,
      statusIds: status.status_ids,
      searchText: [status.id, benchmark?.name, release?.name, lab?.name, labels.join(" "), status.publication_date].join(" "),
      sortValues: { date: status.publication_date, benchmark: benchmark?.name || status.benchmark_id, release: release?.name || status.release_id, status: labels.join(" "), lab: lab?.name || status.lab_id },
      cells: [formatDate(status.publication_date), lab?.name || status.lab_id, benchmark?.name || status.benchmark_id, release?.name || status.release_id, labels.join(", ")],
    };
  });
}

function sourceRecords(indexed) {
  const associationsBySource = new Map();
  for (const occurrence of indexed.data.occurrences) {
    const benchmark = indexed.benchmarks.get(occurrence.benchmark_id);
    const associations = associationsBySource.get(occurrence.source_id) || [];
    associations.push({
      benchmarkId: occurrence.benchmark_id,
      categoryId: benchmark?.category_id || "",
      releaseId: occurrence.release_id,
      statusId: occurrence.review_status,
    });
    associationsBySource.set(occurrence.source_id, associations);
  }
  return indexed.data.sources.map((source) => {
    const lab = indexed.labs.get(source.lab_id);
    const revision = revisionText(source.revision);
    const associations = associationsBySource.get(source.id) || [];
    return {
      id: source.id,
      labId: source.lab_id,
      sourceType: source.source_type,
      publicationDate: source.publication_date,
      associations,
      statusIds: [...new Set(associations.map((association) => association.statusId))],
      searchText: [source.id, source.url, source.source_type, lab?.name, source.publication_date, revision].join(" "),
      sortValues: { date: source.publication_date, source: source.url, benchmark: "", release: "", lab: lab?.name || source.lab_id },
      cells: [formatDate(source.publication_date), lab?.name || source.lab_id, source.source_type.replaceAll("_", " "), revision, String(associations.length)],
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
      benchmarkId: occurrence.benchmark_id,
      categoryId: benchmark?.category_id || "",
      labId: occurrence.lab_id,
      releaseId: occurrence.release_id,
      sourceType: occurrence.source_type,
      statusId: occurrence.review_status,
      publicationDate: occurrence.publication_date,
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
  if (route === "ledger") return [["Date", "date"], ["Lab", "lab"], ["Release", "name"], ["Coverage", "coverage"], ["Occurrences", ""]];
  if (route === "history") return [["Date", "date"], ["Lab", "lab"], ["Benchmark", "benchmark"], ["Release", "release"], ["Reporting status", "status"]];
  if (view === "sources") return [["Date", "date"], ["Lab", "lab"], ["Source type", "source"], ["Revision", ""], ["Occurrences", ""]];
  return [["Date", "date"], ["Lab", "lab"], ["Benchmark", "benchmark"], ["Release", "release"], ["Locator", "source"], ["Review state", ""]];
}

function selectField(name, label, value, options, onChange) {
  const select = element("select", {
    id: `route-${name}`,
    name,
    onChange,
    onKeydown: (event) => {
      if (event.key !== "Home" && event.key !== "End") return;
      const nextIndex = event.key === "Home" ? 0 : event.currentTarget.options.length - 1;
      if (event.currentTarget.selectedIndex === nextIndex) return;
      event.preventDefault();
      event.currentTarget.selectedIndex = nextIndex;
      event.currentTarget.dispatchEvent(new Event("change", { bubbles: true }));
    },
  });
  for (const [optionValue, optionLabel] of options) {
    select.append(element("option", { value: optionValue, text: optionLabel, selected: optionValue === value }));
  }
  return element("p", { className: "field" }, [element("label", { for: `route-${name}`, text: label }), select]);
}

function dateField(name, label, value, min, max, onChange) {
  const input = element("input", { id: `route-${name}`, name, type: "date", value, min, max, onChange });
  return element("p", { className: "field" }, [element("label", { for: `route-${name}`, text: label }), input]);
}

function namedOptions(records) {
  return [...records]
    .sort((left, right) => left.name.localeCompare(right.name, "en"))
    .map((record) => [record.id, record.name]);
}

function renderControls(route, state, indexed, rerender) {
  const controls = document.querySelector(`[data-route-controls="${route}"]`);
  const labs = namedOptions(indexed.labs.values());
  const benchmarks = namedOptions(indexed.benchmarks.values());
  const categories = namedOptions(indexed.categories.values());
  const releases = namedOptions(indexed.releases.values());
  const statusOptions = route === "history"
    ? [...indexed.definitions.values()].map((definition) => [definition.id, definition.label])
    : [...new Set(indexed.data.coverage.map((coverage) => coverage.review_status))].sort().map((value) => [value, value.replaceAll("_", " ")]);
  const sourceTypeOptions = [...new Set([...indexed.data.sources, ...indexed.data.occurrences].map((record) => record.source_type))]
    .sort()
    .map((value) => [value, value.replaceAll("_", " ")]);
  const evidenceStatusOptions = [...new Set(indexed.data.occurrences.map((occurrence) => occurrence.review_status))]
    .sort()
    .map((value) => [value, value.replaceAll("_", " ")]);
  const config = ROUTES[route];
  const change = (field) => (event) => rerender(updateRoute(route, state, { [field]: event.target.value, page: 1 }));
  const form = element("form", { className: "route-filter-panel", onsubmit: (event) => {
    event.preventDefault();
    const query = new FormData(form).get("q")?.toString().trim().slice(0, 200) || "";
    rerender(updateRoute(route, state, { query, page: 1 }));
  } });
  const input = element("input", { id: "route-query", name: "q", type: "search", value: state.query, maxlength: 200, autocomplete: "off", placeholder: "Search this view" });
  form.append(element("p", { className: "field field-search" }, [element("label", { for: "route-query", text: "Search" }), input]));
  if (route === "evidence") {
    form.append(selectField("view", "Evidence view", state.view, [["sources", "Sources"], ["occurrences", "Occurrences"]], change("view")));
    form.append(selectField("benchmark", "Benchmark", state.benchmark, [["", "All benchmarks"], ...benchmarks], change("benchmark")));
    form.append(selectField("category", "Category", state.category, [["", "All categories"], ...categories], change("category")));
  }
  if (route === "history") form.append(selectField("benchmark", "Benchmark", state.benchmark, [["", "All benchmarks"], ...benchmarks], change("benchmark")));
  form.append(selectField("lab", "Lab", state.lab, [["", "All labs"], ...labs], change("lab")));
  if (route === "evidence") {
    form.append(selectField("release", "Release", state.release, [["", "All releases"], ...releases], change("release")));
    form.append(selectField("source-type", "Source type", state.sourceType, [["", "All source types"], ...sourceTypeOptions], change("sourceType")));
    form.append(selectField("status", "Review state", state.status, [["", "All review states"], ...evidenceStatusOptions], change("status")));
  } else {
    form.append(selectField("status", route === "ledger" ? "Coverage" : "Status", state.status, [["", "All states"], ...statusOptions], change("status")));
  }
  if (route === "ledger" || route === "history" || route === "evidence") {
    const { start, end } = indexed.data.corpus.publication_window;
    form.append(dateField("from", "From", state.from, start, end, change("from")));
    form.append(dateField("to", "To", state.to, start, end, change("to")));
  }
  form.append(selectField("sort", "Sort", state.sort, config.sorts.map((sort) => [sort, sort[0].toUpperCase() + sort.slice(1)]), change("sort")));
  form.append(selectField("dir", "Direction", state.direction, [["desc", "Descending"], ["asc", "Ascending"]], change("direction")));
  form.append(selectField("size", "Rows per page", String(state.pageSize), PAGE_SIZES.map((size) => [String(size), String(size)]), (event) => rerender(updateRoute(route, state, { pageSize: Number(event.target.value), page: 1 }))));
  form.append(element("p", { className: "filter-actions" }, [element("button", { className: "button", type: "submit", text: "Apply search" }), element("button", { className: "button button-quiet", type: "button", text: "Reset", onclick: () => rerender(updateRoute(route, state, routeDefaults(route))) })]));
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
  head.append(element("tr", {}, headersFor(route, view).map(([labelText, sort]) => element("th", {
    scope: "col",
    text: labelText,
    "aria-sort": sort ? (state.sort === sort ? (state.direction === "asc" ? "ascending" : "descending") : "none") : null,
  }))));
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
  const makeButton = (name, text, target, disabled, ariaLabel) => element("button", { id: `${route}-page-${name.toLowerCase()}`, type: "button", text, disabled, "aria-label": ariaLabel, onclick: () => rerender(updateRoute(route, state, { page: target })) });
  navigation.append(
    makeButton("First", "First", 1, page.currentPage === 1, "First page"),
    makeButton("Previous", "Previous", page.currentPage - 1, page.currentPage === 1, "Previous page"),
    element("span", { className: "pagination-summary", "aria-hidden": "true", text: `Page ${page.currentPage} of ${page.totalPages}` }),
    makeButton("Next", "Next", page.currentPage + 1, page.currentPage === page.totalPages, "Next page"),
    makeButton("Last", "Last", page.totalPages, page.currentPage === page.totalPages, "Last page"),
  );
  host.replaceChildren(element("div", { className: "table-wrap" }, table), navigation);
}

function renderRoute(route, indexed, state) {
  const focusId = document.activeElement?.id || "";
  const sanitizedState = sanitizeRouteState(route, state, indexed);
  const records = recordsForRoute(route, indexed, sanitizedState);
  const filtered = filterRecords(route, records, sanitizedState);
  const sorted = sortRecords(filtered, sanitizedState.sort, sanitizedState.direction);
  const page = paginate(sorted, sanitizedState.page, sanitizedState.pageSize);
  const clampedState = page.currentPage === sanitizedState.page ? sanitizedState : { ...sanitizedState, page: page.currentPage };
  replaceCanonicalRoute(route, clampedState);
  const rerender = (nextState) => renderRoute(route, indexed, nextState);
  renderControls(route, clampedState, indexed, rerender);
  renderTable(route, route === "evidence" ? clampedState.view : "", page, sorted, clampedState, rerender);
  if (focusId) document.getElementById(focusId)?.focus({ preventScroll: true });
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
