import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  COMBOBOX_OPTION_LIMIT,
  captureCenterDate,
  captureTrackCenter,
  collisionRows,
  dateFromPosition,
  datePosition,
  historyPayload,
  indexData,
  liveCanonicalBenchmarks,
  matchingBenchmarkIds,
  normalize,
  orderedReleaseOccurrences,
  restoreCenterDate,
  scrollToNewest,
  sourceDisclosure,
  timelineTicks,
  trackGeometry,
  validateInterface,
} from "../../core.mjs";
import { DEFAULT_ZOOM, SEARCH_DEBOUNCE_MS, ZOOM_LEVELS, releaseDisplayLabels, sanitizeTimelineState } from "../../timeline.mjs";
import {
  DEFAULT_BENCHMARK_ID,
  MAX_SELECTIONS,
  laneOccurrences,
  parseBenchmarkState,
  rankBenchmarks,
  releaseMatches,
  sanitizeBenchmarkIds,
  serializeBenchmarkState,
  transitionBenchmarkSelection,
} from "../../trends.mjs";
import { fixture } from "./fixture.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const routeRoot = resolve(here, "../..");
const readText = (name) => readFile(resolve(routeRoot, name), "utf8");
const [indexHtml, timelineHtml, ledgerHtml, historyHtml, aboutHtml, definitionsHtml, timelineSource, trendsSource, shellSource, dataRoutesSource, coreSource, cssSource, security, jsonBytes] = await Promise.all([
  readText("index.html"),
  readText("timeline.html"),
  readText("ledger.html"),
  readText("history.html"),
  readText("about.html"),
  readText("definitions.html"),
  readText("timeline.mjs"),
  readText("trends.mjs"),
  readText("shell.mjs"),
  readText("data-routes.mjs"),
  readText("core.mjs"),
  readText("styles.css"),
  readText("SECURITY.md"),
  readFile(resolve(routeRoot, "public/observatory.json")),
]);

for (const deleted of ["evidence.html", "app.mjs", "public/observatory.csv", ".gitattributes"]) {
  await assert.rejects(access(resolve(routeRoot, deleted)), { code: "ENOENT" }, `${deleted} is removed`);
}

validateInterface(fixture);
const indexed = indexData(fixture);
assert.deepEqual(fixture.labs.map((lab) => lab.name), ["OpenAI", "Anthropic", "Google DeepMind", "Meta", "DeepSeek", "Qwen"]);
assert.equal(fixture.corpus.publication_window.start, "2024-01-01");
assert.equal(fixture.corpus.publication_window.end, "2026-09-01");
assert.ok(fixture.releases.some((release) => release.publication_date === "2024-01-01"));
assert.ok(fixture.releases.some((release) => release.publication_date === "2026-09-01"));

const aliasMatches = matchingBenchmarkIds(indexed, "CH tasks", "");
assert.deepEqual([...aliasMatches], ["code_harbor"]);
assert.deepEqual([...matchingBenchmarkIds(indexed, "", "multimodal")], ["vision_compass"]);
assert.deepEqual(ZOOM_LEVELS, [1, 2, 4]);
assert.equal(DEFAULT_ZOOM, 1);
assert.equal(SEARCH_DEBOUNCE_MS, 150);
assert.equal(COMBOBOX_OPTION_LIMIT, 50);

const sanitizedState = sanitizeTimelineState({
  q: `  <img src=x onerror=alert(1)>${"x".repeat(200)}  `,
  category: "not-a-category",
  lab: "not-a-lab",
  from: "2099-01-01",
  to: "1900-01-01",
  zoom: "not-a-zoom",
  release: "not-a-release",
  unknown: "must-not-survive",
}, fixture);
assert.equal(sanitizedState.q.length, 160);
assert.equal(sanitizedState.q.startsWith("<img src=x"), true);
assert.deepEqual({ ...sanitizedState, q: "" }, { q: "", category: "", lab: "", from: "", to: "", zoom: DEFAULT_ZOOM, release: "" });
assert.equal(Object.hasOwn(sanitizedState, "unknown"), false);
assert.equal(sanitizeTimelineState({ zoom: "2" }, fixture).zoom, 2);
for (const zoom of [1, 1.5, 2, 2.5, 3, 4]) assert.equal(sanitizeTimelineState({ zoom: String(zoom) }, fixture).zoom, zoom);
assert.equal(sanitizeTimelineState({ from: "2024-02-30" }, fixture).from, "");
assert.deepEqual(sanitizeTimelineState({ from: "2024-08-01", to: "2024-02-01" }, fixture), { q: "", category: "", lab: "", from: "", to: "", zoom: DEFAULT_ZOOM, release: "" });

