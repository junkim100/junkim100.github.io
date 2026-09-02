import {
  SETUP_FIELDS,
  collisionRows,
  datePosition,
  disclosureText,
  formatDate,
  indexData,
  matchingBenchmarkIds,
  orderedReleaseOccurrences,
  revisionText,
  statusesForOccurrence,
  timelineTicks,
  validateInterface,
} from "./core.mjs";

const LAB_COLORS = ["#2948d7", "#9a3f19", "#18755b", "#7c3ea2", "#9b6511", "#b02458"];
const LAB_SHAPES = ["50%", "2px", "35% 65% 35% 65%", "0 50% 50% 50%", "20%", "50% 10% 50% 10%"];
const STATE_KEYS = ["q", "category", "lab", "from", "to", "zoom", "release"];
const MAX_QUERY_LENGTH = 160;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
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

const element = (tag, options = {}, children = []) => {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(options)) {
    if (value === undefined || value === null) continue;
    if (name === "className") node.className = value;
    else if (name === "text") node.textContent = value;
    else if (name === "style") Object.entries(value).forEach(([property, propertyValue]) => node.style.setProperty(property, propertyValue));
    else if (name.startsWith("on")) node.addEventListener(name.slice(2).toLowerCase(), value);
    else node.setAttribute(name, value);
  }
  for (const child of Array.isArray(children) ? children : [children]) {
    if (child) node.append(child);
  }
  return node;
};

const replaceChildren = (target, children = []) => target.replaceChildren(...children.filter(Boolean));
const labelFor = (value = "") => value.replaceAll("_", " ");

class Timeline {
  constructor() {
    this.mode = document.querySelector("#timeline-host")?.dataset.timelineMode;
    this.host = document.querySelector("#timeline-host");
    this.fullscreenTarget = this.mode === "full" ? this.host?.closest(".timeline-workspace") || this.host : this.host;
    this.mount = document.querySelector("#timeline-chart");
    this.detailHost = document.querySelector("#release-detail-host");
    this.controlsHost = document.querySelector("#timeline-controls");
    this.fullLink = document.querySelector("#timeline-fullscreen-link");
    this.state = this.readState();
    this.indexed = null;
    this.activeTrigger = null;
    this.controls = {};
  }

  readState() {
    const params = new URLSearchParams(window.location.search);
    return Object.fromEntries(STATE_KEYS.map((key) => [key, params.get(key) || ""]));
  }

  isUiFixture(url) {
    return url.searchParams.get("fixture") === "ui" && ["localhost", "127.0.0.1"].includes(url.hostname);
  }

  sanitizeState(candidate) {
    if (!this.indexed) return candidate;
    return sanitizeTimelineState(candidate, this.indexed.data);
  }

  writeTimelineQuery(url, fixtureRequested) {
    url.search = "";
    STATE_KEYS.forEach((key) => {
      const value = this.state[key];
      if (value && (key !== "zoom" || value !== DEFAULT_ZOOM)) url.searchParams.set(key, value);
    });
    if (fixtureRequested) url.searchParams.set("fixture", "ui");
  }

  writeState(method) {
    const url = new URL(window.location.href);
    this.writeTimelineQuery(url, this.isUiFixture(url));
    window.history[method]({}, "", `${url.pathname}${url.search}${url.hash}`);
  }

  async loadData() {
    if (this.isUiFixture(new URL(window.location.href))) {
      return (await import("./tests/ui/fixture.mjs")).fixture;
    }
    const response = await fetch("./public/observatory.json");
    if (!response.ok) throw new Error(`Generated timeline request failed (${response.status}).`);
    return response.json();
  }

  async initialize() {
    if (!this.host || !this.mount || !this.mode) return;
    try {
      this.indexed = indexData(validateInterface(await this.loadData()));
      this.state = this.sanitizeState(this.state);
      this.writeState("replaceState");
      this.renderControls();
      this.render();
      window.addEventListener("popstate", () => {
        this.state = this.sanitizeState(this.readState());
        this.writeState("replaceState");
        this.activeTrigger = null;
        this.syncControls();
        this.render();
      });
    } catch (error) {
      replaceChildren(this.mount, [element("p", { className: "timeline-pending", text: error.message })]);
    }
  }

