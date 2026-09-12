import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  canonicalSearch,
  createTableSearch,
  filterRecords,
  recordsForRoute,
  safeSourceHref,
  sanitizeRouteState,
} from "../../data-routes.mjs";
import {
  decodeViewState,
  definitionsTarget,
  encodeViewState,
  indexData,
  mappedBenchmarkId,
  retainedReleaseOccurrences,
  validateInterface,
} from "../../core.mjs";

const data = validateInterface(JSON.parse(await readFile(new URL("../../public/observatory.json", import.meta.url), "utf8")));
const indexed = indexData(data);
const canonicalBenchmarks = data.benchmarks.filter((benchmark) => !benchmark.identity_status || benchmark.identity_status === "canonical");
const mergedBenchmarks = data.benchmarks.filter((benchmark) => benchmark.identity_status === "merged");
const quarantinedBenchmarks = data.benchmarks.filter((benchmark) => benchmark.identity_status === "quarantined");

const ledger = recordsForRoute("ledger", indexed);
const historyDefault = recordsForRoute("history", indexed);
const historyAll = recordsForRoute("history", indexed, { audit: "all" });
assert.equal(ledger.length, 173, "the ledger retains every release");
assert.equal(historyDefault.length, 3062, "default History excludes only quarantined identity rows");
assert.equal(historyAll.length, 3104, "audit=all exposes the complete stable status-row projection");
assert.equal(historyAll.length - historyDefault.length, 42);
assert.equal(new Set(historyAll.map((record) => record.id)).size, historyAll.length, "canonical display mapping does not deduplicate raw status row IDs");
assert.equal(historyAll.filter((record) => record.occurrence).length, 1826, "every occurrence-linked status remains associated with its exact occurrence");
assert.equal(historyDefault.some((record) => record.identityStatus === "quarantined"), false);
assert.equal(historyAll.filter((record) => record.identityStatus === "quarantined").length, 42);

for (const record of ledger) {
  const retained = retainedReleaseOccurrences(indexed, record.id).length;
  const raw = indexed.occurrencesByRelease.get(record.id)?.length || 0;
  assert.equal(record.retainedCount, retained, `${record.id} uses the shared retained-occurrence predicate`);
  assert.equal(record.withheldCount, raw - retained, `${record.id} keeps withheld occurrences separate`);
}
assert.equal(ledger.reduce((total, record) => total + record.retainedCount, 0), 1826);
assert.equal(ledger.reduce((total, record) => total + record.withheldCount, 0), 998);

const merged = mergedBenchmarks.find((benchmark) => data.derived_statuses.some((status) => status.benchmark_id === benchmark.id));
assert.ok(merged);
const mergedState = decodeViewState("history", `?benchmark=${merged.id}`, data).state;
assert.deepEqual(mergedState.benchmarks, [merged.canonical_benchmark_id]);
const mergedRows = filterRecords("history", historyDefault, mergedState);
const expectedMergedRows = data.derived_statuses.filter((status) => {
  const original = indexed.benchmarks.get(status.benchmark_id);
  if (original?.identity_status === "quarantined") return false;
  return mappedBenchmarkId(indexed.benchmarks, { benchmark_id: status.benchmark_id }) === merged.canonical_benchmark_id;
});
assert.deepEqual(new Set(mergedRows.map((record) => record.id)), new Set(expectedMergedRows.map((status) => status.id)), "a merged old ID filters the complete canonical union while retaining raw row IDs");
assert.ok(mergedRows.some((record) => record.rawBenchmarkId === merged.id), "the canonical union retains the original merged identity provenance");

const quarantined = quarantinedBenchmarks.find((benchmark) => data.derived_statuses.some((status) => status.benchmark_id === benchmark.id));
assert.ok(quarantined);
const quarantinedDecoded = decodeViewState("history", `?benchmark=${quarantined.id}`, data);
assert.equal(quarantinedDecoded.state.audit, "all");
assert.deepEqual(quarantinedDecoded.state.benchmarks, [quarantined.id]);
const quarantinedRows = filterRecords("history", historyAll, quarantinedDecoded.state);
assert.ok(quarantinedRows.length > 0);
assert.ok(quarantinedRows.every((record) => record.rawBenchmarkId === quarantined.id && record.identityStatus === "quarantined"));
assert.match(quarantinedDecoded.notices.join(" "), new RegExp(quarantined.id));

const selected = canonicalBenchmarks.filter((benchmark) => data.derived_statuses.some((status) => mappedBenchmarkId(indexed.benchmarks, { benchmark_id: status.benchmark_id }) === benchmark.id)).slice(0, 2);
const multiDecoded = decodeViewState("history", `?${selected.map((benchmark) => `benchmark=${benchmark.id}`).join("&")}`, data).state;
const multiRows = filterRecords("history", historyDefault, multiDecoded);
assert.ok(multiRows.length > 0);
assert.ok(multiRows.every((record) => new Set(multiDecoded.benchmarks).has(record.benchmarkId)), "repeated History benchmark keys form an OR filter");
const multiSearch = new URLSearchParams(encodeViewState("history", { ...multiDecoded, page: 2 }));
assert.deepEqual(multiSearch.getAll("benchmark"), multiDecoded.benchmarks);
assert.equal(multiSearch.get("page"), "2");
assert.equal(multiSearch.get("v"), "2");

