import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { Trends } from "../../trends.mjs";
import { Timeline, revealReleaseChanges } from "../../timeline.mjs";
import { indexData, matchingReleaseRecords, decodeViewState, encodeViewState } from "../../core.mjs";

const data = JSON.parse(await readFile(new URL("../../public/observatory.json", import.meta.url), "utf8"));
const indexed = indexData(data);
const exactCenter = "2025-06-15T12:34:56.789Z";
// Deterministic non-rendering scheduler. These tests do not prove native geometry.
function harness(Type, route) {
  const frames = new Map(), timers = new Map();
  let id = 0;
  globalThis.document = { querySelector: () => null };
  globalThis.requestAnimationFrame = (fn) => { frames.set(++id, fn); return id; };
  globalThis.cancelAnimationFrame = (key) => frames.delete(key);
  globalThis.setTimeout = (fn) => { timers.set(++id, fn); return id; };
  globalThis.clearTimeout = (key) => timers.delete(key);
  globalThis.window = { location: new URL(`https://example.test/${route}.html`), history: { state: null, replaceState(payload, _, url) { this.state = payload; window.location = new URL(url, window.location); } } };
  const app = new Type();
  app.indexed = indexed;
  app.state = decodeViewState(route, `?v=2&center=${exactCenter}`, indexed).state;
  app.search = { flush() {}, cancel() {} };
  app.edgeStatus = { textContent: "" };
  app.status = { textContent: "" };
  app.fallbackHost = { hidden: true };
  app.announce = () => {};
  const frame = { scrollLeft: 400, clientWidth: 800, scrollWidth: 2220, getBoundingClientRect: () => ({ left: 0, right: 800, width: 800 }) };
  const track = { getBoundingClientRect: () => ({ left: 200 - frame.scrollLeft, width: 2000 }) };
  const label = { getBoundingClientRect: () => ({ left: 0, right: 200, width: 200 }) };
  app.currentGeometryNodes = () => ({ frame, track, label });
  app.lastScrollLeft = frame.scrollLeft;
  const tick = () => { const batch = [...frames.values()]; frames.clear(); batch.forEach((fn) => fn()); };
  const idle = () => { const batch = [...timers.values()]; timers.clear(); batch.forEach((fn) => fn()); };
  const event = (type, extra = {}) => ({ type, pointerId: 1, target: frame, currentTarget: frame, ...extra });
  const move = (x) => { frame.scrollLeft = x; app.onScroll(); };
  return { app, frame, tick, idle, event, move, frames, timers };
}
for (const [Type, route] of [[Trends, "trends"], [Timeline, "timeline"]]) {
  test(`${route}: only unhandled Escape closes a cluster or clears a pin`, () => {
    for (const clustered of [false, true]) {
      const { app, frame } = harness(Type, route);
      app.state.release = "pinned-release";
      app.state.benchmarks = ["benchmark_aime_2025"];
      app.cluster = clustered ? { id: "open-cluster" } : null;
      const state = structuredClone(app.state);
      const cluster = app.cluster;
      const actions = [];
      app.closeCluster = (restoreFocus) => { actions.push(["cluster", restoreFocus]); app.cluster = null; };
      app.clearPin = (restoreFocus) => { actions.push(["pin", restoreFocus]); app.state.release = ""; };
      for (const key of ["Enter", "Tab", " ", "a", "Backspace", "ArrowRight", "Home", "End"]) {
        const event = { key, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
        app.handleEscape(event);
        assert.equal(event.defaultPrevented, false, `${key} must retain its native default`);
        assert.deepEqual(app.state, state, `${key} must preserve pin, selection and center`);
        assert.equal(app.cluster, cluster, `${key} must not dismiss the cluster`);
        assert.equal(frame.scrollLeft, 400);
        assert.deepEqual(actions, []);
      }
      app.handleEscape({ key: "Escape", defaultPrevented: true, preventDefault() { assert.fail("popup has already consumed Escape"); } });
      assert.deepEqual(actions, [], "popup Escape has priority over cluster and pin");
      const escape = { key: "Escape", defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
      app.handleEscape(escape);
      assert.equal(escape.defaultPrevented, true);
      assert.deepEqual(actions, [[clustered ? "cluster" : "pin", true]], "Escape restores focus on exactly one layer");
      if (clustered) assert.equal(app.state.release, state.release, "closing cluster preserves the pin");
      assert.equal(app.state.center, exactCenter);
      assert.deepEqual(app.state.benchmarks, state.benchmarks);
    }
  });
  test(`${route}: multi-frame touch, final copy and route flush, inertia and scrollend`, async () => {
    const { app, tick, event, move } = harness(Type, route);
    app.beginScrollInput(event("touchstart"));
    move(500); tick(); const first = app.state.center;
    move(600); tick(); assert.notEqual(app.state.center, first);
    move(700); let copied;
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { clipboard: { writeText: async (value) => { copied = value; } } } });
    await app.copyLink();
    assert.equal(new URL(copied).searchParams.get("center"), app.state.center);
    const copyCenter = app.state.center;
    move(800); const link = { href: "https://example.test/history.html" }; app.prepareRouteLink(link);
    assert.notEqual(app.state.center, copyCenter);
    assert.equal(new URL(link.href).searchParams.get("center"), app.state.center);
    app.endScrollInput(event("touchend"));
    const ended = app.state.center; move(900); tick(); assert.notEqual(app.state.center, ended, "inertia after release remains eligible");
    move(1000); app.finishUserScroll(); const final = app.state.center;
    assert.equal(app.userScrollPending, false);
    move(1100); tick(); assert.equal(app.state.center, final, "unarmed scrolling is ignored");
  });
  test(`${route}: held pointer survives idle, cancellation transfers inertia, fallback settles`, () => {
    const { app, tick, idle, event, move } = harness(Type, route);
    app.beginScrollInput(event("pointerdown")); move(500); tick(); idle();
    const first = app.state.center; move(600); tick(); assert.notEqual(app.state.center, first);
    app.endScrollInput(event("pointercancel")); move(700); tick();
    const cancelled = app.state.center; move(800); idle();
    assert.notEqual(app.state.center, cancelled); assert.equal(app.userScrollPending, false);
  });
  test(`${route}: wheel and keyboard lifetimes, non-scroll pointer and nested control`, () => {
    const { app, tick, idle, event, move } = harness(Type, route);
    app.beginScrollInput(event("pointerdown")); app.settlePendingCenter(); app.endScrollInput(event("pointerup")); idle();
    assert.equal(app.state.center, exactCenter, "no-scroll pin cannot capture rounded geometry");
    app.beginScrollInput(event("keydown", { key: "ArrowRight", target: {} })); assert.equal(app.userScrollPending, false);
    for (const type of ["wheel", "keydown"]) {
      app.beginScrollInput(event(type, { key: "ArrowRight" }));
      const before = app.state.center; move(type === "wheel" ? 600 : 800); tick(); assert.notEqual(app.state.center, before);
      move(type === "wheel" ? 650 : 850); tick();
      app.endScrollInput(event("keyup", { key: "ArrowRight" })); idle(); assert.equal(app.userScrollPending, false);
    }
  });
  test(`${route}: restoration and cancellation discard stale frames and timers`, () => {
    const { app, tick, idle, event, move, frames, timers } = harness(Type, route);
    app.beginScrollInput(event("wheel")); move(500); app.restoreViewport();
    assert.equal(app.userScrollPending, false); assert.equal(timers.size, 0);
    app.beginScrollInput(event("touchstart")); assert.equal(app.userScrollPending, false);
    tick(); app.onScroll(); tick(); idle(); assert.equal(app.state.center, exactCenter);
    app.beginScrollInput(event("touchstart")); move(900); app.cancelAsync(); tick(); idle();
    assert.equal(app.state.center, exactCenter); assert.equal(frames.size, 0); assert.equal(app.scrollInputs.size, 0);
  });
  test(`${route}: resize and non-pan mutation settle final displacement first`, () => {
    const { app, tick, event, move } = harness(Type, route);
    app.populateLaneMarkers = app.populateReleaseNodes = () => {};
    app.beginScrollInput(event("wheel")); move(650); app.refreshGeometry();
    const center = app.state.center; assert.notEqual(center, exactCenter);
    tick(); assert.equal(app.state.center, center);
    assert.equal(new URLSearchParams(window.location.search).get("center"), center);
    app.syncControls = () => {};
    app.render = () => app.restoreViewport();
    window.history.pushState = window.history.replaceState;
    app.beginScrollInput(event("touchstart")); move(850);
    app.mutate({ zoom: 2 }, "Zoom changed");
    assert.notEqual(app.state.center, center);
    const changed = app.state.center; tick(); assert.equal(app.state.center, changed);
    assert.equal(app.userScrollPending, false); assert.equal(app.state.zoom, 2);
  });
}
const releaseId = "release_anthropic_20240304_introducing_the_next_generation_of_claude";
test("Reveal resolves the full disjoint predicate, retaining comparison and compatible filters", () => {
  const state = { benchmarks: ["benchmark_xstest"], q: "AI2D", category: "", lab: indexed.releases.get(releaseId).lab_id, from: "2024-01-01", to: "2026-09-08", center: exactCenter, zoom: 2, release: releaseId };
  assert.ok(!matchingReleaseRecords(indexed, state).some((r) => r.id === releaseId));
  const changes = revealReleaseChanges(indexed, state, releaseId);
  assert.deepEqual(changes, { center: "2024-03-04T00:00:00.000Z", q: "" });
  const after = { ...state, ...changes };
  assert.ok(matchingReleaseRecords(indexed, after).some((r) => r.id === releaseId));
  assert.deepEqual(after.benchmarks, state.benchmarks); assert.equal(after.zoom, 2); assert.equal(after.release, releaseId);
  const back = decodeViewState("timeline", encodeViewState("timeline", state), indexed).state;
  assert.equal(back.q, "AI2D"); assert.equal(back.center, exactCenter);
});
test("Reveal removes only necessary individual filters and handles unavailable targets", () => {
  const release = indexed.releases.get(releaseId);
  for (const [key, value] of Object.entries({ q: "no-such-benchmark", category: "no-such-category", lab: "no-such-lab", from: "2025-01-01", to: "2024-01-01", benchmarks: ["benchmark_terminal_bench_2_0"] })) {
    const state = { [key]: value, release: releaseId, center: exactCenter };
    const changes = revealReleaseChanges(indexed, state, releaseId);
    assert.deepEqual(Object.keys(changes).sort(), ["center", key].sort(), key);
    assert.ok(matchingReleaseRecords(indexed, { ...state, ...changes }).some((r) => r.id === release.id));
  }
  assert.equal(revealReleaseChanges(indexed, {}, "invalid"), null);
  assert.equal(revealReleaseChanges(indexed, {}, undefined), null);
  const receiver = { indexed, state: { center: exactCenter }, status: {}, mutate() { assert.fail("invalid target mutated state"); } };
  Timeline.prototype.revealRelease.call(receiver, null);
  assert.match(receiver.status.textContent, /could not be revealed/);
});
test("Reveal minimality under combined query/category/selection and date constraints", () => {
  const state = { benchmarks: ["benchmark_xstest"], q: "AI2D", category: indexed.benchmarks.get("benchmark_xstest").category_id, lab: "other-lab", from: "2025-01-01", to: "2025-12-31", center: exactCenter, release: releaseId, zoom: 4 };
  const changes = revealReleaseChanges(indexed, state, releaseId);
  const after = { ...state, ...changes };
  assert.ok(matchingReleaseRecords(indexed, after).some((r) => r.id === releaseId));
  assert.deepEqual(after.benchmarks, state.benchmarks);
  assert.equal(after.category, state.category); assert.equal(after.to, state.to); assert.equal(after.zoom, 4);
  for (const key of Object.keys(changes).filter((key) => key !== "center")) {
    assert.ok(!matchingReleaseRecords(indexed, { ...after, [key]: state[key] }).some((r) => r.id === releaseId), `${key} must actually obstruct the final combined predicate`);
  }
  assert.deepEqual(revealReleaseChanges(indexed, after, releaseId), { center: after.center });
});