  releases() {
    const { q, category, lab, from, to } = this.state;
    const matchingIds = matchingBenchmarkIds(this.indexed, q, category);
    return this.indexed.data.releases
      .filter((release) => !lab || release.lab_id === lab)
      .filter((release) => !from || release.publication_date >= from)
      .filter((release) => !to || release.publication_date <= to)
      .filter((release) => (!q && !category) || (this.indexed.occurrencesByRelease.get(release.id) || []).some((occurrence) => matchingIds.has(occurrence.benchmark_id)))
      .sort((left, right) => left.publication_date.localeCompare(right.publication_date) || left.name.localeCompare(right.name, "en"));
  }

  renderControls() {
    if (!this.controlsHost) return;
    const data = this.indexed.data;
    const field = (key, label, control) => {
      const id = `timeline-${key}`;
      control.id = id;
      this.controls[key] = control;
      return element("div", { className: "field" }, [element("label", { for: id, text: label }), control]);
    };
    const query = element("input", { type: "search", placeholder: "Search benchmark names or aliases", autocomplete: "off" });
    const category = element("select");
    category.append(element("option", { value: "", text: "All categories" }));
    data.categories.forEach((item) => category.append(element("option", { value: item.id, text: item.name })));
    const lab = element("select");
    lab.append(element("option", { value: "", text: "All labs" }));
    data.labs.forEach((item) => lab.append(element("option", { value: item.id, text: item.name })));
    const from = element("input", { type: "date", min: data.corpus.publication_window.start, max: data.corpus.publication_window.end });
    const to = element("input", { type: "date", min: data.corpus.publication_window.start, max: data.corpus.publication_window.end });
    const release = element("select");
    release.append(element("option", { value: "", text: "No pinned release" }));
    [...data.releases].sort((left, right) => left.publication_date.localeCompare(right.publication_date) || left.name.localeCompare(right.name, "en")).forEach((item) => {
      release.append(element("option", { value: item.id, text: `${item.name} · ${formatDate(item.publication_date)}` }));
    });
    const zoom = element("select");
    ZOOM_LEVELS.forEach((level) => zoom.append(element("option", { value: level, text: `${level}×` })));
    const reset = element("button", { className: "button", type: "button", text: "Reset filters" });
    reset.addEventListener("click", () => this.updateState(Object.fromEntries(STATE_KEYS.map((key) => [key, ""]))));
    const fields = [
      field("q", "Benchmark search", query),
      field("category", "Category", category),
      field("lab", "Lab", lab),
      field("from", "From", from),
      field("to", "To", to),
      field("zoom", "Zoom", zoom),
      field("release", "Pinned release", release),
    ];
    for (const [key, control] of Object.entries(this.controls)) {
      control.addEventListener("change", () => {
        if (key === "release") this.activeReleaseId = control.value;
        this.updateState({ [key]: control.value }, key === "release");
      });
    }
    const toolbar = element("form", { className: "timeline-filter-panel", "aria-label": "Timeline filters", onsubmit: (event) => event.preventDefault() }, [
      ...fields,
      element("div", { className: "filter-actions" }, [reset]),
    ]);
    const children = [toolbar];
    if (this.mode === "full") children.push(this.fullscreenControls());
    replaceChildren(this.controlsHost, children);
    this.syncControls();
  }

