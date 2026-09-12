import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { Trends, releaseMatches, revealTrendsChanges } from "../../trends.mjs";
import { Timeline, revealReleaseChanges } from "../../timeline.mjs";
import { indexData, decodeViewState, encodeViewState, mappedBenchmarkId, isLiveCanonical, retainedReleaseOccurrences, matchingReleaseRecords } from "../../core.mjs";

const data = JSON.parse(await readFile(new URL("../../public/observatory.json", import.meta.url), "utf8"));
const indexed = indexData(data);
const historical = "release_qwen_20260319_qwen3_5_max_preview";
const exactCenter = "2025-06-15T12:34:56.789Z";
const initial = (changes = {}) => ({ ...decodeViewState("trends", "?v=2", indexed).state, center: exactCenter, ...changes });
const live = (id) => retainedReleaseOccurrences(indexed, id).filter((o) => isLiveCanonical(indexed.benchmarks.get(mappedBenchmarkId(indexed.benchmarks, o))));
const visible = (state, id) => releaseMatches(indexed, state.benchmarks, state).some((m) => m.release.id === id);
function reveal(state, target) {
  const app = { indexed, state: structuredClone(state), messages: [], mutations: [], announce(message) { this.messages.push(message); }, mutate(changes, message) {
    this.mutations.push(changes);
    this.state = decodeViewState("trends", encodeViewState("trends", { ...this.state, ...changes }), indexed).state;
    this.messages.push(message);
  } };
  Trends.prototype.revealRelease.call(app, target);
  return app;
}

test("historical-only target explains unavailable without changing state or claiming success", () => {
  assert.ok(retainedReleaseOccurrences(indexed, historical).length);
  assert.equal(live(historical).length, 0);
  const before = initial({ release: historical, search: "keep discovery", zoom: 2 });
  const app = reveal(before, indexed.releases.get(historical));
  assert.deepEqual(app.state, before);
  assert.equal(app.mutations.length, 0);
  assert.match(app.messages.join(" "), /unavailable|cannot be shown/i);
  assert.doesNotMatch(app.messages.join(" "), /revealed and chronology/);
});

test("missing, invalid and withheld-only targets cannot manufacture a Trends lane", () => {
  for (const target of [null, undefined, { id: "invalid" }, ...data.releases.filter((r) => !live(r.id).length)]) {
    const before = initial();
    const app = reveal(before, target);
    assert.deepEqual(app.state, before);
    assert.equal(app.mutations.length, 0);
    assert.match(app.messages.join(" "), /unavailable|cannot be shown/i);
  }
});

test("mixed historical/current target uses a real live canonical occurrence", () => {
  const mixed = data.releases.filter((r) => live(r.id).length && live(r.id).length < retainedReleaseOccurrences(indexed, r.id).length);
  assert.ok(mixed.length);
  for (const target of mixed) {
    const app = reveal(initial({ release: target.id }), target);
    assert.ok(visible(app.state, target.id));
    assert.ok(app.state.benchmarks.every((id) => isLiveCanonical(indexed.benchmarks.get(id))));
    assert.ok(live(target.id).some((o) => `${o.publication_date}T00:00:00.000Z` === app.state.center));
  }
});

test("combined filters relax minimally, preserve comparison and discovery, and use reporting dates", () => {
  let trials = 0;
  for (const target of data.releases.filter((r) => live(r.id).length)) {
    const occurrence = live(target.id)[0];
    const benchmark = mappedBenchmarkId(indexed.benchmarks, occurrence);
    for (const selected of [[benchmark], initial().benchmarks]) {
      for (const lab of [target.lab_id, data.labs.find((l) => l.id !== target.lab_id).id]) {
        for (const dates of [{}, { from: "2026-09-08" }, { to: "2024-01-01" }]) {
          const before = initial({ benchmarks: selected, lab, ...dates, release: target.id, search: "unmatched discovery", category: data.categories[0].id, zoom: 2.5 });
          const app = reveal(before, target);
          assert.ok(visible(app.state, target.id), target.id);
          for (const key of ["search", "category", "zoom", "release"]) assert.deepEqual(app.state[key], before[key]);
          if (before.lab === target.lab_id) assert.equal(app.state.lab, before.lab);
          assert.ok(selected.every((id) => app.state.benchmarks.includes(id)), "comparison retained when there is a free slot");
          const changed = ["benchmarks", "lab", "from", "to"].filter((key) => JSON.stringify(app.state[key]) !== JSON.stringify(before[key]));
          for (const key of changed) assert.equal(visible({ ...app.state, [key]: before[key] }, target.id), false, `restoring ${key} must obstruct actual visibility`);
          assert.match(app.messages.join(" "), /revealed|already visible/i);
          const again = reveal(app.state, target);
          assert.deepEqual(again.state, app.state);
          assert.equal(again.mutations.length, 0, "repeated Reveal creates no duplicate history entry");
          trials++;
        }
      }
    }
  }
  console.log(`Trends adversarial full-predicate trials: ${trials}`);
});

