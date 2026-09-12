import {
  definitionsTarget,
  legacyLandingTarget,
  navigationSearch,
  validateInterface,
} from "./core.mjs";

const ROUTE_SCOPE_MARKER = "observatory:route-scope";
const DEFINITIONS_MARKER = "observatory:definitions-fallback";

function systemPrefersDark() {
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
}

function activeTheme() {
  const explicitTheme = document.documentElement.dataset.theme;
  if (explicitTheme === "light" || explicitTheme === "dark") return explicitTheme;
  return systemPrefersDark() ? "dark" : "light";
}

export function setupTheme() {
  const button = document.querySelector(".theme-toggle");
  if (!button) return;

  try {
    const storedTheme = localStorage.getItem("theme");
    if (storedTheme === "light" || storedTheme === "dark") document.documentElement.dataset.theme = storedTheme;
  } catch (_) {}

  button.setAttribute("aria-pressed", String(activeTheme() === "dark"));
  window.matchMedia?.("(prefers-color-scheme: dark)")?.addEventListener("change", () => {
    if (document.documentElement.dataset.theme) return;
    button.setAttribute("aria-pressed", String(activeTheme() === "dark"));
  });
  button.addEventListener("click", () => {
    const nextTheme = activeTheme() === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = nextTheme;
    button.setAttribute("aria-pressed", String(nextTheme === "dark"));
    try {
      localStorage.setItem("theme", nextTheme);
    } catch (_) {}
  });
}

function setSessionMarker(key, value) {
  try {
    sessionStorage.setItem(key, JSON.stringify(value));
  } catch (_) {}
}

function takeSessionMarker(key) {
  try {
    const value = sessionStorage.getItem(key);
    sessionStorage.removeItem(key);
    return value ? JSON.parse(value) : null;
  } catch (_) {
    return null;
  }
}

function scopeNotice(text, link = null) {
  const main = document.querySelector("main");
  if (!main) return;
  const notice = document.createElement("p");
  notice.className = "page-shell route-status";
  notice.setAttribute("role", "status");
  notice.textContent = text;
  if (link) {
    notice.append(document.createTextNode(" "));
    notice.append(link);
  }
  main.prepend(notice);
}

function setupNavigation() {
  const links = document.querySelectorAll(".primary-nav a, .wordmark");
  links.forEach((link) => link.addEventListener("click", () => {
    window.dispatchEvent(new Event("observatory:flush"));
    const target = new URL(link.getAttribute("href"), window.location.href);
    if (target.origin !== window.location.origin) return;
    target.search = navigationSearch(window.location.search);
    link.href = `${target.pathname}${target.search}${target.hash}`;
    if (target.pathname !== window.location.pathname) setSessionMarker(ROUTE_SCOPE_MARKER, { targetPath: target.pathname });
  }));
}

function announceTransferredScope() {
  const marker = takeSessionMarker(ROUTE_SCOPE_MARKER);
  if (!marker || marker.targetPath !== window.location.pathname) return;

  scopeNotice("Kept benchmarks, lab, dates and chronological position; this view has its own search and table controls.");
}

function mixedLegacyNotice() {
  if (document.body?.dataset.page !== "trends") return;
  const params = new URLSearchParams(window.location.search);
  if (!params.has("benchmark") || !params.has("q") || params.getAll("v").includes("2")) return;
  const target = new URLSearchParams(navigationSearch(window.location.search));
  target.set("q", params.get("q"));
  const link = document.createElement("a");
  link.href = `./timeline.html?${target.toString()}`;
  link.textContent = "Open that text in Releases.";
  scopeNotice("Legacy release-search text was not applied in Benchmarks.", link);
}

let generatedDataPromise;
async function generatedData() {
  if (!generatedDataPromise) {
    generatedDataPromise = fetch("./public/observatory.json", { cache: "no-store" }).then(async (response) => {
      if (!response.ok) throw new Error(`Generated data request failed with HTTP ${response.status}.`);
      return validateInterface(await response.json());
    });
  }
  return generatedDataPromise;
}

function appendLabeledText(parent, label, value) {
  const paragraph = document.createElement("p");
  const term = document.createElement("strong");
  term.textContent = `${label}: `;
  paragraph.append(term, document.createTextNode(String(value)));
  parent.append(paragraph);
}

function formatCount(value) {
  return Number(value).toLocaleString("en-US");
}

function kstCutoff(instant) {
  const shifted = new Date(Date.parse(instant) + (9 * 60 * 60 * 1000)).toISOString();
  return `${shifted.slice(0, 10)} ${shifted.slice(11, 19)} KST`;
}

function definitionArticle(definition) {
  const article = document.createElement("article");
  article.id = definition.id;
  article.className = "source-disclosure";
  const heading = document.createElement("h3");
  heading.textContent = definition.label;
  article.append(heading);
  appendLabeledText(article, "Definition", definition.description);
  appendLabeledText(article, "Comparable scope", String(definition.algorithm?.comparable_scope || "Not recorded").replaceAll("_", " "));
  appendLabeledText(article, "Rule", String(definition.algorithm?.kind || "Not recorded").replaceAll("_", " "));
  if (definition.examples?.length) appendLabeledText(article, "Example", definition.examples.join(" "));
  if (definition.cautions?.length) appendLabeledText(article, "Caution", definition.cautions.join(" "));
  return article;
}

