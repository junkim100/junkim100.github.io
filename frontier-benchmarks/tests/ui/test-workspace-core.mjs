import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  captureTrackCenter,
  createCancelableSearch,
  createSearchableCombobox,
  decodeViewState,
  definitionsTarget,
  encodeViewState,
  historyPayload,
  indexData,
  instantFromTrackCoordinate,
  isLiveCanonical,
  legacyLandingTarget,
  matchingReleaseRecords,
  navigationSearch,
  normalize,
  retainedReleaseOccurrences,
  restoreTrackCenter,
  safeSourceHref,
  sourceDisclosure,
  trackCoordinateFromInstant,
  trackGeometry,
  validateInterface,
} from "../../core.mjs";

const data = validateInterface(JSON.parse(await readFile(new URL("../../public/observatory.json", import.meta.url), "utf8")));
const indexed = indexData(data);
const benchmarkMap = new Map(data.benchmarks.map((record) => [record.id, record]));
const merged = data.benchmarks.filter((record) => record.identity_status === "merged");
const quarantined = data.benchmarks.filter((record) => record.identity_status === "quarantined");
const canonical = data.benchmarks.filter((record) => !record.identity_status || record.identity_status === "canonical");

assert.equal(merged.length, 35);
assert.equal(quarantined.length, 31);
assert.equal(isLiveCanonical(undefined), false);
for (const record of merged) {
  const decoded = decodeViewState("trends", `?benchmark=${record.id}`, data);
  assert.deepEqual(decoded.state.benchmarks, [record.canonical_benchmark_id], record.id);
  assert.match(decoded.notices.join(" "), new RegExp(record.id));
}
for (const record of quarantined) {
  const history = decodeViewState("history", `?benchmark=${record.id}`, data);
  assert.deepEqual(history.state.benchmarks, [record.id], record.id);
  assert.equal(history.state.audit, "all");
  assert.deepEqual(history.historicalIds, [record.id]);
  const trends = decodeViewState("trends", `?benchmark=${record.id}`, data);
  assert.deepEqual(trends.historicalIds, [record.id]);
  assert.deepEqual(trends.state.benchmarks, ["benchmark_terminal_bench_2_0"]);
}

const mergedExample = merged[0];
const firstSix = canonical.slice(0, 7).map((record) => record.id);
const capped = decodeViewState("trends", `?${firstSix.map((id) => `benchmark=${id}`).join("&")}`, data);
assert.equal(capped.state.benchmarks.length, 6);
assert.deepEqual(new Set(capped.state.benchmarks), new Set(firstSix.slice(0, 6)));
assert.match(capped.notices.join(" "), /first six/);
assert.deepEqual(
  decodeViewState("trends", `?benchmark=${mergedExample.id}&benchmark=${mergedExample.canonical_benchmark_id}`, data).state.benchmarks,
  [mergedExample.canonical_benchmark_id],
);

const release = data.releases.find((record) => record.publication_date > data.corpus.publication_window.start && record.publication_date < data.corpus.publication_window.end);
const stateCase = decodeViewState(
  "timeline",
  `?lab=bad&lab=${release.lab_id}&from=2024-02-30&from=2025-01-01&to=2025-12-01&zoom=99&zoom=2.5&center=bad&center=2025-06-15&release=${release.id}&q=${"x".repeat(170)}&search=leak&sort=name`,
  data,
);
assert.equal(stateCase.state.lab, release.lab_id);
assert.equal(stateCase.state.from, "2025-01-01");
assert.equal(stateCase.state.to, "2025-12-01");
assert.equal(stateCase.state.zoom, 2.5);
assert.equal(stateCase.state.center, "2025-06-15T00:00:00.000Z");
assert.equal(stateCase.state.q.length, 160);
assert.equal(stateCase.state.search, "");
assert.equal(stateCase.state.sort, "date");
assert.match(stateCase.notices.join(" "), /bad|2024-02-30|99/);
assert.deepEqual(
  { from: decodeViewState("timeline", "?from=2025-12-01&to=2025-01-01", data).state.from, to: decodeViewState("timeline", "?from=2025-12-01&to=2025-01-01", data).state.to },
  { from: "", to: "" },
);
for (const zoom of [1, 1.5, 2, 2.5, 3, 4]) assert.equal(decodeViewState("timeline", `?zoom=${zoom}`, data).state.zoom, zoom);

