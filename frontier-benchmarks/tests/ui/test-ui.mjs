import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  collisionRows,
  indexData,
  matchingBenchmarkIds,
  orderedReleaseOccurrences,
  timelineTicks,
  validateInterface,
} from "../../core.mjs";
import { sanitizeTimelineState } from "../../timeline.mjs";
import { fixture } from "./fixture.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const routeRoot = resolve(here, "../..");
const [indexHtml, timelineHtml, ledgerHtml, historyHtml, evidenceHtml, definitionsHtml, appSource, timelineSource, shellSource, dataRoutesSource, cssSource, jsonBytes, csvBytes] = await Promise.all([
  readFile(resolve(routeRoot, "index.html"), "utf8"),
  readFile(resolve(routeRoot, "timeline.html"), "utf8"),
  readFile(resolve(routeRoot, "ledger.html"), "utf8"),
  readFile(resolve(routeRoot, "history.html"), "utf8"),
  readFile(resolve(routeRoot, "evidence.html"), "utf8"),
  readFile(resolve(routeRoot, "definitions.html"), "utf8"),
  readFile(resolve(routeRoot, "app.mjs"), "utf8"),
  readFile(resolve(routeRoot, "timeline.mjs"), "utf8"),
  readFile(resolve(routeRoot, "shell.mjs"), "utf8"),
  readFile(resolve(routeRoot, "data-routes.mjs"), "utf8"),
  readFile(resolve(routeRoot, "styles.css"), "utf8"),
  readFile(resolve(routeRoot, "public/observatory.json")),
  readFile(resolve(routeRoot, "public/observatory.csv")),
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

const sanitizedState = sanitizeTimelineState({
  q: `  <img src=x onerror=alert(1)>${"x".repeat(200)}  `,
  category: "not-a-category",
  lab: "not-a-lab",
  from: "2099-01-01",
  to: "1900-01-01",
  release: "not-a-release",
}, fixture);
assert.equal(sanitizedState.q.length, 160, "query state is bounded before rendering");
assert.equal(sanitizedState.q.startsWith("<img src=x"), true, "query text remains inert data");
assert.deepEqual({ ...sanitizedState, q: "" }, { q: "", category: "", lab: "", from: "", to: "", release: "" }, "unknown URL state is rejected");

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

assert.deepEqual(collisionRows([0, 12, 24, 225], 200), [0, 1, 2, 0], "dense release positions receive deterministic non-overlapping rows");

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

const routes = new Map([
  ["overview", indexHtml],
  ["timeline", timelineHtml],
  ["ledger", ledgerHtml],
  ["history", historyHtml],
  ["evidence", evidenceHtml],
  ["definitions", definitionsHtml],
]);
const navigationTargets = ["./", "./timeline.html", "./ledger.html", "./history.html", "./evidence.html", "./definitions.html", "./public/observatory.json", "./public/observatory.csv"];
for (const [route, html] of routes) {
  const csp = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)"/)?.[1] || "";
  assert.match(html, /<a class="skip-link" href="#main">Skip to content<\/a>/, `${route} has skip navigation`);
  assert.match(html, /<header class="site-header">/, `${route} has a shared header landmark`);
  assert.match(html, /<nav class="primary-nav" aria-label="Observatory">/, `${route} has the shared navigation landmark`);
  assert.match(html, /<main id="main"/, `${route} has a main landmark`);
  assert.match(html, /<footer class="site-footer page-shell">/, `${route} has a shared footer landmark`);
  assert.match(html, /<script type="module" src="\.\/shell\.mjs"><\/script>/, `${route} uses the shared shell behavior`);
  assert.match(csp, /default-src 'self'/, `${route} has a local default CSP`);
  assert.match(csp, /script-src 'self'/, `${route} permits only local scripts`);
  assert.doesNotMatch(csp, /script-src[^;]*(?:unsafe-|\*)/, `${route} does not permit inline or wildcard scripts`);
  assert.doesNotMatch(csp, /unsafe-eval|\*/, `${route} CSP excludes eval and wildcard sources`);
  const scripts = [...html.matchAll(/<script\b([^>]*)>/g)].map((match) => match[1]);
  assert.ok(scripts.every((attributes) => /\bsrc=/.test(attributes)), `${route} uses no inline script blocks`);
  for (const href of navigationTargets) {
    assert.ok(html.includes(`href="${href}"`), `${route} keeps the no-JavaScript navigation target ${href}`);
  }
}
assert.match(indexHtml, /<script type="module" src="\.\/timeline\.mjs"><\/script>/, "overview loads the shared timeline module");
assert.match(timelineHtml, /<script type="module" src="\.\/timeline\.mjs"><\/script>/, "full route loads the shared timeline module");

assert.match(indexHtml, /evidence-first, score-free/);
assert.match(indexHtml, /A reporting record, not a leaderboard/);
for (const [label, value] of [["Labs", "6"], ["Releases", "172"], ["Benchmarks", "869"], ["Evidence occurrences", "2,821"], ["First-party sources", "537"]]) {
  assert.match(indexHtml, new RegExp(`<dt>${label}<\\/dt><dd>${value}<\\/dd>`), `landing page fixes ${label} at ${value}`);
}
assert.match(indexHtml, /id="timeline-host" data-timeline-mode="compact"/);
assert.match(timelineHtml, /id="timeline-host" data-timeline-mode="full"/);
assert.match(indexHtml, /id="timeline-controls" data-route-controls="timeline"/);
assert.match(indexHtml, /id="release-detail-host" aria-label="Pinned release detail" hidden/);
assert.match(timelineHtml, /id="release-detail-host" aria-label="Pinned release detail" hidden/);
const compactHost = indexHtml.match(/<div class="timeline-host timeline-host-compact"[\s\S]*?<aside class="detail-panel-host"[^>]*><\/aside>\s*<\/div>/)?.[0] || "";
assert.ok(compactHost, "landing page contains a compact timeline host");
assert.doesNotMatch(compactHost, /View in Fullscreen/, "fullscreen transition is outside the compact timeline host");
assert.match(indexHtml, /<aside class="fullscreen-callout"[\s\S]*id="timeline-fullscreen-link" href="\.\/timeline\.html">View in Fullscreen<\/a>/);
for (const forbiddenId of ["ledger-body", "history-content", "evidence-list", "occurrence-table-body", "complete-table"]) {
  assert.doesNotMatch(indexHtml, new RegExp(`id=["']${forbiddenId}["']`), `landing page omits the complete ${forbiddenId} view`);
}
assert.doesNotMatch(indexHtml, /<table[\s>]/, "landing page does not render a data table");
assert.match(ledgerHtml, /id="ledger-controls" data-route-controls="ledger"[\s\S]*id="ledger-host" data-route-view="ledger"/);
assert.match(historyHtml, /id="history-controls" data-route-controls="history"[\s\S]*id="history-host" data-route-view="history"/);
assert.match(evidenceHtml, /id="evidence-controls" data-route-controls="evidence"[\s\S]*id="evidence-host" data-route-view="evidence"/);
for (const html of [ledgerHtml, historyHtml, evidenceHtml]) assert.match(html, /<script type="module" src="\.\/data-routes\.mjs"><\/script>/, "data routes load their bounded renderer");
assert.match(definitionsHtml, /id="definition-list"/);
assert.match(definitionsHtml, /generated artifact used by validation/);
assert.match(definitionsHtml, /These terms describe a bounded sequence of reviewed public reporting\. They never claim private evaluation activity, benchmark quality, or objective obsolescence\./);
assert.match(definitionsHtml, /When source coverage, lineage identity, successor order, or comparability is uncertain, the ledger uses an insufficient-evidence or quarantine state instead of advancing an omission count\./);
assert.match(shellSource, /localStorage\.getItem\("theme"\)/);
assert.match(shellSource, /button\.setAttribute\("aria-pressed"/);
assert.match(dataRoutesSource, /PAGE_SIZES = \[25, 50, 100\]/, "data routes offer only the approved page sizes");
assert.match(dataRoutesSource, /DEFAULT_PAGE_SIZE = 50/, "data routes default to 50 rows");
assert.match(dataRoutesSource, /window\.addEventListener\("popstate"/, "data routes restore browser back and forward state");
assert.match(dataRoutesSource, /history\.pushState/, "data route controls store meaningful state in the URL");
assert.match(dataRoutesSource, /rows: records\.slice\(start, start \+ pageSize\)/, "data routes render only the bounded current page");
assert.match(dataRoutesSource, /target: "_blank", rel: "noopener noreferrer"/, "external source links are safely isolated");
assert.match(dataRoutesSource, /safeSourceHref\(indexed, source\)/, "data routes revalidate corpus source links before rendering");
assert.doesNotMatch(dataRoutesSource, /innerHTML|insertAdjacentHTML/, "data routes render query and corpus text inertly");
assert.match(timelineSource, /from "\.\/core\.mjs"/, "timeline reuses shared data helpers");
assert.match(timelineSource, /const STATE_KEYS = \["q", "category", "lab", "from", "to", "release"\]/, "timeline serializes every supported state key");
assert.match(timelineSource, /this\.writeState\("pushState"\)/, "user timeline actions push allowlisted URL state");
assert.match(timelineSource, /addEventListener\("popstate"/, "timeline restores browser navigation state");
assert.match(timelineSource, /current\.searchParams\.forEach/, "fullscreen route link retains unrelated query state");
assert.match(timelineSource, /addEventListener\("focus"/, "keyboard focus updates the release preview");
assert.match(timelineSource, /addEventListener\("mouseenter"/, "hover updates the release preview");
assert.match(timelineSource, /aria-labelledby/, "pinned detail uses a labelled aside");
assert.match(timelineSource, /document\.fullscreenElement/, "Escape respects native browser fullscreen");
assert.match(timelineSource, /requestFullscreen/, "full timeline exposes browser fullscreen behavior");
assert.match(timelineSource, /target: "_blank", rel: "noopener noreferrer"/, "external source links are isolated");
assert.match(timelineSource, /node\.textContent = value/, "timeline creates text with textContent");
assert.doesNotMatch(timelineSource, /innerHTML|insertAdjacentHTML/, "timeline does not parse query or corpus text as markup");
assert.match(timelineSource, /sanitizeState\(candidate\)/, "timeline normalizes allowlisted URL state");
assert.match(timelineSource, /const MAX_QUERY_LENGTH = 160/, "timeline bounds query state");
assert.match(timelineSource, /safeSourceHref\(source\)/, "timeline revalidates corpus source links before rendering");
assert.match(timelineSource, /data\.releases\.length/, "timeline summary accounts for every release ID");
assert.match(cssSource, /prefers-reduced-motion: reduce/);
assert.match(cssSource, /:focus-visible\s*\{[^}]*outline:\s*3px solid var\(--accent\)/);
assert.match(cssSource, /\.timeline-host-compact\s*\{[^}]*height:\s*560px/);
assert.match(cssSource, /@media \(max-width: 767px\)[\s\S]*?\.timeline-host-compact\s*\{[^}]*height:\s*460px/);
assert.match(cssSource, /\.timeline-host:has\(> \.detail-panel-host:not\(\[hidden\]\)\)\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) minmax\(22rem, 0\.62fr\)/);
assert.match(cssSource, /\.timeline-host-full:fullscreen/);
assert.match(cssSource, /\.data-route-host\s*\{[^}]*min-height/);
assert.match(cssSource, /\.release-point\s*\{[^}]*pointer-events:\s*none/);
assert.match(cssSource, /@media \(max-width: 390px\)/);

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
assert.equal(sha256(jsonBytes), "a945abe22b49e9cd6d309aa47b2979f2a069691ff3d2da1411b10de4ac3c93f5", "JSON preservation anchor remains exact");
assert.equal(sha256(csvBytes), "29eeedcdc07e0992daeaea857db0c706fc96b6c1bd82bef7622ba05f8f49802a", "CSV preservation anchor remains exact");

console.log(JSON.stringify({
  result: "PASS",
  labs: fixture.labs.length,
  releases: fixture.releases.length,
  occurrences: fixture.occurrences.length,
  dense_release_occurrences: denseOccurrences.length,
  alias_filter: [...aliasMatches],
  category_alias_filter: [...categoryAliasMatches],
  routes: routes.size,
}));