  fullscreenControls() {
    const supported = Boolean(this.fullscreenTarget?.requestFullscreen && (document.fullscreenEnabled ?? true));
    this.fullscreenButton = element("button", {
      className: "button",
      type: "button",
      text: "Enter browser fullscreen",
      disabled: supported ? null : "",
      "aria-describedby": "timeline-fullscreen-status",
    });
    this.fullscreenStatus = element("p", {
      className: "timeline-fullscreen-status",
      id: "timeline-fullscreen-status",
      role: "status",
      text: supported ? "Browser fullscreen is available for this timeline workspace." : "Browser fullscreen is unavailable in this browser.",
    });
    if (supported) {
      this.fullscreenButton.addEventListener("click", () => this.toggleFullscreen());
      document.addEventListener("fullscreenchange", () => this.updateFullscreenControl());
    }
    return element("div", { className: "timeline-fullscreen-controls" }, [this.fullscreenButton, this.fullscreenStatus]);
  }

  async toggleFullscreen() {
    try {
      if (document.fullscreenElement === this.fullscreenTarget) await document.exitFullscreen();
      else await this.fullscreenTarget.requestFullscreen();
    } catch (error) {
      this.fullscreenStatus.textContent = `Browser fullscreen could not start: ${error.message}`;
    }
  }

  updateFullscreenControl() {
    const active = document.fullscreenElement === this.fullscreenTarget;
    this.fullscreenButton.textContent = active ? "Exit browser fullscreen" : "Enter browser fullscreen";
    this.fullscreenStatus.textContent = active ? "Browser fullscreen is active for the timeline workspace." : "Browser fullscreen is available for this timeline workspace.";
  }

  syncControls() {
    Object.entries(this.controls).forEach(([key, control]) => { control.value = this.state[key]; });
    this.syncFullLink();
  }

  syncFullLink() {
    if (!this.fullLink) return;
    const url = new URL("./timeline.html", window.location.href);
    this.writeTimelineQuery(url, this.isUiFixture(new URL(window.location.href)));
    this.fullLink.href = `${url.pathname.split("/").pop()}${url.search}`;
  }

  updateState(changes, focusDetail = false) {
    const next = { ...this.state, ...changes };
    if (changes.q !== undefined || changes.category !== undefined || changes.lab !== undefined || changes.from !== undefined || changes.to !== undefined) next.release = "";
    this.state = this.sanitizeState(next);
    this.writeState("pushState");
    this.syncControls();
    this.render();
    if (focusDetail && this.state.release) this.focusClose();
  }

  render() {
    const releases = this.releases();
    const chart = this.chart(releases);
    const selected = this.state.release ? this.indexed.releases.get(this.state.release) : null;
    replaceChildren(this.mount, [chart]);
    if (selected) this.renderDetail(selected);
    else this.closeDetail(false);
    this.syncFullLink();
  }

  canvasWidth(releases) {
    return Math.max(960, releases.length * 24) * this.state.zoom;
  }

  chart(releases) {
    const data = this.indexed.data;
    const summary = element("p", {
      className: "timeline-summary",
      role: "status",
      text: `${releases.length} of ${data.releases.length} included release IDs shown across ${data.labs.length} lab lanes.`,
    });
    const preview = element("section", { className: "timeline-preview", "aria-live": "polite", "aria-atomic": "true" }, [
      element("p", { className: "kicker", text: "Release preview" }),
      element("p", { className: "timeline-preview-copy", text: "Hover or focus a release ID to preview its reviewed reporting context." }),
    ]);
    this.preview = preview;
    const frame = element("div", { className: "timeline-frame", tabindex: "0", "aria-label": "Scrollable release timeline" });
    const canvas = element("div", { className: "timeline-canvas" });
    const canvasWidth = this.canvasWidth(releases);
    canvas.style.setProperty("min-width", `${canvasWidth}px`);
    canvas.append(this.axis(data.corpus.publication_window.start, data.corpus.publication_window.end));
    data.labs.forEach((lab, index) => canvas.append(this.lane(lab, index, releases)));
    frame.append(canvas);
    return element("div", { className: "timeline-shell" }, [summary, frame, preview]);
  }

  axis(start, end) {
    const axis = element("div", { className: "timeline-axis", "aria-hidden": "true" });
    timelineTicks(start, end, 8).forEach((date) => {
      axis.append(element("div", { className: "axis-tick", style: { left: `${datePosition(date, start, end)}%` } }, [element("span", { text: formatDate(date) })]));
    });
    return axis;
  }