const displayLabels = releaseDisplayLabels(fixture.releases);
fixture.releases.forEach((release) => assert.equal(displayLabels.get(release.id), release.name));
const duplicateLabels = releaseDisplayLabels([
  { id: "one", name: "Same", publication_date: "2025-01-01" },
  { id: "two", name: "Same", publication_date: "2025-02-01" },
  { id: "three", name: "Unique", publication_date: "2025-03-01" },
]);
assert.equal(duplicateLabels.get("one"), "Same (2025-01-01)");
assert.equal(duplicateLabels.get("two"), "Same (2025-02-01)");
assert.equal(duplicateLabels.get("three"), "Unique");

const denseRelease = fixture.releases.find((release) => (indexed.occurrencesByRelease.get(release.id) || []).length >= 6);
assert.equal(orderedReleaseOccurrences(indexed, denseRelease.id).length, 6);
assert.equal(fixture.releases.reduce((total, release) => total + orderedReleaseOccurrences(indexed, release.id).length, 0), fixture.occurrences.length, "selected releases expose every occurrence association");
const ticks = timelineTicks("2024-01-01", "2026-09-01", 8);
assert.equal(ticks[0], "2024-01-01");
assert.ok(ticks.length >= 8);
assert.deepEqual(collisionRows([0, 12, 24, 225], 200), [0, 1, 2, 0]);

