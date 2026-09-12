import {
  createCancelableSearch,
  createSearchableCombobox,
  decodeViewState,
  encodeViewState,
  formatDate,
  historyPayload,
  indexData,
  liveCanonicalBenchmarks,
  mappedBenchmarkId,
  navigationSearch,
  retainedReleaseOccurrences,
  safeSourceHref as sharedSafeSourceHref,
  sourceDisclosure,
  validateInterface,
} from "./core.mjs";

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

const normalizedText = (value) => String(value || "").normalize("NFKD").toLocaleLowerCase("en");
const routeValue = (value) => String(value || "").trim().slice(0, 200);
const numberText = (value) => Number(value).toLocaleString("en-US");

export function safeSourceHref(indexed, source, releaseOrLabId = "") {
  return sharedSafeSourceHref(indexed, source, releaseOrLabId);
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

export function isRealIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

const isCorpusDate = (value, window) => isRealIsoDate(value) && value >= window.start && value <= window.end;

/** Compatibility parser for the original single-benchmark table helper contract. Runtime routing uses decodeViewState. */
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

/** Compatibility sanitizer for callers using query, benchmark, direction, and pageSize. */
export function sanitizeRouteState(route, state, indexed) {
  const defaults = routeDefaults(route);
  const benchmark = indexed.benchmarks.get(routeValue(state.benchmark));
  const mappedBenchmark = benchmark?.identity_status === "merged" ? benchmark.canonical_benchmark_id : benchmark?.id || "";
  const validCoverage = new Set(indexed.data.coverage.map((record) => record.review_status));
  let from = isCorpusDate(routeValue(state.from), indexed.data.corpus.publication_window) ? routeValue(state.from) : "";
  let to = isCorpusDate(routeValue(state.to), indexed.data.corpus.publication_window) ? routeValue(state.to) : "";
  if (from && to && from > to) [from, to] = ["", ""];
  return {
    ...defaults,
    query: routeValue(state.query),
    benchmark: route === "history" ? mappedBenchmark : "",
    lab: indexed.labs.has(routeValue(state.lab)) ? routeValue(state.lab) : "",
    status: route === "history"
      ? (indexed.definitions.has(routeValue(state.status)) ? routeValue(state.status) : "")
      : (validCoverage.has(routeValue(state.status)) ? routeValue(state.status) : ""),
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

/** Compatibility serializer that delegates the canonical v2 grammar to core.mjs. */
export function canonicalSearch(route, state) {
  if (Array.isArray(state.benchmarks) || Object.hasOwn(state, "q")) return encodeViewState(route, state);
  return encodeViewState(route, {
    benchmarks: route === "history" && state.benchmark ? [state.benchmark] : [],
    q: state.query,
    lab: state.lab,
    status: state.status,
    from: state.from,
    to: state.to,
    sort: state.sort,
    dir: state.direction,
    size: state.pageSize,
    page: state.page,
  });
}

export function createTableSearch(callback, delay = SEARCH_DEBOUNCE_MS, scheduler = globalThis) {
  return createCancelableSearch((value) => callback(routeValue(value)), delay, scheduler);
}

function sortRecords(records, key, direction) {
  const factor = direction === "asc" ? 1 : -1;
  return [...records].sort((left, right) => {
    const primary = String(left.sortValues[key] || "").localeCompare(String(right.sortValues[key] || ""), "en", { sensitivity: "base", numeric: true });
    return primary ? primary * factor : String(left.id).localeCompare(String(right.id), "en") * factor;
  });
}

export function filterRecords(route, records, state) {
  const query = normalizedText(state.q ?? state.query);
  const selected = new Set(state.benchmarks || (state.benchmark ? [state.benchmark] : []));
  return records
    .filter((record) => route !== "history" || state.audit === "all" || record.identityStatus !== "quarantined")
    .filter((record) => !state.lab || record.labId === state.lab)
    .filter((record) => !state.status || record.statusIds.includes(state.status))
    .filter((record) => !state.from || record.publicationDate >= state.from)
    .filter((record) => !state.to || record.publicationDate <= state.to)
    .filter((record) => route !== "history" || !selected.size || selected.has(record.benchmarkId))
    .filter((record) => !query || normalizedText(record.searchText).includes(query));
}

function releaseRecords(indexed) {
  return indexed.data.releases.map((release) => {
    const review = indexed.coverage.get(release.coverage_id);
    const lab = indexed.labs.get(release.lab_id);
    const rawOccurrences = indexed.occurrencesByRelease.get(release.id) || [];
    const retainedCount = retainedReleaseOccurrences(indexed, release.id).length;
    const withheldCount = rawOccurrences.length - retainedCount;
    const coverageState = review?.review_status?.replaceAll("_", " ") || "unavailable";
    const coverageText = `${coverageState}. Recorded coverage review; baseline coverage not reapproved.`;
    return {
      id: release.id,
      release,
      labId: release.lab_id,
      publicationDate: release.publication_date,
      statusIds: [review?.review_status || "unavailable"],
      searchText: [release.id, release.name, lab?.name, release.publication_date, coverageState].join(" "),
      sortValues: { date: release.publication_date, name: release.name, lab: lab?.name || "", coverage: coverageState },
      cells: [formatDate(release.publication_date), lab?.name || "Unknown lab", release.name, coverageText, numberText(retainedCount), numberText(withheldCount)],
      retainedCount,
      withheldCount,
    };
  });
}

function historyRecords(indexed) {
  const occurrences = new Map(indexed.data.occurrences.map((occurrence) => [occurrence.id, occurrence]));
  return indexed.data.derived_statuses.map((status) => {
    const originalBenchmark = indexed.benchmarks.get(status.benchmark_id);
    const benchmarkId = mappedBenchmarkId(indexed.benchmarks, { benchmark_id: status.benchmark_id });
    const benchmark = indexed.benchmarks.get(benchmarkId) || originalBenchmark;
    const release = indexed.releases.get(status.release_id);
    const lab = indexed.labs.get(status.lab_id);
    const labels = status.status_ids.map((id) => indexed.definitions.get(id)?.label || id.replaceAll("_", " "));
    const occurrence = status.occurrence_id ? occurrences.get(status.occurrence_id) : null;
    const identityStatus = originalBenchmark?.identity_status || "canonical";
    const identityDetail = identityStatus === "merged"
      ? `Canonical identity: ${benchmark?.name || benchmarkId}. Original record: ${originalBenchmark?.name || status.benchmark_id}.`
      : identityStatus === "quarantined"
        ? `Historical/withheld identity: ${originalBenchmark?.name || status.benchmark_id}.`
        : benchmark?.name || "Unnamed benchmark";
    const statusText = `${labels.join(", ")}. Recorded lineage status; baseline coverage not reapproved.`;
    return {
      id: status.id,
      rawBenchmarkId: status.benchmark_id,
      benchmarkId,
      identityStatus,
      labId: status.lab_id,
      publicationDate: status.publication_date,
      statusIds: status.status_ids,
      searchText: [status.id, status.benchmark_id, benchmarkId, benchmark?.name, originalBenchmark?.name, release?.name, lab?.name, labels.join(" "), status.publication_date].join(" "),
      sortValues: { date: status.publication_date, benchmark: benchmark?.name || "", release: release?.name || "", status: labels.join(" "), lab: lab?.name || "" },
      cells: [formatDate(status.publication_date), lab?.name || "Unknown lab", identityDetail, release?.name || "Unnamed release", statusText],
      occurrence,
      sourceHref: occurrence ? safeSourceHref(indexed, indexed.sources.get(occurrence.source_id), occurrence.release_id) : null,
      coverage: release ? indexed.coverage.get(release.coverage_id) : null,
    };
  });
}

export function recordsForRoute(route, indexed, state = {}) {
  if (route === "ledger") return releaseRecords(indexed);
  if (route === "history") {
    const records = historyRecords(indexed);
    return state.audit === "all" ? records : records.filter((record) => record.identityStatus !== "quarantined");
  }
  throw new Error(`Unsupported data route: ${route}`);
}

function headersFor(route) {
  if (route === "ledger") return [["Release date", "date"], ["Lab", "lab"], ["Release", "name"], ["Coverage review", "coverage"], ["Retained occurrences", ""], ["Withheld occurrences", ""]];
  return [["Reporting date", "date"], ["Lab", "lab"], ["Benchmark identity", "benchmark"], ["Release", "release"], ["Reporting status", "status"], ["Evidence or coverage review", ""]];
}

function namedOptions(records) {
  return [...records]
    .sort((left, right) => left.name.localeCompare(right.name, "en") || left.id.localeCompare(right.id, "en"))
    .map((record) => ({ value: record.id, label: record.name }));
}

function appendTextRow(parent, label, value) {
  parent.append(element("p", {}, [element("strong", { text: `${label}: ` }), document.createTextNode(String(value))]));
}

class DataRoute {
  constructor(route) {
    this.route = route;
    this.controlsHost = document.querySelector(`[data-route-controls="${route}"]`);
    this.host = document.querySelector(`[data-route-view="${route}"]`);
    this.state = null;
    this.notices = [];
    this.queryInput = null;
    this.search = createTableSearch((value) => {
      this.state = { ...this.state, q: value, page: 1 };
      this.render("pushState", "Search results updated.", "route-query");
    }, SEARCH_DEBOUNCE_MS, window);
  }

  async initialize() {
    if (!this.controlsHost || !this.host) return;
    try {
      const response = await fetch("./public/observatory.json", { cache: "no-store" });
      if (!response.ok) throw new Error(`Generated data request failed with HTTP ${response.status}.`);
      this.indexed = indexData(validateInterface(await response.json()));
      this.applyDecoded(decodeViewState(this.route, window.location.search, this.indexed, window.history.state), true);
      window.addEventListener("popstate", (event) => {
        this.search.cancel();
        this.applyDecoded(decodeViewState(this.route, window.location.search, this.indexed, event.state || {}), false, "View restored from browser history.", event.state?.observatory?.focusedId || "route-query");
      });
      window.addEventListener("pageshow", (event) => {
        if (!event.persisted) return;
        this.search.cancel();
        this.applyDecoded(decodeViewState(this.route, window.location.search, this.indexed, window.history.state || {}), false, "View restored.");
      });
      window.addEventListener("pagehide", () => this.search.cancel());
      window.addEventListener("observatory:flush", () => this.flushForNavigation());
    } catch (error) {
      this.renderError();
      console.error(error);
    }
  }

  applyDecoded(decoded, canonicalize, message = "", focusId = "") {
    this.state = decoded.state;
    this.notices = [...decoded.notices];
    this.render(canonicalize ? "replaceState" : null, message, focusId);
  }

  targetUrl() {
    const url = new URL(window.location.href);
    url.search = encodeViewState(this.route, this.state);
    return `${url.pathname}${url.search}${url.hash}`;
  }

  writeState(method = "replaceState", focusedId = "") {
    window.history[method](historyPayload(window.history.state, this.state, this.route, focusedId), "", this.targetUrl());
  }

  currentSearchText() {
    return routeValue(this.queryInput?.value ?? this.state?.q);
  }

  flushForNavigation() {
    if (!this.state) return;
    const q = this.currentSearchText();
    this.search.cancel();
    this.state = { ...this.state, q };
    this.writeState("replaceState", document.activeElement?.id || "");
  }

  canonicalize(candidate) {
    const decoded = decodeViewState(this.route, encodeViewState(this.route, candidate), this.indexed, {});
    this.notices = decoded.notices;
    return decoded.state;
  }

  mutate(changes, message, focusId = "") {
    const q = this.currentSearchText();
    this.search.cancel();
    this.state = this.canonicalize({ ...this.state, q, page: 1, ...changes });
    this.render("pushState", message, focusId || document.activeElement?.id || "");
  }

  resetTableControls() {
    this.search.cancel();
    this.state = this.canonicalize({
      ...this.state,
      q: "",
      status: "",
      sort: "date",
      dir: "desc",
      size: DEFAULT_PAGE_SIZE,
      page: 1,
      audit: "",
    });
    this.notices = [];
    this.render("pushState", "Table controls reset. Benchmark, lab, date, and chronological context were kept.", "route-query");
  }

  clearResultFilters() {
    this.search.cancel();
    this.state = this.canonicalize({ ...this.state, q: "", lab: "", status: "", from: "", to: "", page: 1 });
    this.notices = [];
    this.render("pushState", "Result filters cleared. Benchmark selection and chronological context were kept.", "route-query");
  }

  renderControls() {
    const panel = element("div", { className: "route-filter-panel", role: "group", "aria-label": `${this.route} filters` });
    const query = element("input", { id: "route-query", name: "q", type: "search", value: this.state.q, maxlength: 200, autocomplete: "off", placeholder: "Search this view" });
    query.addEventListener("input", () => {
      const status = document.querySelector(`#${this.route}-status`);
      if (status) status.textContent = "Updating results…";
      this.search.schedule(query.value);
    });
    this.queryInput = query;
    panel.append(element("div", { className: "field field-search" }, [element("label", { for: "route-query", text: "Search" }), query]));

    if (this.route === "history") {
      const benchmarkPicker = createSearchableCombobox({
        id: "route-benchmark",
        label: "Add benchmark filter",
        value: "",
        options: namedOptions(liveCanonicalBenchmarks(this.indexed.data.benchmarks)),
        emptyLabel: "All benchmarks",
        placeholder: "Find a canonical benchmark",
        onChange: (value) => {
          if (!value) return;
          if (this.state.benchmarks.includes(value)) {
            const status = document.querySelector("#history-status");
            if (status) status.textContent = "That benchmark is already selected.";
            return;
          }
          if (this.state.benchmarks.length >= 6) {
            const status = document.querySelector("#history-status");
            if (status) status.textContent = "History accepts up to six benchmark filters.";
            return;
          }
          this.mutate({ benchmarks: [...this.state.benchmarks, value] }, "Benchmark OR filter updated.", "route-benchmark");
        },
      });
      panel.append(benchmarkPicker.element);
      if (this.state.benchmarks.length) {
        const selected = element("div", { className: "selection-tray", "aria-label": "Selected benchmark OR filters" }, [element("p", { text: "Match one or more selected benchmarks:" })]);
        const chips = element("div", { className: "trends-chips" });
        this.state.benchmarks.forEach((id, index) => {
          const benchmark = this.indexed.benchmarks.get(id);
          const nextId = this.state.benchmarks[index + 1] || this.state.benchmarks[index - 1] || "route-benchmark";
          chips.append(element("span", { className: "trends-chip" }, [
            element("span", { text: `${benchmark?.name || id}${benchmark?.identity_status === "quarantined" ? " (historical/withheld identity)" : ""}` }),
            element("button", {
              id: `history-remove-${id}`,
              type: "button",
              "aria-label": `Remove ${benchmark?.name || id}`,
              text: "Remove",
              onclick: () => this.mutate({ benchmarks: this.state.benchmarks.filter((value) => value !== id) }, "Benchmark OR filter updated.", nextId.startsWith("route-") ? nextId : `history-remove-${nextId}`),
            }),
          ]));
        });
        selected.append(chips);
        panel.append(selected);
      }
    }

    const selectField = (name, label, value, options, key = name) => {
      const select = element("select", { id: `route-${name}`, name });
      options.forEach(([optionValue, optionLabel]) => select.append(element("option", { value: optionValue, text: optionLabel, selected: optionValue === value })));
      select.addEventListener("change", () => this.mutate({ [key]: select.value }, `${label} filter updated.`, select.id));
      return element("div", { className: "field" }, [element("label", { for: select.id, text: label }), select]);
    };
    const labs = namedOptions(this.indexed.data.labs).map((option) => [option.value, option.label]);
    const statuses = this.route === "history"
      ? [...this.indexed.definitions.values()].sort((left, right) => left.label.localeCompare(right.label, "en")).map((item) => [item.id, item.label])
      : [...new Set(this.indexed.data.coverage.map((item) => item.review_status))].sort().map((item) => [item, item.replaceAll("_", " ")]);
    panel.append(selectField("lab", "Lab", this.state.lab, [["", "All labs"], ...labs]));
    panel.append(selectField("status", this.route === "ledger" ? "Coverage review" : "Status", this.state.status, [["", "All states"], ...statuses]));
    const { start, end } = this.indexed.data.corpus.publication_window;
    for (const [name, label] of [["from", this.route === "ledger" ? "From release date" : "From reporting date"], ["to", this.route === "ledger" ? "To release date" : "To reporting date"]]) {
      const input = element("input", { id: `route-${name}`, name, type: "date", value: this.state[name], min: start, max: end });
      input.addEventListener("change", () => this.mutate({ [name]: input.value }, "Date filter updated.", input.id));
      panel.append(element("div", { className: "field" }, [element("label", { for: input.id, text: label }), input]));
    }
    panel.append(selectField("sort", "Sort", this.state.sort, ROUTES[this.route].sorts.map((key) => [key, key[0].toUpperCase() + key.slice(1)]), "sort"));
    panel.append(selectField("dir", "Direction", this.state.dir, [["desc", "Descending"], ["asc", "Ascending"]], "dir"));
    panel.append(selectField("size", "Rows per page", String(this.state.size), PAGE_SIZES.map((size) => [String(size), String(size)]), "size"));
    if (this.route === "history") {
      const audit = element("input", { id: "route-audit", type: "checkbox", checked: this.state.audit === "all" });
      audit.addEventListener("change", () => {
        const benchmarks = audit.checked ? this.state.benchmarks : this.state.benchmarks.filter((id) => this.indexed.benchmarks.get(id)?.identity_status !== "quarantined");
        this.mutate({ audit: audit.checked ? "all" : "", benchmarks }, audit.checked ? "Historical and withheld benchmark identities included." : "Historical and withheld benchmark identities excluded.", audit.id);
      });
      panel.append(element("div", { className: "field" }, [element("label", { for: audit.id, text: "Include historical/withheld identities" }), audit]));
    }
    panel.append(element("div", { className: "filter-actions" }, [
      element("button", { className: "button", type: "button", text: "Copy link", onclick: () => this.copyLink() }),
      element("button", { className: "button button-quiet", type: "button", text: "Reset table controls", onclick: () => this.resetTableControls() }),
    ]));
    this.controlsHost.replaceChildren(panel, element("p", { className: "route-status", id: `${this.route}-status`, role: "status", "aria-live": "polite", tabindex: "-1" }), element("div", { className: "copy-fallback", id: `${this.route}-copy-fallback`, hidden: true }));
  }

  coverageDisclosure(record) {
    const review = record.coverage;
    const article = element("article", { className: "source-disclosure" }, [element("h4", { text: "Coverage review for a source-less lineage status" })]);
    appendTextRow(article, "Coverage review date", review?.review_date || "Not recorded");
    const sourceIds = review?.reviewed_source_ids || [];
    appendTextRow(article, "Reviewed source IDs", sourceIds.length ? sourceIds.join(", ") : "None recorded");
    if (!sourceIds.length) {
      article.append(element("p", { text: "No approved coverage source is recorded for this status row." }));
      return article;
    }
    const list = element("ul", { "aria-label": "Exact approved coverage sources" });
    sourceIds.forEach((sourceId) => {
      const source = this.indexed.sources.get(sourceId);
      const href = safeSourceHref(this.indexed, source, record.labId);
      const item = element("li");
      if (href) item.append(element("a", { href, target: "_blank", rel: "noopener noreferrer", text: `${sourceId}: ${source.url}` }));
      else item.textContent = `${sourceId}: Source link unavailable: destination validation failed. ${source?.url || "No stored URL"}`;
      list.append(item);
    });
    article.append(list, element("p", { text: "Recorded coverage review; baseline coverage not reapproved." }));
    return article;
  }

  releaseTarget(releaseId) {
    const params = new URLSearchParams(navigationSearch(encodeViewState(this.route, this.state)));
    params.set("release", releaseId);
    return `./timeline.html?${params.toString()}`;
  }

  renderTable(page, records, message, clampMessage) {
    const status = document.querySelector(`#${this.route}-status`);
    const label = this.route === "ledger" ? "releases" : "reporting statuses";
    this.host.dataset.total = String(records.length);
    this.host.dataset.pageSize = String(this.state.size);
    this.host.dataset.currentPage = String(page.currentPage);
    const first = records.length ? page.start + 1 : 0;
    const last = records.length ? page.start + page.rows.length : 0;
    const countMessage = records.length
      ? `Showing ${first} to ${last} of ${records.length} ${label}. Page ${page.currentPage} of ${page.totalPages}.`
      : `No ${label} match the selected filters.`;
    status.textContent = [message, clampMessage, ...this.notices, countMessage].filter(Boolean).join(" ");
    if (!records.length) {
      this.host.replaceChildren(element("section", { className: "empty-state", "aria-labelledby": `${this.route}-empty-title` }, [
        element("h2", { id: `${this.route}-empty-title`, text: "No matching records" }),
        element("p", { text: "No records match the current table filters. The bounded corpus may still be incomplete." }),
        element("button", { className: "button", type: "button", text: "Clear result filters", onclick: () => this.clearResultFilters() }),
      ]));
      return;
    }

    const table = element("table");
    table.append(element("caption", { text: `Current page of ${label}. ${records.length} matching records remain reachable through pagination.` }));
    const head = element("thead");
    head.append(element("tr", {}, headersFor(this.route).map(([labelText, sort]) => element("th", { scope: "col", text: labelText, "aria-sort": sort ? (this.state.sort === sort ? (this.state.dir === "asc" ? "ascending" : "descending") : "none") : null }))));
    const body = element("tbody");
    page.rows.forEach((record) => {
      const row = element("tr");
      record.cells.forEach((cell, index) => {
        const tableCell = element("td");
        if (this.route === "ledger" && index === 2) tableCell.append(element("a", { href: this.releaseTarget(record.id), text: cell }));
        else tableCell.textContent = cell;
        row.append(tableCell);
      });
      if (this.route === "history") {
        const evidence = element("td");
        evidence.append(record.occurrence ? sourceDisclosure(this.indexed, record.occurrence) : this.coverageDisclosure(record));
        row.append(evidence);
      }
      body.append(row);
    });
    table.append(head, body);
    const navigation = element("nav", { className: "route-pagination", "aria-label": `${label} pagination` });
    const button = (name, target, disabled) => {
      const id = `${this.route}-page-${name.toLowerCase()}`;
      return element("button", { id, type: "button", text: name, disabled, "aria-label": `${name} page`, onclick: () => this.mutate({ page: target }, `Page ${target} selected.`, id) });
    };
    navigation.append(
      button("First", 1, page.currentPage === 1),
      button("Previous", page.currentPage - 1, page.currentPage === 1),
      element("span", { className: "pagination-summary", "aria-hidden": "true", text: `Page ${page.currentPage} of ${page.totalPages}` }),
      button("Next", page.currentPage + 1, page.currentPage === page.totalPages),
      button("Last", page.totalPages, page.currentPage === page.totalPages),
    );
    this.host.replaceChildren(element("div", { className: "table-wrap", role: "region", "aria-label": `${label} table`, tabindex: "0" }, table), navigation);
  }

  render(method = null, message = "", focusId = "") {
    const allRecords = recordsForRoute(this.route, this.indexed, this.state);
    const records = sortRecords(filterRecords(this.route, allRecords, this.state), this.state.sort, this.state.dir);
    const requestedPage = this.state.page;
    const page = paginate(records, requestedPage, this.state.size);
    const clampMessage = page.currentPage === requestedPage ? "" : `Requested page ${requestedPage} is outside the filtered result set. Showing page ${page.currentPage} instead.`;
    if (page.currentPage !== requestedPage) this.state = { ...this.state, page: page.currentPage };
    if (method) this.writeState(method, focusId);
    this.renderControls();
    this.renderTable(page, records, message, clampMessage);
    if (focusId) requestAnimationFrame(() => {
      const target = document.getElementById(focusId);
      if (target && !target.disabled && target.isConnected) {
        target.focus({ preventScroll: true });
        if (typeof HTMLInputElement !== "undefined" && target instanceof HTMLInputElement && ["search", "text"].includes(target.type)) target.setSelectionRange(target.value.length, target.value.length);
      } else {
        const status = document.querySelector(`#${this.route}-status`);
        status?.focus({ preventScroll: true });
      }
    });
  }

  async copyLink() {
    const q = this.currentSearchText();
    this.search.cancel();
    this.state = this.canonicalize({ ...this.state, q });
    this.writeState("replaceState", document.activeElement?.id || "");
    const value = new URL(this.targetUrl(), window.location.origin).href;
    const fallback = document.querySelector(`#${this.route}-copy-fallback`);
    try {
      await navigator.clipboard.writeText(value);
      fallback.hidden = true;
      document.querySelector(`#${this.route}-status`).textContent = "Shareable table link copied.";
    } catch {
      const input = element("input", { type: "text", readonly: true, "aria-label": "Shareable table URL" });
      input.value = value;
      fallback.replaceChildren(element("label", { text: "Copy this shareable table URL" }), input);
      fallback.hidden = false;
      input.focus();
      input.select();
    }
  }

  renderError() {
    this.search.cancel();
    this.controlsHost.replaceChildren();
    this.host.replaceChildren(element("section", { className: "empty-state", role: "alert" }, [
      element("h2", { text: "Data unavailable" }),
      element("p", { text: "The Observatory records or interface contract could not be loaded." }),
      element("button", { className: "button", type: "button", text: "Reload", onclick: () => window.location.reload() }),
    ]));
  }
}

async function initialize() {
  const route = document.body?.dataset.page;
  if (!ROUTES[route]) return;
  await new DataRoute(route).initialize();
}

if (typeof document !== "undefined") void initialize();