const urlCenter = "2025-06-15T12:34:56.789Z";
const historyCenter = "2025-04-03T01:02:03.004Z";
assert.equal(decodeViewState("timeline", `?v=2&center=${encodeURIComponent(urlCenter)}&release=${release.id}`, data, { observatory: { centerInstant: historyCenter } }).state.center, urlCenter);
assert.equal(decodeViewState("timeline", "?v=2", data, { observatory: { centerInstant: historyCenter }, timelineCenterDate: "2024-03-01" }).state.center, historyCenter);
assert.equal(decodeViewState("trends", "", data, { trendsCenterDate: "2025-06-15" }).state.center, "2025-06-15T00:00:00.000Z");
assert.equal(decodeViewState("timeline", `?release=${release.id}`, data).state.center, `${release.publication_date}T00:00:00.000Z`);
assert.equal(decodeViewState("timeline", `?v=2&release=${release.id}`, data).intent, "newest");
const pixelOnly = decodeViewState("timeline", "", data, { timelineScroll: 1234, unknown: { nested: true } });
assert.equal(pixelOnly.intent, "newest");
assert.match(pixelOnly.notices.join(" "), /Legacy pixel position/);
const aboutWithoutData = decodeViewState("about", `?benchmark=${mergedExample.id}&center=${encodeURIComponent(urlCenter)}`);
assert.deepEqual(aboutWithoutData.state.benchmarks, []);
assert.equal(aboutWithoutData.state.center, urlCenter);

const completeState = {
  benchmarks: canonical.slice(0, 2).map((record) => record.id),
  lab: release.lab_id,
  from: "2025-01-01",
  to: "2025-12-01",
  zoom: 2.5,
  center: urlCenter,
  release: release.id,
  category: canonical[0].category_id,
  search: "picker",
  q: "route query",
  status: "complete",
  sort: "name",
  dir: "asc",
  size: 100,
  page: 3,
  audit: "all",
};
const ledgerSearch = encodeViewState("ledger", completeState);
for (const key of ["benchmark", "lab", "from", "to", "zoom", "center", "release", "q", "status", "sort", "dir", "size", "page"]) assert.equal(new URLSearchParams(ledgerSearch).has(key), true, key);
assert.equal(new URLSearchParams(ledgerSearch).has("category"), false);
assert.equal(new URLSearchParams(ledgerSearch).has("search"), false);
const aboutSearch = new URLSearchParams(encodeViewState("about", completeState));
for (const key of ["benchmark", "lab", "from", "to", "zoom", "center", "release"]) assert.equal(aboutSearch.has(key), true, key);
assert.equal(aboutSearch.has("q"), false);
assert.equal(encodeViewState("timeline", { zoom: 1 }), "?v=2");
const navigation = new URLSearchParams(navigationSearch(`${ledgerSearch}&category=drop&fixture=ui`));
assert.deepEqual([...new Set(navigation.keys())], ["v", "benchmark", "lab", "from", "to", "zoom", "center", "release"]);

assert.equal(legacyLandingTarget("?q=HumanEval&zoom=1.5&release=release_x&fixture=ui", "#detail"), "./timeline.html?q=HumanEval&zoom=1.5&release=release_x#detail");
assert.equal(legacyLandingTarget("?benchmark=x&q=HumanEval"), null);
assert.equal(legacyLandingTarget("?v=2&release=x"), null);
assert.equal(legacyLandingTarget("?q=x", "#unsafe\nfragment"), "./timeline.html?q=x");
assert.equal(definitionsTarget("?status=first_reported", "#definition-list", ["first_reported"]), "./about.html#first_reported");
assert.equal(definitionsTarget("?status=unknown", "#first_reported", ["first_reported"]), "./about.html#first_reported");
assert.equal(definitionsTarget("?status=unknown", "#definition-list", ["first_reported"]), "./about.html#reporting-definitions");
const previous = { router: { sequence: 4 }, observatory: { old: true } };
const payload = historyPayload(previous, { center: urlCenter }, "timeline", release.id);
assert.deepEqual(payload.router, previous.router);
assert.deepEqual(payload.observatory, { version: 2, centerInstant: urlCenter, chronologicalIntent: "center", route: "timeline", focusedId: release.id });
assert.deepEqual(previous.observatory, { old: true });
for (const center of ["2024-02-30T12:00:00.000Z", "2025-01-01T24:00:00.000Z"]) {
  const decoded = decodeViewState("trends", `?v=2&center=${encodeURIComponent(center)}`, data);
  assert.equal(decoded.state.center, "");
  assert.ok(decoded.notices.some((notice) => notice.includes("center")));
}
const resetPayload = historyPayload({ trendsCenterDate: "2025-01-01" }, { center: "" }, "trends");
assert.equal(decodeViewState("trends", "?v=2", data, resetPayload).state.center, "", "Reset newest intent wins over stale legacy day state");