  lane(lab, index, releases) {
    const laneReleases = releases.filter((release) => release.lab_id === lab.id);
    const positions = laneReleases.map((release) => datePosition(release.publication_date, this.indexed.data.corpus.publication_window.start, this.indexed.data.corpus.publication_window.end));
    const canvasWidth = this.canvasWidth(releases);
    const rows = collisionRows(positions.map((position) => position * canvasWidth / 100), 104);
    const height = Math.max(7, 3.25 + ((Math.max(-1, ...rows) + 1) * 2.55));
    const lane = element("section", { className: "timeline-lane", style: { "min-height": `${height}rem`, "--lab-color": LAB_COLORS[index % LAB_COLORS.length], "--lab-shape": LAB_SHAPES[index % LAB_SHAPES.length] } });
    lane.append(element("h3", { className: "lab-label" }, [element("span", { className: "lab-code", text: lab.name.slice(0, 2).toUpperCase() }), element("span", { text: lab.name })]));
    const track = element("div", { className: "lab-track" });
    laneReleases.forEach((release, releaseIndex) => track.append(this.releasePoint(release, positions[releaseIndex], rows[releaseIndex])));
    lane.append(track);
    return lane;
  }

  releasePoint(release, position, row) {
    const button = element("button", {
      className: "release-node",
      type: "button",
      "aria-expanded": String(this.state.release === release.id),
      "aria-controls": "release-detail-host",
      "aria-label": `${release.id}: ${release.name}, ${formatDate(release.publication_date)}`,
      "data-release-id": release.id,
      text: release.id,
    });
    const preview = () => this.previewRelease(release);
    button.addEventListener("mouseenter", preview);
    button.addEventListener("focus", preview);
    button.addEventListener("click", (event) => {
      this.activeTrigger = event.currentTarget;
      this.activeReleaseId = release.id;
      this.updateState({ release: release.id }, true);
    });
    const edge = position < 7 ? " edge-start" : position > 93 ? " edge-end" : "";
    return element("div", { className: `release-point${edge}`, style: { left: `${position}%`, "--release-top": `${0.55 + (row * 2.55)}rem` } }, [button]);
  }

  previewRelease(release) {
    const lab = this.indexed.labs.get(release.lab_id);
    const coverage = this.indexed.coverage.get(release.coverage_id);
    const occurrences = this.indexed.occurrencesByRelease.get(release.id) || [];
    replaceChildren(this.preview, [
      element("p", { className: "kicker", text: "Release preview" }),
      element("p", { className: "timeline-preview-name", text: release.name }),
      element("p", { className: "timeline-preview-copy", text: `${release.id} · ${lab?.name || release.lab_id} · ${formatDate(release.publication_date)} · ${coverage?.review_status || "coverage unavailable"} review · ${occurrences.length} named occurrence${occurrences.length === 1 ? "" : "s"}` }),
    ]);
  }

