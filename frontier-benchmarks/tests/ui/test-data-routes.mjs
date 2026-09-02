import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { indexData, validateInterface } from "../../core.mjs";
import {
  DEFAULT_PAGE_SIZE,
  PAGE_SIZES,
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
  return filterRecords(route, recordsForRoute(route, indexed, state), state);
};
const assertFiltered = (records, predicate) => {
  assert.ok(records.length > 0);
  assert.ok(records.every(predicate));
};
const evidenceOccurrence = production.occurrences[0];
const evidenceBenchmark = indexed.benchmarks.get(evidenceOccurrence.benchmark_id);
const evidenceSource = indexed.sources.get(evidenceOccurrence.source_id);
const historyStatus = production.derived_statuses[0];

assert.deepEqual(PAGE_SIZES, [25, 50, 100]);
assert.equal(DEFAULT_PAGE_SIZE, 50);
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
  category: "",
  lab: "",
  release: "",
  sourceType: "",
  status: "",
  from: "",
  to: "",
  sort: "date",
  direction: "desc",
  pageSize: 50,
  page: 1,
  view: "sources",
});
assert.deepEqual(
  sanitizeRouteState("evidence", parseRouteState("evidence", "?benchmark=invalid&category=invalid&lab=invalid&release=invalid&source-type=invalid&from=2024-02-30&to=9999-01-01&view=invalid&sort=invalid&dir=invalid&size=1&page=-1"), indexed),
  parseRouteState("evidence"),
);
assert.deepEqual(
  stateFor("history", { from: "2025-01-01", to: "2024-01-01" }),
  { ...parseRouteState("history"), from: "", to: "" },
);
assert.deepEqual(
  stateFor("evidence", { from: "1900-01-01", to: "9999-01-01" }),
  parseRouteState("evidence"),
);
const ledgerDate = production.releases.find((release) => release.publication_date > production.corpus.publication_window.start && release.publication_date < production.corpus.publication_window.end).publication_date;
const ledgerDateState = stateFor("ledger", { from: ledgerDate, to: ledgerDate });
assert.deepEqual(
  { from: ledgerDateState.from, to: ledgerDateState.to },
  { from: ledgerDate, to: ledgerDate },
  "ledger retains valid date bounds",
);
assert.match(canonicalSearch("ledger", ledgerDateState), new RegExp(`from=${ledgerDate}&to=${ledgerDate}`), "ledger date bounds remain reload-addressable");

const evidenceUrlState = stateFor("evidence", {
  benchmark: evidenceOccurrence.benchmark_id,
  category: evidenceBenchmark.category_id,
  lab: evidenceOccurrence.lab_id,
  release: evidenceOccurrence.release_id,
  sourceType: evidenceSource.source_type,
  status: evidenceOccurrence.review_status,
  from: evidenceOccurrence.publication_date,
  to: evidenceOccurrence.publication_date,
});
assert.match(canonicalSearch("evidence", evidenceUrlState), /source-type=/);
assert.match(canonicalSearch("evidence", evidenceUrlState), /benchmark=/);
assert.equal(parseRouteState("evidence", `?source-type=${evidenceSource.source_type}`).sourceType, evidenceSource.source_type);

assert.equal(recordsForRoute("ledger", indexed, parseRouteState("ledger")).length, 172);
assert.equal(recordsForRoute("history", indexed, parseRouteState("history")).length, 5593);
assert.equal(recordsForRoute("evidence", indexed, parseRouteState("evidence")).length, 537);
assert.equal(recordsForRoute("evidence", indexed, parseRouteState("evidence", "?view=occurrences")).length, 2821);
assertFiltered(matchingRecords("ledger", { lab: production.releases[0].lab_id }), (record) => record.labId === production.releases[0].lab_id);
assertFiltered(matchingRecords("ledger", { status: production.coverage[0].review_status }), (record) => record.statusIds.includes(production.coverage[0].review_status));
assertFiltered(matchingRecords("ledger", { from: ledgerDate, to: ledgerDate }), (record) => record.publicationDate === ledgerDate);
assertFiltered(matchingRecords("history", { benchmark: historyStatus.benchmark_id }), (record) => record.benchmarkId === historyStatus.benchmark_id);
assertFiltered(matchingRecords("history", { lab: historyStatus.lab_id }), (record) => record.labId === historyStatus.lab_id);
assertFiltered(matchingRecords("history", { status: historyStatus.status_ids[0] }), (record) => record.statusIds.includes(historyStatus.status_ids[0]));
assertFiltered(matchingRecords("history", { from: historyStatus.publication_date }), (record) => record.publicationDate >= historyStatus.publication_date);
assertFiltered(matchingRecords("history", { to: historyStatus.publication_date }), (record) => record.publicationDate <= historyStatus.publication_date);

