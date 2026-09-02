import {
  createSearchableCombobox,
  datePosition,
  formatDate,
  indexData,
  matchingBenchmarkIds,
  orderedReleaseOccurrences,
  timelineTicks,
  validateInterface,
} from "./core.mjs";

const LAB_COLORS = ["#315b8a", "#8b5540", "#31725f", "#735a91", "#8a6a2f", "#8a4564"];
const STATE_KEYS = ["q", "category", "lab", "from", "to", "zoom", "release"];
const MAX_QUERY_LENGTH = 160;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
export const SEARCH_DEBOUNCE_MS = 150;
export const ZOOM_LEVELS = Object.freeze([1, 2, 4]);
export const DEFAULT_ZOOM = ZOOM_LEVELS[0];

const isIsoDate = (value) => {
  if (typeof value !== "string" || !ISO_DATE.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
};

export function sanitizeTimelineState(candidate, data) {
  const allowedCategories = new Set(data.categories.map((item) => item.id));
  const allowedLabs = new Set(data.labs.map((item) => item.id));
  const allowedReleases = new Set(data.releases.map((item) => item.id));
  const isDateInWindow = (value) => isIsoDate(value)
    && value >= data.corpus.publication_window.start
    && value <= data.corpus.publication_window.end;
  let from = isDateInWindow(candidate.from || "") ? candidate.from : "";
  let to = isDateInWindow(candidate.to || "") ? candidate.to : "";
  if (from && to && from > to) [from, to] = ["", ""];
  const zoom = String(candidate.zoom || "");
  return {
    q: String(candidate.q || "").trim().slice(0, MAX_QUERY_LENGTH),
    category: allowedCategories.has(candidate.category) ? candidate.category : "",
    lab: allowedLabs.has(candidate.lab) ? candidate.lab : "",
    from,
    to,
    zoom: ZOOM_LEVELS.map(String).includes(zoom) ? Number(zoom) : DEFAULT_ZOOM,
    release: allowedReleases.has(candidate.release) ? candidate.release : "",
  };
}

export function releaseDisplayLabels(releases) {
  const counts = new Map();
  releases.forEach((release) => counts.set(release.name, (counts.get(release.name) || 0) + 1));
  return new Map(releases.map((release) => [
    release.id,
    counts.get(release.name) > 1 ? `${release.name} (${release.publication_date})` : release.name,
  ]));
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
const finiteScroll = (value) => Number.isFinite(value) && value >= 0;

class Timeline {
  constructor() {
    this.mode = document.querySelector("#timeline-host")?.dataset.timelineMode;
    this.host = document.querySelector("#timeline-host");
    this.mount = document.querySelector("#timeline-chart");
    this.detailHost = document.querySelector("#release-detail-host");
    this.controlsHost = document.querySelector("#timeline-controls");
    this.fullscreenButton = document.querySelector("#timeline-fullscreen-button");
    this.fullscreenTarget = document.querySelector("#timeline-workspace");
    this.rawState = this.readState();
    this.state = this.rawState;
    this.indexed = null;
    this.controls = {};
    this.nodeByRelease = new Map();
    this.activeReleaseId = "";
    this.restoredScroll = finiteScroll(window.history.state?.timelineScroll) ? window.history.state.timelineScroll : null;
  }

  readState() {
    const params = new URLSearchParams(window.location.search);
    return Object.fromEntries(STATE_KEYS.map((key) => [key, params.get(key) || ""]));
  }

  isUiFixture(url) {
    return url.searchParams.get("fixture") === "ui" && ["localhost", "127.0.0.1"].includes(url.hostname);
  }

  sanitizeState(candidate) {
    return this.indexed ? sanitizeTimelineState(candidate, this.indexed.data) : candidate;
  }

  writeTimelineQuery(url, fixtureRequested) {
    url.search = "";
    STATE_KEYS.forEach((key) => {
      const value = this.state[key];
      if (value && (key !== "zoom" || value !== DEFAULT_ZOOM)) url.searchParams.set(key, value);
    });
    if (fixtureRequested) url.searchParams.set("fixture", "ui");
  }

  historyPayload(scroll = this.currentScroll()) {
    const payload = { ...(window.history.state || {}) };
    if (finiteScroll(scroll)) payload.timelineScroll = scroll;
    return payload;
  }

  writeState(method, scroll = this.currentScroll()) {
    const url = new URL(window.location.href);
    this.writeTimelineQuery(url, this.isUiFixture(url));
    window.history[method](this.historyPayload(scroll), "", `${url.pathname}${url.search}${url.hash}`);
  }

  currentScroll() {
    const value = this.mount?.querySelector(".timeline-frame")?.scrollLeft;
    return finiteScroll(value) ? value : 0;
  }

  async loadData() {
    if (this.isUiFixture(new URL(window.location.href))) return (await import("./tests/ui/fixture.mjs")).fixture;
    const response = await fetch("./public/observatory.json");
    if (!response.ok) throw new Error(`Generated timeline request failed (${response.status}).`);
    return response.json();
  }

  async initialize() {
    if (!this.host || !this.mount || !this.mode) return;
    try {
      this.indexed = indexData(validateInterface(await this.loadData()));
      this.state = this.sanitizeState(this.rawState);
      this.labels = releaseDisplayLabels(this.indexed.data.releases);
      this.explicitInitialTarget = this.explicitTarget(this.rawState, this.state);
      this.writeState("replaceState", this.restoredScroll ?? 0);
      this.renderControls();
      this.setupFullscreen();
      this.render({ restoredScroll: this.restoredScroll, initial: true });
      window.addEventListener("popstate", (event) => {
        this.state = this.sanitizeState(this.readState());
        this.activeReleaseId = this.state.release;
        this.syncControls();
        const restoredScroll = finiteScroll(event.state?.timelineScroll) ? event.state.timelineScroll : null;
        this.render({ restoredScroll, initial: false });
      });
    } catch (error) {
      replaceChildren(this.mount, [element("p", { className: "timeline-pending", text: error.message })]);
    }
  }

  explicitTarget(raw, sanitized) {
    if (raw.release && sanitized.release) return { type: "release", value: sanitized.release };
    if (raw.to && sanitized.to) return { type: "date", value: sanitized.to };
    if (raw.from && sanitized.from) return { type: "date", value: sanitized.from };
    if (raw.zoom && ZOOM_LEVELS.includes(sanitized.zoom) && String(sanitized.zoom) === raw.zoom) return { type: "zoom" };
    return null;
  }

  releases() {
    const { q, category, lab, from, to } = this.state;
    const matchingIds = matchingBenchmarkIds(this.indexed, q, category);
    return this.indexed.data.releases
      .filter((release) => !lab || release.lab_id === lab)
      .filter((release) => !from || release.publication_date >= from)
      .filter((release) => !to || release.publication_date <= to)
      .filter((release) => (!q && !category) || (this.indexed.occurrencesByRelease.get(release.id) || []).some((occurrence) => matchingIds.has(occurrence.benchmark_id)))
      .sort((left, right) => left.publication_date.localeCompare(right.publication_date) || left.name.localeCompare(right.name, "en") || left.id.localeCompare(right.id, "en"));
  }

  renderControls() {
    if (!this.controlsHost) return;
    const data = this.indexed.data;
    const field = (key, label, control) => {
      control.id = `timeline-${key}`;
      this.controls[key] = control;
      return element("div", { className: "field" }, [element("label", { for: control.id, text: label }), control]);
    };
    const query = element("input", { type: "search", placeholder: "Search benchmark names or aliases", autocomplete: "off", maxlength: MAX_QUERY_LENGTH });
    let searchTimer;
    query.addEventListener("input", () => {
      window.clearTimeout(searchTimer);
      this.setControlStatus("Updating timeline…");
      searchTimer = window.setTimeout(() => this.updateState({ q: query.value }), SEARCH_DEBOUNCE_MS);
    });
    const categories = [{ value: "", label: "All categories" }, ...[...data.categories]
      .sort((left, right) => left.name.localeCompare(right.name, "en"))
      .map((item) => ({ value: item.id, label: item.name, searchText: (item.aliases || []).join(" ") }))];
    const category = createSearchableCombobox({
      id: "timeline-category",
      label: "Category",
      value: this.state.category,
      options: categories,
      emptyLabel: "All categories",
      placeholder: "Find a category",
      onChange: (value) => this.updateState({ category: value }),
    });
    this.controls.category = category;
    const lab = element("select");
    lab.append(element("option", { value: "", text: "All labs" }));
    data.labs.forEach((item) => lab.append(element("option", { value: item.id, text: item.name })));
    const from = element("input", { type: "date", min: data.corpus.publication_window.start, max: data.corpus.publication_window.end });
    const to = element("input", { type: "date", min: data.corpus.publication_window.start, max: data.corpus.publication_window.end });
    const releases = [{ value: "", label: "No pinned release" }, ...[...data.releases]
      .sort((left, right) => left.name.localeCompare(right.name, "en") || left.publication_date.localeCompare(right.publication_date) || left.id.localeCompare(right.id, "en"))
      .map((release) => ({ value: release.id, label: this.labels.get(release.id), searchText: release.publication_date }))];
    const release = createSearchableCombobox({
      id: "timeline-release",
      label: "Pinned release",
      value: this.state.release,
      options: releases,
      emptyLabel: "No pinned release",
      placeholder: "Find a release",
      onChange: (value) => {
        this.activeReleaseId = value;
        this.updateState({ release: value }, Boolean(value));
      },
    });
    this.controls.release = release;
    const zoom = element("select");
    ZOOM_LEVELS.forEach((level) => zoom.append(element("option", { value: level, text: `${level}×` })));
    const reset = element("button", { className: "button button-quiet", type: "button", text: "Reset" });
    reset.addEventListener("click", () => this.updateState({ q: "", category: "", lab: "", from: "", to: "", zoom: DEFAULT_ZOOM, release: "" }, false, { defaultEnd: true }));
    const fixedControls = { q: query, lab, from, to, zoom };
    Object.entries(fixedControls).forEach(([key, control]) => {
      this.controls[key] = control;
      if (key !== "q") control.addEventListener("change", () => this.updateState({ [key]: control.value }));
    });
    const toolbar = element("div", { className: "timeline-filter-panel", role: "group", "aria-label": "Timeline filters" }, [
      field("q", "Benchmark search", query),
      category.element,
      field("lab", "Lab", lab),
      field("from", "From", from),
      field("to", "To", to),
      field("zoom", "Zoom", zoom),
      release.element,
      element("div", { className: "filter-actions" }, [reset]),
    ]);
    replaceChildren(this.controlsHost, [toolbar, element("p", { className: "route-status", id: "timeline-filter-status", role: "status", "aria-live": "polite" })]);
    this.syncControls();
  }

  setControlStatus(message) {
    const status = document.querySelector("#timeline-filter-status");
    if (status) status.textContent = message;
  }

  syncControls() {
    Object.entries(this.controls).forEach(([key, control]) => {
      if (typeof control.setValue === "function") control.setValue(this.state[key]);
      else control.value = this.state[key];
    });
  }

  updateState(changes, focusDetail = false, options = {}) {
    const previousScroll = this.currentScroll();
    const next = { ...this.state, ...changes };
    if (["q", "category", "lab", "from", "to"].some((key) => changes[key] !== undefined)) next.release = "";
    this.state = this.sanitizeState(next);
    this.writeState("pushState", previousScroll);
    this.syncControls();
    const explicit = this.explicitTarget(changes, this.state);
    this.render({ preserveScroll: previousScroll, explicit, defaultEnd: options.defaultEnd });
    if (focusDetail && this.state.release) this.focusClose();
  }

  render(scrollOptions = {}) {
    const releases = this.releases();
    this.nodeByRelease = new Map();
    replaceChildren(this.mount, [this.chart(releases)]);
    const selected = this.state.release ? this.indexed.releases.get(this.state.release) : null;
    if (selected) this.renderDetail(selected);
    else this.closeDetail();
    this.setControlStatus(`${releases.length} of ${this.indexed.data.releases.length} releases shown.`);
    this.restoreHorizontalPosition(scrollOptions);
  }

  canvasWidth(releases) {
    return Math.max(1600, releases.length * 112) * this.state.zoom;
  }

  chart(releases) {
    const data = this.indexed.data;
    const summary = element("p", { className: "timeline-summary", role: "status", text: `${releases.length} of ${data.releases.length} releases across ${data.labs.length} lab lanes.` });
    const preview = element("section", { className: "timeline-preview", "aria-live": "polite", "aria-atomic": "true" }, [
      element("p", { className: "timeline-preview-copy", text: "Focus, point to, or select a release to inspect benchmarks named in reviewed materials." }),
    ]);
    this.preview = preview;
    const frame = element("div", { className: "timeline-frame", tabindex: "0", role: "region", "aria-label": "Horizontally scrollable release timeline" });
    const canvas = element("div", { className: "timeline-canvas" });
    canvas.style.setProperty("min-width", `${this.canvasWidth(releases)}px`);
    canvas.append(this.axis(data.corpus.publication_window.start, data.corpus.publication_window.end));
    data.labs.forEach((lab, index) => canvas.append(this.lane(lab, index, releases)));
    frame.append(canvas);
    frame.addEventListener("scroll", () => {
      if (this.scrollFramePending) return;
      this.scrollFramePending = requestAnimationFrame(() => {
        this.scrollFramePending = null;
        this.writeState("replaceState", frame.scrollLeft);
      });
    }, { passive: true });
    return element("div", { className: "timeline-shell" }, [summary, frame, preview]);
  }

  axis(start, end) {
    const axis = element("div", { className: "timeline-axis", "aria-hidden": "true" });
    timelineTicks(start, end, 8).forEach((date) => axis.append(element("div", { className: "axis-tick", style: { left: `${datePosition(date, start, end)}%` } }, [element("span", { text: formatDate(date) })])));
    return axis;
  }

  lane(lab, index, releases) {
    const laneReleases = releases.filter((release) => release.lab_id === lab.id);
    const lane = element("section", { className: "timeline-lane", style: { "--lab-color": LAB_COLORS[index % LAB_COLORS.length] }, "aria-label": `${lab.name} releases` });
    lane.append(element("h2", { className: "lab-label", text: lab.name }));
    const track = element("div", { className: "lab-track" });
    laneReleases.forEach((release) => track.append(this.releasePoint(release, datePosition(release.publication_date, this.indexed.data.corpus.publication_window.start, this.indexed.data.corpus.publication_window.end))));
    lane.append(track);
    return lane;
  }

  releasePoint(release, position) {
    const displayName = this.labels.get(release.id);
    const button = element("button", {
      className: "release-node",
      type: "button",
      "aria-expanded": String(this.state.release === release.id),
      "aria-controls": "release-detail-host",
      "aria-label": `${displayName}, ${formatDate(release.publication_date)}`,
    }, [element("span", { className: "release-tick", "aria-hidden": "true" }), element("span", { className: "release-node-label", text: displayName })]);
    this.nodeByRelease.set(release.id, button);
    const preview = () => this.previewRelease(release);
    button.addEventListener("mouseenter", preview);
    button.addEventListener("focus", preview);
    button.addEventListener("click", () => {
      this.activeReleaseId = release.id;
      this.updateState({ release: release.id }, true);
    });
    const edge = position < 3 ? " edge-start" : position > 97 ? " edge-end" : "";
    return element("div", { className: `release-point${edge}`, style: { left: `${position}%` } }, [button]);
  }

  previewRelease(release) {
    const lab = this.indexed.labs.get(release.lab_id);
    const occurrences = this.indexed.occurrencesByRelease.get(release.id) || [];
    replaceChildren(this.preview, [
      element("p", { className: "timeline-preview-name", text: this.labels.get(release.id) }),
      element("p", { className: "timeline-preview-copy", text: `${lab?.name || "Unknown lab"} · ${formatDate(release.publication_date)} · ${occurrences.length} benchmark occurrence${occurrences.length === 1 ? "" : "s"} in reviewed materials` }),
    ]);
  }

  renderDetail(release) {
    if (!this.detailHost) return;
    const occurrences = orderedReleaseOccurrences(this.indexed, release.id);
    const lab = this.indexed.labs.get(release.lab_id);
    const titleId = "release-detail-title";
    const close = element("button", { className: "detail-close icon-button", type: "button", "aria-label": "Close release detail", text: "×", onclick: () => this.closePinned() });
    this.detailHost.hidden = false;
    this.detailHost.setAttribute("aria-labelledby", titleId);
    replaceChildren(this.detailHost, [element("div", { className: "detail-panel" }, [
      element("header", { className: "detail-head" }, [element("div", {}, [element("h2", { id: titleId, text: this.labels.get(release.id) }), element("p", { className: "detail-byline", text: `${lab?.name || "Unknown lab"} · ${formatDate(release.publication_date)}` })]), close]),
      element("h3", { className: "detail-occurrence-title", text: "Benchmarks in reviewed materials" }),
      ...(occurrences.length ? occurrences.map((occurrence) => this.occurrenceDetail(occurrence)) : [element("p", { className: "detail-empty", text: "No benchmark occurrence was found in the reviewed public materials for this release." })]),
    ])]);
  }

  occurrenceDetail(occurrence) {
    const benchmark = this.indexed.benchmarks.get(occurrence.benchmark_id);
    const source = this.indexed.sources.get(occurrence.source_id);
    const sourceHref = this.safeSourceHref(source);
    return element("article", { className: "detail-occurrence" }, [
      element("h4", { text: benchmark?.name || "Unnamed benchmark" }),
      element("p", { text: "Named in the reviewed first-party material for this release." }),
      sourceHref ? element("a", { className: "source-link", href: sourceHref, target: "_blank", rel: "noopener noreferrer", text: "Source" }) : null,
    ]);
  }

  safeSourceHref(source) {
    try {
      const url = new URL(source?.url);
      const lab = this.indexed.labs.get(source?.lab_id);
      const host = url.hostname.toLowerCase().replace(/\.$/, "");
      const allowed = lab?.official_domains || [];
      return url.protocol === "https:" && !url.username && !url.password && allowed.some((domain) => host === domain || host.endsWith(`.${domain}`)) ? url.href : null;
    } catch (_) {
      return null;
    }
  }

  closeDetail() {
    if (!this.detailHost) return;
    this.detailHost.hidden = true;
    replaceChildren(this.detailHost);
  }

  closePinned() {
    const releaseId = this.activeReleaseId || this.state.release;
    this.updateState({ release: "" });
    requestAnimationFrame(() => (this.nodeByRelease.get(releaseId) || this.controls.release?.input)?.focus({ preventScroll: true }));
  }

  focusClose() {
    requestAnimationFrame(() => this.detailHost?.querySelector(".detail-close")?.focus({ preventScroll: true }));
  }

  restoreHorizontalPosition({ restoredScroll = null, preserveScroll = null, explicit = null, initial = false, defaultEnd = false } = {}) {
    const frame = this.mount.querySelector(".timeline-frame");
    if (!frame) return;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const target = restoredScroll !== null ? { type: "scroll", value: restoredScroll } : explicit || (initial ? this.explicitInitialTarget : null);
      if (target?.type === "scroll") frame.scrollLeft = Math.min(target.value, frame.scrollWidth - frame.clientWidth);
      else if (target?.type === "release") this.scrollReleaseIntoView(target.value, frame);
      else if (target?.type === "date") this.scrollDateIntoView(target.value, frame);
      else if (target?.type === "zoom") frame.scrollLeft = 0;
      else if (defaultEnd || (initial && !target)) frame.scrollLeft = frame.scrollWidth - frame.clientWidth;
      else if (finiteScroll(preserveScroll)) frame.scrollLeft = Math.min(preserveScroll, frame.scrollWidth - frame.clientWidth);
      this.writeState("replaceState", frame.scrollLeft);
    }));
  }

  scrollReleaseIntoView(releaseId, frame) {
    const release = this.indexed.releases.get(releaseId);
    if (release) this.scrollDateIntoView(release.publication_date, frame);
  }

  scrollDateIntoView(date, frame) {
    const { start, end } = this.indexed.data.corpus.publication_window;
    const trackStart = window.innerWidth < 768 ? 120 : 160;
    const usable = Math.max(0, frame.scrollWidth - trackStart - 24);
    frame.scrollLeft = Math.max(0, trackStart + usable * (datePosition(date, start, end) / 100) - frame.clientWidth / 2);
  }

  setupFullscreen() {
    if (!this.fullscreenButton || !this.fullscreenTarget) return;
    this.fullscreenButton.addEventListener("click", () => this.toggleFullscreen());
    document.addEventListener("fullscreenchange", () => {
      const active = document.fullscreenElement === this.fullscreenTarget;
      this.fullscreenButton.textContent = active ? "Exit fullscreen" : "Fullscreen";
      this.fullscreenButton.setAttribute("aria-pressed", String(active));
      this.writeState("replaceState");
    });
  }

  async toggleFullscreen() {
    if (document.fullscreenElement === this.fullscreenTarget && document.exitFullscreen) {
      await document.exitFullscreen();
      return;
    }
    if (!this.fullscreenTarget.requestFullscreen || document.fullscreenEnabled === false) {
      this.navigateToFallback();
      return;
    }
    try {
      await this.fullscreenTarget.requestFullscreen();
    } catch (_) {
      this.navigateToFallback();
    }
  }

  navigateToFallback() {
    const url = new URL("./timeline.html", window.location.href);
    this.writeTimelineQuery(url, this.isUiFixture(new URL(window.location.href)));
    window.location.assign(url.href);
  }

  setupEscape() {
    document.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || !this.state.release) return;
      if (!document.fullscreenElement) event.preventDefault();
      this.closePinned();
    });
  }
}

if (typeof document !== "undefined") {
  const timeline = new Timeline();
  timeline.setupEscape();
  void timeline.initialize();
}
