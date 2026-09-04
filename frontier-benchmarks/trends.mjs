import {
  captureCenterDate,
  collisionRows,
  createSearchableCombobox,
  datePosition,
  formatDate,
  indexData,
  isLiveCanonical,
  liveCanonicalBenchmarks,
  mappedBenchmarkId,
  normalize,
  recentModelCount,
  recentModelCountLabel,
  restoreCenterDate,
  scrollToNewest,
  timelineTicks,
  validateInterface,
} from "./core.mjs";

export const MAX_SELECTIONS = 6;
export const DEFAULT_BENCHMARK_ID = "benchmark_terminal_bench_2_0";
export const ZOOM_LEVELS = Object.freeze([1, 2, 4]);
export const DEFAULT_ZOOM = ZOOM_LEVELS[0];
const FILTER_KEYS = ["category", "lab", "from", "to", "zoom"];
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const LAB_COLORS = ["#315b8a", "#8b5540", "#31725f", "#735a91", "#8a6a2f", "#8a4564"];

const stableCompare = (left, right) => {
  const a = normalize(left);
  const b = normalize(right);
  if (a < b) return -1;
  if (a > b) return 1;
  const rawA = String(left);
  const rawB = String(right);
  return rawA.localeCompare(rawB, "en");
};

const matchClass = (value, query) => {
  const candidate = normalize(value);
  if (!candidate || !query) return -1;
  if (candidate === query) return 0;
  if (candidate.startsWith(query)) return 1;
  const candidateTokens = candidate.split(" ");
  const queryTokens = query.split(" ");
  if (queryTokens.every((queryToken) => candidateTokens.some((candidateToken) => candidateToken.startsWith(queryToken)))) return 2;
  return candidate.includes(query) ? 3 : -1;
};

const benchmarkCatalog = (benchmarks = []) => liveCanonicalBenchmarks(benchmarks.map((benchmark) => typeof benchmark === "string" ? { id: benchmark, name: benchmark } : benchmark));

const compareBenchmarkIds = (records, leftId, rightId) => {
  const leftName = normalize(records.get(leftId)?.name || leftId);
  const rightName = normalize(records.get(rightId)?.name || rightId);
  if (leftName < rightName) return -1;
  if (leftName > rightName) return 1;
  return String(leftId).localeCompare(String(rightId), "en");
};

/** Returns matching records ordered by match class, canonical-name provenance, canonical name, then ID. */
export function rankBenchmarks(benchmarks = [], query = "") {
  const needle = normalize(query);
  return benchmarks
    .map((benchmark) => {
      if (!needle) return { benchmark, rank: 0, provenanceRank: 0 };
      const canonicalRank = matchClass(benchmark.name, needle);
      const aliasRank = Math.min(...(benchmark.aliases || []).map((alias) => matchClass(alias, needle)).filter((rank) => rank >= 0));
      if (canonicalRank < 0 && !Number.isFinite(aliasRank)) return null;
      if (canonicalRank >= 0 && (!Number.isFinite(aliasRank) || canonicalRank <= aliasRank)) {
        return { benchmark, rank: canonicalRank, provenanceRank: 0 };
      }
      return { benchmark, rank: aliasRank, provenanceRank: 1 };
    })
    .filter(Boolean)
    .sort((left, right) => left.rank - right.rank
      || left.provenanceRank - right.provenanceRank
      || stableCompare(left.benchmark.name, right.benchmark.name)
      || stableCompare(left.benchmark.id, right.benchmark.id))
    .map(({ benchmark }) => benchmark);
}

/** Returns up to six unique valid IDs in canonical name and ID order, with one deterministic fallback when needed. */
export function sanitizeBenchmarkIds(values = [], benchmarks = [], defaultId = DEFAULT_BENCHMARK_ID) {
  const catalog = benchmarkCatalog(benchmarks);
  const records = new Map(catalog.map((benchmark) => [benchmark.id, benchmark]));
  const selected = [];
  for (const value of values || []) {
    if (!records.has(value) || selected.includes(value)) continue;
    selected.push(value);
    if (selected.length === MAX_SELECTIONS) break;
  }
  if (selected.length) return selected.sort((left, right) => compareBenchmarkIds(records, left, right));
  if (records.has(defaultId)) return [defaultId];
  return catalog.length ? [catalog.slice().sort((left, right) => compareBenchmarkIds(records, left.id, right.id))[0].id] : [];
}

/** Returns an ordered array of sanitized benchmark IDs parsed from a URL search string. */
export function parseBenchmarkState(search = "", benchmarks = [], defaultId = DEFAULT_BENCHMARK_ID) {
  return sanitizeBenchmarkIds(new URLSearchParams(search).getAll("benchmark"), benchmarks, defaultId);
}

