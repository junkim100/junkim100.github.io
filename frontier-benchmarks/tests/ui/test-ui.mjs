import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  COMBOBOX_OPTION_LIMIT,
  collisionRows,
  indexData,
  matchingBenchmarkIds,
  orderedReleaseOccurrences,
  timelineTicks,
  validateInterface,
} from "../../core.mjs";
import { DEFAULT_ZOOM, SEARCH_DEBOUNCE_MS, ZOOM_LEVELS, releaseDisplayLabels, sanitizeTimelineState } from "../../timeline.mjs";
import { fixture } from "./fixture.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const routeRoot = resolve(here, "../..");
const readText = (name) => readFile(resolve(routeRoot, name), "utf8");
const [indexHtml, timelineHtml, ledgerHtml, historyHtml, aboutHtml, definitionsHtml, timelineSource, shellSource, dataRoutesSource, coreSource, cssSource, readme, security, jsonBytes] = await Promise.all([
  readText("index.html"),
  readText("timeline.html"),
  readText("ledger.html"),
  readText("history.html"),
  readText("about.html"),
  readText("definitions.html"),
  readText("timeline.mjs"),
  readText("shell.mjs"),
  readText("data-routes.mjs"),
  readText("core.mjs"),
  readText("styles.css"),
  readText("README.md"),
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
assert.equal(sanitizeTimelineState({ zoom: "3" }, fixture).zoom, DEFAULT_ZOOM);
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

const pages = new Map([["landing", indexHtml], ["timeline", timelineHtml], ["ledger", ledgerHtml], ["history", historyHtml], ["about", aboutHtml]]);
const expectedLinks = {
  landing: ["./", "./", "./ledger.html", "./history.html", "./about.html"],
  timeline: ["./", "./timeline.html", "./ledger.html", "./history.html", "./about.html"],
  ledger: ["./", "./", "./ledger.html", "./history.html", "./about.html"],
  history: ["./", "./", "./ledger.html", "./history.html", "./about.html"],
  about: ["./", "./", "./ledger.html", "./history.html", "./about.html"],
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
  const themeToggle = header.match(/<button class="theme-toggle"[\s\S]*?<\/button>/)?.[0] || "";
  assert.match(themeToggle, /^<button class="theme-toggle" type="button" aria-label="Toggle dark mode" aria-pressed="false"><span class="theme-toggle-icon" aria-hidden="true">◐<\/span><\/button>$/);
  assert.doesNotMatch(themeToggle, />Theme</, `${route} theme toggle omits visible Theme text`);
}

assert.match(indexHtml, /<h1 id="page-title">Frontier Benchmark Observatory<\/h1>/);
assert.match(ledgerHtml, /<h1 id="page-title">Release Ledger<\/h1>/);
assert.match(historyHtml, /<h1 id="page-title">Benchmark History<\/h1>/);
for (const [name, contract] of [
  ["landing heading", /\.landing-timeline > h1\s*\{[^}]*font:\s*400 clamp\(1\.5rem, 6vw, 6\.5rem\)\/0\.9 var\(--display\)[^}]*white-space:\s*nowrap/],
  ["360px and 390px landing heading", /@media \(max-width: 480px\)[\s\S]*?\.landing-timeline > h1\s*\{[^}]*font-size:\s*1\.25rem/],
  ["Ledger and History headings", /\.route-intro h1\s*\{[^}]*font-size:\s*clamp\(2\.6rem, 6vw, 5\.5rem\)[^}]*white-space:\s*nowrap/],
  ["360px Ledger and History headings", /@media \(max-width: 390px\)[\s\S]*?\.route-intro h1\s*\{[^}]*font-size:\s*1\.75rem/],
]) assert.match(cssSource, contract, `${name} stays on one line at 360, 768, 1280, and 1920 CSS px`);
assert.match(cssSource, /\.theme-toggle\s*\{[^}]*width:\s*2\.4rem[^}]*height:\s*2\.4rem/);
assert.match(cssSource, /\.theme-toggle-icon\s*\{[^}]*font-size:\s*1rem/);
assert.match(indexHtml, /id="timeline-host" data-timeline-mode="compact"/);
assert.equal((indexHtml.match(/id="timeline-fullscreen-button"/g) || []).length, 1);
assert.match(indexHtml, /id="timeline-fullscreen-button" type="button" aria-pressed="false">Fullscreen<\/button>/);
assert.match(indexHtml, /<h1 id="page-title">Frontier Benchmark Observatory<\/h1>\s*<div class="landing-overview">[\s\S]*<div class="timeline-workspace landing-workspace" id="timeline-workspace"/);
assert.match(indexHtml, /<p class="landing-lead">An evidence-first, score-free record of which benchmarks six frontier AI labs name in reviewed first-party release materials, when those references appear, and the source behind each occurrence\.<\/p>/);
assert.match(indexHtml, /<aside class="landing-boundary" aria-labelledby="landing-boundary-title">\s*<h2 id="landing-boundary-title">A reporting record, not a leaderboard\.<\/h2>\s*<p>An omission means only that a benchmark was not found in the reviewed first-party source bundle\. It does not establish whether a lab ran an evaluation privately or elsewhere\.<\/p>/);
assert.match(indexHtml, /<dl class="landing-corpus-stats" aria-label="Fixed corpus counts">[\s\S]*<dt>Window<\/dt><dd>2024-01-01 to 2026-09-01<\/dd>[\s\S]*<dt>Labs<\/dt><dd>6<\/dd>[\s\S]*<dt>Releases<\/dt><dd>172<\/dd>[\s\S]*<dt>Benchmarks<\/dt><dd>869<\/dd>[\s\S]*<dt>Evidence occurrences<\/dt><dd>2,821<\/dd>[\s\S]*<dt>First-party sources<\/dt><dd>537<\/dd>/);
assert.doesNotMatch(indexHtml, /landing-intro|hero-intro|boundary-note|class="corpus-stats"|download-row|methodology|route-cards|<table\b/);
assert.match(cssSource, /\.landing-overview\s*\{[^}]*margin:\s*0 0 0\.8rem/);
assert.match(cssSource, /\.landing-boundary\s*\{[^}]*display:\s*grid[^}]*grid-template-columns:\s*minmax\(14rem,\s*0\.7fr\)\s*minmax\(18rem,\s*1\.3fr\)[^}]*border:\s*1px solid var\(--line-strong\)[^}]*background:\s*var\(--surface\)/);
assert.match(cssSource, /\.landing-corpus-stats\s*\{[^}]*display:\s*grid[^}]*grid-template-columns:\s*repeat\(6,\s*minmax\(0,\s*1fr\)\)[^}]*background:\s*var\(--line\)/);
assert.match(cssSource, /@media \(max-width: 767px\)[\s\S]*?\.landing-boundary\s*\{[^}]*grid-template-columns:\s*1fr[\s\S]*?\.landing-corpus-stats\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/);
assert.match(cssSource, /@media \(max-width: 390px\)[\s\S]*?\.landing-corpus-stats\s*\{[^}]*grid-template-columns:\s*1fr/);
assert.match(timelineHtml, /id="timeline-host" data-timeline-mode="full"/);
assert.doesNotMatch(timelineHtml, /fullscreen-button|Enter browser fullscreen/);
assert.match(ledgerHtml, /id="ledger-controls" data-route-controls="ledger"[\s\S]*id="ledger-host" data-route-view="ledger"/);
assert.match(historyHtml, /id="history-controls" data-route-controls="history"[\s\S]*id="history-host" data-route-view="history"/);

