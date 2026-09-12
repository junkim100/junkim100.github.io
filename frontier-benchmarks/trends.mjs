import {
  COMBOBOX_OPTION_LIMIT,
  benchmarkSearchText,
  captureTrackCenter,
  createCancelableSearch,
  createSearchableCombobox,
  datePosition,
  decodeViewState,
  encodeViewState,
  formatDate,
  historyPayload,
  indexData,
  isLiveCanonical,
  liveCanonicalBenchmarks,
  mappedBenchmarkId,
  recentModelCount,
  recentModelCountLabel,
  restoreTrackCenter,
  retainedReleaseOccurrences,
  scrollToNewest,
  sourceDisclosure,
  timelineTicks,
  trackGeometry,
  validateInterface,
} from "./core.mjs";

export const MAX_SELECTIONS = 6;
export const DEFAULT_BENCHMARK_ID = "benchmark_terminal_bench_2_0";
export const ZOOM_LEVELS = Object.freeze([1, 2, 4]);
export const DEFAULT_ZOOM = ZOOM_LEVELS[0];
export const SEARCH_DEBOUNCE_MS = 150;
const ACCEPTED_ZOOM_LEVELS = new Set([1, 1.5, 2, 2.5, 3, 4]);
const LAB_COLORS = ["#315b8a", "#8b5540", "#31725f", "#735a91", "#8a6a2f", "#8a4564"];
const MARKER_GAP = 168;

const stableCompare = (left, right) => {
  const a = String(left).normalize("NFKD").toLocaleLowerCase("en").replaceAll("+", " plus ").replace(/[^a-z0-9]+/g, " ").trim();
  const b = String(right).normalize("NFKD").toLocaleLowerCase("en").replaceAll("+", " plus ").replace(/[^a-z0-9]+/g, " ").trim();
  return a.localeCompare(b, "en");
};

const matchClass = (value, query) => {
  const candidate = String(value).normalize("NFKD").toLocaleLowerCase("en").replaceAll("+", " plus ").replace(/[^a-z0-9]+/g, " ").trim();
  if (!candidate || !query) return -1;
  if (candidate === query) return 0;
  if (candidate.startsWith(query)) return 1;
  const candidateTokens = candidate.split(" ");
  const queryTokens = query.split(" ");
  if (queryTokens.every((queryToken) => candidateTokens.some((candidateToken) => candidateToken.startsWith(queryToken)))) return 2;
  return candidate.includes(query) ? 3 : -1;
};

const normalized = (value) => String(value).normalize("NFKD").toLocaleLowerCase("en").replaceAll("+", " plus ").replace(/[^a-z0-9]+/g, " ").trim();
const benchmarkCatalog = (benchmarks = []) => liveCanonicalBenchmarks(benchmarks.map((benchmark) => typeof benchmark === "string" ? { id: benchmark, name: benchmark } : benchmark));
const compareBenchmarkIds = (records, leftId, rightId) => stableCompare(records.get(leftId)?.name || leftId, records.get(rightId)?.name || rightId) || String(leftId).localeCompare(String(rightId), "en");

/** Returns matching records ordered by match class, canonical-name provenance, canonical name, then ID. */
export function rankBenchmarks(benchmarks = [], query = "") {
  const needle = normalized(query);
  return benchmarks
    .map((benchmark) => {
      if (!needle) return { benchmark, rank: 0, provenanceRank: 0 };
      const canonicalRank = matchClass(benchmark.name, needle);
      const aliasRank = Math.min(...(benchmark.aliases || []).map((alias) => matchClass(alias, needle)).filter((rank) => rank >= 0));
      if (canonicalRank < 0 && !Number.isFinite(aliasRank)) return null;
      if (canonicalRank >= 0 && (!Number.isFinite(aliasRank) || canonicalRank <= aliasRank)) return { benchmark, rank: canonicalRank, provenanceRank: 0 };
      return { benchmark, rank: aliasRank, provenanceRank: 1 };
    })
    .filter(Boolean)
    .sort((left, right) => left.rank - right.rank || left.provenanceRank - right.provenanceRank || stableCompare(left.benchmark.name, right.benchmark.name) || stableCompare(left.benchmark.id, right.benchmark.id))
    .map(({ benchmark }) => benchmark);
}

/** Extends benchmark ranking with category names and aliases while preserving canonical-name ranking precedence. */
export function rankDiscoveryBenchmarks(benchmarks = [], categories = new Map(), query = "") {
  const needle = normalized(query);
  if (!needle) return rankBenchmarks(benchmarks, "");
  const ranked = rankBenchmarks(benchmarks, query);
  const direct = new Set(ranked.map((benchmark) => benchmark.id));
  const categoryMatches = benchmarks
    .filter((benchmark) => !direct.has(benchmark.id) && benchmarkSearchText(benchmark, categories).includes(needle))
    .sort((left, right) => stableCompare(left.name, right.name) || stableCompare(left.id, right.id));
  return [...ranked, ...categoryMatches];
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

export function parseBenchmarkState(search = "", benchmarks = [], defaultId = DEFAULT_BENCHMARK_ID) {
  return sanitizeBenchmarkIds(new URLSearchParams(search).getAll("benchmark"), benchmarks, defaultId);
}

export function sanitizeTrendsFilters(candidate, data) {
  const allowedCategories = new Set((data.categories || []).map((item) => item.id));
  const allowedLabs = new Set((data.labs || []).map((item) => item.id));
  const date = (value) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value || "")) return "";
    const parsed = new Date(`${value}T00:00:00.000Z`);
    if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) return "";
    return value >= data.corpus.publication_window.start && value <= data.corpus.publication_window.end ? value : "";
  };
  let from = date(candidate.from);
  let to = date(candidate.to);
  if (from && to && from > to) [from, to] = ["", ""];
  const zoom = Number(candidate.zoom);
  return {
    category: allowedCategories.has(candidate.category) ? candidate.category : "",
    lab: allowedLabs.has(candidate.lab) ? candidate.lab : "",
    from,
    to,
    zoom: ACCEPTED_ZOOM_LEVELS.has(zoom) ? zoom : DEFAULT_ZOOM,
  };
}

export function parseTrendsState(search = "", benchmarks = [], data = {}, defaultId = DEFAULT_BENCHMARK_ID) {
  const params = new URLSearchParams(search);
  return {
    ids: sanitizeBenchmarkIds(params.getAll("benchmark"), benchmarks, defaultId),
    filters: sanitizeTrendsFilters({ category: params.get("category") || "", lab: params.get("lab") || "", from: params.get("from") || "", to: params.get("to") || "", zoom: params.get("zoom") || "" }, data),
  };
}

export function serializeBenchmarkState(ids = []) {
  const params = new URLSearchParams();
  for (const id of ids) params.append("benchmark", String(id));
  const query = params.toString();
  return query ? `?${query}` : "";
}

export function serializeTrendsState(ids = [], filters = {}) {
  return encodeViewState("trends", { benchmarks: ids, ...filters });
}

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