const isIsoDate = (value) => {
  if (typeof value !== "string" || !ISO_DATE.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
};

export function sanitizeTrendsFilters(candidate, data) {
  const allowedCategories = new Set((data.categories || []).map((item) => item.id));
  const allowedLabs = new Set((data.labs || []).map((item) => item.id));
  const start = data.corpus?.publication_window?.start;
  const end = data.corpus?.publication_window?.end;
  const isDateInWindow = (value) => isIsoDate(value) && (!start || value >= start) && (!end || value <= end);
  let from = isDateInWindow(candidate.from || "") ? candidate.from : "";
  let to = isDateInWindow(candidate.to || "") ? candidate.to : "";
  if (from && to && from > to) [from, to] = ["", ""];
  const zoom = String(candidate.zoom || "");
  return {
    category: allowedCategories.has(candidate.category) ? candidate.category : "",
    lab: allowedLabs.has(candidate.lab) ? candidate.lab : "",
    from,
    to,
    zoom: ZOOM_LEVELS.map(String).includes(zoom) ? Number(zoom) : DEFAULT_ZOOM,
  };
}

export function parseTrendsState(search = "", benchmarks = [], data = {}, defaultId = DEFAULT_BENCHMARK_ID) {
  const params = new URLSearchParams(search);
  return {
    ids: sanitizeBenchmarkIds(params.getAll("benchmark"), benchmarks, defaultId),
    filters: sanitizeTrendsFilters({
      category: params.get("category") || "",
      lab: params.get("lab") || "",
      from: params.get("from") || "",
      to: params.get("to") || "",
      zoom: params.get("zoom") || "",
    }, data),
  };
}

/** Returns a canonical query string with one repeated benchmark key per ordered ID. */
export function serializeBenchmarkState(ids = []) {
  const params = new URLSearchParams();
  for (const id of ids) params.append("benchmark", String(id));
  const query = params.toString();
  return query ? `?${query}` : "";
}

export function serializeTrendsState(ids = [], filters = {}) {
  const params = new URLSearchParams();
  for (const id of ids) params.append("benchmark", String(id));
  for (const key of FILTER_KEYS) {
    const value = filters[key];
    if (!value || (key === "zoom" && Number(value) === DEFAULT_ZOOM)) continue;
    params.set(key, String(value));
  }
  const query = params.toString();
  return query ? `?${query}` : "";
}

/** Applies one picker toggle while preserving the final-chip invariant and six-selection cap. */
export function transitionBenchmarkSelection(ids = [], benchmarkId = "", benchmarks = []) {
  const catalog = benchmarkCatalog(benchmarks);
  const allowed = new Set(catalog.map((benchmark) => benchmark.id));
  const current = sanitizeBenchmarkIds(ids, catalog);
  if (!allowed.has(benchmarkId)) return { ids: current, outcome: "invalid" };
  if (current.includes(benchmarkId)) {
    if (current.length === 1) return { ids: current, outcome: "final" };
    return { ids: sanitizeBenchmarkIds(current.filter((id) => id !== benchmarkId), catalog), outcome: "removed" };
  }
  if (current.length >= MAX_SELECTIONS) return { ids: current, outcome: "limit" };
  return { ids: sanitizeBenchmarkIds([...current, benchmarkId], catalog), outcome: "added" };
}

/** Returns release matches as ordered { release, benchmarkIds, occurrences } records. */
export function releaseMatches(indexed, selectedIds = [], filters = {}) {
  const orderedIds = [...new Set(selectedIds)].filter((id) => indexed.benchmarks.has(id) && isLiveCanonical(indexed.benchmarks.get(id)));
  const selected = new Set(orderedIds);
  const lab = filters.lab || "";
  const from = filters.from || "";
  const to = filters.to || "";
  return [...indexed.data.releases]
    .filter((release) => !lab || release.lab_id === lab)
    .filter((release) => !from || release.publication_date >= from)
    .filter((release) => !to || release.publication_date <= to)
    .map((release) => {
      const occurrences = (indexed.occurrencesByRelease.get(release.id) || []).filter((occurrence) => {
        if (occurrence.review_status && occurrence.review_status !== "verified") return false;
        return selected.has(mappedBenchmarkId(indexed.benchmarks, occurrence));
      });
      if (!occurrences.length) return null;
      return {
        release,
        benchmarkIds: orderedIds.filter((id) => occurrences.some((occurrence) => mappedBenchmarkId(indexed.benchmarks, occurrence) === id)),
        occurrences: [...occurrences].sort((left, right) => orderedIds.indexOf(mappedBenchmarkId(indexed.benchmarks, left)) - orderedIds.indexOf(mappedBenchmarkId(indexed.benchmarks, right)) || stableCompare(left.id, right.id)),
      };
    })
    .filter(Boolean)
    .sort((left, right) => stableCompare(left.release.publication_date, right.release.publication_date)
      || stableCompare(left.release.name, right.release.name)
      || stableCompare(left.release.id, right.release.id));
}

/** Returns every exact occurrence represented in one selected benchmark lane. */
export function laneOccurrences(matches = [], benchmarkId = "", indexed = null) {
  return matches.flatMap((match) => match.occurrences
    .filter((occurrence) => {
      if (!indexed) return occurrence.benchmark_id === benchmarkId;
      return mappedBenchmarkId(indexed.benchmarks, occurrence) === benchmarkId;
    })
    .map((occurrence) => ({ match, occurrence })));
}

const element = (tag, options = {}, children = []) => {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(options)) {
    if (value === undefined || value === null || value === false) continue;
    if (name === "className") node.className = value;
    else if (name === "text") node.textContent = value;
    else if (name === "style") Object.entries(value).forEach(([property, propertyValue]) => node.style.setProperty(property, propertyValue));
    else if (name.startsWith("on")) node.addEventListener(name.slice(2).toLowerCase(), value);
    else if (value === true) node.setAttribute(name, "");
    else node.setAttribute(name, value);
  }
  for (const child of Array.isArray(children) ? children : [children]) if (child) node.append(child);
  return node;
};

