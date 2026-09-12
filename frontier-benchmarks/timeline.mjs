import {
  captureTrackCenter,
  createCancelableSearch,
  createSearchableCombobox,
  datePosition,
  decodeViewState,
  encodeViewState,
  formatDate,
  historyPayload,
  indexData,
  matchingReleaseRecords,
  restoreTrackCenter,
  retainedReleaseOccurrences,
  scrollToNewest,
  sourceDisclosure,
  timelineTicks,
  trackGeometry,
  validateInterface,
} from "./core.mjs";

const LAB_COLORS = ["#315b8a", "#8b5540", "#31725f", "#735a91", "#8a6a2f", "#8a4564"];
const ACCEPTED_ZOOM_LEVELS = new Set([1, 1.5, 2, 2.5, 3, 4]);
const RELEASE_GAP = 156;
export const SEARCH_DEBOUNCE_MS = 150;
export const ZOOM_LEVELS = Object.freeze([1, 2, 4]);
export const DEFAULT_ZOOM = ZOOM_LEVELS[0];

export function sanitizeTimelineState(candidate, data) {
  const params = new URLSearchParams({ v: "2" });
  for (const id of candidate.benchmarks || []) params.append("benchmark", id);
  for (const key of ["q", "category", "lab", "from", "to", "zoom", "center", "release"]) if (candidate[key] !== undefined && candidate[key] !== "") params.set(key, candidate[key]);
  const state = decodeViewState("timeline", params, data).state;
  return { q: state.q, category: state.category, lab: state.lab, from: state.from, to: state.to, zoom: state.zoom, release: state.release };
}

export function releaseDisplayLabels(releases) {
  const counts = new Map();
  releases.forEach((release) => counts.set(release.name, (counts.get(release.name) || 0) + 1));
  return new Map(releases.map((release) => [release.id, counts.get(release.name) > 1 ? `${release.name} (${release.publication_date})` : release.name]));
}