const forbiddenVisible = /observatory\.(?:json|csv)|Download JSON|Download CSV|Definitions|Overview|Public reporting research ledger|Continuous time|Expanded workspace|Full chronology workspace|Complete release denominator|Chronological reporting sequence|Methodology and coverage|View in Fullscreen/;
for (const [name, text] of [...pages, ["readme", readme], ["security", security]]) assert.doesNotMatch(text, forbiddenVisible, `${name} removes obsolete visible destinations and copy`);
assert.doesNotMatch(indexHtml, /href="\.\/evidence\.html"|href="\.\/definitions\.html"|download|methodology|route-cards|<table\b/);

assert.match(aboutHtml, /2024-01-01 through 2026-09-01/);
assert.match(aboutHtml, /first-party public materials/);
assert.match(aboutHtml, /score-free reporting record/);
assert.match(aboutHtml, /does not establish whether a lab evaluated the model privately or reported an evaluation elsewhere/);
assert.doesNotMatch(aboutHtml, /canonical definition|implementation version/i);
assert.match(definitionsHtml, /<meta http-equiv="refresh" content="0; url=\.\/about\.html"/);
assert.match(definitionsHtml, /<link rel="canonical" href="https:\/\/junkim100\.github\.io\/frontier-benchmarks\/about\.html"/);
assert.match(definitionsHtml, /<a href="\.\/about\.html">Continue to About<\/a>/);
assert.doesNotMatch(definitionsHtml, /<script\b/);

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
assert.match(dataRoutesSource, /text: "Source"/);
assert.doesNotMatch(dataRoutesSource, /innerHTML|insertAdjacentHTML/);

