import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  createCancelableSearch,
  decodeViewState,
  encodeViewState,
  indexData,
  mappedBenchmarkId,
  matchingReleaseRecords,
} from "../../core.mjs";
import {
  chronologyClusters,
  DEFAULT_BENCHMARK_ID,
  preserveChronologyCenter as preserveBenchmarkCenter,
  rankDiscoveryBenchmarks,
  releaseMatches,
} from "../../trends.mjs";
import {
  preserveChronologyCenter as preserveReleaseCenter,
  releaseChronologyClusters,
  sanitizeTimelineState,
} from "../../timeline.mjs";

const production = JSON.parse(await readFile(new URL("../../public/observatory.json", import.meta.url), "utf8"));
const productionIndex = indexData(production);
const retainedWithDifferentDates = production.occurrences.find((occurrence) => occurrence.review_status === "verified" && occurrence.publication_date !== productionIndex.releases.get(occurrence.release_id)?.publication_date);
assert.ok(retainedWithDifferentDates, "the real corpus keeps reporting date separate from release date");

const categories = [
  { id: "coding", name: "Coding", aliases: ["programming"] },
  { id: "reasoning", name: "Reasoning", aliases: ["logic"] },
];
const labs = [
  { id: "lab_a", name: "Lab A", official_domains: ["a.example"] },
  { id: "lab_b", name: "Lab B", official_domains: ["b.example"] },
];
const benchmarks = [
  { id: DEFAULT_BENCHMARK_ID, name: "Terminal-Bench 2.0", category_id: "coding", aliases: ["terminal tasks"] },
  { id: "benchmark_beta", name: "Beta Reasoning", category_id: "reasoning", aliases: ["logic beta"] },
];
const releases = [
  { id: "release_a", name: "Alpha Release", lab_id: "lab_a", model_id: "model_a", publication_date: "2025-01-05" },
  { id: "release_b", name: "Beta Release", lab_id: "lab_b", model_id: "model_b", publication_date: "2025-02-10" },
  { id: "release_withheld", name: "Withheld Release", lab_id: "lab_a", model_id: "model_a", publication_date: "2025-03-10" },
];
const occurrences = [
  { id: "occurrence_a", release_id: "release_a", lab_id: "lab_a", model_id: "model_a", benchmark_id: DEFAULT_BENCHMARK_ID, source_id: "source_a", publication_date: "2025-01-20", review_status: "verified" },
  { id: "occurrence_b", release_id: "release_b", lab_id: "lab_b", model_id: "model_b", benchmark_id: "benchmark_beta", source_id: "source_b", publication_date: "2025-02-12", review_status: "verified" },
  { id: "occurrence_withheld", release_id: "release_withheld", lab_id: "lab_a", model_id: "model_a", benchmark_id: DEFAULT_BENCHMARK_ID, source_id: "source_a", publication_date: "2025-03-10", review_status: "quarantined" },
];
const synthetic = {
  corpus: { publication_window: { start: "2024-01-01", end: "2026-09-08" } },
  categories,
  labs,
  benchmarks,
  releases,
  occurrences,
  models: [{ id: "model_a" }, { id: "model_b" }],
  lineages: [],
  sources: [],
  coverage: [],
  canonical_definitions: [],
  derived_statuses: [],
  quarantine: [],
};
const indexed = indexData(synthetic);

assert.deepEqual(matchingReleaseRecords(indexed, { benchmarks: [DEFAULT_BENCHMARK_ID, "benchmark_beta"] }).map((release) => release.id), ["release_a", "release_b"], "selected benchmarks form a retained OR union");
assert.deepEqual(matchingReleaseRecords(indexed, { benchmarks: [DEFAULT_BENCHMARK_ID, "benchmark_beta"], q: "logic beta" }).map((release) => release.id), ["release_b"], "benchmark search intersects the selected OR union");
assert.deepEqual(matchingReleaseRecords(indexed, { benchmarks: [DEFAULT_BENCHMARK_ID, "benchmark_beta"], category: "coding", lab: "lab_a" }).map((release) => release.id), ["release_a"], "category and lab constraints intersect retained benchmark matches");
assert.deepEqual(matchingReleaseRecords(indexed, {}).map((release) => release.id), releases.map((release) => release.id), "an unfiltered release chronology retains releases with zero retained occurrences");