/** Groups sorted releases exactly once when dates match or adjacent measured coordinates collide. */
export function releaseChronologyClusters(releases = [], positions = [], minimumGap = RELEASE_GAP) {
  if (releases.length !== positions.length) throw new Error("Releases and positions must have equal lengths.");
  const clusters = [];
  releases.forEach((release, index) => {
    const position = positions[index];
    if (!Number.isFinite(position)) throw new Error("Release positions must be finite.");
    const previous = clusters.at(-1);
    if (previous && (previous.date === release.publication_date || position - previous.lastPosition < minimumGap)) {
      previous.releases.push(release);
      previous.lastPosition = position;
    } else {
      clusters.push({ date: release.publication_date, position, lastPosition: position, releases: [release] });
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

/** Minimize relaxed filters, preferring to keep the comparison on equal-cost choices. */
export function revealReleaseChanges(indexed, state, releaseId) {
  const release = indexed.releases.get(releaseId);
  if (!release) return null;
  const changes = { center: instantForDate(release.publication_date) };
  if (state.lab && state.lab !== release.lab_id) changes.lab = "";
  if (state.from && release.publication_date < state.from) changes.from = "";
  if (state.to && release.publication_date > state.to) changes.to = "";
  const keys = ["q", "category", "benchmarks"].filter((key) => state[key]?.length);
  const options = Array.from({ length: 2 ** keys.length }, (_, mask) => keys.filter((_, bit) => mask & (1 << bit)));
  options.sort((a, b) => a.length - b.length || Number(a.includes("benchmarks")) - Number(b.includes("benchmarks")));
  for (const relaxed of options) {
    const candidate = { ...changes, ...Object.fromEntries(relaxed.map((key) => [key, key === "benchmarks" ? [] : ""])) };
    if (matchingReleaseRecords(indexed, { ...state, ...candidate }).some((item) => item.id === releaseId)) return candidate;
  }
  return null;
}

export class Timeline {
  constructor() {
    this.host = document.querySelector("#timeline-host");
    this.mount = document.querySelector("#timeline-chart");
    this.detailHost = document.querySelector("#release-detail-host");
    this.controlsHost = document.querySelector("#timeline-controls");
    this.indexed = null;
    this.state = null;
    this.controls = {};
    this.nodeByRelease = new Map();
    this.cluster = null;
    this.triggeringNode = null;
    this.restoringViewport = false;
    this.restoreGeneration = 0;
    this.restoreFramePending = null;
    this.scrollFramePending = null;
    this.userScrollPending = false;
    this.filtersOpen = false;
    this.scrollInputs = new Set();
    this.scrollIdleTimer = null;
    this.edgeClamped = false;
    this.resizeObserver = null;
  }

  async loadData() {
    const response = await fetch("./public/observatory.json");
    if (!response.ok) throw new Error(`Generated timeline request failed (${response.status}).`);
    return response.json();
  }

  decode(historyState = window.history.state) {
    return decodeViewState("timeline", window.location.search, this.indexed, historyState || {});
  }

  targetUrl() {
    const url = new URL(window.location.href);
    url.search = encodeViewState("timeline", this.state);
    return `${url.pathname}${url.search}${url.hash}`;
  }

  writeState(method = "replaceState", focusedId = "") {
    window.history[method](historyPayload(window.history.state, this.state, "timeline", focusedId), "", this.targetUrl());
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

  async initialize() {
    if (!this.host || !this.mount || !this.detailHost || !this.controlsHost) return;
    try {
      this.indexed = indexData(validateInterface(await this.loadData()));
      this.labels = releaseDisplayLabels(this.indexed.data.releases);
      this.applyDecoded(this.decode(), true);
      this.renderControls();
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
        this.resizeObserver.observe(this.mount);
      }
      document.addEventListener("keydown", (event) => this.handleEscape(event));
      document.querySelectorAll(".primary-nav a, .wordmark").forEach((link) => link.addEventListener("click", () => this.prepareRouteLink(link)));
    } catch {
      this.renderError();
    }
  }

  applyDecoded(decoded, canonicalize) {
    this.state = decoded.state;
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
    const reload = element("button", { className: "button", type: "button", text: "Reload", onclick: () => window.location.reload() });
    replaceChildren(this.controlsHost, [element("div", { className: "chronology-error", role: "alert" }, [element("p", { text: "Release filters and controls could not be loaded." }), reload])]);
    replaceChildren(this.mount, [element("p", { className: "chronology-error", role: "alert", text: "Release chronology data is unavailable." })]);
    this.detailHost.hidden = true;
  }

  renderControls() {
    const data = this.indexed.data;
    const query = element("input", { id: "timeline-q", type: "search", placeholder: "Search benchmark names, aliases or categories", autocomplete: "off", maxlength: "160" });
    this.search = createCancelableSearch(() => this.writeState("replaceState"), SEARCH_DEBOUNCE_MS, window);
    query.addEventListener("input", () => {
      this.settlePendingCenter();
      this.state.q = query.value.trim().slice(0, 160);
      this.search.schedule(this.state.q);
      this.render("Search results updated.");
    });
    const categoryOptions = [{ value: "", label: "All categories" }, ...data.categories.slice().sort((a, b) => a.name.localeCompare(b.name, "en")).map((item) => ({ value: item.id, label: item.name, searchText: (item.aliases || []).join(" ") }))];
    const category = createSearchableCombobox({ id: "timeline-category", label: "Benchmark category", value: this.state.category, options: categoryOptions, emptyLabel: "All categories", placeholder: "Find a category", onChange: (value) => this.mutate({ category: value }, "Benchmark category filter updated.") });
    const lab = element("select", { id: "timeline-lab" });
    lab.append(element("option", { value: "", text: "All labs" }));
    data.labs.forEach((item) => lab.append(element("option", { value: item.id, text: item.name })));
    const from = element("input", { id: "timeline-from", type: "date", min: data.corpus.publication_window.start, max: data.corpus.publication_window.end });
    const to = element("input", { id: "timeline-to", type: "date", min: data.corpus.publication_window.start, max: data.corpus.publication_window.end });
    this.controls = { q: query, category, lab, from, to };
    this.releaseControl = createSearchableCombobox({ id: "timeline-release", label: "Pin release", value: this.state.release, options: [{ value: "", label: "No pinned release" }, ...data.releases.map((release) => ({ value: release.id, label: this.labels.get(release.id), searchText: release.id }))], emptyLabel: "No pinned release", placeholder: "Find a release", onChange: (release) => this.mutate({ release }, release ? "Release pinned without changing chronological position." : "Pinned release cleared.") });
    for (const [key, control] of Object.entries({ lab, from, to })) control.addEventListener("change", () => this.mutate({ [key]: control.value }, "Result filters updated."));
    const field = (label, control) => element("div", { className: "field" }, [element("label", { for: control.id, text: label }), control]);
    this.filterDetails = element("details", { className: "chronology-filters" }, [
      element("summary", { text: "Result filters" }),
      element("div", { className: "timeline-filter-panel" }, [field("Benchmark search", query), category.element, field("Lab", lab), field("From release date", from), field("To release date", to), element("div", { className: "filter-actions" }, [element("button", { className: "button button-quiet", type: "button", text: "Clear result filters", onclick: () => this.clearResultFilters() })])]),
    ]);
    this.filterDetails.addEventListener("toggle", () => { if (window.innerWidth < 768) this.filtersOpen = this.filterDetails.open; });

    this.zoomControl = element("select", { id: "timeline-zoom", "aria-label": "Zoom" });
    this.fillZoomOptions();
    this.zoomControl.addEventListener("change", () => this.mutate({ zoom: Number(this.zoomControl.value) }, "Zoom updated."));
    this.jumpDate = element("input", { id: "timeline-jump-date", type: "date", min: data.corpus.publication_window.start, max: data.corpus.publication_window.end, "aria-label": "Jump date" });
    const toolbar = element("div", { className: "chronology-toolbar", role: "group", "aria-label": "Chronology position" }, [
      element("button", { className: "button", type: "button", text: "Previous period", onclick: () => this.panPeriod(-1) }),
      element("button", { className: "button", type: "button", text: "Next period", onclick: () => this.panPeriod(1) }),
      this.jumpDate,
      element("button", { className: "button", type: "button", text: "Jump to date", onclick: () => this.jumpToDate() }),
      element("button", { className: "button", type: "button", text: "Latest", onclick: () => this.latest() }),
      this.zoomControl,
      element("button", { className: "button", type: "button", text: "Copy link", onclick: () => this.copyLink() }),
      element("button", { className: "button button-quiet", type: "button", text: "Reset", onclick: () => this.resetView() }),
    ]);
    this.status = element("p", { className: "route-status", role: "status", "aria-live": "polite" });
    this.edgeStatus = element("p", { className: "chronology-edge", role: "status" });
    this.noticeHost = element("div", { className: "chronology-notices", role: "status", "aria-live": "polite" });
    this.fallbackHost = element("div", { className: "copy-fallback", hidden: true });
    replaceChildren(this.controlsHost, [this.filterDetails, this.releaseControl.element, toolbar, this.status, this.edgeStatus, this.noticeHost, this.fallbackHost]);
    this.syncControls();
  }

  fillZoomOptions() {
    const levels = new Set(ZOOM_LEVELS);
    if (ACCEPTED_ZOOM_LEVELS.has(Number(this.state.zoom))) levels.add(Number(this.state.zoom));
    replaceChildren(this.zoomControl, [...levels].sort((a, b) => a - b).map((level) => element("option", { value: level, text: `${level}×` })));
  }

  syncControls() {
    if (!this.controls.q) return;
    this.controls.q.value = this.state.q;
    this.controls.category.setValue(this.state.category);
    this.releaseControl.setValue(this.state.release);
    for (const key of ["lab", "from", "to"]) this.controls[key].value = this.state[key] || "";
    this.fillZoomOptions();
    this.zoomControl.value = String(this.state.zoom);
    this.syncFilterDisclosure();
  }

  activeFilterCount() {
    return [this.state.q, this.state.category, this.state.lab, this.state.from, this.state.to].filter(Boolean).length;
  }

  syncFilterDisclosure() {
    if (!this.filterDetails) return;
    const wide = window.innerWidth >= 768;
    const focusedInside = this.filterDetails.contains(document.activeElement);
    this.filterDetails.open = wide || Boolean(this.activeFilterCount()) || focusedInside || this.filtersOpen;
    const count = this.activeFilterCount();
    this.filterDetails.querySelector("summary").textContent = count ? `Result filters (${count} active)` : "Result filters";
  }

  releases() {
    return matchingReleaseRecords(this.indexed, this.state).slice().sort((left, right) => left.publication_date.localeCompare(right.publication_date) || left.name.localeCompare(right.name, "en") || left.id.localeCompare(right.id, "en"));
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
    const decoded = decodeViewState("timeline", encodeViewState("timeline", preserveChronologyCenter(this.state, changes)), this.indexed, {});
    this.state = decoded.state;
    this.notices = [...new Set([...(this.notices || []), ...decoded.notices])];
    this.writeState("pushState", focusedId);
    this.syncControls();
    this.render(message);
    if (active && !active.isConnected) this.restoreFocus(focusedId);
  }

  restoreFocus(focusedId = "") {
    requestAnimationFrame(() => {
      const target = document.getElementById(focusedId) || (this.state.release ? this.detailHost.querySelector("h2") : null) || this.controls.q;
      if (target?.isConnected && !target.disabled) target.focus({ preventScroll: true });
    });
  }

  clearResultFilters() {
    this.mutate({ q: "", category: "", lab: "", from: "", to: "" }, "Result filters cleared.");
  }

  resetView() {
    this.cancelAsync();
    this.state = decodeViewState("timeline", "?v=2", this.indexed, {}).state;
    this.cluster = null;
    this.notices = [];
    this.historicalIds = [];
    this.filtersOpen = false;
    this.writeState("pushState");
    this.syncControls();
    this.render("Release chronology reset to all releases and latest.");
  }

  render(message = "") {
    this.restoringViewport = true;
    const releases = this.releases();
    this.currentReleases = releases;
    this.nodeByRelease = new Map();
    this.renderNotices();
    replaceChildren(this.mount, [this.chart(releases)]);
    this.populateReleaseNodes();
    this.renderInspector();
    this.status.textContent = message || `${releases.length} of ${this.indexed.data.releases.length} releases shown. Release dates position markers.`;
    this.restoreViewport();
  }

  renderNotices() {
    const nodes = (this.notices || []).map((notice) => element("p", { text: notice }));
    for (const id of this.historicalIds || []) nodes.push(element("p", {}, [document.createTextNode(`${id} is historical or withheld. `), element("a", { href: `./history.html?v=2&benchmark=${encodeURIComponent(id)}&audit=all`, text: "Open its History audit" })]));
    replaceChildren(this.noticeHost, nodes);
  }

  chart(releases) {
    const data = this.indexed.data;
    const empty = releases.length ? null : element("div", { className: "timeline-empty" }, [element("h3", { text: "No releases match current result filters" }), element("p", { text: "The corpus still contains releases. Clear result filters while preserving the chronological position and any pinned release." }), element("button", { className: "button", type: "button", text: "Clear result filters", onclick: () => this.clearResultFilters() })]);
    const frame = element("div", { className: "timeline-frame", tabindex: "0", role: "region", "aria-label": "Horizontally scrollable release chronology" });
    const canvas = element("div", { className: "timeline-canvas", style: { width: `${Math.round(Math.max(1600, 2200 * Number(this.state.zoom)))}px` } });
    canvas.append(element("div", { className: "timeline-axis", "aria-hidden": "true" }, timelineTicks(data.corpus.publication_window.start, data.corpus.publication_window.end, 8).map((date) => element("div", { className: "axis-tick", style: { left: `${datePosition(date, data.corpus.publication_window.start, data.corpus.publication_window.end)}%` } }, [element("span", { text: formatDate(date) })]))));
    const labs = this.state.lab ? data.labs.filter((lab) => lab.id === this.state.lab) : data.labs;
    labs.forEach((lab, index) => canvas.append(this.laneShell(lab, index, releases.filter((release) => release.lab_id === lab.id))));
    frame.append(canvas);
    for (const type of ["pointerdown", "keydown", "wheel", "touchstart"]) frame.addEventListener(type, (event) => this.beginScrollInput(event), { passive: true });
    frame.addEventListener("scrollend", () => this.finishUserScroll());
    frame.addEventListener("scroll", () => this.onScroll(), { passive: true });
    return element("div", { className: "timeline-shell" }, [element("p", { className: "timeline-summary", text: `${releases.length} releases across ${new Set(releases.map((release) => release.lab_id)).size} lab lanes. The axis remains fixed to ${data.corpus.publication_window.start} through ${data.corpus.publication_window.end}.` }), empty, frame]);
  }

  laneShell(lab, index, releases) {
    const lane = element("section", { className: "timeline-lane", style: { "--lab-color": LAB_COLORS[index % LAB_COLORS.length] }, "aria-label": `${lab.name} releases` });
    lane.append(element("h2", { className: "lab-label", text: lab.name }));
    lane.append(element("div", { className: "lab-track", "data-lab-track": lab.id, "data-release-ids": releases.map((release) => release.id).join(" ") }));
    return lane;
  }

  populateReleaseNodes() {
    this.nodeByRelease = new Map();
    const { start, end } = this.indexed.data.corpus.publication_window;
    for (const lab of this.indexed.data.labs) {
      const track = this.mount.querySelector(`[data-lab-track="${CSS.escape(lab.id)}"]`);
      if (!track) continue;
      track.replaceChildren();
      const ids = (track.dataset.releaseIds || "").split(" ").filter(Boolean);
      const releases = ids.map((id) => this.indexed.releases.get(id)).sort((left, right) => left.publication_date.localeCompare(right.publication_date) || left.name.localeCompare(right.name, "en") || left.id.localeCompare(right.id, "en"));
      const width = track.getBoundingClientRect().width || track.clientWidth || 1;
      const positions = releases.map((release) => datePosition(release.publication_date, start, end) / 100 * width);
      for (const cluster of releaseChronologyClusters(releases, positions, RELEASE_GAP)) track.append(this.releaseCluster(cluster));
    }
  }

  releaseCluster(cluster) {
    const { start, end } = this.indexed.data.corpus.publication_window;
    const position = datePosition(cluster.date, start, end);
    if (cluster.releases.length > 1) {
      const lastDate = cluster.releases.at(-1).publication_date;
      const dateLabel = lastDate === cluster.date ? formatDate(cluster.date) : `${formatDate(cluster.date)} to ${formatDate(lastDate)}`;
      const button = element("button", { className: `release-node release-cluster${position > 97 ? " edge-end" : ""}`, type: "button", "aria-label": `${cluster.releases.length} releases from ${dateLabel}`, style: { left: `${position}%` } }, [element("strong", { text: `${cluster.releases.length} releases` }), element("span", { text: dateLabel })]);
      button.addEventListener("click", () => {
        this.triggeringNode = button;
        this.cluster = cluster;
        this.renderInspector();
        requestAnimationFrame(() => this.detailHost.querySelector("h2")?.focus({ preventScroll: true }));
      });
      return button;
    }
    const release = cluster.releases[0];
    const button = element("button", { className: `release-node${position > 97 ? " edge-end" : ""}`, type: "button", "aria-expanded": String(this.state.release === release.id), "aria-controls": "release-detail-host", "aria-label": `${this.labels.get(release.id)}, ${formatDate(release.publication_date)}`, style: { left: `${position}%` } }, [element("span", { className: "release-tick", "aria-hidden": "true" }), element("span", { className: "release-node-label", text: this.labels.get(release.id) }), element("span", { className: "release-node-date", text: formatDate(release.publication_date) })]);
    this.nodeByRelease.set(release.id, button);
    button.addEventListener("click", () => {
      this.triggeringNode = button;
      this.cluster = null;
      this.mutate({ release: release.id }, `${release.name} pinned.`, release.id);
      requestAnimationFrame(() => this.detailHost.querySelector("h2")?.focus({ preventScroll: true }));
    });
    return button;
  }

  renderInspector() {
    if (this.cluster) return this.renderClusterInspector();
    const release = this.state.release ? this.indexed.releases.get(this.state.release) : null;
    if (!release) {
      this.detailHost.hidden = true;
      return replaceChildren(this.detailHost);
    }
    const visible = this.currentReleases.some((item) => item.id === release.id);
    const lab = this.indexed.labs.get(release.lab_id);
    const occurrences = retainedReleaseOccurrences(this.indexed, release.id);
    const close = element("button", { className: "detail-close icon-button", type: "button", "aria-label": "Clear pinned release", text: "×", onclick: () => this.clearPin(true) });
    this.detailHost.hidden = false;
    replaceChildren(this.detailHost, [element("div", { className: "detail-panel" }, [
      element("header", { className: "detail-head" }, [element("div", {}, [element("h2", { id: "release-detail-title", tabindex: "-1", text: this.labels.get(release.id) }), element("p", { className: "detail-byline", text: `${lab?.name || "Unknown lab"} · release date ${formatDate(release.publication_date)}` }), !visible ? element("p", { className: "outside-filter", text: "Pinned release outside current filters" }) : null]), close]),
      element("div", { className: "inspector-actions" }, [element("button", { className: "button button-quiet", type: "button", text: "Clear pin", onclick: () => this.clearPin(true) }), !visible ? element("button", { className: "button", type: "button", text: "Reveal release", onclick: () => this.revealRelease(release) }) : null]),
      element("h3", { className: "detail-occurrence-title", text: "Exact retained occurrences" }),
      ...(occurrences.length ? occurrences.map((occurrence) => sourceDisclosure(this.indexed, occurrence)) : [element("p", { className: "detail-empty", text: "No retained benchmark occurrence is available for this release in the bounded corpus. Withheld or incomplete evidence is not presented as non-reporting." })]),
    ])]);
  }

  renderClusterInspector() {
    const releases = this.cluster.releases.slice().sort((left, right) => left.name.localeCompare(right.name, "en") || left.id.localeCompare(right.id, "en"));
    const rows = releases.map((release) => {
      const occurrences = retainedReleaseOccurrences(this.indexed, release.id).slice().sort((left, right) => left.id.localeCompare(right.id, "en"));
      return element("li", {}, [element("button", { className: "button cluster-member", type: "button", text: `${release.name} · ${release.id}`, onclick: () => { this.cluster = null; this.mutate({ release: release.id }, `${release.name} pinned.`, release.id); } }), element("span", { text: `Release date ${release.publication_date}` }), occurrences.length ? element("ul", { className: "cluster-occurrences" }, occurrences.map((occurrence) => element("li", { text: occurrence.id }))) : element("p", { text: "No retained occurrences in this bounded corpus." })]);
    });
    const close = element("button", { className: "detail-close icon-button", type: "button", "aria-label": "Close cluster inspector", text: "×", onclick: () => this.closeCluster(true) });
    this.detailHost.hidden = false;
    replaceChildren(this.detailHost, [element("div", { className: "detail-panel" }, [element("header", { className: "detail-head" }, [element("div", {}, [element("h2", { tabindex: "-1", text: `${releases.length} releases near ${formatDate(this.cluster.date)}` }), element("p", { className: "detail-byline", text: "Every release is ordered by name and ID. Every retained occurrence is ordered by occurrence ID." })]), close]), element("ul", { className: "cluster-list" }, rows)])]);
  }

  closeCluster(restoreFocus) {
    const trigger = this.triggeringNode;
    this.cluster = null;
    this.renderInspector();
    if (restoreFocus) requestAnimationFrame(() => (trigger?.isConnected ? trigger : this.controls.q)?.focus({ preventScroll: true }));
  }

  clearPin(restoreFocus) {
    const releaseId = this.state.release;
    const trigger = this.triggeringNode;
    this.mutate({ release: "" }, "Pinned release cleared.");
    if (restoreFocus) requestAnimationFrame(() => (trigger?.isConnected ? trigger : this.nodeByRelease.get(releaseId) || this.controls.q)?.focus({ preventScroll: true }));
  }

  revealRelease(release) {
    const target = this.indexed.releases.get(release?.id);
    const changes = revealReleaseChanges(this.indexed, this.state, target?.id);
    if (!changes) {
      this.status.textContent = "Release could not be revealed. The target is unavailable; filters and position were kept.";
      return;
    }
    const labels = { q: "benchmark search", category: "benchmark category", benchmarks: "benchmark selection", lab: "lab", from: "from date", to: "to date" };
    const cleared = Object.keys(changes).filter((key) => key !== "center").map((key) => labels[key]);
    this.mutate(changes, `${target.name} revealed and chronology position updated.${cleared.length ? ` Cleared conflicting filters: ${cleared.join(", ")}.` : " Existing filters kept."}`, target.id);
  }

  currentGeometryNodes() {
    const frame = this.mount?.querySelector(".timeline-frame");
    const track = frame?.querySelector(".lab-track");
    const label = frame?.querySelector(".lab-label");
    return { frame, track, label };
  }

  refreshGeometry() {
    if (this.userScrollPending) { this.settlePendingCenter(); this.writeState("replaceState"); }
    const { track } = this.currentGeometryNodes();
    const width = track?.getBoundingClientRect().width;
    if (width !== this.measuredTrackWidth) {
      this.measuredTrackWidth = width;
      const active = document.activeElement;
      this.populateReleaseNodes();
      if (active && !active.isConnected) this.restoreFocus(active.id);
    }
    this.restoreViewport();
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
    if (!date) {
      this.status.textContent = "Choose a jump date first.";
      return;
    }
    this.mutate({ center: instantForDate(date) }, `Jumped to ${formatDate(date)}.`);
  }

  latest() {
    this.mutate({ center: "" }, "Jumped to the latest edge.");
  }

  updateEdgeStatus() {
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
      this.status.textContent = "Shareable link copied.";
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
}

if (typeof document !== "undefined") {
  const timeline = new Timeline();
  void timeline.initialize();
}