for (const source of data.sources) assert.equal(safeSourceHref(indexed, source, source.lab_id), source.url, source.id);
for (const occurrence of data.occurrences) assert.equal(safeSourceHref(indexed, indexed.sources.get(occurrence.source_id), occurrence.release_id), indexed.sources.get(occurrence.source_id).url, occurrence.id);
const ordinarySource = data.sources.find((source) => !/github\.com|huggingface\.co/.test(source.url));
const ordinaryHost = new URL(ordinarySource.url).hostname;
for (const unsafe of [
  { ...ordinarySource, url: `http://${ordinaryHost}/path` },
  { ...ordinarySource, url: `https://user@${ordinaryHost}/path` },
  { ...ordinarySource, url: `https://${ordinaryHost}:444/path` },
  { ...ordinarySource, url: `https://${ordinaryHost}.evil.example/path` },
]) assert.equal(safeSourceHref(indexed, unsafe, ordinarySource.lab_id), null);
assert.equal(safeSourceHref(indexed, ordinarySource, data.labs.find((lab) => lab.id !== ordinarySource.lab_id).id), null);
const deepseekGithub = data.sources.find((source) => source.lab_id === "deepseek" && source.url.startsWith("https://github.com/"));
assert.equal(safeSourceHref(indexed, { ...deepseekGithub, url: deepseekGithub.url.replace("/deepseek-ai/", "/attacker/") }, "deepseek"), null);
assert.equal(safeSourceHref(indexed, { ...deepseekGithub, url: deepseekGithub.url.replace("github.com", "attacker.github.com") }, "deepseek"), null);
assert.equal(safeSourceHref(indexed, { ...deepseekGithub, url: deepseekGithub.url.replace("https://github.com/deepseek-ai/", "https://raw.githubusercontent.com/deepseek-ai/") }, "deepseek"), null, "A sibling hosting domain must not be implicitly added to the lab allowlist");
const upperHostUrl = ordinarySource.url.replace(ordinaryHost, ordinaryHost.toUpperCase());
assert.equal(safeSourceHref(indexed, { ...ordinarySource, url: upperHostUrl }, ordinarySource.lab_id), upperHostUrl);

const canonicalId = (occurrence) => {
  const benchmark = benchmarkMap.get(occurrence.benchmark_id);
  return benchmark?.identity_status === "merged" ? benchmark.canonical_benchmark_id : occurrence.benchmark_id;
};
const retainedByRelease = new Map();
for (const occurrence of data.occurrences) {
  if (occurrence.review_status !== "verified") continue;
  const rows = retainedByRelease.get(occurrence.release_id) || [];
  rows.push(occurrence);
  retainedByRelease.set(occurrence.release_id, rows);
}
for (const rows of retainedByRelease.values()) rows.sort((left, right) => canonicalId(left).localeCompare(canonicalId(right), "en") || left.id.localeCompare(right.id, "en"));
for (const item of data.releases) assert.deepEqual(retainedReleaseOccurrences(indexed, item.id).map((row) => row.id), (retainedByRelease.get(item.id) || []).map((row) => row.id), item.id);