assert.deepEqual(releaseMatches(indexed, [DEFAULT_BENCHMARK_ID], { from: "2025-01-20", to: "2025-01-20" }).map((match) => match.release.id), ["release_a"], "benchmark lanes filter on reporting date");
assert.deepEqual(releaseMatches(indexed, [DEFAULT_BENCHMARK_ID], { from: "2025-01-05", to: "2025-01-05" }), [], "a release date does not substitute for a reporting date in benchmark lanes");
assert.deepEqual(releaseMatches(indexed, [DEFAULT_BENCHMARK_ID, "benchmark_beta"], { lab: "lab_b" }).map((match) => match.release.id), ["release_b"], "lab intersects the selected benchmark OR union");

const categoryMap = new Map(categories.map((category) => [category.id, category]));
assert.deepEqual(rankDiscoveryBenchmarks([
  { id: "substring", name: "Alpha Terminal-Bench 2.0", aliases: [] },
  { id: "exact", name: "Terminal-Bench 2.0", aliases: [] },
], categoryMap, "Terminal-Bench 2.0").map((benchmark) => benchmark.id), ["exact", "substring"], "Discovery preserves exact-name priority instead of alphabetically resorting matching IDs");
assert.deepEqual(rankDiscoveryBenchmarks(benchmarks, categoryMap, "programming").map((benchmark) => benchmark.id), [DEFAULT_BENCHMARK_ID], "category aliases participate in benchmark discovery");
assert.deepEqual(rankDiscoveryBenchmarks(benchmarks, categoryMap, "terminal tasks").map((benchmark) => benchmark.id), [DEFAULT_BENCHMARK_ID], "benchmark aliases participate in discovery");

const laneEntries = [
  { occurrence: { id: "o1", publication_date: "2025-01-01" } },
  { occurrence: { id: "o2", publication_date: "2025-01-01" } },
  { occurrence: { id: "o3", publication_date: "2025-01-02" } },
  { occurrence: { id: "o4", publication_date: "2025-02-01" } },
];
const laneClusters = chronologyClusters(laneEntries, [10, 10, 35, 400], 50);
assert.deepEqual(laneClusters.map((cluster) => cluster.entries.map((entry) => entry.occurrence.id)), [["o1", "o2", "o3"], ["o4"]]);
assert.deepEqual(laneClusters.flatMap((cluster) => cluster.entries), laneEntries, "lane collision clustering retains every occurrence exactly once");

const clusteredReleases = [
  { id: "r1", publication_date: "2025-01-01" },
  { id: "r2", publication_date: "2025-01-01" },
  { id: "r3", publication_date: "2025-01-02" },
  { id: "r4", publication_date: "2025-03-01" },
];
const releaseClusters = releaseChronologyClusters(clusteredReleases, [20, 20, 55, 500], 50);
assert.deepEqual(releaseClusters.map((cluster) => cluster.releases.map((release) => release.id)), [["r1", "r2", "r3"], ["r4"]]);
assert.deepEqual(releaseClusters.flatMap((cluster) => cluster.releases), clusteredReleases, "release collision clustering retains every release exactly once");