const replaceChildren = (target, children = []) => target.replaceChildren(...children.filter(Boolean));

class Trends {
  constructor() {
    this.pickerHost = document.querySelector("#trends-picker");
    this.chartHost = document.querySelector("#trends-chart");
    this.detailHost = document.querySelector("#trends-detail");
    this.indexed = null;
    this.selectedIds = [];
    this.filters = { category: "", lab: "", from: "", to: "", zoom: DEFAULT_ZOOM };
    this.searchQuery = "";
    this.options = [];
    this.activeOption = -1;
    this.pinnedReleaseId = "";
    this.triggeringMarker = null;
    this.hoveredReleaseId = "";
    this.focusedReleaseId = "";
    this.markersByRelease = new Map();
  }

  isUiFixture(url = new URL(window.location.href)) {
    return url.searchParams.get("fixture") === "ui" && ["localhost", "127.0.0.1"].includes(url.hostname);
  }

  async loadData() {
    if (this.isUiFixture()) return (await import("./tests/ui/fixture.mjs")).fixture;
    const response = await fetch("./public/observatory.json");
    if (!response.ok) throw new Error(`Generated trends request failed (${response.status}).`);
    return response.json();
  }

  canonicalUrl(ids = this.selectedIds, filters = this.filters) {
    const url = new URL(window.location.href);
    const fixture = this.isUiFixture(url);
    url.search = serializeTrendsState(ids, filters);
    if (fixture) url.searchParams.append("fixture", "ui");
    return url;
  }

  historyTarget(url) {
    return `${url.pathname}${url.search}${url.hash}`;
  }

  historyPayload(centerDate = this.centerDate) {
    const payload = { ...(window.history.state || {}) };
    if (centerDate) payload.trendsCenterDate = centerDate;
    return payload;
  }

  currentFrame() {
    return this.chartHost?.querySelector(".trends-frame");
  }

  corpusWindow() {
    return this.indexed.data.corpus.publication_window;
  }

  captureViewportDate() {
    const frame = this.currentFrame();
    if (!frame || !this.indexed) return this.centerDate;
    const { start, end } = this.corpusWindow();
    this.centerDate = captureCenterDate(frame, start, end);
    return this.centerDate;
  }