async function renderAbout() {
  if (document.body?.dataset.page !== "about") return;
  const limitations = document.querySelector("#generated-limitations");
  const definitions = document.querySelector("#definition-list-generated");
  const status = document.querySelector("#about-data-status");
  const previousRetry = status?.querySelector("button");
  const shouldRestoreFocus = () => previousRetry && document.activeElement === previousRetry;
  if (previousRetry) previousRetry.disabled = true;
  try {
    const data = await generatedData();
    const overlay = data.audit_overlay;
    const summary = overlay.summary;
    const unresolved = summary.baseline_audit_dispositions.unresolved;
    const denominator = summary.baseline_audit_units;
    const retained = data.occurrences.filter((occurrence) => occurrence.review_status === "verified").length;
    limitations.replaceChildren();
    const bounded = document.createElement("p");
    bounded.textContent = `Coverage is bounded and incomplete. Intake includes public reporting dated from ${data.corpus.publication_window.start} through ${kstCutoff(overlay.intake_cutoff)}. The fixed UTC cutoff is ${overlay.intake_cutoff}. Pages were retrieved later and may have changed. ${formatCount(unresolved)} of ${formatCount(denominator)} baseline audit units remain unresolved; scoped field checks do not reapprove entire records. Missing or withheld records do not show that an evaluation was not run.`;
    const auditUnit = document.createElement("p");
    auditUnit.textContent = `An audit unit is a catalog row or typed source association. ${formatCount(summary.unresolved_named_candidates)} named candidates remain unresolved. Index and pagination closure are unproven, and ${formatCount(summary.url_dispositions.inaccessible)} URL candidates were unavailable during intake.`;
    const recent = document.createElement("p");
    recent.textContent = `Recent global counts use ${formatCount(retained)} retained catalog associations, including unresolved baseline assertions, not only newly verified evidence. The overlay marks semantic corpus approval as ${overlay.semantic_corpus_approval ? "approved" : "not approved"}; no blanket semantic approval is claimed.`;
    limitations.append(bounded, auditUnit, recent);

    definitions.replaceChildren(...data.canonical_definitions.map(definitionArticle));
    if (status) {
      const restoreFocus = shouldRestoreFocus();
      status.setAttribute("role", "status");
      status.setAttribute("aria-live", "polite");
      status.textContent = `${data.canonical_definitions.length} reporting definitions loaded from generated data.`;
      if (restoreFocus) {
        status.setAttribute("tabindex", "-1");
        status.focus({ preventScroll: true });
      }
    }
    const fragment = window.location.hash.slice(1);
    if (data.canonical_definitions.some((definition) => definition.id === fragment)) requestAnimationFrame(() => document.getElementById(fragment)?.scrollIntoView());
  } catch (error) {
    generatedDataPromise = null;
    if (status) {
      const restoreFocus = shouldRestoreFocus();
      status.setAttribute("role", "alert");
      status.setAttribute("aria-live", "assertive");
      status.textContent = "Generated counts and reporting definitions are unavailable. The static scope and interpretation boundaries remain below. ";
      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "button";
      retry.textContent = "Retry";
      retry.addEventListener("click", () => { void renderAbout(); });
      status.append(retry);
      if (restoreFocus) retry.focus({ preventScroll: true });
    }
    console.error(error);
  }
}

async function redirectDefinitions() {
  if (!document.body?.classList.contains("redirect-page")) return;
  const manual = document.querySelector("#definitions-continue");
  try {
    const data = await generatedData();
    const known = data.canonical_definitions.map((definition) => definition.id);
    const target = definitionsTarget(window.location.search, window.location.hash, known);
    if (manual) manual.href = target;
    const params = new URLSearchParams(window.location.search);
    const fragment = window.location.hash.slice(1);
    const knownSet = new Set(known);
    const knownRequestedStatus = params.getAll("status").some((value) => knownSet.has(value));
    const knownFragment = knownSet.has(fragment);
    const genericFragment = !fragment || ["definition-list", "reporting-definitions"].includes(fragment);
    if (!knownRequestedStatus && !knownFragment && (params.has("status") || !genericFragment)) setSessionMarker(DEFINITIONS_MARKER, { targetPath: new URL(target, window.location.href).pathname });
    window.location.replace(target);
  } catch (error) {
    const explanation = document.querySelector("#definitions-explanation");
    if (explanation) explanation.textContent = "Automatic definition mapping is unavailable. Continue to the complete reporting definitions on About.";
    console.error(error);
  }
}

function announceDefinitionsFallback() {
  if (document.body?.dataset.page !== "about") return;
  const marker = takeSessionMarker(DEFINITIONS_MARKER);
  if (marker?.targetPath === window.location.pathname) scopeNotice("The requested definition was not recognized. Showing all reporting definitions.");
}

function initialize() {
  if (document.body?.dataset.page === "trends") {
    const target = legacyLandingTarget(window.location.search, window.location.hash);
    if (target) {
      window.location.replace(target);
      return;
    }
  }
  setupTheme();
  setupNavigation();
  announceTransferredScope();
  announceDefinitionsFallback();
  mixedLegacyNotice();
  void renderAbout();
  void redirectDefinitions();
}

if (typeof document !== "undefined") initialize();