const benchmarkCatalog = [
  { id: "zulu", name: "Zulu", aliases: [] },
  { id: "alpha", name: "Álpha-Test", aliases: [] },
  { id: "beta", name: "Beta", aliases: [] },
  { id: "charlie", name: "Charlie", aliases: [] },
  { id: "delta", name: "Delta", aliases: [] },
  { id: "echo", name: "Echo", aliases: [] },
  { id: "foxtrot", name: "Foxtrot", aliases: [] },
];
assert.deepEqual(sanitizeBenchmarkIds(["zulu", "alpha", "unknown", "zulu", "beta", "charlie", "delta", "echo", "foxtrot"], benchmarkCatalog), ["alpha", "beta", "charlie", "delta", "echo", "zulu"], "selection sanitation deduplicates, drops invalid IDs, caps at six, and canonicalizes by name");
assert.deepEqual(sanitizeBenchmarkIds(["zulu_id", "alpha_id"], [{ id: "alpha_id", name: "A-B" }, { id: "zulu_id", name: "A B" }]), ["alpha_id", "zulu_id"], "normalized canonical-name collisions break ties by canonical ID");
assert.deepEqual(parseBenchmarkState("?q=discard&benchmark=zulu&benchmark=alpha&benchmark=unknown&lab=discard", benchmarkCatalog), ["alpha", "zulu"], "only repeated canonical benchmark state survives parsing");
assert.equal(serializeBenchmarkState(["alpha", "zulu"]), "?benchmark=alpha&benchmark=zulu");
assert.deepEqual(parseBenchmarkState("?benchmark=unknown", benchmarkCatalog, "beta"), ["beta"], "malformed state falls back deterministically");
assert.equal(MAX_SELECTIONS, 6);
assert.equal(DEFAULT_BENCHMARK_ID, "benchmark_terminal_bench_2_0");
assert.deepEqual(transitionBenchmarkSelection(["alpha"], "alpha", benchmarkCatalog), { ids: ["alpha"], outcome: "final" }, "the final benchmark cannot be removed");
assert.deepEqual(transitionBenchmarkSelection(["alpha", "beta"], "alpha", benchmarkCatalog), { ids: ["beta"], outcome: "removed" }, "an already-selected benchmark toggles off when another remains");
assert.deepEqual(transitionBenchmarkSelection(["zulu"], "alpha", benchmarkCatalog), { ids: ["alpha", "zulu"], outcome: "added" }, "added selections are canonicalized");
assert.deepEqual(transitionBenchmarkSelection(["alpha", "beta", "charlie", "delta", "echo", "foxtrot"], "zulu", benchmarkCatalog), { ids: ["alpha", "beta", "charlie", "delta", "echo", "foxtrot"], outcome: "limit" }, "the six-selection cap does not mutate state");
assert.equal(normalize("  Café—TEST__v2  "), "cafe test v2", "NFKD, case, punctuation, hyphen, and whitespace normalization is shared");
const rankingCatalog = [
  { id: "exact", name: "Pha Be", aliases: [] },
  { id: "alias_exact", name: "Zulu Alias", aliases: ["Pha Be"] },
  { id: "prefix", name: "Pha Be Plus", aliases: [] },
  { id: "tokens", name: "Beta Phalanx", aliases: [] },
  { id: "substring", name: "Alpha Beta", aliases: [] },
  { id: "alias_tokens", name: "Alias Tokens", aliases: ["Beta Phalanx"] },
];
assert.deepEqual(rankBenchmarks(rankingCatalog, "pha be").map(({ id }) => id), ["exact", "alias_exact", "prefix", "tokens", "alias_tokens", "substring"], "exact, alias, prefix, all-token-prefix, and contiguous substring tiers are deterministic");
const provenanceRankingCases = [
  {
    label: "exact",
    query: "omega exact",
    catalog: [
      { id: "canonical_z", name: "Omega Exact", aliases: [] },
      { id: "canonical_a", name: "Omega Exact", aliases: [] },
      { id: "alias", name: "A Alias Holder", aliases: ["Omega Exact"] },
    ],
    expected: ["canonical_a", "canonical_z", "alias"],
  },
  {
    label: "name prefix",
    query: "omega pre",
    catalog: [
      { id: "canonical_z", name: "Omega Prefix Zulu", aliases: [] },
      { id: "canonical_a", name: "Omega Prefix Alpha", aliases: [] },
      { id: "alias", name: "A Alias Holder", aliases: ["Omega Prefix Alias"] },
    ],
    expected: ["canonical_a", "canonical_z", "alias"],
  },
  {
    label: "token prefix",
    query: "ome can",
    catalog: [
      { id: "canonical_z", name: "Omega Canonical Zulu", aliases: [] },
      { id: "canonical_a", name: "Canonical Omega Alpha", aliases: [] },
      { id: "alias", name: "A Alias Holder", aliases: ["Omega Canonical Alias"] },
    ],
    expected: ["canonical_a", "canonical_z", "alias"],
  },
  {
    label: "substring",
    query: "mega beta",
    catalog: [
      { id: "canonical_z", name: "Omega Beta Zulu", aliases: [] },
      { id: "canonical_a", name: "Omega Beta Alpha", aliases: [] },
      { id: "alias", name: "A Alias Holder", aliases: ["Omega Beta Alias"] },
    ],
    expected: ["canonical_a", "canonical_z", "alias"],
  },
];
for (const { label, query, catalog, expected } of provenanceRankingCases) {
  assert.deepEqual(rankBenchmarks(catalog, query).map(({ id }) => id), expected, `canonical-name provenance wins within the ${label} class before stable canonical name and ID tie-breaks`);
}
const pages = new Map([["landing", indexHtml], ["timeline", timelineHtml], ["ledger", ledgerHtml], ["history", historyHtml], ["about", aboutHtml]]);
const expectedLinks = {
  landing: ["./", "./", "./timeline.html", "./ledger.html", "./history.html", "./about.html"],
  timeline: ["./", "./", "./timeline.html", "./ledger.html", "./history.html", "./about.html"],
  ledger: ["./", "./", "./timeline.html", "./ledger.html", "./history.html", "./about.html"],
  history: ["./", "./", "./timeline.html", "./ledger.html", "./history.html", "./about.html"],
  about: ["./", "./", "./timeline.html", "./ledger.html", "./history.html", "./about.html"],
};
for (const [route, html] of pages) {
  const csp = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)"/)?.[1] || "";
  assert.match(html, /<a class="skip-link" href="#main">Skip to content<\/a>/);
  assert.match(html, /<header class="site-header">/);
  assert.match(html, /<nav class="primary-nav" aria-label="Observatory">/);
  assert.match(html, /<main id="main"/);
  assert.doesNotMatch(html, /<footer\b/);
  assert.match(html, /<script type="module" src="\.\/shell\.mjs"><\/script>/);
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /script-src 'self'/);
  assert.doesNotMatch(csp, /https:|unsafe-eval|\*/);
  const header = html.match(/<header class="site-header">[\s\S]*?<\/header>/)?.[0] || "";
  const hrefs = [...header.matchAll(/href="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(hrefs, expectedLinks[route], `${route} header contains only the approved links`);
  assert.match(header, /<nav class="primary-nav" aria-label="Observatory"><ul><li><a[^>]*>Benchmarks<\/a><\/li><li><a[^>]*>Releases<\/a><\/li><li><a[^>]*>Release ledger<\/a><\/li><li><a[^>]*>Reporting history<\/a><\/li><li><a[^>]*>About<\/a><\/li><\/ul><\/nav>/);
  const themeToggle = header.match(/<button class="theme-toggle"[\s\S]*?<\/button>/)?.[0] || "";
  assert.match(themeToggle, /^<button class="theme-toggle" type="button" aria-label="Toggle dark mode" aria-pressed="false"><span class="theme-toggle-icon" aria-hidden="true">◐<\/span><\/button>$/);
  assert.doesNotMatch(themeToggle, />Theme</, `${route} theme toggle omits visible Theme text`);
}

assert.match(indexHtml, /<h1 id="page-title">Which benchmarks do models publicly report\?<\/h1>/);
assert.match(ledgerHtml, /<h1 id="page-title">Release Ledger<\/h1>/);
assert.match(historyHtml, /<h1 id="page-title">Reporting History<\/h1>/);
assert.match(cssSource, /\.landing-timeline > h1\s*\{[^}]*max-width:\s*18ch[^}]*font:\s*400 clamp\(2\.5rem, 7vw, 6\.5rem\)\/0\.92 var\(--display\)/);
assert.match(cssSource, /@media \(max-width: 480px\)[\s\S]*?\.landing-timeline > h1\s*\{[^}]*font-size:\s*2\.35rem/);
assert.match(cssSource, /\.route-intro h1\s*\{[^}]*font-size:\s*clamp\(2\.6rem, 6vw, 5\.5rem\)[^}]*overflow-wrap:\s*normal[^}]*white-space:\s*nowrap/);
assert.match(cssSource, /@media \(max-width: 390px\)[\s\S]*?\.route-intro h1\s*\{[^}]*font-size:\s*2rem/);
assert.match(cssSource, /\.theme-toggle\s*\{[^}]*width:\s*2\.75rem[^}]*height:\s*2\.75rem/);
assert.match(cssSource, /\.theme-toggle-icon\s*\{[^}]*font-size:\s*1rem/);
assert.match(indexHtml, /id="trends-picker"/);
assert.match(indexHtml, /id="trends-chart" role="region" aria-label="Benchmark chronology chart"/);
assert.match(indexHtml, /<script type="module" src="\.\/trends\.mjs"><\/script>/);
assert.match(timelineHtml, /<title>Releases \| Frontier Benchmark Observatory<\/title>/);
assert.match(timelineHtml, /<h1 id="page-title" class="route-title">Releases<\/h1>/);
assert.match(indexHtml, /<h1 id="page-title">Which benchmarks do models publicly report\?<\/h1>[\s\S]*<section class="trends-workspace"/);
assert.match(indexHtml, /<p class="landing-lead">A bounded record of public reporting, not a performance comparison\.<\/p>/);
assert.match(indexHtml, /<aside class="landing-boundary" aria-labelledby="landing-boundary-title">\s*<h2 id="landing-boundary-title">Coverage is bounded and incomplete\.<\/h2>\s*<p>A missing or withheld record does not show that an evaluation was not run\. <a href="\.\/about\.html#coverage">Read About and coverage limitations\.<\/a><\/p>/);
assert.match(indexHtml, /<dl class="landing-corpus-stats" id="landing-corpus-summary" aria-label="Generated corpus counts">\s*<div><dt>Status<\/dt><dd>Loading generated counts<\/dd><\/div>\s*<\/dl>/);
assert.doesNotMatch(indexHtml, /<dt>Releases<\/dt>|<dt>Canonical benchmarks<\/dt>|download-row|route-cards|<table\b/);
assert.match(trendsSource, /renderSummary\(\)[\s\S]*\["Canonical benchmarks", canonical\.toLocaleString\("en"\)\][\s\S]*\["Retained occurrences", retained\.toLocaleString\("en"\)\][\s\S]*\["Releases", data\.releases\.length\.toLocaleString\("en"\)\][\s\S]*Raw, merged and withheld counts/);
assert.match(cssSource, /\.landing-overview\s*\{[^}]*margin:\s*0 0 1\.5rem/);
assert.match(cssSource, /\.landing-boundary\s*\{[^}]*display:\s*grid[^}]*grid-template-columns:\s*minmax\(14rem,\s*0\.7fr\)\s*minmax\(18rem,\s*1\.3fr\)[^}]*border:\s*1px solid var\(--line-strong\)[^}]*background:\s*var\(--surface\)/);
assert.match(cssSource, /\.landing-corpus-stats\s*\{[^}]*display:\s*grid[^}]*grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)\s*minmax\(18rem,\s*1\.5fr\)[^}]*background:\s*var\(--line\)/);
assert.match(cssSource, /@media \(max-width: 767px\)[\s\S]*?\.landing-boundary\s*\{[^}]*grid-template-columns:\s*1fr[\s\S]*?\.landing-corpus-stats\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/);
assert.match(timelineHtml, /id="timeline-host" data-timeline-mode="full"/);
assert.doesNotMatch(timelineHtml, /fullscreen-button|Enter browser fullscreen/);
assert.match(ledgerHtml, /id="ledger-controls" data-route-controls="ledger"[\s\S]*id="ledger-host" data-route-view="ledger"/);
assert.match(historyHtml, /id="history-controls" data-route-controls="history"[\s\S]*id="history-host" data-route-view="history"/);