test("full six-item comparison replaces only one obstructing selection", () => {
  const target = data.releases.find((r) => live(r.id).length);
  const targetIds = new Set(live(target.id).map((o) => mappedBenchmarkId(indexed.benchmarks, o)));
  const benchmarks = data.benchmarks.filter((b) => isLiveCanonical(b) && !targetIds.has(b.id)).slice(0, 6).map((b) => b.id);
  const app = reveal(initial({ benchmarks, release: target.id }), target);
  assert.ok(visible(app.state, target.id));
  assert.equal(app.state.benchmarks.length, 6);
  assert.equal(benchmarks.filter((id) => app.state.benchmarks.includes(id)).length, 5);
});

test("already-visible target keeps compatible filters and centers an actually matching report", () => {
  const target = data.releases.find((r) => live(r.id).length);
  const o = live(target.id)[0];
  const before = initial({ release: target.id, benchmarks: [mappedBenchmarkId(indexed.benchmarks, o)], from: o.publication_date, to: o.publication_date, lab: target.lab_id });
  assert.ok(visible(before, target.id));
  const app = reveal(before, target);
  for (const key of ["benchmarks", "lab", "from", "to"]) assert.deepEqual(app.state[key], before[key]);
  assert.equal(app.state.center, `${o.publication_date}T00:00:00.000Z`);
});

test("a later compatible report wins over the first report and a needless filter reset", () => {
  const target = data.releases.find((r) => live(r.id).length);
  const report = live(target.id)[0];
  // Test-only dates deliberately differ from release day and occurrence-ID order.
  const fixture = indexData({ ...data, releases: [target], occurrences: [
    { ...report, id: "first-test-report", publication_date: "2024-01-01" },
    { ...report, id: "later-test-report", publication_date: "2025-06-15" },
  ] });
  const state = initial({ benchmarks: [mappedBenchmarkId(indexed.benchmarks, report)], from: "2025-01-01", to: "2025-12-31", release: target.id });
  assert.deepEqual(revealTrendsChanges(fixture, state, target.id), { center: "2025-06-15T00:00:00.000Z" });
  const disjoint = { ...state, from: "2024-02-01", to: "2024-12-31" };
  const changes = revealTrendsChanges(fixture, disjoint, target.id);
  assert.equal(Object.keys(changes).length, 2, "clear only one date endpoint, not both");
  assert.ok(releaseMatches(fixture, disjoint.benchmarks, { ...disjoint, ...changes }).some((m) => m.release.id === target.id));
});

test("Releases sibling legitimately reveals historical/withheld release-only rows without reactivation", () => {
  const empty = data.releases.filter((r) => !live(r.id).length);
  assert.ok(empty.some((r) => r.id === historical));
  for (const target of empty) {
    const before = { ...initial(), q: "AI2D", category: data.categories[0].id, lab: data.labs.find((l) => l.id !== target.lab_id).id, from: "2026-09-08", to: "2026-09-08", release: target.id };
    const changes = revealReleaseChanges(indexed, before, target.id);
    assert.ok(changes);
    const after = { ...before, ...changes };
    assert.ok(matchingReleaseRecords(indexed, after).some((r) => r.id === target.id));
    assert.deepEqual(after.benchmarks, []);
    assert.equal(after.center, `${target.publication_date}T00:00:00.000Z`);
    assert.equal(live(target.id).length, 0);
    assert.deepEqual({ ...after, ...revealReleaseChanges(indexed, after, target.id) }, after);
    const receiver = { indexed, state: before, status: {}, mutate(c, message) { assert.deepEqual(c, changes); assert.match(message, /revealed/); } };
    Timeline.prototype.revealRelease.call(receiver, target);
  }
});
