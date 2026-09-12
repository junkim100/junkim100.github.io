import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { test } from "node:test";

// Non-rendering Happy DOM is supplied by the verification workspace, not shipped to users.
// node tests/ui/test-repair-dom.mjs /absolute/path/to/happy-dom/lib/index.js
const { Window } = await import(pathToFileURL(resolve(process.argv[2])).href);
const app = new URL("../../", import.meta.url);
const data = JSON.parse(await readFile(new URL("public/observatory.json", app), "utf8"));
const wait = () => new Promise((done) => setTimeout(done, 80));
async function setup(route, query = "?v=2&center=2025-06-15T12%3A34%3A56.789Z") {
  const w = new Window({ url: `https://candidate.invalid/frontier-benchmarks/${route}.html${query}`, console: { ...console, error() {} }, settings: { disableJavaScriptFileLoading: true, disableCSSFileLoading: true, enableJavaScriptEvaluation: false, handleDisabledFileLoadingAsSuccess: true, navigation: { disableMainFrameNavigation: true, disableChildFrameNavigation: true, disableChildPageNavigation: true } } });
  for (const key of ["window", "document", "history", "location", "localStorage", "sessionStorage", "navigator", "HTMLElement", "HTMLInputElement", "HTMLSelectElement", "Element", "Node", "Event", "CustomEvent", "KeyboardEvent", "MouseEvent", "PointerEvent", "ResizeObserver", "DOMException", "CSS"]) Object.defineProperty(globalThis, key, { configurable: true, value: key === "window" ? w : w[key] });
  for (const key of ["requestAnimationFrame", "cancelAnimationFrame", "getComputedStyle", "matchMedia"]) globalThis[key] = w[key].bind(w);
  w.document.write((await readFile(new URL(`${route}.html`, app), "utf8")).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ""));
  return w;
}
for (const mode of ["network", "json", "schema"]) {
  test(`About: ${mode} failure, repeated retry, successful recovery and focus/state`, async () => {
    const w = await setup("about");
    const originalURL = w.location.href;
    let calls = 0, resolveFetch;
    globalThis.fetch = w.fetch = async () => {
      calls += 1;
      if (calls === 3) await new Promise((done) => { resolveFetch = done; });
      if (calls <= 2 && mode === "network") throw new Error("Test network failure");
      return { ok: true, json: async () => {
        if (calls <= 2 && mode === "json") throw new SyntaxError("Test malformed JSON");
        return calls <= 2 && mode === "schema" ? { corpus: {} } : data;
      } };
    };
    await import(new URL(`shell.mjs?about-repair=${mode}`, app)); await wait();
    const status = w.document.querySelector("#about-data-status");
    const staticText = w.document.querySelector("#generated-limitations").textContent;
    assert.match(staticText, /bounded and incomplete/);
    assert.equal(status.getAttribute("role"), "alert");
    assert.equal(status.getAttribute("aria-live"), "assertive");
    let retry = status.querySelector("button"); assert.equal(retry.textContent, "Retry");
    retry.focus(); retry.click(); await wait();
    assert.equal(calls, 2); assert.equal(status.querySelectorAll("button").length, 1);
    retry = status.querySelector("button"); assert.equal(w.document.activeElement, retry);
    retry.click(); retry.click(); assert.equal(calls, 3, "disabled retry prevents duplicate requests");
    assert.equal(retry.disabled, true);
    const theme = w.document.querySelector(".theme-toggle");
    if (mode === "json") theme.focus();
    resolveFetch(); await wait();
    assert.equal(status.getAttribute("role"), "status"); assert.equal(status.getAttribute("aria-live"), "polite");
    assert.equal(w.document.querySelectorAll('[role="alert"]').length, 0);
    assert.equal(status.querySelectorAll("button").length, 0);
    assert.equal(w.document.querySelectorAll("#definition-list-generated article").length, data.canonical_definitions.length);
    assert.match(status.textContent, /definitions loaded/); assert.doesNotMatch(status.textContent, /unavailable|Retry/);
    assert.equal(w.document.activeElement, mode === "json" ? theme : status, "recovery keeps connected focus without stealing it after the user moves");
    const oldTheme = theme.getAttribute("aria-pressed"); theme.click(); assert.notEqual(theme.getAttribute("aria-pressed"), oldTheme, "shell handlers were not duplicated");
    assert.equal(w.location.href, originalURL); assert.equal(calls, 3);
    await w.happyDOM.abort(); w.close();
  });
}
test("Releases: actual Reveal handler, accurate announcement and synthetic Back restoration", async () => {
  const release = "release_anthropic_20240304_introducing_the_next_generation_of_claude";
  const w = await setup("timeline", `?v=2&benchmark=benchmark_xstest&q=AI2D&release=${release}&center=2025-06-15T12%3A34%3A56.789Z&zoom=2`);
  globalThis.fetch = w.fetch = async () => ({ ok: true, json: async () => data });
  await import(new URL("shell.mjs?reveal-repair", app));
  await import(new URL("timeline.mjs?reveal-repair", app)); await wait(); await wait();
  const before = { url: w.location.href, state: structuredClone(w.history.state), length: w.history.length };
  assert.ok(w.document.querySelector(".outside-filter"));
  [...w.document.querySelectorAll("button")].find((b) => b.textContent === "Reveal release").click(); await wait();
  assert.equal(w.document.querySelector(".outside-filter"), null);
  const params = new URLSearchParams(w.location.search);
  assert.deepEqual(params.getAll("benchmark"), ["benchmark_xstest"]); assert.equal(params.get("q"), null);
  assert.equal(params.get("release"), release); assert.equal(params.get("center"), "2024-03-04T00:00:00.000Z"); assert.equal(params.get("zoom"), "2");
  assert.equal(w.history.length, before.length + 1);
  assert.match(w.document.querySelector("#timeline-controls .route-status").textContent, /Cleared conflicting filters: benchmark search/);
  // Dispatch the real popstate handler with the prior exact URL/payload. Not native Back proof.
  w.history.replaceState(before.state, "", before.url);
  w.dispatchEvent(new w.PopStateEvent("popstate", { state: before.state })); await wait();
  assert.ok(w.document.querySelector(".outside-filter"));
  assert.equal(new URLSearchParams(w.location.search).get("q"), "AI2D");
  assert.equal(new URLSearchParams(w.location.search).get("center"), "2025-06-15T12:34:56.789Z");
  await w.happyDOM.abort(); w.close();
});