  restoreViewport(options = {}) {
    const frame = this.currentFrame();
    if (!frame || !this.indexed) return;
    const { start, end } = this.corpusWindow();
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (options.newest) scrollToNewest(frame);
      else restoreCenterDate(frame, this.centerDate || end, start, end);
      this.centerDate = captureCenterDate(frame, start, end);
      window.history.replaceState(this.historyPayload(this.centerDate), "", this.historyTarget(this.canonicalUrl()));
    }));
  }

  replaceCanonicalUrl() {
    const url = this.canonicalUrl();
    const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    const target = this.historyTarget(url);
    if (target !== current) window.history.replaceState(this.historyPayload(), "", target);
  }

  pushSelection(ids, message, newest = false) {
    this.captureViewportDate();
    this.selectedIds = sanitizeBenchmarkIds(ids, this.indexed.data.benchmarks, DEFAULT_BENCHMARK_ID);
    const url = this.canonicalUrl();
    window.history.pushState(this.historyPayload(), "", this.historyTarget(url));
    this.render(message, { newest });
  }

  async initialize() {
    if (!this.pickerHost || !this.chartHost || !this.detailHost) return;
    try {
      this.indexed = indexData(validateInterface(await this.loadData()));
      const parsed = parseTrendsState(window.location.search, this.indexed.data.benchmarks, this.indexed.data, DEFAULT_BENCHMARK_ID);
      this.selectedIds = parsed.ids;
      this.filters = parsed.filters;
      this.centerDate = window.history.state?.trendsCenterDate || "";
      this.replaceCanonicalUrl();
      this.renderPicker();
      this.render("", { newest: !this.centerDate });
      window.addEventListener("popstate", (event) => {
        const restored = parseTrendsState(window.location.search, this.indexed.data.benchmarks, this.indexed.data, DEFAULT_BENCHMARK_ID);
        this.selectedIds = restored.ids;
        this.filters = restored.filters;
        this.centerDate = event.state?.trendsCenterDate || this.centerDate;
        this.replaceCanonicalUrl();
        this.syncFilterControls();
        this.render("Selection restored from browser history.");
      });
      window.addEventListener("resize", () => {
        this.captureViewportDate();
        this.restoreViewport();
      });
      document.addEventListener("keydown", (event) => {
        if (event.defaultPrevented || event.key !== "Escape" || !this.pinnedReleaseId) return;
        event.preventDefault();
        this.closeDetail(true);
      });
    } catch (error) {
      replaceChildren(this.pickerHost, [element("p", { className: "trends-error", role: "alert", text: "Benchmark choices could not be loaded." })]);
      replaceChildren(this.chartHost, [element("p", { className: "trends-error", role: "alert", text: "Trends data could not be loaded. Refresh the page or try again later." })]);
    }
  }

  renderPicker() {
    this.chips = element("div", { className: "trends-chips", role: "list", "aria-label": "Selected benchmarks" });
    this.input = element("input", {
      id: "benchmark-picker-input",
      type: "search",
      role: "combobox",
      autocomplete: "off",
      placeholder: "Search benchmarks",
      "aria-autocomplete": "list",
      "aria-haspopup": "listbox",
      "aria-expanded": "false",
      "aria-controls": "benchmark-picker-options",
      "aria-describedby": "benchmark-picker-help",
    });
    this.listbox = element("ul", { id: "benchmark-picker-options", className: "trends-options", role: "listbox", "aria-label": "Benchmark choices", "aria-multiselectable": "true", hidden: true });
    this.count = element("span", { className: "trends-selection-count" });
    this.live = element("p", { className: "visually-hidden", role: "status", "aria-live": "polite", "aria-atomic": "true" });
    const field = element("div", { className: "trends-combobox" }, [this.input, this.listbox]);
    const data = this.indexed.data;
    const categories = [{ value: "", label: "All categories" }, ...[...data.categories]
      .sort((left, right) => left.name.localeCompare(right.name, "en"))
      .map((item) => ({ value: item.id, label: item.name, searchText: (item.aliases || []).join(" ") }))];
    this.categoryControl = createSearchableCombobox({
      id: "trends-category",
      label: "Category",
      value: this.filters.category,
      options: categories,
      emptyLabel: "All categories",
      placeholder: "Find a category",
      onChange: (value) => this.updateFilters({ category: value }),
    });
    const lab = element("select");
    lab.append(element("option", { value: "", text: "All labs" }));
    data.labs.forEach((item) => lab.append(element("option", { value: item.id, text: item.name })));
    const from = element("input", { type: "date", min: data.corpus.publication_window.start, max: data.corpus.publication_window.end });
    const to = element("input", { type: "date", min: data.corpus.publication_window.start, max: data.corpus.publication_window.end });
    const zoom = element("select");
    ZOOM_LEVELS.forEach((level) => zoom.append(element("option", { value: level, text: `${level}×` })));
    const reset = element("button", { className: "button button-quiet", type: "button", text: "Reset" });
    reset.addEventListener("click", () => this.resetView());
    this.filterControls = { lab, from, to, zoom };
    Object.entries(this.filterControls).forEach(([key, control]) => {
      control.id = `trends-${key}`;
      control.addEventListener("change", () => this.updateFilters({ [key]: control.value }));
    });
    const filterField = (key, label, control) => element("div", { className: "field" }, [element("label", { for: control.id, text: label }), control]);
    const filters = element("div", { className: "trends-filter-panel", role: "group", "aria-label": "Trends filters" }, [
      this.categoryControl.element,
      filterField("lab", "Lab", lab),
      filterField("from", "From", from),
      filterField("to", "To", to),
      filterField("zoom", "Zoom", zoom),
      element("div", { className: "filter-actions" }, [reset]),
    ]);
    replaceChildren(this.pickerHost, [
      element("div", { className: "trends-picker-head" }, [element("label", { for: this.input.id, text: "Benchmarks" }), this.count]),
      this.chips,
      field,
      element("p", { id: "benchmark-picker-help", className: "trends-picker-help", text: "Type to filter. Use arrow keys to review choices and Enter to add. Choose 1 to 6 benchmarks." }),
      filters,
      this.live,
    ]);
    this.syncFilterControls();
    this.input.addEventListener("focus", () => this.openOptions());
    this.input.addEventListener("input", () => {
      this.searchQuery = this.input.value;
      this.activeOption = -1;
      this.openOptions();
    });
    this.input.addEventListener("keydown", (event) => this.handlePickerKey(event));
    this.input.addEventListener("blur", () => queueMicrotask(() => {
      if (!this.pickerHost.contains(document.activeElement)) this.closeOptions();
    }));
    document.addEventListener("pointerdown", (event) => {
      if (!this.pickerHost.contains(event.target)) this.closeOptions();
    });
  }

  syncFilterControls() {
    if (this.categoryControl) this.categoryControl.setValue(this.filters.category);
    Object.entries(this.filterControls || {}).forEach(([key, control]) => {
      control.value = this.filters[key] ?? "";
    });
  }

  updateFilters(changes) {
    this.captureViewportDate();
    this.filters = sanitizeTrendsFilters({ ...this.filters, ...changes }, this.indexed.data);
    window.history.pushState(this.historyPayload(), "", this.historyTarget(this.canonicalUrl()));
    this.syncFilterControls();
    this.render("Filters updated.");
  }

  resetView() {
    this.filters = sanitizeTrendsFilters({ category: "", lab: "", from: "", to: "", zoom: DEFAULT_ZOOM }, this.indexed.data);
    this.selectedIds = sanitizeBenchmarkIds([DEFAULT_BENCHMARK_ID], this.indexed.data.benchmarks, DEFAULT_BENCHMARK_ID);
    this.searchQuery = "";
    if (this.input) this.input.value = "";
    window.history.pushState(this.historyPayload(), "", this.historyTarget(this.canonicalUrl()));
    this.syncFilterControls();
    this.render("Filters reset.", { newest: true });
  }

  countLabel(benchmarkId) {
    const count = recentModelCount(this.indexed.data, benchmarkId);
    return `${count} ${recentModelCountLabel(this.indexed.data)}`;
  }

  versionlessNote(benchmark) {
    return benchmark?.id === "benchmark_terminal_bench" ? "version not stated by source" : "";
  }

  render(message = "", options = {}) {
    this.renderChips();
    this.renderOptions();
    this.renderChart();
    if (this.pinnedReleaseId) this.renderDetail(this.pinnedReleaseId);
    this.restoreViewport(options);
    if (message) this.announce(message);
  }

  renderChips() {
    const chips = this.selectedIds.map((id) => {
      const benchmark = this.indexed.benchmarks.get(id);
      const remove = element("button", { type: "button", "aria-label": `Remove ${benchmark.name}`, "data-remove-benchmark": id, text: "×" });
      remove.addEventListener("click", () => this.removeSelection(id, true));
      const note = this.versionlessNote(benchmark);
      const label = element("span", { text: `${benchmark.name} · ${this.countLabel(id)}` });
      return element("span", { className: "trends-chip", role: "listitem", title: note ? `${benchmark.name} (${note})` : benchmark.name }, [label, note ? element("span", { className: "trends-chip-note", text: note }) : null, remove]);
    });
    replaceChildren(this.chips, chips);
    this.count.textContent = `${this.selectedIds.length} of ${MAX_SELECTIONS} selected`;
  }

  discoveryBenchmarks() {
    const live = liveCanonicalBenchmarks(this.indexed.data.benchmarks);
    if (!this.filters.category) return live;
    return live.filter((benchmark) => benchmark.category_id === this.filters.category || this.selectedIds.includes(benchmark.id));
  }

  renderOptions() {
    if (!this.input) return;
    this.options = rankBenchmarks(this.discoveryBenchmarks(), this.searchQuery);
    if (this.activeOption >= this.options.length) this.activeOption = this.options.length - 1;
    const atLimit = this.selectedIds.length >= MAX_SELECTIONS;
    const nodes = this.options.map((benchmark, index) => {
      const selected = this.selectedIds.includes(benchmark.id);
      const disabled = !selected && atLimit;
      const option = element("li", {
        id: `benchmark-option-${benchmark.id}`,
        className: index === this.activeOption ? "is-active" : "",
        role: "option",
        "aria-selected": String(selected),
        "aria-disabled": String(disabled),
        "data-benchmark-id": benchmark.id,
      }, [
        element("span", { className: "trends-option-name", text: benchmark.name }),
        element("span", { className: "trends-option-count", text: this.countLabel(benchmark.id) }),
        selected ? element("span", { className: "trends-option-state", text: "Selected" }) : null,
      ]);
      option.addEventListener("pointerdown", (event) => event.preventDefault());
      option.addEventListener("click", () => {
        if (selected) this.removeSelection(benchmark.id, false);
        else this.addSelection(benchmark.id);
      });
      return option;
    });
    replaceChildren(this.listbox, nodes.length ? nodes : [element("li", { className: "trends-option-empty", text: "No benchmarks match this search." })]);
    this.syncActiveOption(false);
  }

  openOptions() {
    this.listbox.hidden = false;
    this.input.setAttribute("aria-expanded", "true");
    this.renderOptions();
  }

  closeOptions() {
    this.listbox.hidden = true;
    this.input.setAttribute("aria-expanded", "false");
    this.input.removeAttribute("aria-activedescendant");
    this.activeOption = -1;
  }

  syncActiveOption(scroll = true) {
    const optionNodes = [...this.listbox.querySelectorAll('[role="option"]')];
    optionNodes.forEach((option, index) => option.classList.toggle("is-active", index === this.activeOption));
    const active = optionNodes[this.activeOption];
    if (!active) {
      this.input.removeAttribute("aria-activedescendant");
      return;
    }
    this.input.setAttribute("aria-activedescendant", active.id);
    if (scroll) active.scrollIntoView({ block: "nearest" });
  }

  handlePickerKey(event) {
    const navigates = ["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key);
    if (navigates) {
      event.preventDefault();
      if (this.listbox.hidden) this.openOptions();
      if (!this.options.length) return;
      if (event.key === "Home") this.activeOption = 0;
      else if (event.key === "End") this.activeOption = this.options.length - 1;
      else if (event.key === "ArrowDown") this.activeOption = Math.min(this.options.length - 1, this.activeOption + 1);
      else this.activeOption = this.activeOption <= 0 ? 0 : this.activeOption - 1;
      this.syncActiveOption();
      return;
    }
    if (event.key === "Enter" && !this.listbox.hidden && this.activeOption >= 0) {
      event.preventDefault();
      const benchmark = this.options[this.activeOption];
      if (benchmark && this.selectedIds.includes(benchmark.id)) this.removeSelection(benchmark.id, false);
      else if (benchmark) this.addSelection(benchmark.id);
      return;
    }
    if (event.key === "Escape" && !this.listbox.hidden) {
      event.preventDefault();
      event.stopPropagation();
      this.closeOptions();
      return;
    }
    if (event.key === "Backspace" && !this.input.value && !this.searchQuery) {
      event.preventDefault();
      this.removeSelection(this.selectedIds[this.selectedIds.length - 1], false);
    }
  }

  addSelection(id) {
    const result = transitionBenchmarkSelection(this.selectedIds, id, this.indexed.data.benchmarks);
    if (result.outcome === "invalid") return;
    if (result.outcome === "limit") {
      this.announce("Six benchmarks are already selected. Remove one before adding another.");
      return;
    }
    if (result.outcome !== "added") return;
    const name = this.indexed.benchmarks.get(id).name;
    this.searchQuery = "";
    this.input.value = "";
    this.activeOption = -1;
    this.pushSelection(result.ids, `${name} selected. ${result.ids.length} of ${MAX_SELECTIONS} benchmarks selected.`);
    this.input.focus();
    this.openOptions();
  }

  removeSelection(id, focusNearestChip) {
    const benchmark = this.indexed.benchmarks.get(id);
    if (!benchmark) return;
    const selectedIndex = this.selectedIds.indexOf(id);
    const result = transitionBenchmarkSelection(this.selectedIds, id, this.indexed.data.benchmarks);
    if (result.outcome === "final") {
      this.announce(`${benchmark.name} remains selected. Choose a replacement before removing the final benchmark.`);
      this.input.focus();
      this.openOptions();
      return;
    }
    if (result.outcome !== "removed") return;
    const nearestId = result.ids[Math.min(selectedIndex, result.ids.length - 1)];
    this.pushSelection(result.ids, `${benchmark.name} removed. ${result.ids.length} of ${MAX_SELECTIONS} benchmarks selected.`);
    if (focusNearestChip && nearestId) {
      requestAnimationFrame(() => [...this.chips.querySelectorAll("button")].find((button) => button.dataset.removeBenchmark === nearestId)?.focus());
      return;
    }
    this.input.focus();
    this.openOptions();
  }

  announce(message) {
    this.live.textContent = "";
    requestAnimationFrame(() => { this.live.textContent = message; });
  }

  labColor(labId) {
    const index = this.indexed.data.labs.findIndex((lab) => lab.id === labId);
    return LAB_COLORS[(index < 0 ? 0 : index) % LAB_COLORS.length];
  }

  renderChart() {
    const matches = releaseMatches(this.indexed, this.selectedIds, this.filters);
    const laneCounts = this.selectedIds.map((id) => laneOccurrences(matches, id, this.indexed).length);
    const zoom = this.filters.zoom || DEFAULT_ZOOM;
    const chartWidth = Math.max(1120, Math.min(7200, 280 + Math.max(0, ...laneCounts) * 190)) * zoom;
    this.markersByRelease = new Map();
    const representedLabs = this.indexed.data.labs.filter((lab) => matches.some((match) => match.release.lab_id === lab.id));
    const legend = element("ul", { className: "trends-legend", "aria-label": "Lab legend" }, representedLabs.map((lab) => element("li", { style: { "--lab-color": this.labColor(lab.id) } }, [element("span", { "aria-hidden": "true" }), element("span", { text: lab.name })])));
    const summary = element("div", { className: "trends-chart-summary" }, [element("p", { text: `${matches.length} distinct release${matches.length === 1 ? "" : "s"} match the selected benchmarks.` }), legend]);
    const empty = matches.length ? null : element("div", { className: "trends-empty" }, [element("h3", { text: "No reviewed occurrences" }), element("p", { text: "No release in the reviewed source record names the selected benchmark set. Choose another benchmark to continue." })]);
    if (!matches.length) {
      this.closeDetail(false);
    }
    const start = this.indexed.data.corpus.publication_window.start;
    const end = this.indexed.data.corpus.publication_window.end;
    const axis = element("div", { className: "trends-axis", "aria-hidden": "true" }, timelineTicks(start, end, 8).map((date) => element("span", { className: "trends-axis-tick", style: { left: `${datePosition(date, start, end)}%` } }, [element("span", { text: formatDate(date) })])));
    const canvas = element("div", { className: "trends-canvas", style: { width: `${chartWidth}px` } }, [axis]);
    this.selectedIds.forEach((benchmarkId) => canvas.append(this.renderLane(benchmarkId, matches, start, end, chartWidth)));
    const frame = element("div", { className: "trends-frame", tabindex: "0", role: "region", "aria-label": "Horizontally scrollable benchmark trends chart" }, [canvas]);
    frame.addEventListener("scroll", () => {
      if (this.scrollFramePending) return;
      this.scrollFramePending = requestAnimationFrame(() => {
        this.scrollFramePending = null;
        this.captureViewportDate();
        window.history.replaceState(this.historyPayload(this.centerDate), "", this.historyTarget(this.canonicalUrl()));
      });
    }, { passive: true });
    replaceChildren(this.chartHost, [summary, empty, frame]);
    this.syncMarkerHighlights();
  }

  renderLane(benchmarkId, matches, start, end, chartWidth) {
    const benchmark = this.indexed.benchmarks.get(benchmarkId);
    const occurrences = laneOccurrences(matches, benchmarkId, this.indexed);
    const trackWidth = Math.max(1, chartWidth - 210);
    const positions = occurrences.map(({ match }) => (datePosition(match.release.publication_date, start, end) / 100) * trackWidth);
    const rows = collisionRows(positions, 178);
    const rowCount = Math.max(1, ...rows.map((row) => row + 1));
    const lane = element("section", { className: "trends-lane", style: { "--lane-rows": rowCount }, "aria-labelledby": `trends-lane-${benchmarkId}` });
    const note = this.versionlessNote(benchmark);
    lane.append(element("h3", { id: `trends-lane-${benchmarkId}`, className: "trends-lane-label", title: benchmark.name }, [
      element("span", { text: benchmark.name }),
      element("span", { className: "trends-lane-count", text: this.countLabel(benchmarkId) }),
      note ? element("span", { className: "trends-lane-note", text: note }) : null,
    ]));
    const track = element("div", { className: "trends-track" });
    occurrences.forEach(({ match, occurrence }, index) => track.append(this.renderMarker(match, occurrence, benchmark, rows[index], datePosition(match.release.publication_date, start, end))));
    lane.append(track);
    return lane;
  }

  renderMarker(match, occurrence, benchmark, row, position) {
    const release = match.release;
    const lab = this.indexed.labs.get(release.lab_id);
    const model = this.indexed.models.get(occurrence.model_id || release.model_id);
    const badge = element("span", { className: "trends-marker-lab", style: { "--lab-color": this.labColor(release.lab_id) }, text: lab?.name || "Unknown lab" });
    const marker = element("button", {
      className: `trends-marker${position > 98 ? " edge-end" : ""}`,
      type: "button",
      "data-release-id": release.id,
      "data-occurrence-id": occurrence.id,
      "aria-pressed": String(this.pinnedReleaseId === release.id),
      "aria-controls": "trends-detail",
      "aria-label": `${model?.name || "Unknown model"}, ${release.name}, ${lab?.name || "Unknown lab"}, ${formatDate(release.publication_date)}, reported with ${benchmark.name}`,
      style: { "--lab-color": this.labColor(release.lab_id), left: `${position}%`, top: `${0.65 + row * 3.1}rem` },
    }, [element("span", { className: "trends-marker-name", text: model?.name || release.name, title: `${model?.name || "Unknown model"} · ${release.name}` }), badge]);
    const markers = this.markersByRelease.get(release.id) || [];
    markers.push(marker);
    this.markersByRelease.set(release.id, markers);
    marker.addEventListener("mouseenter", () => {
      this.hoveredReleaseId = release.id;
      this.syncMarkerHighlights();
    });
    marker.addEventListener("mouseleave", () => {
      if (this.hoveredReleaseId === release.id) this.hoveredReleaseId = "";
      this.syncMarkerHighlights();
    });
    marker.addEventListener("focus", () => {
      this.focusedReleaseId = release.id;
      this.syncMarkerHighlights();
    });
    marker.addEventListener("blur", () => {
      if (this.focusedReleaseId === release.id) this.focusedReleaseId = "";
      this.syncMarkerHighlights();
    });
    marker.addEventListener("click", () => {
      this.triggeringMarker = marker;
      this.pinnedReleaseId = release.id;
      this.renderDetail(release.id);
      this.syncMarkerHighlights();
      requestAnimationFrame(() => this.detailHost.querySelector(".detail-close")?.focus({ preventScroll: true }));
    });
    return marker;
  }

  syncMarkerHighlights() {
    for (const [releaseId, markers] of this.markersByRelease) {
      const highlighted = releaseId === this.hoveredReleaseId || releaseId === this.focusedReleaseId || releaseId === this.pinnedReleaseId;
      for (const marker of markers) {
        marker.classList.toggle("is-highlighted", highlighted);
        marker.setAttribute("aria-pressed", String(releaseId === this.pinnedReleaseId));
      }
    }
  }

  safeSourceHref(source, labId) {
    try {
      if (!source || source.lab_id !== labId) return null;
      const url = new URL(source.url);
      const lab = this.indexed.labs.get(labId);
      const host = url.hostname.toLowerCase().replace(/\.$/, "");
      const allowed = (lab?.official_domains || []).map((domain) => domain.toLowerCase().replace(/\.$/, ""));
      const official = allowed.some((domain) => host === domain || host.endsWith(`.${domain}`));
      return url.protocol === "https:" && !url.username && !url.password && !url.port && official ? url.href : null;
    } catch (_) {
      return null;
    }
  }

  renderDetail(releaseId) {
    const match = releaseMatches(this.indexed, this.selectedIds, this.filters).find((candidate) => candidate.release.id === releaseId);
    if (!match) {
      this.closeDetail(false);
      return;
    }
    const release = match.release;
    const lab = this.indexed.labs.get(release.lab_id);
    const model = this.indexed.models.get(release.model_id);
    const close = element("button", { className: "detail-close icon-button", type: "button", "aria-label": "Close release detail", text: "×", onclick: () => this.closeDetail(true) });
    const benchmarks = match.occurrences.map((occurrence) => element("li", { text: this.indexed.benchmarks.get(occurrence.benchmark_id).name }));
    const sources = match.occurrences.map((occurrence, index) => {
      const source = this.indexed.sources.get(occurrence.source_id);
      const href = this.safeSourceHref(source, release.lab_id);
      const benchmark = this.indexed.benchmarks.get(occurrence.benchmark_id);
      return element("li", {}, [
        element("span", { text: benchmark.name }),
        href ? element("a", { className: "source-link", href, target: "_blank", rel: "noopener noreferrer", text: `Source ${index + 1}` }) : element("span", { className: "source-unavailable", text: "Validated source link unavailable" }),
      ]);
    });
    this.detailHost.hidden = false;
    this.detailHost.setAttribute("aria-labelledby", "trends-detail-title");
    replaceChildren(this.detailHost, [element("div", { className: "detail-panel trends-detail-panel" }, [
      element("header", { className: "detail-head" }, [element("div", {}, [element("h2", { id: "trends-detail-title", text: release.name }), element("p", { className: "detail-byline", text: `${model?.name || "Unknown model"} · ${lab?.name || "Unknown lab"} · ${formatDate(release.publication_date)}` })]), close]),
      element("h3", { className: "detail-occurrence-title", text: "Selected benchmarks in this release" }),
      element("ul", { className: "trends-detail-benchmarks" }, benchmarks),
      element("h3", { className: "detail-occurrence-title", text: "Reviewed first-party sources" }),
      sources.length ? element("ul", { className: "trends-detail-sources" }, sources) : element("p", { className: "detail-empty", text: "No matching occurrence source is available for this release." }),
    ])]);
  }

  closeDetail(restoreFocus) {
    const trigger = this.triggeringMarker;
    const releaseId = this.pinnedReleaseId;
    this.pinnedReleaseId = "";
    this.triggeringMarker = null;
    this.detailHost.hidden = true;
    replaceChildren(this.detailHost);
    this.syncMarkerHighlights();
    if (!restoreFocus) return;
    const fallback = trigger?.isConnected ? trigger : this.markersByRelease.get(releaseId)?.[0];
    requestAnimationFrame(() => (fallback || this.input)?.focus({ preventScroll: true }));
  }
}

if (typeof document !== "undefined") {
  const trends = new Trends();
  void trends.initialize();
}