for (const occurrence of data.occurrences.filter((record) => record.review_status === "verified")) {
  const source = indexed.sources.get(occurrence.source_id);
  assert.equal(safeSourceHref(indexed, source, occurrence.release_id), source.url, occurrence.id);
}

const pinnedQwenSources = data.sources.filter((source) => source.url.startsWith("https://raw.githubusercontent.com/QwenLM/qwenlm.github.io/1f89f8c81adb85e3808f9cc15180ab1fdacbb900/"));
assert.equal(pinnedQwenSources.length, 26, "every rebound article keeps a usable immutable Source link");
for (const source of pinnedQwenSources) {
  assert.equal(safeSourceHref(indexed, source, "qwen"), source.url);
  assert.equal(safeSourceHref(indexed, { ...source, url: source.url.replace("/QwenLM/", "/unrelated-publisher/") }, "qwen"), null, "shared host does not authorize another publisher namespace");
  assert.equal(safeSourceHref(indexed, source, "openai"), null, "source cannot be transferred to a different lab");
  assert.equal(safeSourceHref(indexed, { ...source, url: source.url.replace("https://", "https://user@") }), null);
  assert.equal(safeSourceHref(indexed, { ...source, url: source.url.replace("raw.githubusercontent.com", "evil.raw.githubusercontent.com") }), null);
}

const contextRelease = data.releases.find((release) => release.publication_date > data.corpus.publication_window.start && release.publication_date < data.corpus.publication_window.end);
const contextLab = contextRelease.lab_id;
const contextBenchmarkIds = selected.map((benchmark) => benchmark.id);
const context = {
  benchmarks: contextBenchmarkIds,
  lab: contextLab,
  from: contextRelease.publication_date,
  to: contextRelease.publication_date,
  zoom: 2.5,
  center: `${contextRelease.publication_date}T00:00:00.000Z`,
  release: contextRelease.id,
  q: "release name",
  status: data.coverage[0].review_status,
  sort: "name",
  dir: "asc",
  size: 100,
  page: 2,
};
const firstRoundTrip = decodeViewState("ledger", encodeViewState("ledger", context), data).state;
const secondRoundTrip = decodeViewState("ledger", encodeViewState("ledger", firstRoundTrip), data).state;
for (const key of ["benchmarks", "lab", "from", "to", "zoom", "center", "release", "q", "status", "sort", "dir", "size", "page"]) assert.deepEqual(secondRoundTrip[key], firstRoundTrip[key], `${key} survives an inert table-state round trip`);
const compatibility = sanitizeRouteState("history", { benchmark: merged.id }, indexed);
assert.equal(compatibility.benchmark, merged.canonical_benchmark_id);
assert.match(canonicalSearch("history", { ...compatibility, query: "needle" }), /^\?v=2(?:&|$)/);

class FakeScheduler {
  constructor() {
    this.tasks = [];
  }

  setTimeout(callback) {
    const task = { callback, cleared: false };
    this.tasks.push(task);
    return task;
  }

  clearTimeout(task) {
    task.cleared = true;
  }

  run(task) {
    task.callback();
  }
}

const scheduler = new FakeScheduler();
const committedSearches = [];
const routeSearch = createTableSearch((value) => committedSearches.push(value), 150, scheduler);
routeSearch.schedule("older text");
const olderTask = scheduler.tasks.at(-1);
routeSearch.schedule("current text");
const currentTask = scheduler.tasks.at(-1);
scheduler.run(olderTask);
assert.deepEqual(committedSearches, [], "a replaced route timer cannot commit its stale closure");
routeSearch.cancel();
committedSearches.push("current text + finite lab action");
scheduler.run(currentTask);
assert.deepEqual(committedSearches, ["current text + finite lab action"], "a finite action owns the current text and cancels the older callback");
routeSearch.schedule("back race");
const backTask = scheduler.tasks.at(-1);
routeSearch.cancel();
scheduler.run(backTask);
assert.deepEqual(committedSearches, ["current text + finite lab action"], "Back or route leave cancellation prevents a stale history write");
routeSearch.schedule("flushed");
routeSearch.flush();
assert.deepEqual(committedSearches, ["current text + finite lab action", "flushed"]);

const definitionIds = data.canonical_definitions.map((definition) => definition.id);
assert.equal(definitionIds.length, 8);
for (const id of definitionIds) {
  assert.equal(definitionsTarget(`?status=${id}`, "#definition-list", definitionIds), `./about.html#${id}`);
  assert.equal(definitionsTarget("", `#${id}`, definitionIds), `./about.html#${id}`);
}
assert.equal(definitionsTarget("?status=unknown", "#unknown", definitionIds), "./about.html#reporting-definitions");
assert.equal(definitionsTarget("", "#definition-list", definitionIds), "./about.html#reporting-definitions");

console.log(JSON.stringify({
  result: "PASS",
  releases: ledger.length,
  history_default: historyDefault.length,
  history_all: historyAll.length,
  occurrence_links: historyAll.filter((record) => record.occurrence).length,
  merged_union: mergedRows.length,
  quarantined_rows: quarantinedRows.length,
  multi_id_rows: multiRows.length,
  definitions: definitionIds.length,
}));