const releaseIdsForBenchmark = new Map(canonical.map((record) => [record.id, new Set()]));
for (const [releaseId, rows] of retainedByRelease) for (const occurrence of rows) releaseIdsForBenchmark.get(canonicalId(occurrence))?.add(releaseId);
for (const benchmark of canonical) {
  const actual = matchingReleaseRecords(indexed, { benchmarks: [benchmark.id] }).map((item) => item.id);
  const expected = data.releases.filter((item) => releaseIdsForBenchmark.get(benchmark.id).has(item.id)).map((item) => item.id);
  assert.deepEqual(actual, expected, benchmark.id);
}
assert.deepEqual(matchingReleaseRecords(indexed, {}).map((item) => item.id), data.releases.map((item) => item.id));
for (const lab of data.labs) assert.deepEqual(matchingReleaseRecords(indexed, { lab: lab.id }).map((item) => item.id), data.releases.filter((item) => item.lab_id === lab.id).map((item) => item.id));
for (const item of data.releases) assert.deepEqual(matchingReleaseRecords(indexed, { from: item.publication_date, to: item.publication_date }).map((row) => row.id), data.releases.filter((row) => row.publication_date === item.publication_date).map((row) => row.id));
const selectedBenchmark = canonical.find((record) => releaseIdsForBenchmark.get(record.id).size > 0);
const differentCategory = data.categories.find((record) => record.id !== selectedBenchmark.category_id);
assert.deepEqual(matchingReleaseRecords(indexed, { benchmarks: [selectedBenchmark.id], category: differentCategory.id }), []);
const independentSearchText = (benchmark) => {
  const category = indexed.categories.get(benchmark.category_id);
  return normalize([benchmark.name, ...(benchmark.aliases || []), category?.name || "", ...(category?.aliases || [])].join(" "));
};
const query = selectedBenchmark.name;
const queryIds = new Set(canonical.filter((record) => independentSearchText(record).includes(normalize(query))).map((record) => record.id));
const queryExpected = data.releases.filter((item) => (retainedByRelease.get(item.id) || []).some((occurrence) => queryIds.has(canonicalId(occurrence)))).map((item) => item.id);
assert.deepEqual(matchingReleaseRecords(indexed, { q: query }).map((item) => item.id), queryExpected);

