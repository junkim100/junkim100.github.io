import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  indexData,
  matchingBenchmarkIds,
  orderedReleaseOccurrences,
  timelineTicks,
  validateInterface,
} from "../../core.mjs";
import { fixture } from "./fixture.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const routeRoot = resolve(here, "../..");
const [indexHtml, definitionsHtml, appSource, cssSource] = await Promise.all([
  readFile(resolve(routeRoot, "index.html"), "utf8"),
  readFile(resolve(routeRoot, "definitions.html"), "utf8"),
  readFile(resolve(routeRoot, "app.mjs"), "utf8"),
  readFile(resolve(routeRoot, "styles.css"), "utf8"),
]);

validateInterface(fixture);
const indexed = indexData(fixture);
assert.deepEqual(fixture.labs.map((lab) => lab.name), ["OpenAI", "Anthropic", "Google DeepMind", "Meta", "DeepSeek", "Qwen"]);
assert.equal(fixture.corpus.publication_window.start, "2024-01-01");
assert.equal(fixture.corpus.publication_window.end, "2026-09-01");
assert.ok(fixture.releases.some((release) => release.publication_date === "2024-01-01"), "inclusive start is represented");
assert.ok(fixture.releases.some((release) => release.publication_date === "2026-09-01"), "inclusive end is represented");

const aliasMatches = matchingBenchmarkIds(indexed, "CH tasks", "");
assert.deepEqual([...aliasMatches], ["code_harbor"], "benchmark alias filter resolves canonical identity");
const categoryAliasMatches = matchingBenchmarkIds(indexed, "programming", "");
assert.ok(categoryAliasMatches.has("code_harbor"), "category alias filter resolves canonical benchmarks");
const categoryMatches = matchingBenchmarkIds(indexed, "", "multimodal");
assert.deepEqual([...categoryMatches], ["vision_compass"], "category selector is exact");

const denseRelease = fixture.releases.find((release) => (indexed.occurrencesByRelease.get(release.id) || []).length >= 6);
assert.ok(denseRelease, "fixture contains dense label collisions");
const denseOccurrences = orderedReleaseOccurrences(indexed, denseRelease.id);
assert.equal(denseOccurrences.length, 6, "collision detail retains every occurrence");
assert.equal(new Set(denseOccurrences.map((item) => item.id)).size, denseOccurrences.length, "collision detail has no duplicate occurrence");
assert.ok(fixture.benchmarks.some((benchmark) => benchmark.name.length > 50), "fixture covers long canonical text");
assert.ok(fixture.occurrences.some((occurrence) => occurrence.summary.length > 180), "fixture covers long evidence text");
assert.ok(fixture.coverage.some((record) => record.review_status === "incomplete"), "fixture covers incomplete coverage state");
assert.ok(fixture.quarantine.length > 0, "fixture covers quarantine state");

const ticks = timelineTicks("2024-01-01", "2026-09-01", 8);
assert.equal(ticks[0], "2024-01-01");
assert.ok(ticks.length >= 8, "continuous axis has representative date ticks");
assert.ok(ticks.some((date) => !date.endsWith("-01-01") && !date.endsWith("-04-01") && !date.endsWith("-07-01") && !date.endsWith("-10-01")), "axis is not grouped into calendar quarters");

const forbiddenKeys = /^(score|scores|ranking|rank|win_rate|percentage|metric_value)$/i;
function inspect(value, path = "fixture") {
  if (Array.isArray(value)) return value.forEach((item, index) => inspect(item, `${path}[${index}]`));
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    assert.ok(!forbiddenKeys.test(key), `forbidden result field at ${path}.${key}`);
    inspect(child, `${path}.${key}`);
  }
}
inspect(fixture);

for (const id of ["timeline", "ledger", "history", "evidence", "methodology", "complete-table"]) {
  assert.match(indexHtml, new RegExp(`id=["']${id}["']`), `main page contains ${id} view`);
}
assert.match(indexHtml, /<caption>Every included model release/);
assert.match(indexHtml, /role="status" aria-live="polite"/);
assert.match(indexHtml, /<dialog id="detail-dialog"/);
assert.match(indexHtml, /definitions\.html/);
assert.match(definitionsHtml, /id="definition-list"/);
assert.match(definitionsHtml, /generated artifact used by validation/);
assert.match(appSource, /showModal\(\)/, "click and tap details use a native modal dialog");
assert.match(appSource, /addEventListener\("focus"/, "keyboard focus has release preview parity");
assert.match(appSource, /addEventListener\("mouseenter"/, "hover has release preview parity");
assert.match(appSource, /history\.replaceState/, "timeline state is serialized in the URL");
assert.match(appSource, /onclick:\s*\(event\)\s*=>\s*openReleaseDialog\(release,\s*event\.currentTarget\)/, "overflow dialog tracks its actual trigger for focus return");
assert.match(appSource, /No qualifying benchmark occurrence was found/, "zero-occurrence release semantics are explicit");
assert.match(appSource, /Generated ledger request failed/, "network error state is implemented");
assert.match(cssSource, /prefers-reduced-motion: reduce/);
assert.match(cssSource, /@media \(max-width: 767px\)/);
assert.match(cssSource, /@media \(max-width: 390px\)/);

console.log(JSON.stringify({
  result: "PASS",
  labs: fixture.labs.length,
  releases: fixture.releases.length,
  occurrences: fixture.occurrences.length,
  dense_release_occurrences: denseOccurrences.length,
  alias_filter: [...aliasMatches],
  category_alias_filter: [...categoryAliasMatches],
  views: 6,
}));