const exactCenter = "2025-06-15T12:34:56.789Z";
const changes = [
  { benchmarks: [DEFAULT_BENCHMARK_ID, "benchmark_beta"] },
  { category: "coding" },
  { lab: "lab_a" },
  { from: "2025-01-01" },
  { to: "2025-12-31" },
  { zoom: 2.5 },
  { release: "release_a" },
  { release: "" },
];
let benchmarkState = { center: exactCenter, release: "release_a" };
let releaseState = { center: exactCenter, release: "release_a" };
for (let cycle = 0; cycle < 20; cycle += 1) {
  for (const change of changes) {
    benchmarkState = preserveBenchmarkCenter(benchmarkState, change);
    releaseState = preserveReleaseCenter(releaseState, change);
    assert.equal(benchmarkState.center, exactCenter);
    assert.equal(releaseState.center, exactCenter);
  }
}
assert.equal(preserveBenchmarkCenter({ center: exactCenter, release: "release_a" }, { lab: "lab_b" }).release, "release_a", "filters preserve a pinned release");
assert.equal(preserveReleaseCenter({ center: exactCenter, release: "release_a" }, { q: "beta" }).release, "release_a", "release filters preserve a pinned release");

for (const route of ["trends", "timeline"]) {
  for (const zoom of [1, 1.5, 2, 2.5, 3, 4]) {
    const decoded = decodeViewState(route, `?v=2&zoom=${zoom}&center=${encodeURIComponent(exactCenter)}&release=release_a`, synthetic);
    assert.equal(decoded.state.zoom, zoom, `${route} accepts historical zoom ${zoom}`);
    assert.equal(decoded.state.center, exactCenter);
    assert.equal(decoded.state.release, "release_a");
    assert.equal(new URLSearchParams(encodeViewState(route, decoded.state)).get("center"), exactCenter);
  }
}
const benchmarkReset = decodeViewState("trends", "?v=2", synthetic, {}).state;
assert.deepEqual({ benchmarks: benchmarkReset.benchmarks, center: benchmarkReset.center, release: benchmarkReset.release, zoom: benchmarkReset.zoom }, { benchmarks: [DEFAULT_BENCHMARK_ID], center: "", release: "", zoom: 1 });
const pinnedWithCenter = decodeViewState("trends", `?v=2&benchmark=${DEFAULT_BENCHMARK_ID}&release=release_b&center=${encodeURIComponent(exactCenter)}`, synthetic, {}).state;
assert.equal(pinnedWithCenter.center, exactCenter, "a pin never overrides an explicit center");
assert.equal(pinnedWithCenter.release, "release_b");

assert.equal(sanitizeTimelineState({ zoom: "1.5", release: "release_a" }, synthetic).zoom, 1.5);
assert.equal(sanitizeTimelineState({ zoom: "3", release: "release_a" }, synthetic).zoom, 3);
assert.equal(sanitizeTimelineState({ zoom: "9", release: "missing" }, synthetic).zoom, 1);
assert.equal(sanitizeTimelineState({ zoom: "9", release: "missing" }, synthetic).release, "");

class FakeClock {
  constructor() { this.tasks = new Map(); this.next = 1; }
  setTimeout(callback) { const id = this.next; this.next += 1; this.tasks.set(id, callback); return id; }
  clearTimeout(id) { this.tasks.delete(id); }
  runAll() { const tasks = [...this.tasks.values()]; this.tasks.clear(); tasks.forEach((task) => task()); }
}
const clock = new FakeClock();
const searches = [];
const search = createCancelableSearch((value) => searches.push(value), 150, clock);
search.schedule("stale");
search.schedule("current");
assert.equal(clock.tasks.size, 1, "a newer search cancels the stale timer");
search.flush();
assert.deepEqual(searches, ["current"]);
assert.equal(clock.tasks.size, 0, "flush leaves no timer");
search.schedule("leave");
search.cancel();
clock.runAll();
assert.deepEqual(searches, ["current"], "route leave cancellation prevents a stale callback");

const canonicalId = mappedBenchmarkId(productionIndex.benchmarks, retainedWithDifferentDates);
assert.ok(productionIndex.benchmarks.has(canonicalId));
console.log(JSON.stringify({ result: "PASS", real_reporting_date_example: retainedWithDifferentDates.id, chronology_clusters: laneClusters.length, release_clusters: releaseClusters.length }));