  renderDetail(release) {
    if (!this.detailHost) return;
    const occurrences = orderedReleaseOccurrences(this.indexed, release.id);
    const coverage = this.indexed.coverage.get(release.coverage_id);
    const lab = this.indexed.labs.get(release.lab_id);
    const model = this.indexed.models.get(release.model_id);
    const lineage = this.indexed.lineages.get(release.lineage_id);
    const titleId = "release-detail-title";
    const close = element("button", { className: "detail-close icon-button", type: "button", "aria-label": "Close release detail", text: "×", onclick: () => this.closePinned() });
    this.detailHost.hidden = false;
    this.detailHost.setAttribute("aria-labelledby", titleId);
    replaceChildren(this.detailHost, [element("div", { className: "detail-panel" }, [
      element("header", { className: "detail-head" }, [
        element("div", {}, [element("p", { className: "kicker", text: "Pinned release context" }), element("h2", { id: titleId, text: release.name }), element("p", { className: "detail-release-id", text: release.id })]),
        close,
      ]),
      element("dl", { className: "detail-meta meta-grid" }, [
        this.meta("Lab", lab?.name || release.lab_id),
        this.meta("Publication date", formatDate(release.publication_date)),
        this.meta("Model", model?.name || release.model_id),
        this.meta("Lineage", lineage?.name || release.lineage_id),
        this.meta("Coverage review", coverage?.review_status ? labelFor(coverage.review_status) : "Unavailable"),
        this.meta("Review date", coverage?.review_date ? formatDate(coverage.review_date) : "Unavailable"),
      ]),
      element("h3", { className: "detail-occurrence-title", text: `Named benchmark occurrences (${occurrences.length})` }),
      ...(occurrences.length ? occurrences.map((occurrence) => this.occurrenceDetail(occurrence)) : [element("p", { className: "detail-empty", text: "No qualifying benchmark occurrence was found in this release’s reviewed source bundle. This does not establish that the lab did not run an evaluation." })]),
    ])]);
  }

  meta(label, value) {
    return element("div", {}, [element("dt", { text: label }), element("dd", { text: value })]);
  }

  occurrenceDetail(occurrence) {
    const benchmark = this.indexed.benchmarks.get(occurrence.benchmark_id);
    const source = this.indexed.sources.get(occurrence.source_id);
    const statuses = statusesForOccurrence(this.indexed, occurrence);
    const labels = statuses.map((id) => this.indexed.definitions.get(id)?.label || labelFor(id)).join(", ") || "Verified occurrence";
    const setup = element("ul", { className: "setup-list" });
    SETUP_FIELDS.forEach(([key, label]) => setup.append(element("li", { text: `${label}: ${disclosureText(occurrence.evaluation_setup?.[key])}` })));
    const sourceHref = this.safeSourceHref(source);
    const sourceLink = sourceHref ? element("p", {}, [element("a", { href: sourceHref, target: "_blank", rel: "noopener noreferrer", text: "Open exact first-party source ↗" })]) : null;
    return element("article", { className: "detail-occurrence" }, [
      element("h4", { text: benchmark?.name || occurrence.benchmark_id }),
      element("p", { text: occurrence.summary }),
      element("dl", { className: "meta-grid" }, [
        this.meta("Reporting state", labels),
        this.meta("Review state", labelFor(occurrence.review_status)),
        this.meta("Source type", labelFor(occurrence.source_type)),
        this.meta("Revision", revisionText(source?.revision)),
        this.meta("Locator", occurrence.locator ? `${occurrence.locator.kind}: ${occurrence.locator.value}` : "Unavailable"),
        this.meta("Record", occurrence.id),
      ]),
      element("h5", { text: "Evaluation setup" }),
      setup,
      sourceLink,
    ]);
  }

  safeSourceHref(source) {
    try {
      const url = new URL(source?.url);
      const lab = this.indexed.labs.get(source?.lab_id);
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

  focusClose() {
    requestAnimationFrame(() => this.detailHost?.querySelector(".detail-close")?.focus());
  }

  closeDetail() {
    if (!this.detailHost) return;
    this.detailHost.hidden = true;
    replaceChildren(this.detailHost);
  }

  closePinned() {
    this.updateState({ release: "" });
    requestAnimationFrame(() => {
      const trigger = [...this.mount.querySelectorAll("[data-release-id]")].find((node) => node.dataset.releaseId === this.activeReleaseId);
      (trigger || this.controls.release)?.focus();
    });
  }

  setupEscape() {
    document.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      const fullscreenActive = Boolean(document.fullscreenElement);
      if (!this.state.release && !fullscreenActive) return;
      event.preventDefault();
      if (this.state.release) this.closePinned();
      if (fullscreenActive && document.exitFullscreen) document.exitFullscreen().catch(() => {});
    });
  }
}

if (typeof document !== "undefined") {
  const timeline = new Timeline();
  timeline.setupEscape();
  timeline.initialize();
}