const frame = {
  scrollLeft: 400,
  scrollWidth: 2000,
  clientWidth: 500,
  clientLeft: 1,
  marker: "unchanged",
  getBoundingClientRect() { return { left: 100, right: 602, width: 502 }; },
};
const track = {
  getBoundingClientRect() {
    const left = 101 + 200 - frame.scrollLeft;
    return { left, right: left + 1700, width: 1700 };
  },
};
const label = { getBoundingClientRect() { return { left: 101, right: 221, width: 120 }; } };
assert.deepEqual(trackGeometry(frame, track, label), { trackLeft: 200, trackWidth: 1700, viewportLeft: 520, viewportWidth: 380, maxScroll: 1500 });
const start = "2024-01-01";
const end = "2026-09-08";
const captured = captureTrackCenter(frame, track, label, start, end);
assert.match(captured, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
assert.notEqual(captured.slice(11), "00:00:00.000Z");
const targetInstant = "2025-06-15T12:34:56.789Z";
const targetCoordinate = trackCoordinateFromInstant(targetInstant, 200, 1700, start, end);
assert.equal(instantFromTrackCoordinate(targetCoordinate, 200, 1700, start, end), targetInstant);
const restored = restoreTrackCenter(frame, track, label, targetInstant, start, end);
assert.equal(restored.clamped, false);
assert.equal(restored.displayedCenter, targetInstant);
assert.equal(captureTrackCenter(frame, track, label, start, end), targetInstant);
const intended = "2026-09-08T00:00:00.000Z";
const edge = restoreTrackCenter(frame, track, label, intended, start, end);
assert.equal(edge.clamped, true);
assert.notEqual(edge.displayedCenter, intended);
assert.equal(intended, "2026-09-08T00:00:00.000Z");
assert.equal(frame.marker, "unchanged");

class FakeScheduler {
  constructor() { this.tasks = []; }
  setTimeout(callback) { const task = { callback, canceled: false }; this.tasks.push(task); return task; }
  clearTimeout(task) { task.canceled = true; }
  run(task) { task.callback(); }
}
const scheduler = new FakeScheduler();
const searched = [];
const cancelable = createCancelableSearch((value) => searched.push(value), 150, scheduler);
cancelable.schedule("old");
const oldTask = scheduler.tasks.at(-1);
cancelable.schedule("new");
const newTask = scheduler.tasks.at(-1);
scheduler.run(oldTask);
assert.deepEqual(searched, []);
scheduler.run(newTask);
assert.deepEqual(searched, ["new"]);
cancelable.schedule("canceled");
const canceledTask = scheduler.tasks.at(-1);
cancelable.cancel();
scheduler.run(canceledTask);
assert.deepEqual(searched, ["new"]);
cancelable.schedule("flushed");
const flushedTask = scheduler.tasks.at(-1);
cancelable.flush();
scheduler.run(flushedTask);
assert.deepEqual(searched, ["new", "flushed"]);

class FakeNode {
  constructor(tagName = "") {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.attributes = new Map();
    this.listeners = new Map();
    this.dataset = {};
    this.hidden = false;
    this._text = "";
  }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map((child) => child.textContent).join(""); }
  append(...children) { this.children.push(...children.map((child) => typeof child === "string" ? new FakeText(child) : child)); }
  replaceChildren(...children) { this._text = ""; this.children = children; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  removeAttribute(name) { this.attributes.delete(name); }
  addEventListener(type, callback) { const listeners = this.listeners.get(type) || []; listeners.push(callback); this.listeners.set(type, listeners); }
  dispatch(type, event = {}) { for (const callback of this.listeners.get(type) || []) callback(event); }
  querySelectorAll(selector) {
    const result = [];
    const matches = (node) => selector === '[role="option"]' && node.getAttribute?.("role") === "option";
    const visit = (node) => { for (const child of node.children || []) { if (matches(child)) result.push(child); visit(child); } };
    visit(this);
    return result;
  }
  scrollIntoView() {}
  focus() {}
}
class FakeText extends FakeNode {
  constructor(text) { super("#text"); this._text = text; }
}
class FakeDocument {
  createElement(name) { return new FakeNode(name); }
  createTextNode(text) { return new FakeText(String(text)); }
}
const findTag = (root, tagName) => {
  if (root.tagName === tagName.toUpperCase()) return root;
  for (const child of root.children) { const found = findTag(child, tagName); if (found) return found; }
  return null;
};
const findLinks = (root) => {
  const links = root.tagName === "A" ? [root] : [];
  return links.concat(...root.children.map(findLinks));
};
globalThis.document = new FakeDocument();
globalThis.requestAnimationFrame = (callback) => callback();
const occurrence = data.occurrences.find((item) => item.review_status === "verified");
const disclosure = sourceDisclosure(indexed, occurrence);
assert.equal(disclosure.tagName, "ARTICLE");
assert.match(disclosure.textContent, /Occurrence ID|Source revision ID|Evaluation setup|Audit state|Retrieval check/);
assert.equal(disclosure.textContent.includes(occurrence.summary), true, "Validated catalog summary carries the exact configuration scope, not source performance quotes");
assert.equal(findLinks(disclosure)[0].getAttribute("href"), indexed.sources.get(occurrence.source_id).url);
const rejectedIndexed = { ...indexed, sources: new Map(indexed.sources) };
rejectedIndexed.sources.set(occurrence.source_id, { ...indexed.sources.get(occurrence.source_id), url: "https://evil.example/source" });
assert.match(sourceDisclosure(rejectedIndexed, occurrence).textContent, /Source link unavailable: destination validation failed/);
assert.match(sourceDisclosure(rejectedIndexed, occurrence).textContent, new RegExp(occurrence.locator.value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

const changes = [];
const combo = createSearchableCombobox({
  id: "benchmark-picker",
  label: "Benchmark",
  options: Array.from({ length: 55 }, (_, index) => ({ value: `value-${index}`, label: `Choice ${index}` })),
  emptyLabel: "All benchmarks",
  onChange: (value) => changes.push(value),
});
combo.input.dispatch("click");
assert.match(combo.status.textContent, /Showing first 50 of 55 matches; type to narrow/);
combo.input.value = "nothing matches";
combo.input.dispatch("input");
assert.equal(combo.status.textContent, "No choices match this search.");
assert.match(findTag(combo.element, "ul").textContent, /No choices match this search/);
combo.input.value = "Choice 1";
combo.input.dispatch("input");
const option = findTag(combo.element, "ul").querySelectorAll('[role="option"]')[0];
let pointerPrevented = false;
option.dispatch("pointerdown", { preventDefault() { pointerPrevented = true; } });
combo.input.dispatch("blur");
assert.equal(pointerPrevented, true);
assert.deepEqual(changes, ["value-1"]);
let hiddenEscapePrevented = false;
combo.input.dispatch("keydown", { key: "Escape", preventDefault() { hiddenEscapePrevented = true; }, stopPropagation() {} });
assert.equal(hiddenEscapePrevented, false);
combo.input.dispatch("click");
let openEscapePrevented = false;
let propagationStopped = false;
combo.input.dispatch("keydown", { key: "Escape", preventDefault() { openEscapePrevented = true; }, stopPropagation() { propagationStopped = true; } });
assert.equal(openEscapePrevented, true);
assert.equal(propagationStopped, true);

console.log(JSON.stringify({ result: "PASS", merged: merged.length, quarantined: quarantined.length, canonical: canonical.length, releases: data.releases.length, sources: data.sources.length }));