for (const [name, html] of [...pages, ["definitions", definitionsHtml]]) {
  assert.doesNotMatch(html, /href="\.\/evidence\.html"|href="\.\/public\/observatory\.csv"|<a[^>]+\bdownload\b|>Scores?<\/|Download (?:JSON|CSV)/, `${name} exposes no scores, downloads, CSV, or Evidence route`);
}
assert.match(security, /DOM text APIs, not HTML parsing APIs/);
assert.match(security, /First-party Source links are rechecked before rendering/);

assert.match(aboutHtml, /2024-01-01 through the fixed intake cutoff/);
assert.match(aboutHtml, /first-party public materials/);
assert.match(aboutHtml, /score-free reporting record/);
assert.match(aboutHtml, /does not establish whether a lab evaluated the model privately or reported an evaluation elsewhere/);
assert.match(aboutHtml, /id="reporting-definitions"[\s\S]*id="about-data-status"[^>]*role="status"[^>]*aria-live="polite"[\s\S]*id="definition-list-generated"/);
assert.match(shellSource, /definitions\.replaceChildren\(\.\.\.data\.canonical_definitions\.map\(definitionArticle\)\)/);
assert.match(shellSource, /data\.canonical_definitions\.length} reporting definitions loaded from generated data/);
assert.match(definitionsHtml, /<link rel="canonical" href="https:\/\/junkim100\.github\.io\/frontier-benchmarks\/about\.html"/);
assert.match(definitionsHtml, /<a id="definitions-continue" href="\.\/about\.html#reporting-definitions">Continue to About<\/a>/);
assert.match(definitionsHtml, /<noscript><p>Automatic definition mapping requires JavaScript\. The manual link opens all reporting definitions\.<\/p><\/noscript>/);
assert.match(definitionsHtml, /<script type="module" src="\.\/shell\.mjs"><\/script>/);
assert.doesNotMatch(definitionsHtml, /http-equiv="refresh"/);

