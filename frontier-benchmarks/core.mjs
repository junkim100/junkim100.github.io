export const SETUP_FIELDS = [
  ["prompting", "Prompting"],
  ["shot_configuration", "Shot configuration"],
  ["tool_use", "Tool use"],
  ["evaluation_harness", "Evaluation harness"],
  ["sample_selection", "Sample selection"],
];

export function normalize(value = "") {
  return String(value)
    .normalize("NFKD")
    .toLocaleLowerCase("en")
    .replaceAll("+", " plus ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function byId(records = []) {
  return new Map(records.map((record) => [record.id, record]));
}

export function indexData(data) {
  const indexed = {
    data,
    labs: byId(data.labs),
    categories: byId(data.categories),
    lineages: byId(data.lineages),
    models: byId(data.models),
    releases: byId(data.releases),
    benchmarks: byId(data.benchmarks),
    sources: byId(data.sources),
    coverage: byId(data.coverage),
    definitions: byId(data.canonical_definitions),
    statusesByRelease: new Map(),
    occurrencesByRelease: new Map(),
  };

  for (const status of data.derived_statuses || []) {
    const statuses = indexed.statusesByRelease.get(status.release_id) || [];
    statuses.push(status);
    indexed.statusesByRelease.set(status.release_id, statuses);
  }
  for (const occurrence of data.occurrences || []) {
    const occurrences = indexed.occurrencesByRelease.get(occurrence.release_id) || [];
    occurrences.push(occurrence);
    indexed.occurrencesByRelease.set(occurrence.release_id, occurrences);
  }
  return indexed;
}

const ROUTE_KEYS = Object.freeze({
  trends: new Set(["search", "category"]),
  timeline: new Set(["q", "category"]),
  ledger: new Set(["q", "status", "sort", "dir", "size", "page"]),
  history: new Set(["q", "status", "sort", "dir", "size", "page", "audit"]),
  about: new Set(),
});
const COMMON_KEYS = ["benchmark", "lab", "from", "to", "zoom", "center", "release"];
const ZOOM_VALUES = new Set(["1", "1.5", "2", "2.5", "3", "4"]);
const PAGE_SIZE_VALUES = new Set(["25", "50", "100"]);
const SORT_VALUES = Object.freeze({
  ledger: new Set(["date", "name", "lab", "coverage"]),
  history: new Set(["date", "benchmark", "release", "status", "lab"]),
});
const DEFAULT_BENCHMARK_ID = "benchmark_terminal_bench_2_0";
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

const dataRecordMap = (data, key) => {
  if (data?.[key] instanceof Map) return data[key];
  const raw = data?.data || data;
  return byId(Array.isArray(raw?.[key]) ? raw[key] : []);
};

const dataRecords = (data, key) => {
  const raw = data?.data || data;
  return Array.isArray(raw?.[key]) ? raw[key] : [];
};

const publicationWindow = (data) => (data?.data || data)?.corpus?.publication_window || {};

const isRealDate = (value) => {
  if (typeof value !== "string" || !ISO_DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
};

const instantValue = (value) => {
  if (isRealDate(value)) return `${value}T00:00:00.000Z`;
  if (typeof value !== "string" || !ISO_INSTANT.test(value)) return "";
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || !isRealDate(value.slice(0, 10))) return "";
  const canonical = parsed.toISOString();
  return canonical.slice(0, 19) === value.slice(0, 19) ? canonical : "";
};

const boundedDate = (value, data) => {
  if (!isRealDate(value)) return "";
  const { start, end } = publicationWindow(data);
  return (!start || value >= start) && (!end || value <= end) ? value : "";
};

const boundedInstant = (value, data) => {
  const instant = instantValue(value);
  if (!instant) return "";
  const { start, end } = publicationWindow(data);
  const time = Date.parse(instant);
  if (start && time < Date.parse(`${start}T00:00:00.000Z`)) return "";
  if (end && time > Date.parse(`${end}T00:00:00.000Z`)) return "";
  return instant;
};

const acceptedSingular = (params, key, validate, fallback, notices) => {
  const values = params.getAll(key);
  if (!values.length) return fallback;
  for (const value of values) {
    const accepted = validate(value);
    if (accepted !== null && accepted !== undefined) return accepted;
    notices.push(`Ignored invalid ${key} value: ${value}`);
  }
  return fallback;
};

const acceptedText = (value, maximum, key, notices) => {
  const trimmed = String(value).trim();
  if (trimmed.length <= maximum) return trimmed;
  notices.push(`${key} was shortened to ${maximum} characters.`);
  return trimmed.slice(0, maximum);
};

const compareBenchmarkIds = (benchmarks, left, right) => {
  const leftName = normalize(benchmarks.get(left)?.name || left);
  const rightName = normalize(benchmarks.get(right)?.name || right);
  return leftName.localeCompare(rightName, "en") || String(left).localeCompare(String(right), "en");
};

export function decodeViewState(route, search = "", data, historyState = {}) {
  if (!Object.hasOwn(ROUTE_KEYS, route)) throw new Error(`Unsupported route: ${route}`);
  const params = new URLSearchParams(search);
  const notices = [];
  const historicalIds = [];
  const benchmarks = dataRecordMap(data, "benchmarks");
  const labs = dataRecordMap(data, "labs");
  const categories = dataRecordMap(data, "categories");
  const releases = dataRecordMap(data, "releases");
  const definitions = dataRecordMap(data, "canonical_definitions");
  const rawBenchmarkIds = params.getAll("benchmark");
  const selected = [];
  for (const requestedId of rawBenchmarkIds) {
    const benchmark = benchmarks.get(requestedId);
    if (!benchmark) {
      notices.push(`Ignored unknown benchmark ID: ${requestedId}`);
      continue;
    }
    if (benchmark.identity_status === "quarantined") {
      if (!historicalIds.includes(requestedId)) historicalIds.push(requestedId);
      notices.push(`Benchmark identity ${requestedId} is quarantined and retained only as historical context.`);
      if (route === "history" && !selected.includes(requestedId)) {
        if (selected.length < 6) selected.push(requestedId);
        else if (!notices.includes("Only the first six canonical benchmarks were retained.")) notices.push("Only the first six canonical benchmarks were retained.");
      }
      continue;
    }
    const canonicalId = benchmark.identity_status === "merged" ? benchmark.canonical_benchmark_id : requestedId;
    const canonical = benchmarks.get(canonicalId);
    if (!canonical || !isLiveCanonical(canonical)) {
      notices.push(`Ignored benchmark ID without a live canonical identity: ${requestedId}`);
      continue;
    }
    if (canonicalId !== requestedId) notices.push(`Mapped merged benchmark ID ${requestedId} to ${canonicalId}.`);
    if (!selected.includes(canonicalId)) {
      if (selected.length < 6) selected.push(canonicalId);
      else if (!notices.includes("Only the first six canonical benchmarks were retained.")) notices.push("Only the first six canonical benchmarks were retained.");
    }
  }
  selected.sort((left, right) => compareBenchmarkIds(benchmarks, left, right));
  if (route === "trends" && !selected.some((id) => isLiveCanonical(benchmarks.get(id)))) {
    const fallback = isLiveCanonical(benchmarks.get(DEFAULT_BENCHMARK_ID)) ? DEFAULT_BENCHMARK_ID
      : [...benchmarks.keys()].filter((id) => isLiveCanonical(benchmarks.get(id))).sort((a, b) => compareBenchmarkIds(benchmarks, a, b))[0];
    if (fallback) selected.push(fallback);
  }

  const finite = (allowed, transform = (value) => value) => (value) => allowed.has(value) ? transform(value) : null;
  const known = (records) => (value) => value === "" || records.has(value) ? value : null;
  const date = (value) => value === "" ? "" : boundedDate(value, data) || null;
  const state = {
    benchmarks: selected,
    lab: acceptedSingular(params, "lab", known(labs), "", notices),
    from: acceptedSingular(params, "from", date, "", notices),
    to: acceptedSingular(params, "to", date, "", notices),
    zoom: acceptedSingular(params, "zoom", finite(ZOOM_VALUES, Number), 1, notices),
    center: "",
    release: acceptedSingular(params, "release", known(releases), "", notices),
    category: "",
    search: "",
    q: "",
    status: "",
    sort: "date",
    dir: "desc",
    size: 50,
    page: 1,
    audit: "",
  };
  if (state.from && state.to && state.from > state.to) {
    notices.push(`Ignored inverted date range: ${state.from} to ${state.to}`);
    state.from = "";
    state.to = "";
  }

  const routeKeys = ROUTE_KEYS[route];
  if (routeKeys.has("category")) state.category = acceptedSingular(params, "category", known(categories), "", notices);
  if (routeKeys.has("search")) state.search = acceptedSingular(params, "search", (value) => acceptedText(value, 160, "search", notices), "", notices);
  if (routeKeys.has("q")) state.q = acceptedSingular(params, "q", (value) => acceptedText(value, route === "timeline" ? 160 : 200, "q", notices), "", notices);
  if (routeKeys.has("status")) {
    const statuses = route === "history"
      ? definitions
      : new Set(dataRecords(data, "coverage").map((record) => record.review_status));
    state.status = acceptedSingular(params, "status", known(statuses), "", notices);
  }
  if (routeKeys.has("sort")) state.sort = acceptedSingular(params, "sort", finite(SORT_VALUES[route]), "date", notices);
  if (routeKeys.has("dir")) state.dir = acceptedSingular(params, "dir", finite(new Set(["asc", "desc"])), "desc", notices);
  if (routeKeys.has("size")) state.size = acceptedSingular(params, "size", finite(PAGE_SIZE_VALUES, Number), 50, notices);
  if (routeKeys.has("page")) {
    state.page = acceptedSingular(params, "page", (value) => {
      if (!/^\d+$/.test(value)) return null;
      const page = Number(value);
      return Number.isSafeInteger(page) && page > 0 ? page : null;
    }, 1, notices);
  }
  if (routeKeys.has("audit")) state.audit = acceptedSingular(params, "audit", (value) => ["", "all"].includes(value) ? value : null, "", notices);
  if (route === "history" && historicalIds.length) state.audit = "all";

  const urlCenter = acceptedSingular(params, "center", (value) => value === "" ? "" : boundedInstant(value, data) || null, "", notices);
  if (urlCenter) {
    state.center = urlCenter;
  } else {
    const observatoryCenter = boundedInstant(historyState?.observatory?.centerInstant, data);
    const routeLegacyKey = route === "trends" ? "trendsCenterDate" : "timelineCenterDate";
    const explicitlyNewest = historyState?.observatory?.version === 2 && historyState.observatory.chronologicalIntent === "newest";
    const legacyCenter = explicitlyNewest ? "" : boundedInstant(historyState?.[routeLegacyKey], data)
      || boundedInstant(historyState?.trendsCenterDate, data)
      || boundedInstant(historyState?.timelineCenterDate, data);
    state.center = observatoryCenter || legacyCenter;
    if (!state.center && !explicitlyNewest && params.get("v") !== "2") {
      const release = releases.get(state.release);
      const targetDate = release?.publication_date || state.to || state.from;
      state.center = boundedInstant(targetDate, data);
    }
  }
  if (Object.hasOwn(historyState || {}, "timelineScroll") && !state.center) {
    notices.push("Legacy pixel position could not be restored.");
  }
  if (route === "trends" && rawBenchmarkIds.length && params.has("q")) {
    notices.push("Legacy release-search text was not applied in Benchmarks.");
  }
  return { state, notices, historicalIds, intent: state.center ? "center" : "newest" };
}

export function encodeViewState(route, state = {}) {
  if (!Object.hasOwn(ROUTE_KEYS, route)) throw new Error(`Unsupported route: ${route}`);
  const params = new URLSearchParams({ v: "2" });
  for (const id of state.benchmarks || []) if (id) params.append("benchmark", String(id));
  if (state.lab) params.set("lab", String(state.lab));
  if (state.from) params.set("from", String(state.from));
  if (state.to) params.set("to", String(state.to));
  if (Number(state.zoom) !== 1 && ZOOM_VALUES.has(String(state.zoom))) params.set("zoom", String(state.zoom));
  if (state.center) params.set("center", String(state.center));
  if (state.release) params.set("release", String(state.release));
  const routeKeys = ROUTE_KEYS[route];
  if (routeKeys.has("category") && state.category) params.set("category", String(state.category));
  if (routeKeys.has("search") && state.search) params.set("search", String(state.search));
  if (routeKeys.has("q") && state.q) params.set("q", String(state.q));
  if (routeKeys.has("status") && state.status) params.set("status", String(state.status));
  if (routeKeys.has("sort") && state.sort && state.sort !== "date") params.set("sort", String(state.sort));
  if (routeKeys.has("dir") && state.dir && state.dir !== "desc") params.set("dir", String(state.dir));
  if (routeKeys.has("size") && Number(state.size) !== 50) params.set("size", String(state.size));
  if (routeKeys.has("page") && Number(state.page) !== 1) params.set("page", String(state.page));
  if (routeKeys.has("audit") && state.audit === "all") params.set("audit", "all");
  return `?${params.toString()}`;
}

export function navigationSearch(search = "") {
  const source = new URLSearchParams(search);
  const target = new URLSearchParams({ v: "2" });
  for (const key of COMMON_KEYS) {
    const values = source.getAll(key);
    if (key === "benchmark") values.forEach((value) => target.append(key, value));
    else if (values.length) target.set(key, values[0]);
  }
  return `?${target.toString()}`;
}

export function legacyLandingTarget(search = "", hash = "") {
  const source = new URLSearchParams(search);
  if (source.has("benchmark") || source.getAll("v").includes("2") || (!source.has("q") && !source.has("release"))) return null;
  const target = new URLSearchParams();
  for (const key of ["q", "category", "lab", "from", "to", "zoom", "center", "release"]) {
    if (source.has(key)) target.set(key, source.get(key));
  }
  const safeHash = /^#[A-Za-z0-9_.~!$&'()*+,;=:@/?%-]*$/.test(hash) ? hash : "";
  const query = target.toString();
  return `./timeline.html${query ? `?${query}` : ""}${safeHash}`;
}

export function definitionsTarget(search = "", hash = "", knownStatusIds = []) {
  const known = knownStatusIds instanceof Set ? knownStatusIds : new Set(knownStatusIds);
  const requested = new URLSearchParams(search).getAll("status").find((value) => known.has(value)) || "";
  const fragment = hash.startsWith("#") ? hash.slice(1) : hash;
  if (requested) return `./about.html#${requested}`;
  if (known.has(fragment)) return `./about.html#${fragment}`;
  return "./about.html#reporting-definitions";
}

export function historyPayload(previous, state, route, focusedId = "") {
  const payload = previous && typeof previous === "object" && !Array.isArray(previous) ? { ...previous } : {};
  payload.observatory = {
    version: 2,
    centerInstant: state?.center || "",
    chronologicalIntent: state?.center ? "center" : "newest",
    route,
    focusedId,
  };
  return payload;
}

export function benchmarkSearchText(benchmark, categories) {
  const category = categories.get(benchmark.category_id);
  return normalize([
    benchmark.name,
    ...(benchmark.aliases || []),
    category?.name || "",
    ...(category?.aliases || []),
  ].join(" "));
}

export function isLiveCanonical(benchmark) {
  return Boolean(benchmark) && (!benchmark.identity_status || benchmark.identity_status === "canonical");
}

export function liveCanonicalBenchmarks(benchmarks = []) {
  return benchmarks.filter(isLiveCanonical);
}

export function mappedBenchmarkId(benchmarksById, occurrence) {
  const benchmark = typeof benchmarksById.get === "function"
    ? benchmarksById.get(occurrence.benchmark_id)
    : benchmarksById[occurrence.benchmark_id];
  if (benchmark?.identity_status === "merged" && benchmark.canonical_benchmark_id) {
    return benchmark.canonical_benchmark_id;
  }
  return occurrence.benchmark_id;
}

export function isRetainedOccurrence(occurrence) {
  return occurrence?.review_status === "verified";
}

export function recentModelCount(data, benchmarkId) {
  const row = (data?.recent_model_counts?.counts || []).find((item) => item.benchmark_id === benchmarkId);
  return row ? row.distinct_model_count : 0;
}

export function recentModelCountLabel(data) {
  return data?.recent_model_counts?.label || "models in latest 90 days";
}

export function matchingBenchmarkIds(indexed, query = "", categoryId = "") {
  const needle = normalize(query);
  return new Set(
    liveCanonicalBenchmarks(indexed.data.benchmarks)
      .filter((benchmark) => !categoryId || benchmark.category_id === categoryId)
      .filter((benchmark) => !needle || benchmarkSearchText(benchmark, indexed.categories).includes(needle))
      .map((benchmark) => benchmark.id),
  );
}

export function occurrenceFrequency(data) {
  const counts = new Map();
  const benchmarks = byId(data.benchmarks || []);
  for (const occurrence of data.occurrences || []) {
    if (!isRetainedOccurrence(occurrence)) continue;
    const benchmarkId = mappedBenchmarkId(benchmarks, occurrence);
    counts.set(benchmarkId, (counts.get(benchmarkId) || 0) + 1);
  }
  return counts;
}

export function orderedReleaseOccurrences(indexed, releaseId, matchingIds = null) {
  const frequencies = occurrenceFrequency(indexed.data);
  const statuses = indexed.statusesByRelease.get(releaseId) || [];
  const firstReported = new Set(
    statuses
      .filter((status) => status.occurrence_id && status.status_ids.includes("first_reported"))
      .map((status) => status.occurrence_id),
  );
  return [...(indexed.occurrencesByRelease.get(releaseId) || [])]
    .filter((occurrence) => isRetainedOccurrence(occurrence))
    .filter((occurrence) => !matchingIds || matchingIds.has(mappedBenchmarkId(indexed.benchmarks, occurrence)))
    .sort((left, right) => {
      const firstDelta = Number(firstReported.has(right.id)) - Number(firstReported.has(left.id));
      if (firstDelta) return firstDelta;
      const frequencyDelta = (frequencies.get(right.benchmark_id) || 0) - (frequencies.get(left.benchmark_id) || 0);
      if (frequencyDelta) return frequencyDelta;
      return indexed.benchmarks.get(mappedBenchmarkId(indexed.benchmarks, left)).name.localeCompare(indexed.benchmarks.get(mappedBenchmarkId(indexed.benchmarks, right)).name, "en");
    });
}

export function retainedReleaseOccurrences(indexed, releaseId, matchingIds = null) {
  return [...(indexed?.occurrencesByRelease?.get(releaseId) || [])]
    .filter(isRetainedOccurrence)
    .filter((occurrence) => !matchingIds || matchingIds.has(mappedBenchmarkId(indexed.benchmarks, occurrence)))
    .sort((left, right) => {
      const leftId = mappedBenchmarkId(indexed.benchmarks, left);
      const rightId = mappedBenchmarkId(indexed.benchmarks, right);
      return leftId.localeCompare(rightId, "en") || left.id.localeCompare(right.id, "en");
    });
}

export function matchingReleaseRecords(indexed, state = {}) {
  const selected = new Set((state.benchmarks || []).filter((id) => isLiveCanonical(indexed.benchmarks.get(id))));
  const discoveryActive = Boolean(state.q || state.category);
  const discovery = discoveryActive ? matchingBenchmarkIds(indexed, state.q || "", state.category || "") : null;
  const matchingIds = selected.size
    ? new Set([...selected].filter((id) => !discovery || discovery.has(id)))
    : discovery;
  return indexed.data.releases
    .filter((release) => !state.lab || release.lab_id === state.lab)
    .filter((release) => !state.from || release.publication_date >= state.from)
    .filter((release) => !state.to || release.publication_date <= state.to)
    .filter((release) => {
      if (!matchingIds) return true;
      if (!matchingIds.size) return false;
      return retainedReleaseOccurrences(indexed, release.id, matchingIds).length > 0;
    });
}

export function statusesForOccurrence(indexed, occurrence) {
  const status = (indexed.statusesByRelease.get(occurrence.release_id) || []).find(
    (item) => item.occurrence_id === occurrence.id,
  );
  return status?.status_ids || [];
}

export function dateValue(isoDate) {
  const value = Date.parse(`${isoDate}T00:00:00Z`);
  if (!Number.isFinite(value)) throw new Error(`Invalid publication date: ${isoDate}`);
  return value;
}

export function formatDate(isoDate) {
  return new Intl.DateTimeFormat("en", {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(dateValue(isoDate)));
}

export function datePosition(isoDate, startDate, endDate) {
  const start = dateValue(startDate);
  const end = dateValue(endDate);
  if (end <= start) return 0;
  return Math.max(0, Math.min(100, ((dateValue(isoDate) - start) / (end - start)) * 100));
}

export function dateFromPosition(percent, startDate, endDate) {
  const start = dateValue(startDate);
  const end = dateValue(endDate);
  const span = end - start;
  const ms = start + (Number(percent) / 100) * (span || 0);
  return new Date(ms).toISOString().slice(0, 10);
}

export function captureCenterDate(frame, startDate, endDate) {
  if (!frame || !frame.scrollWidth) return endDate;
  const percent = ((frame.scrollLeft + frame.clientWidth / 2) / frame.scrollWidth) * 100;
  return dateFromPosition(percent, startDate, endDate);
}

export function restoreCenterDate(frame, centerDate, startDate, endDate) {
  if (!frame) return;
  const percent = datePosition(centerDate, startDate, endDate);
  const centerPx = (percent / 100) * frame.scrollWidth;
  const maxScroll = Math.max(0, frame.scrollWidth - frame.clientWidth);
  frame.scrollLeft = Math.min(maxScroll, Math.max(0, centerPx - frame.clientWidth / 2));
}

const rectWidth = (rect) => Number.isFinite(rect?.width) ? rect.width : Math.max(0, Number(rect?.right) - Number(rect?.left));

export function trackGeometry(frame, track, label = null) {
  if (!frame?.getBoundingClientRect || !track?.getBoundingClientRect) {
    return { trackLeft: 0, trackWidth: 0, viewportLeft: 0, viewportWidth: 0, maxScroll: 0 };
  }
  const frameRect = frame.getBoundingClientRect();
  const trackRect = track.getBoundingClientRect();
  const scrollLeft = Number.isFinite(frame.scrollLeft) ? frame.scrollLeft : 0;
  const clientLeft = Number.isFinite(frame.clientLeft) ? frame.clientLeft : 0;
  const clientWidth = Number.isFinite(frame.clientWidth) ? frame.clientWidth : rectWidth(frameRect);
  const origin = frameRect.left + clientLeft;
  const trackLeft = scrollLeft + trackRect.left - origin;
  const trackWidth = Math.max(0, rectWidth(trackRect));
  const labelRight = label?.getBoundingClientRect
    ? label.getBoundingClientRect().right - origin
    : 0;
  const viewportLeft = Math.max(trackLeft, scrollLeft + Math.max(0, labelRight));
  const viewportRight = Math.max(viewportLeft, Math.min(trackLeft + trackWidth, scrollLeft + clientWidth));
  return {
    trackLeft,
    trackWidth,
    viewportLeft,
    viewportWidth: viewportRight - viewportLeft,
    maxScroll: Math.max(0, Number(frame.scrollWidth || 0) - clientWidth),
  };
}

export function trackCoordinateFromInstant(instant, trackLeft, trackWidth, startDate, endDate) {
  const start = dateValue(startDate);
  const end = dateValue(endDate);
  const target = Date.parse(instant);
  if (!Number.isFinite(target) || end <= start || !Number.isFinite(trackWidth)) return trackLeft;
  return trackLeft + Math.max(0, Math.min(1, (target - start) / (end - start))) * trackWidth;
}

export function instantFromTrackCoordinate(coordinate, trackLeft, trackWidth, startDate, endDate) {
  const start = dateValue(startDate);
  const end = dateValue(endDate);
  const fraction = trackWidth > 0 ? Math.max(0, Math.min(1, (coordinate - trackLeft) / trackWidth)) : 1;
  return new Date(start + fraction * (end - start)).toISOString();
}

export function captureTrackCenter(frame, track, label, startDate, endDate) {
  const geometry = trackGeometry(frame, track, label);
  const center = geometry.viewportLeft + geometry.viewportWidth / 2;
  return instantFromTrackCoordinate(center, geometry.trackLeft, geometry.trackWidth, startDate, endDate);
}

export function restoreTrackCenter(frame, track, label, instant, startDate, endDate) {
  const before = trackGeometry(frame, track, label);
  const target = trackCoordinateFromInstant(instant, before.trackLeft, before.trackWidth, startDate, endDate);
  const origin = frame.getBoundingClientRect().left + Number(frame.clientLeft || 0);
  const gutter = Math.max(0, label?.getBoundingClientRect ? label.getBoundingClientRect().right - origin : 0);
  const width = Number(frame.clientWidth || 0);
  // Invert the same clipped interval used by capture, including right padding.
  const centerAt = (scroll) => {
    const left = Math.max(before.trackLeft, scroll + gutter);
    const right = Math.max(left, Math.min(before.trackLeft + before.trackWidth, scroll + width));
    return (left + right) / 2;
  };
  let low = 0;
  let high = before.maxScroll;
  for (let step = 0; step < 48; step += 1) {
    const mid = (low + high) / 2;
    if (centerAt(mid) < target) low = mid;
    else high = mid;
  }
  frame.scrollLeft = (low + high) / 2;
  const after = trackGeometry(frame, track, label);
  const displayedCenter = instantFromTrackCoordinate(after.viewportLeft + after.viewportWidth / 2, after.trackLeft, after.trackWidth, startDate, endDate);
  return { clamped: Math.abs(after.viewportLeft + after.viewportWidth / 2 - target) > 1, displayedCenter };
}

export function scrollToNewest(frame) {
  if (!frame) return;
  frame.scrollLeft = Math.max(0, frame.scrollWidth - frame.clientWidth);
}

export function collisionRows(positions, minimumGap) {
  if (!Number.isFinite(minimumGap) || minimumGap <= 0) throw new Error("Collision spacing must be a positive number.");
  const rowEnds = [];
  return positions.map((position) => {
    if (!Number.isFinite(position)) throw new Error("Collision positions must be finite numbers.");
    let row = rowEnds.findIndex((end) => position - end >= minimumGap);
    if (row === -1) row = rowEnds.length;
    rowEnds[row] = position;
    return row;
  });
}

export function timelineTicks(startDate, endDate, desired = 8) {
  const start = new Date(dateValue(startDate));
  const end = new Date(dateValue(endDate));
  const span = end.getTime() - start.getTime();
  const ticks = [];
  for (let index = 0; index <= desired; index += 1) {
    const date = new Date(start.getTime() + (span * index) / desired);
    ticks.push(date.toISOString().slice(0, 10));
  }
  return [...new Set(ticks)];
}

export function disclosureText(disclosure) {
  return disclosure?.status === "disclosed" ? disclosure.value : "Not disclosed";
}

export function revisionText(revision) {
  if (!revision) return "Revision state unavailable";
  if (revision.identifier) return revision.identifier;
  return `Unavailable: ${revision.unavailable_reason.replaceAll("_", " ")} · retrieved ${formatDate(revision.retrieval_date)}`;
}

const SHARED_SOURCE_NAMESPACES = Object.freeze({
  qwen: Object.freeze({
    "raw.githubusercontent.com": new Set(["qwenlm"]),
  }),
  deepseek: Object.freeze({
    "github.com": new Set(["deepseek-ai"]),
    "raw.githubusercontent.com": new Set(["deepseek-ai"]),
    "huggingface.co": new Set(["deepseek-ai"]),
  }),
  meta: Object.freeze({
    "github.com": new Set(["facebookresearch", "meta-llama"]),
    "raw.githubusercontent.com": new Set(["facebookresearch", "meta-llama"]),
  }),
});

export function safeSourceHref(indexed, source, releaseOrLabId = "") {
  if (!source || typeof source.url !== "string") return null;
  const labs = indexed?.labs || dataRecordMap(indexed, "labs");
  const releases = indexed?.releases || dataRecordMap(indexed, "releases");
  const lab = labs.get(source.lab_id);
  if (!lab) return null;
  if (releaseOrLabId) {
    const release = releases.get(releaseOrLabId);
    const expectedLabId = release?.lab_id || (labs.has(releaseOrLabId) ? releaseOrLabId : "");
    if (!expectedLabId || source.lab_id !== expectedLabId) return null;
  }
  try {
    const url = new URL(source.url);
    const host = url.hostname.toLocaleLowerCase("en").replace(/\.$/, "");
    const allowedDomains = (lab.official_domains || []).map((domain) => String(domain).toLocaleLowerCase("en").replace(/\.$/, ""));
    const allowedHost = allowedDomains.some((domain) => host === domain || host.endsWith(`.${domain}`));
    if (host.endsWith(".github.com") || host.endsWith(".huggingface.co") || host.endsWith(".raw.githubusercontent.com")) return null;
    if (url.protocol !== "https:" || url.username || url.password || url.port || !allowedHost) return null;
    if (["github.com", "raw.githubusercontent.com", "huggingface.co"].includes(host)) {
      const namespace = decodeURIComponent(url.pathname.split("/").filter(Boolean)[0] || "").toLocaleLowerCase("en");
      if (!SHARED_SOURCE_NAMESPACES[source.lab_id]?.[host]?.has(namespace)) return null;
    }
    return source.url;
  } catch {
    return null;
  }
}

const appendTextRow = (parent, label, value) => {
  const row = document.createElement("p");
  const term = document.createElement("strong");
  term.textContent = `${label}: `;
  row.append(term);
  row.append(document.createTextNode(String(value)));
  parent.append(row);
};

const humanized = (value) => String(value || "").replaceAll("_", " ");

const setupDisclosureText = (disclosure) => {
  if (disclosure?.status === "disclosed") return disclosure.value;
  if (disclosure?.status === "not_applicable") return "Not applicable";
  return "Not disclosed";
};

const revisionKind = (source) => {
  const identifier = source?.revision?.identifier || "";
  if (/^[0-9a-f]{40}$/i.test(identifier)) return "Pinned repository revision";
  if (/^sha256:[0-9a-f]{64}$/i.test(identifier)) return "Retrieved-content fingerprint";
  return "Source revision identifier";
};

export function sourceDisclosure(indexed, occurrence) {
  const article = document.createElement("article");
  article.className = "source-disclosure";
  const source = indexed.sources.get(occurrence.source_id);
  const release = indexed.releases.get(occurrence.release_id);
  const lab = indexed.labs.get(occurrence.lab_id || release?.lab_id || source?.lab_id);
  const originalBenchmark = indexed.benchmarks.get(occurrence.benchmark_id);
  const canonicalId = mappedBenchmarkId(indexed.benchmarks, occurrence);
  const canonicalBenchmark = indexed.benchmarks.get(canonicalId);
  const heading = document.createElement("h4");
  heading.textContent = canonicalBenchmark?.name || originalBenchmark?.name || occurrence.benchmark_id;
  article.append(heading);
  if (originalBenchmark && originalBenchmark.id !== canonicalId) appendTextRow(article, "Original record label", originalBenchmark.name);
  appendTextRow(article, "Source type and publisher", `${humanized(source?.source_type || occurrence.source_type || "unknown")} · ${lab?.name || "Unknown lab"}`);

  const href = safeSourceHref(indexed, source, occurrence.release_id);
  const sourceRow = document.createElement("p");
  const sourceLabel = `${humanized(source?.source_type || occurrence.source_type || "source")} from ${lab?.name || "unknown publisher"}`;
  if (href) {
    const link = document.createElement("a");
    link.setAttribute("href", href);
    link.setAttribute("target", "_blank");
    link.setAttribute("rel", "noopener noreferrer");
    link.textContent = `${sourceLabel}, ${humanized(occurrence.locator?.kind || "location")} ${occurrence.locator?.value || "not recorded"}`;
    sourceRow.append(link);
  } else {
    sourceRow.textContent = `Source link unavailable: destination validation failed. ${sourceLabel}.`;
  }
  article.append(sourceRow);
  appendTextRow(article, "Exact stored URL", source?.url || "Not recorded");
  appendTextRow(article, "Locator", `${humanized(occurrence.locator?.kind || "unknown")}: ${occurrence.locator?.value || "Not recorded"}`);
  appendTextRow(article, "Reporting date", occurrence.publication_date || "Not recorded");
  appendTextRow(article, "Source publication date", source?.publication_date || "Not recorded");
  if (occurrence.summary) appendTextRow(article, "Reporting and configuration context", occurrence.summary);
  if (release?.publication_date && release.publication_date !== occurrence.publication_date) appendTextRow(article, "Release date", release.publication_date);

  const setup = document.createElement("section");
  const setupHeading = document.createElement("h5");
  setupHeading.textContent = "Evaluation setup";
  setup.append(setupHeading);
  for (const [field, label] of SETUP_FIELDS) appendTextRow(setup, label, setupDisclosureText(occurrence.evaluation_setup?.[field]));
  article.append(setup);

  const details = document.createElement("details");
  const summary = document.createElement("summary");
  summary.textContent = "Technical details";
  details.append(summary);
  appendTextRow(details, "Occurrence ID", occurrence.id);
  appendTextRow(details, "Source ID", occurrence.source_id);
  appendTextRow(details, "Source revision ID", occurrence.source_revision_id);
  appendTextRow(details, "Canonical benchmark ID", canonicalId);
  if (canonicalId !== occurrence.benchmark_id) appendTextRow(details, "Original benchmark ID", occurrence.benchmark_id);
  if (source?.revision?.identifier) {
    appendTextRow(details, revisionKind(source), source.revision.identifier);
    appendTextRow(details, "Revision interpretation", revisionKind(source) === "Retrieved-content fingerprint"
      ? "A fingerprint of retrieved content, not an immutable live URL or independently verified version history."
      : "Recorded revision identity; baseline provenance has not been independently reapproved.");
  } else if (source?.revision) {
    appendTextRow(details, "Source revision", `Unavailable: ${humanized(source.revision.unavailable_reason)}; retrieval date ${source.revision.retrieval_date}`);
  } else {
    appendTextRow(details, "Source revision", "Not recorded");
  }

  const overlay = indexed.data.audit_overlay;
  const auditRows = (overlay?.records || []).filter((record) => (
    (record.entity_type === "occurrences" && record.record_id === occurrence.id)
    || (record.entity_type === "source_associations" && record.record_id.includes(`:${occurrence.id}:`))
  ));
  for (const audit of auditRows) {
    appendTextRow(details, "Audit state", `${audit.origin} · ${audit.disposition} · ${humanized(audit.implementation_disposition)}`);
    if (audit.checked_fields?.length) appendTextRow(details, "Scoped checked fields", audit.checked_fields.join(", "));
    appendTextRow(details, "Audit uncertainty / next check", audit.uncertainty || "Not recorded");
  }
  const sourceCheck = (overlay?.source_checks || []).find((check) => check.source_id === source?.id && check.exact_url === source?.url);
  if (sourceCheck) {
    appendTextRow(details, "Retrieval check", sourceCheck.access_status ? humanized(sourceCheck.access_status) : "Unknown");
    appendTextRow(details, "Retrieval timestamp", sourceCheck.accessed_at || "Unknown");
    if (sourceCheck.fingerprint) appendTextRow(details, `Retrieval fingerprint (${humanized(sourceCheck.fingerprint_kind)})`, sourceCheck.fingerprint);
    appendTextRow(details, "Retrieval uncertainty / next check", sourceCheck.uncertainty);
  } else {
    appendTextRow(details, "Retrieval check", "Unknown");
  }
  article.append(details);
  return article;
}

export function validateInterface(data) {
  const requiredArrays = [
    "labs",
    "categories",
    "lineages",
    "models",
    "releases",
    "benchmarks",
    "sources",
    "coverage",
    "occurrences",
    "derived_statuses",
    "canonical_definitions",
    "quarantine",
  ];
  const missing = requiredArrays.filter((key) => !Array.isArray(data[key]));
  if (missing.length) throw new Error(`Generated data is missing: ${missing.join(", ")}`);
  if (!data.corpus?.publication_window?.start || !data.corpus?.publication_window?.end) {
    throw new Error("Generated data is missing the inclusive publication window.");
  }
  return data;
}

export function createCancelableSearch(callback, delay = 150, scheduler = globalThis) {
  let timer = null;
  let generation = 0;
  let pending = false;
  let pendingValue;
  const cancel = () => {
    generation += 1;
    if (timer !== null) scheduler.clearTimeout(timer);
    timer = null;
    pending = false;
  };
  const invoke = (expectedGeneration) => {
    if (!pending || expectedGeneration !== generation) return;
    const value = pendingValue;
    pending = false;
    timer = null;
    callback(value);
  };
  return {
    schedule(value) {
      cancel();
      pending = true;
      pendingValue = value;
      const expectedGeneration = generation;
      timer = scheduler.setTimeout(() => invoke(expectedGeneration), delay);
    },
    cancel,
    flush() {
      if (!pending) return;
      if (timer !== null) scheduler.clearTimeout(timer);
      timer = null;
      invoke(generation);
    },
  };
}

export const COMBOBOX_OPTION_LIMIT = 50;

export function createSearchableCombobox({
  id,
  label,
  value = "",
  options,
  emptyLabel,
  placeholder = "Type to search",
  onChange,
}) {
  const field = document.createElement("div");
  field.className = "field combobox-field";
  const labelNode = document.createElement("label");
  labelNode.htmlFor = id;
  labelNode.textContent = label;
  const shell = document.createElement("div");
  shell.className = "combobox";
  const input = document.createElement("input");
  const listbox = document.createElement("ul");
  const clear = document.createElement("button");
  const listboxId = `${id}-listbox`;
  const status = document.createElement("p");
  let selectedValue = options.some((option) => option.value === value) ? value : "";
  let visibleOptions = [];
  let activeIndex = -1;

  input.id = id;
  input.type = "text";
  input.autocomplete = "off";
  input.placeholder = placeholder;
  input.setAttribute("role", "combobox");
  input.setAttribute("aria-autocomplete", "list");
  input.setAttribute("aria-controls", listboxId);
  input.setAttribute("aria-expanded", "false");
  listbox.id = listboxId;
  listbox.className = "combobox-listbox";
  listbox.setAttribute("role", "listbox");
  listbox.hidden = true;
  status.id = `${id}-window-status`;
  status.className = "combobox-window-status";
  status.setAttribute("role", "status");
  clear.type = "button";
  clear.id = `${id}-clear`;
  clear.className = "combobox-clear";
  clear.textContent = "×";
  clear.setAttribute("aria-label", `Clear ${label}`);

  const optionLabel = (candidate) => candidate.value === "" ? emptyLabel : candidate.label;
  const selectedLabel = () => optionLabel(options.find((option) => option.value === selectedValue) || { value: "", label: "" });
  const close = () => {
    listbox.hidden = true;
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
    activeIndex = -1;
  };
  const setActive = (nextIndex) => {
    if (!visibleOptions.length) return;
    activeIndex = Math.max(0, Math.min(nextIndex, visibleOptions.length - 1));
    const optionNodes = [...listbox.querySelectorAll('[role="option"]')];
    optionNodes.forEach((node, index) => {
      node.setAttribute("aria-selected", String(index === activeIndex));
      if (index === activeIndex) {
        input.setAttribute("aria-activedescendant", node.id);
        node.scrollIntoView({ block: "nearest" });
      }
    });
  };
  const select = (option) => {
    selectedValue = option.value;
    input.value = optionLabel(option);
    close();
    onChange(option.value);
  };
  const renderOptions = (query = "") => {
    const needle = normalize(query);
    const matches = options.filter((option) => !needle || normalize(`${option.label} ${option.searchText || ""}`).includes(needle));
    visibleOptions = matches.slice(0, COMBOBOX_OPTION_LIMIT);
    listbox.replaceChildren();
    if (!visibleOptions.length) {
      const empty = document.createElement("li");
      empty.className = "combobox-empty";
      empty.textContent = "No choices match this search.";
      listbox.append(empty);
    }
    visibleOptions.forEach((option, index) => {
      const item = document.createElement("li");
      let selectedByPointer = false;
      item.id = `${listboxId}-option-${index}`;
      item.dataset.value = option.value;
      item.setAttribute("role", "option");
      item.setAttribute("aria-selected", String(option.value === selectedValue));
      item.textContent = optionLabel(option);
      item.addEventListener("pointerdown", (event) => {
        event.preventDefault();
        selectedByPointer = true;
        select(option);
      });
      item.addEventListener("mousedown", (event) => event.preventDefault());
      item.addEventListener("click", () => {
        if (selectedByPointer) {
          selectedByPointer = false;
          return;
        }
        select(option);
      });
      listbox.append(item);
    });
    status.textContent = !matches.length
      ? "No choices match this search."
      : matches.length > COMBOBOX_OPTION_LIMIT
        ? `Showing first ${visibleOptions.length} of ${matches.length} matches; type to narrow.`
        : "";
    if (status.textContent) status.setAttribute("aria-live", "polite");
    else status.removeAttribute("aria-live");
    listbox.hidden = false;
    input.setAttribute("aria-expanded", "true");
    activeIndex = visibleOptions.findIndex((option) => option.value === selectedValue);
    if (activeIndex >= 0) setActive(activeIndex);
    else input.removeAttribute("aria-activedescendant");
  };
  const setValue = (nextValue) => {
    selectedValue = options.some((option) => option.value === nextValue) ? nextValue : "";
    input.value = selectedLabel();
  };

  input.addEventListener("click", () => renderOptions(""));
  input.addEventListener("input", () => renderOptions(input.value));
  input.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !listbox.hidden) {
      event.preventDefault();
      event.stopPropagation();
      input.value = selectedLabel();
      close();
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End", "Enter"].includes(event.key)) return;
    if (event.key === "Enter" && !listbox.hidden && activeIndex >= 0) {
      event.preventDefault();
      select(visibleOptions[activeIndex]);
      return;
    }
    if (event.key === "Enter") return;
    event.preventDefault();
    if (listbox.hidden) renderOptions("");
    if (event.key === "Home") setActive(0);
    else if (event.key === "End") setActive(visibleOptions.length - 1);
    else if (event.key === "ArrowDown") setActive(activeIndex + 1);
    else setActive(activeIndex < 0 ? visibleOptions.length - 1 : activeIndex - 1);
  });
  input.addEventListener("blur", () => {
    input.value = selectedLabel();
    close();
  });
  clear.addEventListener("click", () => {
    if (!selectedValue && !input.value) return;
    selectedValue = "";
    input.value = "";
    close();
    onChange("");
    requestAnimationFrame(() => input.focus());
  });
  setValue(selectedValue);
  shell.append(input, clear, listbox);
  field.append(labelNode, shell, status);
  return { element: field, input, setValue, close, status };
}