for (const view of ["sources", "occurrences"]) {
  assertFiltered(
    matchingRecords("evidence", { view, benchmark: evidenceOccurrence.benchmark_id }),
    (record) => (record.associations || [record]).some((association) => association.benchmarkId === evidenceOccurrence.benchmark_id),
  );
  assertFiltered(
    matchingRecords("evidence", { view, category: evidenceBenchmark.category_id }),
    (record) => (record.associations || [record]).some((association) => association.categoryId === evidenceBenchmark.category_id),
  );
  assertFiltered(matchingRecords("evidence", { view, lab: evidenceOccurrence.lab_id }), (record) => record.labId === evidenceOccurrence.lab_id);
  assertFiltered(
    matchingRecords("evidence", { view, release: evidenceOccurrence.release_id }),
    (record) => (record.associations || [record]).some((association) => association.releaseId === evidenceOccurrence.release_id),
  );
  assertFiltered(matchingRecords("evidence", { view, sourceType: evidenceSource.source_type }), (record) => record.sourceType === evidenceSource.source_type);
  assertFiltered(matchingRecords("evidence", { view, status: evidenceOccurrence.review_status }), (record) => record.statusIds.includes(evidenceOccurrence.review_status));
  assertFiltered(matchingRecords("evidence", { view, from: evidenceOccurrence.publication_date }), (record) => record.publicationDate >= evidenceOccurrence.publication_date);
  assertFiltered(matchingRecords("evidence", { view, to: evidenceOccurrence.publication_date }), (record) => record.publicationDate <= evidenceOccurrence.publication_date);
}
assert.equal(matchingRecords("evidence", { query: "legitimate-zero-result-query" }).length, 0);
const splitEvidenceAssociations = [{
  id: "source-with-split-associations",
  labId: "anthropic",
  sourceType: "model_card",
  publicationDate: "2024-03-04",
  statusIds: ["verified", "needs_review"],
  associations: [
    { benchmarkId: "benchmark-a", categoryId: "category-a", releaseId: "release-a", statusId: "verified" },
    { benchmarkId: "benchmark-b", categoryId: "category-b", releaseId: "release-b", statusId: "needs_review" },
  ],
  searchText: "",
}];
assert.equal(filterRecords("evidence", splitEvidenceAssociations, { ...parseRouteState("evidence"), benchmark: "benchmark-a", status: "needs_review" }).length, 0, "evidence source filters intersect on one occurrence association");

const validSource = production.sources[0];
assert.match(safeSourceHref(indexed, validSource), /^https:\/\//);
assert.equal(safeSourceHref(indexed, { ...validSource, url: `https://user@${new URL(validSource.url).hostname}/unsafe` }), null);
assert.equal(safeSourceHref(indexed, { ...validSource, url: "javascript:alert(1)" }), null);
assert.deepEqual(Object.fromEntries([172, 5593, 2821].map((count) => [count, paginate(Array.from({ length: count }), 9999, 50).totalPages])), { 172: 4, 2821: 57, 5593: 112 });
console.log(JSON.stringify({ result: "PASS", page_sizes: PAGE_SIZES, default_page_size: DEFAULT_PAGE_SIZE, releases: 172, statuses: 5593, sources: 537, occurrences: 2821 }));