assert.match(shellSource, /localStorage\.getItem\("theme"\)/);
assert.match(shellSource, /button\.setAttribute\("aria-pressed"/);
assert.match(coreSource, /role", "combobox"/);
assert.match(coreSource, /role", "listbox"/);
assert.match(coreSource, /role", "option"/);
assert.match(coreSource, /aria-activedescendant/);
for (const key of ["ArrowDown", "ArrowUp", "Home", "End", "Enter", "Escape"]) assert.ok(coreSource.includes(`"${key}"`));
assert.match(coreSource, /slice\(0, COMBOBOX_OPTION_LIMIT\)/);
assert.match(dataRoutesSource, /SEARCH_DEBOUNCE_MS = 150/);
assert.match(dataRoutesSource, /addEventListener\("input"/);
assert.doesNotMatch(dataRoutesSource, /Apply search|type: "submit"|route === "evidence"/);
assert.match(dataRoutesSource, /window\.addEventListener\("popstate"/);
assert.match(dataRoutesSource, /"aria-sort"/);
assert.match(dataRoutesSource, /sourceDisclosure\(this\.indexed, record\.occurrence\)/);
assert.doesNotMatch(dataRoutesSource, /innerHTML|insertAdjacentHTML/);

assert.match(timelineSource, /historyPayload\(window\.history\.state, this\.state, "timeline", focusedId\)/);
assert.match(trendsSource, /historyPayload\(window\.history\.state, this\.state, "trends", focusedId\)/);
assert.match(timelineSource, /captureTrackCenter\(frame, track, label, start, end\)/);
assert.match(trendsSource, /captureTrackCenter\(frame, track, label, start, end\)/);
assert.match(timelineSource, /scrollToNewest\(frame\)/);
assert.match(timelineSource, /this\.restoringViewport = true/);
assert.match(timelineSource, /if \(this\.restoringViewport \|\| !this\.indexed\) return this\.state\.center/);
assert.match(trendsSource, /this\.restoringViewport = true/);
assert.match(trendsSource, /if \(this\.restoringViewport \|\| !this\.indexed\) return this\.state\.center/);
assert.doesNotMatch(timelineSource, /requestFullscreen\(\)|navigateToFallback\(\)|window\.location\.assign\(url\.href\)/);
assert.match(timelineSource, /sourceDisclosure\(this\.indexed, occurrence\)/);
assert.match(trendsSource, /sourceDisclosure\(this\.indexed, occurrence\)/);
assert.doesNotMatch(timelineSource, /innerHTML|insertAdjacentHTML/);
for (const key of ["ArrowDown", "ArrowUp", "Home", "End", "Enter", "Escape", "Backspace"]) assert.ok(trendsSource.includes(`"${key}"`), `Benchmarks handles ${key}`);
assert.match(trendsSource, /addEventListener\("blur"/);
assert.match(trendsSource, /aria-live/);
assert.match(trendsSource, /aria-multiselectable/);
assert.match(trendsSource, /data-occurrence-id/);
assert.doesNotMatch(trendsSource, /innerHTML|insertAdjacentHTML/);
assert.match(timelineHtml, /id="timeline-host"[\s\S]*id="release-detail-host" aria-label="Evidence inspector" hidden/);
assert.match(indexHtml, /<div class="trends-layout">\s*<div class="trends-chart-host"[\s\S]*<aside class="trends-detail-host" id="trends-detail" aria-label="Evidence inspector" hidden><\/aside>\s*<\/div>/);
assert.match(cssSource, /\.trends-layout\s*\{[^}]*display:\s*grid[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/);
assert.match(cssSource, /\.timeline-frame\s*\{[^}]*overflow-x:\s*auto[^}]*overflow-y:\s*visible/);
assert.match(cssSource, /\.timeline-lane\s*\{[^}]*height:\s*7rem/);
assert.match(cssSource, /body\s*\{[^}]*overflow-wrap:\s*anywhere[^}]*\}/);
assert.doesNotMatch(cssSource, /body\s*\{[^}]*\boverflow\s*:\s*hidden/);
assert.match(cssSource, /\.timeline-route-main\s*\{[^}]*min-height:\s*calc\(100dvh - 3\.75rem\)/);
assert.match(trendsSource, /label: "Discovery category"/);
assert.match(trendsSource, /field\("Lab", lab\)/);
assert.match(trendsSource, /field\("From reporting date", from\)/);
assert.match(trendsSource, /field\("To reporting date", to\)/);
assert.match(trendsSource, /"aria-label": "Zoom"/);
assert.match(trendsSource, /text: "Reset"/);
assert.match(cssSource, /prefers-reduced-motion: reduce/);
assert.match(cssSource, /animation-duration:\s*0\.01ms/);
assert.match(cssSource, /:focus-visible\s*\{[^}]*outline:\s*3px solid var\(--accent\)/);
assert.match(cssSource, /\.trends-chip button\s*\{[^}]*width:\s*2\.75rem[^}]*min-height:\s*2\.75rem/);
assert.match(cssSource, /\.detail-close\s*\{[^}]*width:\s*2\.75rem[^}]*min-height:\s*2\.75rem/);
assert.match(cssSource, /\.trends-options \[role="option"\]\s*\{[^}]*min-height:\s*2\.75rem/);
assert.match(cssSource, /\.trends-marker\s*\{[^}]*min-height:\s*2\.75rem/);

const production = validateInterface(JSON.parse(jsonBytes.toString("utf8")));
const productionIndex = indexData(production);
assert.deepEqual({ labs: production.labs.length, releases: production.releases.length, benchmarks: production.benchmarks.length, occurrences: production.occurrences.length, statuses: production.derived_statuses.length, sources: production.sources.length, definitions: production.canonical_definitions.length, quarantine: production.quarantine.length }, { labs: 6, releases: 173, benchmarks: 873, occurrences: 2824, statuses: 3104, sources: 539, definitions: 8, quarantine: 1 });
assert.equal(rankBenchmarks(liveCanonicalBenchmarks(production.benchmarks), "").length, 807, "an empty query exposes the live canonical benchmark denominator");
assert.equal(normalize("HumanEval+"), "humaneval plus");
assert.equal(dateFromPosition(datePosition("2025-06-15", "2024-01-01", "2026-09-01"), "2024-01-01", "2026-09-01"), "2025-06-15");
const v2Payload = historyPayload({ router: { sequence: 4 }, observatory: { stale: true } }, { center: "2025-06-15T12:34:56.789Z" }, "timeline", production.releases[0].id);
assert.deepEqual(v2Payload, { router: { sequence: 4 }, observatory: { version: 2, centerInstant: "2025-06-15T12:34:56.789Z", chronologicalIntent: "center", route: "timeline", focusedId: production.releases[0].id } });
const geometryFrame = {
  scrollLeft: 400,
  scrollWidth: 2000,
  clientWidth: 500,
  clientLeft: 1,
  getBoundingClientRect() { return { left: 100, right: 602, width: 502 }; },
};
const geometryTrack = {
  getBoundingClientRect() {
    const left = 301 - geometryFrame.scrollLeft;
    return { left, right: left + 1700, width: 1700 };
  },
};
const geometryLabel = { getBoundingClientRect() { return { left: 101, right: 221, width: 120 }; } };
assert.deepEqual(trackGeometry(geometryFrame, geometryTrack, geometryLabel), { trackLeft: 200, trackWidth: 1700, viewportLeft: 520, viewportWidth: 380, maxScroll: 1500 });
assert.match(captureTrackCenter(geometryFrame, geometryTrack, geometryLabel, "2024-01-01", "2026-09-08"), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
const restoredFrame = { scrollWidth: 4000, clientWidth: 800, scrollLeft: 0 };
restoreCenterDate(restoredFrame, "2025-01-24", "2024-01-01", "2026-09-01");
assert.equal(captureCenterDate(restoredFrame, "2024-01-01", "2026-09-01"), "2025-01-24");
assert.ok(restoredFrame.scrollLeft > 0 && restoredFrame.scrollLeft < restoredFrame.scrollWidth - restoredFrame.clientWidth);
restoreCenterDate(restoredFrame, "2020-01-01", "2024-01-01", "2026-09-01");
assert.equal(restoredFrame.scrollLeft, 0);
restoreCenterDate(restoredFrame, "2029-01-01", "2024-01-01", "2026-09-01");
assert.equal(restoredFrame.scrollLeft, 3200);
scrollToNewest(restoredFrame);
assert.equal(restoredFrame.scrollLeft, 3200);
const terminalCounts = new Map(["benchmark_terminal_bench", "benchmark_terminal_bench_2_0", "benchmark_terminal_bench_2_1"].map((id) => [id, production.occurrences.filter((occurrence) => occurrence.benchmark_id === id && occurrence.review_status === "verified").length]));
assert.deepEqual(Object.fromEntries(terminalCounts), { benchmark_terminal_bench: 7, benchmark_terminal_bench_2_0: 12, benchmark_terminal_bench_2_1: 6 });
assert.equal(production.benchmarks.some((benchmark) => benchmark.id === "benchmark_terminal_bench_3_0"), true, "canonical Terminal-Bench 3.0 is present");
assert.equal(production.benchmarks.some((benchmark) => benchmark.id === "benchmark_terminal_bench_4_0" || ["terminal bench 4 0"].includes(normalize(benchmark.name))), true, "canonical Terminal-Bench 4.0 is present");
assert.equal(production.recent_model_counts.label, "models in latest 90 days");
assert.equal(production.recent_model_counts.window.inclusive_days, 90);
assert.equal(production.recent_model_counts.counts.length, 807);
class DisclosureNode {
  constructor(tagName = "") {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.attributes = new Map();
    this._text = "";
  }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map((child) => child.textContent).join(""); }
  append(...children) { this.children.push(...children.map((child) => typeof child === "string" ? new DisclosureText(child) : child)); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
}
class DisclosureText extends DisclosureNode {
  constructor(text) {
    super("#text");
    this._text = String(text);
  }
}
const originalDocument = globalThis.document;
globalThis.document = {
  createElement(name) { return new DisclosureNode(name); },
  createTextNode(text) { return new DisclosureText(text); },
};
const disclosedOccurrence = production.occurrences.find((occurrence) => occurrence.review_status === "verified" && occurrence.summary);
const disclosure = sourceDisclosure(productionIndex, disclosedOccurrence);
const disclosureLinks = (node) => (node.tagName === "A" ? [node] : []).concat(...node.children.map(disclosureLinks));
assert.equal(disclosure.tagName, "ARTICLE");
assert.equal(disclosure.textContent.includes(disclosedOccurrence.summary), true);
assert.equal(disclosure.textContent.includes(`Exact stored URL: ${productionIndex.sources.get(disclosedOccurrence.source_id).url}`), true);
assert.equal(disclosure.textContent.includes(`Locator: ${disclosedOccurrence.locator.kind}: ${disclosedOccurrence.locator.value}`), true);
assert.equal(disclosureLinks(disclosure)[0].getAttribute("href"), productionIndex.sources.get(disclosedOccurrence.source_id).url);
if (originalDocument === undefined) delete globalThis.document;
else globalThis.document = originalDocument;
const selectedTerminalIds = [...terminalCounts.keys()];
const terminalMatches = releaseMatches(productionIndex, selectedTerminalIds);
const expectedTerminalReleaseIds = new Set(production.occurrences.filter((occurrence) => selectedTerminalIds.includes(occurrence.benchmark_id) && occurrence.review_status === "verified").map((occurrence) => occurrence.release_id));
assert.deepEqual(new Set(terminalMatches.map(({ release }) => release.id)), expectedTerminalReleaseIds, "trend release inclusion is the exact OR union of selected occurrences");
for (const benchmarkId of selectedTerminalIds) {
  const expectedOccurrences = production.occurrences.filter((occurrence) => occurrence.benchmark_id === benchmarkId && occurrence.review_status === "verified").map((occurrence) => occurrence.id).sort();
  assert.deepEqual(laneOccurrences(terminalMatches, benchmarkId).map(({ occurrence }) => occurrence.id).sort(), expectedOccurrences, `${benchmarkId} lane preserves every exact occurrence without collision loss`);
}
const duplicatedOccurrence = { ...fixture.occurrences[0], id: `${fixture.occurrences[0].id}_duplicate` };
const collisionData = { ...fixture, occurrences: [...fixture.occurrences, duplicatedOccurrence] };
const collisionMatches = releaseMatches(indexData(collisionData), [duplicatedOccurrence.benchmark_id]);
assert.equal(laneOccurrences(collisionMatches, duplicatedOccurrence.benchmark_id).filter(({ match }) => match.release.id === duplicatedOccurrence.release_id).length, 2, "same release, benchmark, and date occurrences remain separately represented");
assert.equal(new Set(production.releases.map((release) => release.name)).size, 173, "current release names are unique");
assert.equal(jsonBytes.length, 19036515);
assert.equal(createHash("sha256").update(jsonBytes).digest("hex"), "aa18a2ca4b91034f0a1bee0279ebd727c2a07527baf67398ad7fcad11407559b");

console.log(JSON.stringify({ result: "PASS", labs: production.labs.length, releases: production.releases.length, occurrences: production.occurrences.length, statuses: production.derived_statuses.length, source_associations: production.occurrences.length, routes: pages.size }));
