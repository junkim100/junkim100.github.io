import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { indexData, validateInterface } from "../../core.mjs";
import {
  DEFAULT_PAGE_SIZE,
  PAGE_SIZES,
  SEARCH_DEBOUNCE_MS,
  canonicalSearch,
  eventTypeForAttribute,
  filterRecords,
  isRealIsoDate,
  paginate,
  parseRouteState,
  recordsForRoute,
  safeSourceHref,
  sanitizeRouteState,
} from "../../data-routes.mjs";

const production = validateInterface(JSON.parse(await readFile(new URL("../../public/observatory.json", import.meta.url), "utf8")));
const indexed = indexData(production);
const stateFor = (route, changes = {}) => sanitizeRouteState(route, { ...parseRouteState(route), ...changes }, indexed);
const matchingRecords = (route, changes = {}) => {
  const state = stateFor(route, changes);
  return filterRecords(route, recordsForRoute(route, indexed), state);
};
const assertFiltered = (records, predicate) => {
  assert.ok(records.length > 0);
  assert.ok(records.every(predicate));
};

assert.deepEqual(PAGE_SIZES, [25, 50, 100]);
assert.equal(DEFAULT_PAGE_SIZE, 50);
assert.equal(SEARCH_DEBOUNCE_MS, 150);
assert.equal(eventTypeForAttribute("onChange"), "change");
assert.equal(eventTypeForAttribute("onclick"), "click");
assert.equal(eventTypeForAttribute("change"), null);
assert.equal(isRealIsoDate("2024-02-29"), true);
assert.equal(isRealIsoDate("2025-02-29"), false);
assert.equal(isRealIsoDate("2024-02-30"), false);
assert.equal(isRealIsoDate("2024-2-09"), false);
assert.equal(parseRouteState("ledger", "?page=2junk&size=100junk").page, 1);
assert.equal(parseRouteState("ledger", "?page=2junk&size=100junk").pageSize, DEFAULT_PAGE_SIZE);
assert.deepEqual(parseRouteState("ledger", "?size=malformed&page=-4&sort=invalid&dir=invalid"), {
  query: "",
  benchmark: "",
  lab: "",
  status: "",
  from: "",
  to: "",
  sort: "date",
  direction: "desc",
  pageSize: 50,
  page: 1,
});
assert.deepEqual(
  stateFor("history", { benchmark: "invalid", lab: "invalid", status: "invalid", from: "2024-02-30", to: "9999-01-01", sort: "invalid", direction: "invalid", pageSize: 1, page: -1 }),
  parseRouteState("history"),
);
assert.deepEqual(stateFor("history", { from: "2025-01-01", to: "2024-01-01" }), parseRouteState("history"));

const ledgerDate = production.releases.find((release) => release.publication_date > production.corpus.publication_window.start && release.publication_date < production.corpus.publication_window.end).publication_date;
const ledgerDateState = stateFor("ledger", { from: ledgerDate, to: ledgerDate });
assert.deepEqual({ from: ledgerDateState.from, to: ledgerDateState.to }, { from: ledgerDate, to: ledgerDate });
assert.match(canonicalSearch("ledger", ledgerDateState), new RegExp(`from=${ledgerDate}&to=${ledgerDate}`));

const ledgerRecords = recordsForRoute("ledger", indexed);
const historyRecords = recordsForRoute("history", indexed);
assert.equal(ledgerRecords.length, 172);
assert.equal(historyRecords.length, 5593);
assert.deepEqual(new Set(ledgerRecords.map((record) => record.id)), new Set(production.releases.map((release) => release.id)), "ledger default is the exact release ID union");
assert.deepEqual(new Set(historyRecords.map((record) => record.id)), new Set(production.derived_statuses.map((status) => status.id)), "history default is the exact status ID union");

const occurrences = new Map(production.occurrences.map((occurrence) => [occurrence.id, occurrence]));
const historyById = new Map(historyRecords.map((record) => [record.id, record]));
const statusesWithOccurrence = production.derived_statuses.filter((status) => status.occurrence_id);
const linkedHistoryRows = historyRecords.filter((record) => record.sourceHref);
assert.equal(statusesWithOccurrence.length, 2821);
assert.equal(linkedHistoryRows.length, 2821, "every history row associated with an occurrence exposes one Source destination");
for (const status of statusesWithOccurrence) {
  const occurrence = occurrences.get(status.occurrence_id);
  const source = indexed.sources.get(occurrence.source_id);
  const record = historyById.get(status.id);
  assert.equal(record.sourceHref, safeSourceHref(indexed, source));
}

const firstRelease = production.releases[0];
const firstStatus = production.derived_statuses[0];
assertFiltered(matchingRecords("ledger", { lab: firstRelease.lab_id }), (record) => record.labId === firstRelease.lab_id);
assertFiltered(matchingRecords("ledger", { status: production.coverage[0].review_status }), (record) => record.statusIds.includes(production.coverage[0].review_status));
assertFiltered(matchingRecords("ledger", { from: ledgerDate, to: ledgerDate }), (record) => record.publicationDate === ledgerDate);
assertFiltered(matchingRecords("history", { benchmark: firstStatus.benchmark_id }), (record) => record.benchmarkId === firstStatus.benchmark_id);
assertFiltered(matchingRecords("history", { lab: firstStatus.lab_id }), (record) => record.labId === firstStatus.lab_id);
assertFiltered(matchingRecords("history", { status: firstStatus.status_ids[0] }), (record) => record.statusIds.includes(firstStatus.status_ids[0]));
assert.equal(matchingRecords("history", { query: "legitimate-zero-result-query" }).length, 0);

const validSource = production.sources[0];
assert.match(safeSourceHref(indexed, validSource), /^https:\/\//);
assert.equal(safeSourceHref(indexed, { ...validSource, url: `https://user@${new URL(validSource.url).hostname}/unsafe` }), null);
assert.equal(safeSourceHref(indexed, { ...validSource, url: "javascript:alert(1)" }), null);
assert.deepEqual(Object.fromEntries([172, 5593].map((count) => [count, paginate(Array.from({ length: count }), 9999, 50).totalPages])), { 172: 4, 5593: 112 });

console.log(JSON.stringify({ result: "PASS", page_sizes: PAGE_SIZES, default_page_size: DEFAULT_PAGE_SIZE, releases: ledgerRecords.length, statuses: historyRecords.length, source_links: linkedHistoryRows.length }));
