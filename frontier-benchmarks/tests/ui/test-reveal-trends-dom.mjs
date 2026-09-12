import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { test } from "node:test";
import { indexData, decodeViewState, encodeViewState } from "../../core.mjs";
import { releaseMatches } from "../../trends.mjs";

// Non-rendering DOM only. Supply an isolated installed Happy DOM module path.
const { Window } = await import(pathToFileURL(resolve(process.argv[2])).href);
const app = new URL("../../", import.meta.url);
const data = JSON.parse(await readFile(new URL("public/observatory.json", app), "utf8"));
const indexed = indexData(data);
const wait = () => new Promise((done) => setTimeout(done, 100));
async function setup(query, token) {
  const w = new Window({ url: `https://candidate.invalid/frontier-benchmarks/index.html${query}#trends-detail`, settings: { disableJavaScriptFileLoading: true, disableCSSFileLoading: true, enableJavaScriptEvaluation: false, navigation: { disableMainFrameNavigation: true } } });
  for (const k of ["window", "document", "history", "location", "localStorage", "sessionStorage", "navigator", "HTMLElement", "HTMLInputElement", "HTMLSelectElement", "Element", "Node", "Event", "CustomEvent", "KeyboardEvent", "MouseEvent", "PointerEvent", "ResizeObserver", "DOMException", "CSS"]) Object.defineProperty(globalThis, k, { configurable: true, value: k === "window" ? w : w[k] });
  for (const k of ["requestAnimationFrame", "cancelAnimationFrame", "getComputedStyle", "matchMedia"]) globalThis[k] = w[k].bind(w);
  w.history.replaceState({ unrelated: { preserved: true } }, "", w.location.href);
  globalThis.fetch = async () => ({ ok: true, json: async () => data });
  w.document.write((await readFile(new URL("index.html", app), "utf8")).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ""));
  await import(new URL(`shell.mjs?rv04=${token}`, app));
  const module = await import(new URL(`trends.mjs?rv04=${token}`, app));
  await wait(); await wait();
  return { w, module };
}
const revealButton = () => [...document.querySelectorAll("button")].find((b) => b.textContent === "Reveal release");
const status = () => [...document.querySelectorAll('[role="status"]')].map((n) => n.textContent).join("\n");

test("historical-only Reveal retains exact URL/history/pin and explicitly announces unavailable", async () => {
  const id = "release_qwen_20260319_qwen3_5_max_preview";
  const { w } = await setup(`?v=2&release=${id}&center=2025-06-15T12:34:56.789Z&zoom=2&search=AI2D`, "unavailable");
  const before = { url: w.location.href, payload: structuredClone(w.history.state), length: w.history.length };
  assert.match(document.querySelector("#trends-detail").textContent, /Pinned release unavailable.*no retained live canonical occurrence/);
  assert.ok(revealButton());
  for (let i = 0; i < 3; i++) {
    revealButton().click(); await wait();
    assert.equal(w.location.href, before.url);
    assert.deepEqual(w.history.state, before.payload);
    assert.equal(w.history.length, before.length);
    assert.match(status(), /Release unavailable.*Filters, comparison and position were kept/);
    assert.doesNotMatch(status(), /revealed and chronology/);
    assert.equal(document.querySelector(`[data-release-id="${id}"]`), null, "no invented marker");
    assert.match(document.querySelector("#trends-detail").textContent, /Historical or withheld identities remain audit context/);
  }
  await w.happyDOM.abort(); w.close();
});

test("real reveal checks final membership, exact share state, announcement and synthetic restoration", async () => {
  const id = "release_anthropic_20240304_introducing_the_next_generation_of_claude";
  const otherLab = data.labs.find((lab) => lab.id !== indexed.releases.get(id).lab_id).id;
  const { w } = await setup(`?v=2&benchmark=benchmark_xstest&benchmark=benchmark_terminal_bench_2_0&release=${id}&center=2025-06-15T12:34:56.789Z&zoom=2.5&from=2026-09-08&lab=${otherLab}&search=not-a-result-filter`, "visible");
  const before = { url: w.location.href, payload: structuredClone(w.history.state), length: w.history.length };
  assert.ok(document.querySelector(".outside-filter"));
  revealButton().click(); await wait();
  const after = decodeViewState("trends", w.location.search, indexed).state;
  assert.ok(releaseMatches(indexed, after.benchmarks, after).some((m) => m.release.id === id));
  assert.equal(document.querySelector(".outside-filter"), null);
  assert.ok(document.querySelector(`[data-release-id="${id}"]`) || document.querySelector(".chronology-cluster"));
  assert.deepEqual(after.benchmarks, decodeViewState("trends", new URL(before.url).search, indexed).state.benchmarks);
  assert.equal(after.search, "not-a-result-filter"); assert.equal(after.zoom, 2.5); assert.equal(after.release, id);
  assert.equal(after.from, ""); assert.equal(after.lab, "");
  assert.equal(w.location.hash, "#trends-detail");
  assert.deepEqual(w.history.state.unrelated, { preserved: true });
  assert.equal(w.history.length, before.length + 1);
  assert.match(status(), /revealed and chronology position updated.*lab, from date/);
  assert.equal(revealButton(), undefined, "visible target no longer offers hidden-target recovery");
  const exactURL = w.location.href;
  let copied;
  Object.defineProperty(w.navigator.clipboard, "writeText", { configurable: true, value: async (value) => { copied = value; } });
  [...document.querySelectorAll("button")].find((b) => b.textContent === "Copy link").click(); await wait();
  assert.equal(copied, exactURL);
  assert.deepEqual(decodeViewState("trends", encodeViewState("trends", after), indexed).state, after);
  w.history.replaceState(before.payload, "", before.url);
  w.dispatchEvent(new w.PopStateEvent("popstate", { state: before.payload })); await wait();
  assert.equal(w.location.href, before.url); assert.ok(document.querySelector(".outside-filter"));
  assert.deepEqual(w.history.state.unrelated, { preserved: true });
  await w.happyDOM.abort(); w.close();
});