/** Returns releases carrying retained selected occurrences in the inclusive reporting-date range. */
export function releaseMatches(indexed, selectedIds = [], filters = {}) {
  const orderedIds = [...new Set(selectedIds)].filter((id) => indexed.benchmarks.has(id) && isLiveCanonical(indexed.benchmarks.get(id)));
  const selected = new Set(orderedIds);
  return indexed.data.releases
    .filter((release) => !filters.lab || release.lab_id === filters.lab)
    .map((release) => {
      const occurrences = retainedReleaseOccurrences(indexed, release.id).filter((occurrence) => selected.has(mappedBenchmarkId(indexed.benchmarks, occurrence)) && (!filters.from || occurrence.publication_date >= filters.from) && (!filters.to || occurrence.publication_date <= filters.to));
      if (!occurrences.length) return null;
      return { release, benchmarkIds: orderedIds.filter((id) => occurrences.some((occurrence) => mappedBenchmarkId(indexed.benchmarks, occurrence) === id)), occurrences };
    })
    .filter(Boolean)
    .sort((left, right) => Math.min(...left.occurrences.map((item) => Date.parse(item.publication_date))) - Math.min(...right.occurrences.map((item) => Date.parse(item.publication_date))) || stableCompare(left.release.name, right.release.name) || stableCompare(left.release.id, right.release.id));
}

/** Reveal only live canonical reports; historical identity visibility belongs to History. */
export function revealTrendsChanges(indexed, state, releaseId) {
  const release = indexed.releases.get(releaseId);
  if (!release) return null;
  const options = retainedReleaseOccurrences(indexed, releaseId).flatMap((occurrence) => {
    const id = mappedBenchmarkId(indexed.benchmarks, occurrence);
    if (!isLiveCanonical(indexed.benchmarks.get(id))) return [];
    const changes = { center: instantForDate(occurrence.publication_date) };
    if (!state.benchmarks.includes(id)) {
      // Keep every comparison slot possible, replacing only the last at the cap.
      changes.benchmarks = sanitizeBenchmarkIds([...state.benchmarks.slice(0, MAX_SELECTIONS - 1), id], indexed.data.benchmarks);
    }
    if (state.lab && state.lab !== release.lab_id) changes.lab = "";
    if (state.from && occurrence.publication_date < state.from) changes.from = "";
    if (state.to && occurrence.publication_date > state.to) changes.to = "";
    return [changes];
  });
  options.sort((a, b) => Object.keys(a).length - Object.keys(b).length || Number(Boolean(a.benchmarks)) - Number(Boolean(b.benchmarks)));
  for (const changes of options) {
    // Check the same decoded state and full predicate used by mutation/rendering.
    const candidate = decodeViewState("trends", encodeViewState("trends", { ...state, ...changes }), indexed).state;
    if (releaseMatches(indexed, candidate.benchmarks, candidate).some((match) => match.release.id === releaseId)) return changes;
  }
  return null;
}

export function laneOccurrences(matches = [], benchmarkId = "", indexed = null) {
  return matches.flatMap((match) => match.occurrences.filter((occurrence) => indexed ? mappedBenchmarkId(indexed.benchmarks, occurrence) === benchmarkId : occurrence.benchmark_id === benchmarkId).map((occurrence) => ({ match, occurrence })))
    .sort((left, right) => left.occurrence.publication_date.localeCompare(right.occurrence.publication_date) || stableCompare(left.match.release.name, right.match.release.name) || stableCompare(left.match.release.id, right.match.release.id) || stableCompare(left.occurrence.id, right.occurrence.id));
}

/** Groups sorted lane entries exactly once when dates match or adjacent measured coordinates collide. */
export function chronologyClusters(entries = [], positions = [], minimumGap = MARKER_GAP) {
  if (entries.length !== positions.length) throw new Error("Chronology entries and positions must have equal lengths.");
  const clusters = [];
  entries.forEach((entry, index) => {
    const position = positions[index];
    if (!Number.isFinite(position)) throw new Error("Chronology positions must be finite.");
    const previous = clusters.at(-1);
    const date = entry.occurrence?.publication_date || entry.release?.publication_date || "";
    if (previous && (previous.date === date || position - previous.lastPosition < minimumGap)) {
      previous.entries.push(entry);
      previous.lastPosition = position;
    } else {
      clusters.push({ date, position, lastPosition: position, entries: [entry] });
    }
  });
  return clusters;
}