assert.match(timelineSource, /history\.state\?\.timelineScroll/);
assert.match(timelineSource, /payload\.timelineScroll = scroll/);
assert.match(timelineSource, /frame\.scrollLeft = frame\.scrollWidth - frame\.clientWidth/);
assert.match(timelineSource, /requestFullscreen\(\)/);
assert.match(timelineSource, /navigateToFallback\(\)/);
assert.match(timelineSource, /window\.location\.assign\(url\.href\)/);
assert.match(timelineSource, /text: "Source"/);
assert.match(timelineSource, /text: displayName/);
assert.doesNotMatch(timelineSource, /text: release\.id|Open exact first-party source|detail-release-id|Evaluation setup|Coverage review|Review date|Reporting state|Review state|Source type|Locator|Record/);
assert.doesNotMatch(timelineSource, /innerHTML|insertAdjacentHTML/);
assert.match(cssSource, /\.timeline-host-compact\s*\{[^}]*height:\s*560px/);
assert.match(cssSource, /@media \(max-width: 767px\)[\s\S]*?\.timeline-host-compact\s*\{[^}]*height:\s*460px/);
assert.match(cssSource, /\.timeline-frame\s*\{[^}]*overflow-y:\s*hidden/);
assert.match(cssSource, /\.timeline-lane\s*\{[^}]*height:\s*calc\(100% \/ 6\)/);
assert.match(cssSource, /prefers-reduced-motion: reduce/);
assert.match(cssSource, /:focus-visible\s*\{[^}]*outline:\s*3px solid var\(--accent\)/);

const production = validateInterface(JSON.parse(jsonBytes.toString("utf8")));
assert.deepEqual({ labs: production.labs.length, releases: production.releases.length, benchmarks: production.benchmarks.length, occurrences: production.occurrences.length, statuses: production.derived_statuses.length, sources: production.sources.length, definitions: production.canonical_definitions.length, quarantine: production.quarantine.length }, { labs: 6, releases: 172, benchmarks: 869, occurrences: 2821, statuses: 5593, sources: 537, definitions: 8, quarantine: 1 });
assert.equal(new Set(production.releases.map((release) => release.name)).size, 172, "current release names are unique");
assert.equal(jsonBytes.length, 11980016);
assert.equal(createHash("sha256").update(jsonBytes).digest("hex"), "a945abe22b49e9cd6d309aa47b2979f2a069691ff3d2da1411b10de4ac3c93f5");

console.log(JSON.stringify({ result: "PASS", labs: production.labs.length, releases: production.releases.length, occurrences: production.occurrences.length, statuses: production.derived_statuses.length, source_associations: production.occurrences.length, routes: pages.size }));
