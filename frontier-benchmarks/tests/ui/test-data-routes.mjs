import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { indexData, validateInterface } from "../../core.mjs";
import { DEFAULT_PAGE_SIZE, PAGE_SIZES, paginate, parseRouteState, recordsForRoute, safeSourceHref } from "../../data-routes.mjs";

const production = validateInterface(JSON.parse(await readFile(new URL("../../public/observatory.json", import.meta.url), "utf8")));
const indexed = indexData(production);

assert.deepEqual(PAGE_SIZES, [25, 50, 100]);
assert.equal(DEFAULT_PAGE_SIZE, 50);
assert.deepEqual(parseRouteState("ledger", "?size=malformed&page=-4&sort=invalid&dir=invalid"), {
  query: "",
  lab: "",
  status: "",
  sort: "date",
  direction: "desc",
  pageSize: 50,
  page: 1,
  view: "sources",
});
assert.equal(recordsForRoute("ledger", indexed, parseRouteState("ledger")).length, 172);
assert.equal(recordsForRoute("history", indexed, parseRouteState("history")).length, 5593);
assert.equal(recordsForRoute("evidence", indexed, parseRouteState("evidence")).length, 537);
assert.equal(recordsForRoute("evidence", indexed, parseRouteState("evidence", "?view=occurrences")).length, 2821);
const validSource = production.sources[0];
assert.match(safeSourceHref(indexed, validSource), /^https:\/\//);
assert.equal(safeSourceHref(indexed, { ...validSource, url: `https://user@${new URL(validSource.url).hostname}/unsafe` }), null);
assert.equal(safeSourceHref(indexed, { ...validSource, url: "javascript:alert(1)" }), null);
assert.deepEqual(Object.fromEntries([172, 5593, 2821].map((count) => [count, paginate(Array.from({ length: count }), 9999, 50).totalPages])), { 172: 4, 2821: 57, 5593: 112 });
console.log(JSON.stringify({ result: "PASS", page_sizes: PAGE_SIZES, default_page_size: DEFAULT_PAGE_SIZE, releases: 172, statuses: 5593, sources: 537, occurrences: 2821 }));