/** Applies a non-pan state mutation without rounding or replacing the authoritative center instant. */
export function preserveChronologyCenter(state = {}, changes = {}) {
  const center = Object.hasOwn(changes, "center") ? changes.center : state.center;
  return { ...state, ...changes, center };
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
const instantForDate = (date) => `${date}T00:00:00.000Z`;

export class Trends {
  constructor() {
    this.pickerHost = document.querySelector("#trends-picker");
    this.chartHost = document.querySelector("#trends-chart");
    this.detailHost = document.querySelector("#trends-detail");
    this.summaryHost = document.querySelector("#landing-corpus-summary");
    this.state = null;
    this.indexed = null;
    this.options = [];
    this.activeOption = -1;
    this.markersByRelease = new Map();
    this.hoveredReleaseId = "";
    this.focusedReleaseId = "";
    this.triggeringMarker = null;
    this.cluster = null;
    this.restoringViewport = false;
    this.restoreGeneration = 0;
    this.restoreFramePending = null;
    this.scrollFramePending = null;
    this.userScrollPending = false;
    this.edgeClamped = false;
    this.scrollInputs = new Set();
    this.scrollIdleTimer = null;
    this.filtersOpen = false;
    this.resizeObserver = null;
  }

  async loadData() {
    const response = await fetch("./public/observatory.json");
    if (!response.ok) throw new Error(`Generated trends request failed (${response.status}).`);
    return response.json();
  }

  decode(historyState = window.history.state) {
    return { ...decodeViewState("trends", window.location.search, this.indexed, historyState || {}), legacyQuery: new URLSearchParams(window.location.search).get("q") || "" };
  }

  targetUrl() {
    const url = new URL(window.location.href);
    url.search = encodeViewState("trends", this.state);
    return `${url.pathname}${url.search}${url.hash}`;
  }

  writeState(method = "replaceState", focusedId = "") {
    window.history[method](historyPayload(window.history.state, this.state, "trends", focusedId), "", this.targetUrl());
  }

  cancelAsync() {
    this.cancelUserScroll();
    this.search?.cancel();
    this.restoreGeneration += 1;
    if (this.restoreFramePending !== null) cancelAnimationFrame(this.restoreFramePending);
    if (this.scrollFramePending !== null) cancelAnimationFrame(this.scrollFramePending);
    this.restoreFramePending = null;
    this.scrollFramePending = null;
    this.userScrollPending = false;
    this.restoringViewport = false;
  }

  currentGeometryNodes() {
    const frame = this.chartHost?.querySelector(".trends-frame");
    const track = frame?.querySelector(".trends-track");
    const label = frame?.querySelector(".trends-lane-label");
    return { frame, track, label };
  }

  captureUserCenter() {
    if (this.restoringViewport || !this.indexed) return this.state.center;
    const { frame, track, label } = this.currentGeometryNodes();
    if (!frame || !track) return this.state.center;
    if (frame.scrollLeft === this.lastScrollLeft) return this.state.center;
    this.lastScrollLeft = frame.scrollLeft;
    const { start, end } = this.indexed.data.corpus.publication_window;
    this.state.center = captureTrackCenter(frame, track, label, start, end);
    return this.state.center;
  }

  restoreViewport() {
    this.cancelUserScroll();
    if (this.restoreFramePending !== null) cancelAnimationFrame(this.restoreFramePending);
    const generation = ++this.restoreGeneration;
    this.restoringViewport = true;
    const schedule = (callback) => {
      this.restoreFramePending = requestAnimationFrame(() => {
        this.restoreFramePending = null;
        callback();
      });
    };
    const apply = (attempt = 0) => {
      if (generation !== this.restoreGeneration) return;
      const { frame, track, label } = this.currentGeometryNodes();
      if ((!frame || !track || !track.getBoundingClientRect().width) && attempt < 30) {
        schedule(() => apply(attempt + 1));
        return;
      }
      if (!frame || !track) {
        this.restoringViewport = false;
        return;
      }
      const { start, end } = this.indexed.data.corpus.publication_window;
      if (this.state.center) {
        const result = restoreTrackCenter(frame, track, label, this.state.center, start, end);
        this.edgeClamped = result.clamped;
      } else {
        scrollToNewest(frame);
        this.edgeClamped = true;
      }
      this.lastScrollLeft = frame.scrollLeft;
      this.restoringViewport = false;
      this.updateEdgeStatus();
    };
    schedule(() => apply());
  }

  async initialize() {
    if (!this.pickerHost || !this.chartHost || !this.detailHost) return;
    try {
      this.indexed = indexData(validateInterface(await this.loadData()));
      this.applyDecoded(this.decode(), true);
      this.renderSummary();
      this.renderPicker();
      this.render();
      window.addEventListener("popstate", (event) => {
        this.cancelAsync();
        this.cluster = null;
        this.applyDecoded(this.decode(event.state), false);
        this.syncControls();
        this.render("View restored from browser history.");
        this.restoreFocus(event.state?.observatory?.focusedId);
      });
      window.addEventListener("pageshow", (event) => {
        if (!event.persisted) return;
        this.cancelAsync();
        this.applyDecoded(this.decode(window.history.state), false);
        this.syncControls();
        this.render("View restored.");
      });
      window.addEventListener("pagehide", () => { this.settlePendingCenter(); this.writeState("replaceState"); this.cancelAsync(); });
      window.addEventListener("blur", () => { this.finishUserScroll(); this.cancelUserScroll(); });
      for (const type of ["pointerup", "pointercancel", "touchend", "touchcancel", "keyup"]) window.addEventListener(type, (event) => this.endScrollInput(event));
      window.addEventListener("observatory:flush", () => { this.search.flush(); this.settlePendingCenter(); this.writeState("replaceState"); });
      window.addEventListener("resize", () => {
        this.syncFilterDisclosure();
        this.refreshGeometry();
      });
      if (typeof ResizeObserver === "function") {
        this.resizeObserver = new ResizeObserver(() => this.refreshGeometry());
        this.resizeObserver.observe(this.chartHost);
      }
      document.addEventListener("keydown", (event) => this.handleEscape(event));
      document.querySelectorAll(".primary-nav a, .wordmark").forEach((link) => link.addEventListener("click", () => this.prepareRouteLink(link)));
    } catch {
      this.renderError();
    }
  }

  applyDecoded(decoded, canonicalize) {
    this.state = decoded.state;
    this.legacyQuery = decoded.legacyQuery;
    this.notices = [...decoded.notices];
    this.historicalIds = decoded.historicalIds;
    if (canonicalize) {
      try {
        const referrer = new URL(document.referrer);
        if (referrer.origin === window.location.origin && referrer.pathname !== window.location.pathname) this.notices.push("Kept benchmarks, lab, dates and chronological position; this view has its own search and table controls.");
      } catch {}
      this.writeState("replaceState");
    }
  }

  renderError() {
    this.cancelAsync();
    if (this.summaryHost) this.summaryHost.replaceChildren(element("p", { text: "Generated counts are unavailable." }));
    const reload = element("button", { className: "button", type: "button", text: "Reload", onclick: () => window.location.reload() });
    replaceChildren(this.pickerHost, [element("div", { className: "chronology-error", role: "alert" }, [element("p", { text: "Benchmark choices and controls could not be loaded." }), reload])]);
    replaceChildren(this.chartHost, [element("p", { className: "chronology-error", role: "alert", text: "Benchmark chronology data is unavailable." })]);
    this.detailHost.hidden = true;
  }

  renderSummary() {
    if (!this.summaryHost) return;
    const data = this.indexed.data;
    const retained = data.occurrences.filter((item) => item.review_status === "verified").length;
    const merged = data.benchmarks.filter((item) => item.identity_status === "merged").length;
    const quarantined = data.benchmarks.filter((item) => item.identity_status === "quarantined").length;
    const canonical = liveCanonicalBenchmarks(data.benchmarks).length;
    const withheld = data.occurrences.length - retained;
    const stats = [
      ["Canonical benchmarks", canonical.toLocaleString("en")],
      ["Retained occurrences", retained.toLocaleString("en")],
      ["Releases", data.releases.length.toLocaleString("en")],
    ].map(([label, value]) => element("div", {}, [element("dt", { text: label }), element("dd", { text: value })]));
    const disclosure = element("details", { className: "corpus-disclosure" }, [
      element("summary", { text: "Raw, merged and withheld counts" }),
      element("p", { text: `${data.benchmarks.length.toLocaleString("en")} benchmark identities: ${merged.toLocaleString("en")} merged and ${quarantined.toLocaleString("en")} quarantined. ${data.occurrences.length.toLocaleString("en")} raw occurrences: ${retained.toLocaleString("en")} retained and ${withheld.toLocaleString("en")} withheld.` }),
    ]);
    replaceChildren(this.summaryHost, [...stats, disclosure]);
  }

  renderPicker() {
    const data = this.indexed.data;
    this.chips = element("div", { className: "trends-chips", role: "list", "aria-label": "Selected benchmarks" });
    this.input = element("input", { id: "benchmark-picker-input", type: "search", role: "combobox", autocomplete: "off", maxlength: "160", placeholder: "Search names, aliases or categories", "aria-autocomplete": "list", "aria-haspopup": "listbox", "aria-expanded": "false", "aria-controls": "benchmark-picker-options", "aria-describedby": "benchmark-picker-help benchmark-picker-window" });
    this.input.value = this.state.search;
    this.listbox = element("ul", { id: "benchmark-picker-options", className: "trends-options", role: "listbox", "aria-label": "Benchmark choices", "aria-multiselectable": "true", hidden: true });
    this.choiceStatus = element("p", { id: "benchmark-picker-window", className: "trends-picker-help", role: "status", "aria-live": "polite" });
    this.count = element("span", { className: "trends-selection-count" });
    this.live = element("p", { className: "visually-hidden", role: "status", "aria-live": "polite", "aria-atomic": "true" });
    this.search = createCancelableSearch(() => this.writeState("replaceState"), SEARCH_DEBOUNCE_MS, window);

    const categories = [{ value: "", label: "All categories" }, ...data.categories.slice().sort((a, b) => a.name.localeCompare(b.name, "en")).map((item) => ({ value: item.id, label: item.name, searchText: (item.aliases || []).join(" ") }))];
    this.categoryControl = createSearchableCombobox({ id: "trends-category", label: "Discovery category", value: this.state.category, options: categories, emptyLabel: "All categories", placeholder: "Find a category", onChange: (value) => this.mutate({ category: value }, "Discovery category updated.") });

    const lab = element("select", { id: "trends-lab" });
    lab.append(element("option", { value: "", text: "All labs" }));
    data.labs.forEach((item) => lab.append(element("option", { value: item.id, text: item.name })));
    const from = element("input", { id: "trends-from", type: "date", min: data.corpus.publication_window.start, max: data.corpus.publication_window.end });
    const to = element("input", { id: "trends-to", type: "date", min: data.corpus.publication_window.start, max: data.corpus.publication_window.end });
    this.filterControls = { lab, from, to };
    Object.entries(this.filterControls).forEach(([key, control]) => control.addEventListener("change", () => this.mutate({ [key]: control.value }, "Result filters updated.")));
    const field = (label, control) => element("div", { className: "field" }, [element("label", { for: control.id, text: label }), control]);
    this.filterDetails = element("details", { className: "chronology-filters" }, [
      element("summary", { text: "Result filters" }),
      element("div", { className: "trends-filter-panel" }, [field("Lab", lab), field("From reporting date", from), field("To reporting date", to), element("div", { className: "filter-actions" }, [element("button", { className: "button button-quiet", type: "button", text: "Clear result filters", onclick: () => this.clearResultFilters() })])]),
    ]);
    this.filterDetails.addEventListener("toggle", () => { if (window.innerWidth < 768) this.filtersOpen = this.filterDetails.open; });

    const zoom = element("select", { id: "trends-zoom", "aria-label": "Zoom" });
    this.zoomControl = zoom;
    this.fillZoomOptions();
    zoom.addEventListener("change", () => this.mutate({ zoom: Number(zoom.value) }, "Zoom updated."));
    this.jumpDate = element("input", { id: "trends-jump-date", type: "date", min: data.corpus.publication_window.start, max: data.corpus.publication_window.end, "aria-label": "Jump date" });
    const toolbar = element("div", { className: "chronology-toolbar", role: "group", "aria-label": "Chronology position" }, [
      element("button", { className: "button", type: "button", text: "Previous period", onclick: () => this.panPeriod(-1) }),
      element("button", { className: "button", type: "button", text: "Next period", onclick: () => this.panPeriod(1) }),
      this.jumpDate,
      element("button", { className: "button", type: "button", text: "Jump to date", onclick: () => this.jumpToDate() }),
      element("button", { className: "button", type: "button", text: "Latest", onclick: () => this.latest() }),
      zoom,
      element("button", { className: "button", type: "button", text: "Copy link", onclick: () => this.copyLink() }),
      element("button", { className: "button button-quiet", type: "button", text: "Reset", onclick: () => this.resetView() }),
    ]);
    this.edgeStatus = element("p", { className: "chronology-edge", role: "status" });
    this.noticeHost = element("div", { className: "chronology-notices", role: "status", "aria-live": "polite" });
    this.fallbackHost = element("div", { className: "copy-fallback", hidden: true });
    replaceChildren(this.pickerHost, [
      element("section", { className: "benchmark-discovery", "aria-labelledby": "discovery-title" }, [element("div", { className: "trends-picker-head" }, [element("label", { id: "discovery-title", for: this.input.id, text: "Discover benchmarks" }), this.count]), this.categoryControl.element, element("div", { className: "trends-combobox" }, [this.input, this.listbox]), this.choiceStatus, element("p", { id: "benchmark-picker-help", className: "trends-picker-help", text: "Type to filter. Use arrow keys and Enter to select one to six benchmarks." })]),
      element("section", { className: "selection-tray", "aria-label": "Comparison tray" }, [element("h3", { text: "Selected comparison" }), this.chips, element("div", { className: "compare-suggestions" })]),
      this.filterDetails,
      toolbar,
      this.edgeStatus,
      this.noticeHost,
      this.fallbackHost,
      this.live,
    ]);
    this.syncControls();
    this.input.addEventListener("focus", () => this.openOptions());
    this.input.addEventListener("input", () => {
      this.state.search = this.input.value.trim().slice(0, 160);
      this.activeOption = -1;
      this.openOptions();
      this.search.schedule(this.state.search);
    });
    this.input.addEventListener("keydown", (event) => this.handlePickerKey(event));
    this.input.addEventListener("blur", () => queueMicrotask(() => { if (!this.pickerHost.contains(document.activeElement)) this.closeOptions(); }));
    document.addEventListener("pointerdown", (event) => { if (!this.pickerHost.contains(event.target)) this.closeOptions(); });
  }

  fillZoomOptions() {
    const levels = new Set(ZOOM_LEVELS);
    if (ACCEPTED_ZOOM_LEVELS.has(Number(this.state.zoom))) levels.add(Number(this.state.zoom));
    replaceChildren(this.zoomControl, [...levels].sort((a, b) => a - b).map((level) => element("option", { value: level, text: `${level}×` })));
  }

  syncControls() {
    if (!this.filterControls) return;
    this.input.value = this.state.search;
    this.categoryControl.setValue(this.state.category);
    Object.entries(this.filterControls).forEach(([key, control]) => { control.value = this.state[key] || ""; });
    this.fillZoomOptions();
    this.zoomControl.value = String(this.state.zoom);
    this.syncFilterDisclosure();
  }

  activeFilterCount() {
    return [this.state.lab, this.state.from, this.state.to].filter(Boolean).length;
  }

  syncFilterDisclosure() {
    if (!this.filterDetails) return;
    const wide = window.innerWidth >= 768;
    const focusedInside = this.filterDetails.contains(document.activeElement);
    if (wide || this.activeFilterCount() || focusedInside || this.filtersOpen) this.filterDetails.open = true;
    else this.filterDetails.open = false;
    const summary = this.filterDetails.querySelector("summary");
    const active = this.activeFilterCount();
    summary.textContent = active ? `Result filters (${active} active)` : "Result filters";
  }

  render(message = "") {
    this.restoringViewport = true;
    this.renderChips();
    this.renderOptions();
    this.renderNotices();
    this.renderChart();
    this.renderInspector();
    this.restoreViewport();
    if (message) this.announce(message);
  }

  renderChips() {
    const nodes = this.state.benchmarks.map((id) => {
      const benchmark = this.indexed.benchmarks.get(id);
      const hiddenCategory = this.state.category && benchmark.category_id !== this.state.category;
      const remove = element("button", { type: "button", "aria-label": `Remove ${benchmark.name}`, "data-remove-benchmark": id, text: "×" });
      remove.addEventListener("click", () => this.removeSelection(id, true));
      return element("span", { className: "trends-chip", role: "listitem" }, [element("span", { text: `${benchmark.name} · ${this.countLabel(id)}` }), hiddenCategory ? element("span", { className: "trends-chip-note", text: "outside discovery category" }) : null, remove]);
    });
    replaceChildren(this.chips, nodes);
    this.count.textContent = `${this.state.benchmarks.length} of ${MAX_SELECTIONS} selected`;
    const suggestions = ["benchmark_terminal_bench_2_1", "benchmark_terminal_bench_4_0"].filter((id) => this.indexed.benchmarks.has(id) && !this.state.benchmarks.includes(id));
    const host = this.pickerHost.querySelector(".compare-suggestions");
    replaceChildren(host, suggestions.length ? [element("span", { text: "Compare versions:" }), ...suggestions.map((id) => element("button", { className: "button button-quiet", type: "button", text: this.indexed.benchmarks.get(id).name, onclick: () => this.addSelection(id) }))] : []);
  }

  countLabel(id) {
    const window = this.indexed.data.recent_model_counts?.window;
    const range = window ? `, globally from ${window.start} to ${window.end}` : ", globally";
    return `${recentModelCount(this.indexed.data, id)} ${recentModelCountLabel(this.indexed.data)}${range}`;
  }

  discoveryBenchmarks() {
    return liveCanonicalBenchmarks(this.indexed.data.benchmarks).filter((benchmark) => !this.state.category || benchmark.category_id === this.state.category);
  }

  renderOptions() {
    if (!this.input) return;
    const matches = rankDiscoveryBenchmarks(this.discoveryBenchmarks(), this.indexed.categories, this.state.search);
    this.options = matches.slice(0, COMBOBOX_OPTION_LIMIT);
    if (this.activeOption >= this.options.length) this.activeOption = this.options.length - 1;
    const atLimit = this.state.benchmarks.length >= MAX_SELECTIONS;
    const nodes = this.options.map((benchmark, index) => {
      const selected = this.state.benchmarks.includes(benchmark.id);
      const option = element("li", { id: `benchmark-option-${benchmark.id}`, className: index === this.activeOption ? "is-active" : "", role: "option", "aria-selected": String(selected), "aria-disabled": String(!selected && atLimit), "data-benchmark-id": benchmark.id }, [element("span", { className: "trends-option-name", text: benchmark.name }), element("span", { className: "trends-option-count", text: this.countLabel(benchmark.id) }), selected ? element("span", { className: "trends-option-state", text: "Selected" }) : null]);
      let committed = false;
      option.addEventListener("pointerdown", (event) => {
        event.preventDefault();
        committed = true;
        selected ? this.removeSelection(benchmark.id, false) : this.addSelection(benchmark.id);
      });
      option.addEventListener("mousedown", (event) => event.preventDefault());
      option.addEventListener("click", () => {
        if (committed) { committed = false; return; }
        selected ? this.removeSelection(benchmark.id, false) : this.addSelection(benchmark.id);
      });
      return option;
    });
    replaceChildren(this.listbox, nodes.length ? nodes : [element("li", { className: "trends-option-empty", text: "No benchmarks match this search." })]);
    this.choiceStatus.textContent = !matches.length ? "No benchmarks match this search." : matches.length > COMBOBOX_OPTION_LIMIT ? `Showing first 50 of ${matches.length} matches; type to narrow.` : `${matches.length} benchmark choice${matches.length === 1 ? "" : "s"}.`;
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
    const nodes = [...this.listbox.querySelectorAll('[role="option"]')];
    nodes.forEach((node, index) => node.classList.toggle("is-active", index === this.activeOption));
    const active = nodes[this.activeOption];
    if (!active) return this.input.removeAttribute("aria-activedescendant");
    this.input.setAttribute("aria-activedescendant", active.id);
    if (scroll) active.scrollIntoView({ block: "nearest" });
  }

  handlePickerKey(event) {
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      if (this.listbox.hidden) this.openOptions();
      if (!this.options.length) return;
      if (event.key === "Home") this.activeOption = 0;
      else if (event.key === "End") this.activeOption = this.options.length - 1;
      else if (event.key === "ArrowDown") this.activeOption = Math.min(this.options.length - 1, this.activeOption + 1);
      else this.activeOption = this.activeOption <= 0 ? 0 : this.activeOption - 1;
      this.syncActiveOption();
    } else if (event.key === "Enter" && !this.listbox.hidden && this.activeOption >= 0) {
      event.preventDefault();
      const benchmark = this.options[this.activeOption];
      this.state.benchmarks.includes(benchmark.id) ? this.removeSelection(benchmark.id, false) : this.addSelection(benchmark.id);
    } else if (event.key === "Escape" && !this.listbox.hidden) {
      event.preventDefault();
      event.stopPropagation();
      this.closeOptions();
    } else if (event.key === "Backspace" && !this.input.value) {
      event.preventDefault();
      this.removeSelection(this.state.benchmarks.at(-1), false);
    }
  }

  addSelection(id) {
    this.search.cancel();
    const result = transitionBenchmarkSelection(this.state.benchmarks, id, this.indexed.data.benchmarks);
    if (result.outcome === "limit") return this.announce("Six benchmarks are already selected. Remove one before adding another.");
    if (result.outcome !== "added") return;
    this.settlePendingCenter();
    const name = this.indexed.benchmarks.get(id).name;
    this.state = preserveChronologyCenter(this.state, { benchmarks: result.ids, search: "" });
    this.input.value = "";
    this.closeOptions();
    this.writeState("pushState", id);
    this.render(`${name} selected.`);
    requestAnimationFrame(() => this.input.focus());
  }

  removeSelection(id, focusNearest) {
    this.search.cancel();
    const index = this.state.benchmarks.indexOf(id);
    const benchmark = this.indexed.benchmarks.get(id);
    const result = transitionBenchmarkSelection(this.state.benchmarks, id, this.indexed.data.benchmarks);
    if (result.outcome === "final") {
      this.announce(`${benchmark.name} remains selected. Choose a replacement before removing the final benchmark.`);
      return this.input.focus();
    }
    if (result.outcome !== "removed") return;
    this.settlePendingCenter();
    const nextId = result.ids[Math.min(index, result.ids.length - 1)];
    this.state = preserveChronologyCenter(this.state, { benchmarks: result.ids });
    this.writeState("pushState", nextId || "");
    this.render(`${benchmark.name} removed.`);
    requestAnimationFrame(() => {
      if (focusNearest && nextId) this.chips.querySelector(`[data-remove-benchmark="${CSS.escape(nextId)}"]`)?.focus();
      else this.input.focus();
    });
  }

  settlePendingCenter() {
    if (!this.userScrollPending) return;
    if (this.scrollFramePending !== null) cancelAnimationFrame(this.scrollFramePending);
    this.scrollFramePending = null;
    this.captureUserCenter();
  }

  cancelUserScroll() {
    clearTimeout(this.scrollIdleTimer);
    this.scrollIdleTimer = null;
    this.scrollInputs.clear();
    this.userScrollPending = false;
    if (this.scrollFramePending !== null) cancelAnimationFrame(this.scrollFramePending);
    this.scrollFramePending = null;
  }

  scheduleScrollEnd() {
    clearTimeout(this.scrollIdleTimer);
    // Fallback for engines without scrollend. Every inertial displacement renews it.
    if (!this.scrollInputs.size) this.scrollIdleTimer = setTimeout(() => this.finishUserScroll(), 200);
  }

  beginScrollInput(event) {
    if (this.restoringViewport) return;
    if (event.type === "keydown" && (event.target !== event.currentTarget || !["ArrowLeft", "ArrowRight", "PageUp", "PageDown", "Home", "End"].includes(event.key))) return;
    if (event.type === "pointerdown") this.scrollInputs.add(`pointer:${event.pointerId}`);
    if (event.type === "touchstart") this.scrollInputs.add("touch");
    if (event.type === "keydown") this.scrollInputs.add(`key:${event.key}`);
    this.userScrollPending = true;
    this.scheduleScrollEnd();
  }

  endScrollInput(event) {
    if (event.type.startsWith("pointer")) this.scrollInputs.delete(`pointer:${event.pointerId}`);
    if (event.type.startsWith("touch") && !event.touches?.length) this.scrollInputs.delete("touch");
    if (event.type === "keyup") this.scrollInputs.delete(`key:${event.key}`);
    if (!this.userScrollPending) return;
    this.settlePendingCenter();
    this.writeState("replaceState");
    // Pointer cancellation can transfer a touch gesture to native scrolling.
    this.scheduleScrollEnd();
  }

  finishUserScroll() {
    if (!this.userScrollPending) return;
    this.settlePendingCenter();
    this.writeState("replaceState");
    if (!this.scrollInputs.size) this.cancelUserScroll();
  }

  mutate(changes, message, focusedId = "") {
    this.search.cancel();
    this.settlePendingCenter();
    const active = document.activeElement;
    const decoded = decodeViewState("trends", encodeViewState("trends", preserveChronologyCenter(this.state, changes)), this.indexed, {});
    this.state = decoded.state;
    this.notices = [...new Set([...(this.notices || []), ...decoded.notices])];
    this.writeState("pushState", focusedId);
    this.syncControls();
    this.render(message);
    if (active && !active.isConnected) this.restoreFocus(focusedId);
  }

  restoreFocus(focusedId = "") {
    requestAnimationFrame(() => {
      const target = document.getElementById(focusedId) || (this.state.release ? this.detailHost.querySelector("h2") : null) || this.input;
      if (target?.isConnected && !target.disabled) target.focus({ preventScroll: true });
    });
  }

  clearResultFilters() {
    this.mutate({ lab: "", from: "", to: "" }, "Result filters cleared.");
  }

  resetView() {
    this.cancelAsync();
    const decoded = decodeViewState("trends", "?v=2", this.indexed, {});
    this.state = decoded.state;
    this.cluster = null;
    this.notices = [];
    this.historicalIds = [];
    this.filtersOpen = false;
    this.writeState("pushState");
    this.syncControls();
    this.render("View reset to Terminal-Bench 2.0 and latest.");
  }

  renderNotices() {
    const nodes = [];
    for (const notice of this.notices || []) nodes.push(element("p", { text: notice }));
    for (const id of this.historicalIds || []) {
      const link = element("a", { href: `./history.html?v=2&benchmark=${encodeURIComponent(id)}&audit=all`, text: `Audit ${id} in Reporting history` });
      nodes.push(element("p", {}, [document.createTextNode(`${id} is historical or withheld. `), link]));
    }
    if ((this.notices || []).some((notice) => notice.includes("Legacy release-search"))) {
      const q = this.legacyQuery || "";
      nodes.push(element("p", {}, [document.createTextNode("Open the legacy text in "), element("a", { href: `./timeline.html?v=2&q=${encodeURIComponent(q)}`, text: "Releases" }), document.createTextNode(".")]));
    }
    replaceChildren(this.noticeHost, nodes);
  }

  renderChart() {
    const matches = releaseMatches(this.indexed, this.state.benchmarks, this.state);
    this.currentMatches = matches;
    this.markersByRelease = new Map();
    const data = this.indexed.data;
    const width = Math.round(Math.max(1120, 1800 * Number(this.state.zoom)));
    const summary = element("div", { className: "trends-chart-summary" }, [element("p", { text: `${matches.length} release${matches.length === 1 ? "" : "s"} contain retained selected occurrences under the result filters. Reporting dates position markers.` })]);
    const canvas = element("div", { className: "trends-canvas", style: { width: `${width}px` } });
    canvas.append(element("div", { className: "trends-axis", "aria-hidden": "true" }, timelineTicks(data.corpus.publication_window.start, data.corpus.publication_window.end, 8).map((date) => element("span", { className: "trends-axis-tick", style: { left: `${datePosition(date, data.corpus.publication_window.start, data.corpus.publication_window.end)}%` } }, [element("span", { text: formatDate(date) })]))));
    for (const benchmarkId of this.state.benchmarks) canvas.append(this.renderLaneShell(benchmarkId, matches));
    const frame = element("div", { className: "trends-frame", tabindex: "0", role: "region", "aria-label": "Horizontally scrollable benchmark chronology" }, [canvas]);
    for (const type of ["pointerdown", "keydown", "wheel", "touchstart"]) frame.addEventListener(type, (event) => this.beginScrollInput(event), { passive: true });
    frame.addEventListener("scrollend", () => this.finishUserScroll());
    frame.addEventListener("scroll", () => this.onScroll(), { passive: true });
    replaceChildren(this.chartHost, [summary, frame]);
    this.populateLaneMarkers();
  }

  renderLaneShell(benchmarkId, matches) {
    const benchmark = this.indexed.benchmarks.get(benchmarkId);
    const allCorpus = retainedReleaseOccurrencesForBenchmark(this.indexed, benchmarkId);
    const entries = laneOccurrences(matches, benchmarkId, this.indexed);
    const lane = element("section", { className: "trends-lane", "aria-labelledby": `trends-lane-${benchmarkId}`, "data-benchmark-lane": benchmarkId });
    lane.append(element("h3", { id: `trends-lane-${benchmarkId}`, className: "trends-lane-label" }, [element("span", { text: benchmark.name }), element("span", { className: "trends-lane-count", text: this.countLabel(benchmarkId) })]));
    const track = element("div", { className: "trends-track", "data-lane-track": benchmarkId });
    if (!entries.length) {
      const corpusZero = !allCorpus.length;
      track.append(element("div", { className: "lane-empty" }, [element("strong", { text: corpusZero ? "No retained corpus occurrence" : "No occurrences under current result filters" }), element("span", { text: corpusZero ? "Coverage is bounded and incomplete. This does not show that the benchmark was not evaluated." : "Clear result filters to restore retained occurrences while preserving this selection and chronology position." }), !corpusZero ? element("button", { className: "button button-quiet", type: "button", text: "Clear result filters", onclick: () => this.clearResultFilters() }) : null]));
    }
    lane.append(track);
    return lane;
  }

  populateLaneMarkers() {
    this.markersByRelease = new Map();
    const { start, end } = this.indexed.data.corpus.publication_window;
    for (const benchmarkId of this.state.benchmarks) {
      const track = this.chartHost.querySelector(`[data-lane-track="${CSS.escape(benchmarkId)}"]`);
      if (!track) continue;
      track.querySelectorAll(".trends-marker").forEach((marker) => marker.remove());
      const entries = laneOccurrences(this.currentMatches, benchmarkId, this.indexed);
      if (!entries.length) continue;
      const width = track.getBoundingClientRect().width || track.clientWidth || 1;
      const positions = entries.map((entry) => datePosition(entry.occurrence.publication_date, start, end) / 100 * width);
      const clusters = chronologyClusters(entries, positions, MARKER_GAP);
      for (const cluster of clusters) track.append(this.renderClusterMarker(cluster, benchmarkId));
    }
    this.syncMarkerHighlights();
  }

  refreshGeometry() {
    if (this.userScrollPending) { this.settlePendingCenter(); this.writeState("replaceState"); }
    const { track } = this.currentGeometryNodes();
    const width = track?.getBoundingClientRect().width;
    if (width !== this.measuredTrackWidth) {
      this.measuredTrackWidth = width;
      const active = document.activeElement;
      this.populateLaneMarkers();
      if (active && !active.isConnected) this.restoreFocus(active.id);
    }
    this.restoreViewport();
  }

  renderClusterMarker(cluster, benchmarkId) {
    const position = datePosition(cluster.date, this.indexed.data.corpus.publication_window.start, this.indexed.data.corpus.publication_window.end);
    if (cluster.entries.length > 1) {
      const releases = new Set(cluster.entries.map((entry) => entry.match.release.id));
      const lastDate = cluster.entries.at(-1).occurrence.publication_date;
      const dateLabel = lastDate === cluster.date ? formatDate(cluster.date) : `${formatDate(cluster.date)} to ${formatDate(lastDate)}`;
      const button = element("button", { className: `trends-marker chronology-cluster${position > 97 ? " edge-end" : ""}`, type: "button", "aria-label": `${cluster.entries.length} occurrences across ${releases.size} releases from ${dateLabel}`, style: { left: `${position}%` } }, [element("strong", { text: `${cluster.entries.length} reports` }), element("span", { text: dateLabel })]);
      for (const releaseId of releases) {
        const markers = this.markersByRelease.get(releaseId) || [];
        markers.push(button);
        this.markersByRelease.set(releaseId, markers);
      }
      button.addEventListener("click", () => {
        this.triggeringMarker = button;
        this.cluster = { benchmarkId, ...cluster };
        this.renderInspector();
        requestAnimationFrame(() => this.detailHost.querySelector("h2")?.focus({ preventScroll: true }));
      });
      return button;
    }
    const entry = cluster.entries[0];
    const release = entry.match.release;
    const lab = this.indexed.labs.get(release.lab_id);
    const button = element("button", { className: `trends-marker${position > 97 ? " edge-end" : ""}`, type: "button", "data-release-id": release.id, "data-occurrence-id": entry.occurrence.id, "aria-pressed": String(this.state.release === release.id), "aria-controls": "trends-detail", "aria-label": `${release.name}, ${lab?.name || "Unknown lab"}, reported ${formatDate(entry.occurrence.publication_date)}`, style: { "--lab-color": this.labColor(release.lab_id), left: `${position}%` } }, [element("span", { className: "trends-marker-name", text: release.name }), element("span", { className: "trends-marker-lab", text: `${lab?.name || "Unknown lab"} · ${formatDate(entry.occurrence.publication_date)}` })]);
    const markers = this.markersByRelease.get(release.id) || [];
    markers.push(button);
    this.markersByRelease.set(release.id, markers);
    button.addEventListener("mouseenter", () => { this.hoveredReleaseId = release.id; this.syncMarkerHighlights(); });
    button.addEventListener("mouseleave", () => { this.hoveredReleaseId = ""; this.syncMarkerHighlights(); });
    button.addEventListener("focus", () => { this.focusedReleaseId = release.id; this.syncMarkerHighlights(); });
    button.addEventListener("blur", () => { this.focusedReleaseId = ""; this.syncMarkerHighlights(); });
    button.addEventListener("click", () => { this.triggeringMarker = button; this.cluster = null; this.mutate({ release: release.id }, `${release.name} pinned.`, release.id); requestAnimationFrame(() => this.detailHost.querySelector("h2")?.focus({ preventScroll: true })); });
    return button;
  }

  labColor(labId) {
    const index = this.indexed.data.labs.findIndex((lab) => lab.id === labId);
    return LAB_COLORS[(index < 0 ? 0 : index) % LAB_COLORS.length];
  }

  syncMarkerHighlights() {
    const states = new Map();
    for (const [releaseId, markers] of this.markersByRelease) for (const marker of markers) {
      const current = states.get(marker) || { highlighted: false, pressed: false };
      current.highlighted ||= [this.hoveredReleaseId, this.focusedReleaseId, this.state.release].includes(releaseId);
      current.pressed ||= this.state.release === releaseId;
      states.set(marker, current);
    }
    for (const [marker, state] of states) {
      marker.classList.toggle("is-highlighted", state.highlighted);
      marker.setAttribute("aria-pressed", String(state.pressed));
    }
  }

  renderInspector() {
    if (this.cluster) return this.renderClusterInspector();
    const release = this.state.release ? this.indexed.releases.get(this.state.release) : null;
    if (!release) {
      this.detailHost.hidden = true;
      return replaceChildren(this.detailHost);
    }
    const visible = this.currentMatches.some((match) => match.release.id === release.id);
    const lab = this.indexed.labs.get(release.lab_id);
    const occurrences = retainedReleaseOccurrences(this.indexed, release.id);
    const available = occurrences.some((occurrence) => isLiveCanonical(this.indexed.benchmarks.get(mappedBenchmarkId(this.indexed.benchmarks, occurrence))));
    const close = element("button", { className: "detail-close icon-button", type: "button", "aria-label": "Clear pinned release", text: "×", onclick: () => this.clearPin(true) });
    const actions = element("div", { className: "inspector-actions" }, [element("button", { className: "button button-quiet", type: "button", text: "Clear pin", onclick: () => this.clearPin(true) }), !visible && occurrences.length ? element("button", { className: "button", type: "button", text: "Reveal release", onclick: () => this.revealRelease(release) }) : null]);
    this.detailHost.hidden = false;
    replaceChildren(this.detailHost, [element("div", { className: "detail-panel" }, [
      element("header", { className: "detail-head" }, [element("div", {}, [element("h2", { id: "trends-detail-title", tabindex: "-1", text: release.name }), element("p", { className: "detail-byline", text: `${lab?.name || "Unknown lab"} · release date ${formatDate(release.publication_date)}` }), !visible ? element("p", { className: available ? "outside-filter" : "detail-empty", text: available ? "Pinned release outside current filters" : "Pinned release unavailable in benchmark chronology: no retained live canonical occurrence. Historical or withheld identities remain audit context, not lane evidence." }) : null]), close]),
      actions,
      element("h3", { className: "detail-occurrence-title", text: "Exact retained occurrences" }),
      ...(occurrences.length ? occurrences.map((occurrence) => sourceDisclosure(this.indexed, occurrence)) : [element("p", { className: "detail-empty", text: "No retained benchmark occurrence is available for this release in the bounded corpus. Withheld or incomplete evidence is not presented as non-reporting." })]),
    ])]);
  }

  renderClusterInspector() {
    const ordered = this.cluster.entries.slice().sort((left, right) => stableCompare(left.match.release.name, right.match.release.name) || stableCompare(left.match.release.id, right.match.release.id) || stableCompare(left.occurrence.id, right.occurrence.id));
    const groups = [];
    for (const entry of ordered) {
      let group = groups.at(-1);
      if (!group || group.release.id !== entry.match.release.id) {
        group = { release: entry.match.release, occurrences: [] };
        groups.push(group);
      }
      group.occurrences.push(entry.occurrence);
    }
    const close = element("button", { className: "detail-close icon-button", type: "button", "aria-label": "Close cluster inspector", text: "×", onclick: () => this.closeCluster(true) });
    const list = element("ul", { className: "cluster-list" }, groups.map((group) => element("li", {}, [
      element("button", { className: "button cluster-member", type: "button", text: `${group.release.name} · ${group.release.id}`, onclick: () => { this.cluster = null; this.mutate({ release: group.release.id }, `${group.release.name} pinned.`, group.release.id); } }),
      element("ul", { className: "cluster-occurrences" }, group.occurrences.map((occurrence) => element("li", {}, [element("button", { className: "button button-quiet", type: "button", text: `${occurrence.id} · reporting date ${occurrence.publication_date}`, onclick: () => { this.cluster = null; this.mutate({ release: group.release.id }, `${group.release.name} pinned.`, occurrence.id); } })]))),
    ])));
    this.detailHost.hidden = false;
    replaceChildren(this.detailHost, [element("div", { className: "detail-panel" }, [element("header", { className: "detail-head" }, [element("div", {}, [element("h2", { tabindex: "-1", text: `${this.cluster.entries.length} reports near ${formatDate(this.cluster.date)}` }), element("p", { className: "detail-byline", text: "Releases are ordered by name and ID. Their exact occurrences are ordered by occurrence ID." })]), close]), list])]);
  }

  closeCluster(restoreFocus) {
    const trigger = this.triggeringMarker;
    this.cluster = null;
    this.renderInspector();
    if (restoreFocus) requestAnimationFrame(() => (trigger?.isConnected ? trigger : this.input)?.focus({ preventScroll: true }));
  }

  clearPin(restoreFocus) {
    const releaseId = this.state.release;
    const trigger = this.triggeringMarker;
    this.mutate({ release: "" }, "Pinned release cleared.");
    if (restoreFocus) requestAnimationFrame(() => (trigger?.isConnected ? trigger : this.markersByRelease.get(releaseId)?.[0] || this.input)?.focus({ preventScroll: true }));
  }

  revealRelease(release) {
    const target = this.indexed.releases.get(release?.id);
    const changes = revealTrendsChanges(this.indexed, this.state, target?.id);
    if (!changes) return this.announce("Release unavailable in benchmark chronology: no retained live canonical occurrence can be shown. Historical or withheld identities remain audit context. Filters, comparison and position were kept.");
    if (Object.entries(changes).every(([key, value]) => JSON.stringify(this.state[key]) === JSON.stringify(value))) return this.announce(`${target.name} is already visible at this chronology position. Filters and comparison kept.`);
    const labels = { benchmarks: "benchmark selection", lab: "lab", from: "from date", to: "to date" };
    const relaxed = Object.keys(changes).filter((key) => key !== "center").map((key) => labels[key]);
    this.mutate(changes, `${target.name} revealed and chronology position updated.${relaxed.length ? ` Adjusted conflicting filters: ${relaxed.join(", ")}.` : " Existing filters kept."}`, target.id);
  }

  onScroll() {
    if (this.restoringViewport || !this.userScrollPending) return;
    this.scheduleScrollEnd();
    if (this.scrollFramePending !== null) return;
    this.scrollFramePending = requestAnimationFrame(() => {
      this.scrollFramePending = null;
      if (this.restoringViewport || !this.userScrollPending) return;
      this.captureUserCenter();
      this.writeState("replaceState");
      this.edgeClamped = false;
      this.updateEdgeStatus();
    });
  }

  panPeriod(direction) {
    this.cancelAsync();
    const { frame, track, label } = this.currentGeometryNodes();
    if (!frame || !track) return;
    const geometry = trackGeometry(frame, track, label);
    this.userScrollPending = true;
    frame.scrollLeft += direction * geometry.viewportWidth / 2;
    this.onScroll();
  }

  jumpToDate() {
    const date = this.jumpDate.value;
    if (!date) return this.announce("Choose a jump date first.");
    this.mutate({ center: instantForDate(date) }, `Jumped to ${formatDate(date)}.`);
  }

  latest() {
    this.mutate({ center: "" }, "Jumped to the latest edge.");
  }

  updateEdgeStatus() {
    if (!this.edgeStatus) return;
    this.edgeStatus.textContent = !this.state.center ? "Showing the latest edge." : this.edgeClamped ? "The intended chronological center is beyond the currently visible edge. The saved center remains unchanged." : "";
  }

  async copyLink() {
    this.search.flush();
    if (this.userScrollPending) {
      this.settlePendingCenter();
      this.writeState("replaceState");
    }
    const value = new URL(this.targetUrl(), window.location.origin).href;
    try {
      await navigator.clipboard.writeText(value);
      this.fallbackHost.hidden = true;
      this.announce("Shareable link copied.");
    } catch {
      const input = element("input", { type: "text", readonly: true, "aria-label": "Shareable URL" });
      input.value = value;
      replaceChildren(this.fallbackHost, [element("label", { text: "Copy this shareable URL" }), input]);
      this.fallbackHost.hidden = false;
      input.focus();
      input.select();
    }
  }

  prepareRouteLink(link) {
    this.search.flush();
    if (this.userScrollPending) {
      this.settlePendingCenter();
      this.writeState("replaceState");
    }
    const url = new URL(link.href, window.location.href);
    if (url.origin !== window.location.origin) return;
    const params = new URLSearchParams({ v: "2" });
    for (const id of this.state.benchmarks) params.append("benchmark", id);
    for (const key of ["lab", "from", "to", "zoom", "center", "release"]) if (this.state[key] && !(key === "zoom" && this.state[key] === 1)) params.set(key, this.state[key]);
    url.search = params;
    link.href = url.href;
  }

  handleEscape(event) {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    if (this.cluster) {
      event.preventDefault();
      return this.closeCluster(true);
    }
    if (this.state?.release) {
      event.preventDefault();
      this.clearPin(true);
    }
  }

  announce(message) {
    if (!this.live) return;
    this.live.textContent = "";
    requestAnimationFrame(() => { this.live.textContent = message; });
  }
}

function retainedReleaseOccurrencesForBenchmark(indexed, benchmarkId) {
  const matching = new Set([benchmarkId]);
  return indexed.data.releases.flatMap((release) => retainedReleaseOccurrences(indexed, release.id, matching));
}

if (typeof document !== "undefined") {
  const trends = new Trends();
  void trends.initialize();
}
