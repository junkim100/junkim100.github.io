export const SETUP_FIELDS = [
  ["prompting", "Prompting"],
  ["shot_configuration", "Shot configuration"],
  ["tool_use", "Tool use"],
  ["evaluation_harness", "Evaluation harness"],
  ["sample_selection", "Sample selection"],
];

export function normalize(value = "") {
  return String(value)
    .normalize("NFKD")
    .toLocaleLowerCase("en")
    .replaceAll("+", " plus ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function byId(records = []) {
  return new Map(records.map((record) => [record.id, record]));
}

export function indexData(data) {
  const indexed = {
    data,
    labs: byId(data.labs),
    categories: byId(data.categories),
    lineages: byId(data.lineages),
    models: byId(data.models),
    releases: byId(data.releases),
    benchmarks: byId(data.benchmarks),
    sources: byId(data.sources),
    coverage: byId(data.coverage),
    definitions: byId(data.canonical_definitions),
    statusesByRelease: new Map(),
    occurrencesByRelease: new Map(),
  };

  for (const status of data.derived_statuses || []) {
    const statuses = indexed.statusesByRelease.get(status.release_id) || [];
    statuses.push(status);
    indexed.statusesByRelease.set(status.release_id, statuses);
  }
  for (const occurrence of data.occurrences || []) {
    const occurrences = indexed.occurrencesByRelease.get(occurrence.release_id) || [];
    occurrences.push(occurrence);
    indexed.occurrencesByRelease.set(occurrence.release_id, occurrences);
  }
  return indexed;
}

export function benchmarkSearchText(benchmark, categories) {
  const category = categories.get(benchmark.category_id);
  return normalize([
    benchmark.name,
    ...(benchmark.aliases || []),
    category?.name || "",
    ...(category?.aliases || []),
  ].join(" "));
}

export function isLiveCanonical(benchmark) {
  return !benchmark?.identity_status || benchmark.identity_status === "canonical";
}

export function liveCanonicalBenchmarks(benchmarks = []) {
  return benchmarks.filter(isLiveCanonical);
}

export function mappedBenchmarkId(benchmarksById, occurrence) {
  const benchmark = typeof benchmarksById.get === "function"
    ? benchmarksById.get(occurrence.benchmark_id)
    : benchmarksById[occurrence.benchmark_id];
  if (benchmark?.identity_status === "merged" && benchmark.canonical_benchmark_id) {
    return benchmark.canonical_benchmark_id;
  }
  return occurrence.benchmark_id;
}

export function isRetainedOccurrence(occurrence) {
  return occurrence?.review_status === "verified";
}

export function recentModelCount(data, benchmarkId) {
  const row = (data?.recent_model_counts?.counts || []).find((item) => item.benchmark_id === benchmarkId);
  return row ? row.distinct_model_count : 0;
}

export function recentModelCountLabel(data) {
  return data?.recent_model_counts?.label || "models in latest 90 days";
}

export function matchingBenchmarkIds(indexed, query = "", categoryId = "") {
  const needle = normalize(query);
  return new Set(
    liveCanonicalBenchmarks(indexed.data.benchmarks)
      .filter((benchmark) => !categoryId || benchmark.category_id === categoryId)
      .filter((benchmark) => !needle || benchmarkSearchText(benchmark, indexed.categories).includes(needle))
      .map((benchmark) => benchmark.id),
  );
}

export function occurrenceFrequency(data) {
  const counts = new Map();
  const benchmarks = byId(data.benchmarks || []);
  for (const occurrence of data.occurrences || []) {
    if (!isRetainedOccurrence(occurrence)) continue;
    const benchmarkId = mappedBenchmarkId(benchmarks, occurrence);
    counts.set(benchmarkId, (counts.get(benchmarkId) || 0) + 1);
  }
  return counts;
}

export function orderedReleaseOccurrences(indexed, releaseId, matchingIds = null) {
  const frequencies = occurrenceFrequency(indexed.data);
  const statuses = indexed.statusesByRelease.get(releaseId) || [];
  const firstReported = new Set(
    statuses
      .filter((status) => status.occurrence_id && status.status_ids.includes("first_reported"))
      .map((status) => status.occurrence_id),
  );
  return [...(indexed.occurrencesByRelease.get(releaseId) || [])]
    .filter((occurrence) => isRetainedOccurrence(occurrence))
    .filter((occurrence) => !matchingIds || matchingIds.has(mappedBenchmarkId(indexed.benchmarks, occurrence)))
    .sort((left, right) => {
      const firstDelta = Number(firstReported.has(right.id)) - Number(firstReported.has(left.id));
      if (firstDelta) return firstDelta;
      const frequencyDelta = (frequencies.get(right.benchmark_id) || 0) - (frequencies.get(left.benchmark_id) || 0);
      if (frequencyDelta) return frequencyDelta;
      return indexed.benchmarks.get(mappedBenchmarkId(indexed.benchmarks, left)).name.localeCompare(indexed.benchmarks.get(mappedBenchmarkId(indexed.benchmarks, right)).name, "en");
    });
}

export function statusesForOccurrence(indexed, occurrence) {
  const status = (indexed.statusesByRelease.get(occurrence.release_id) || []).find(
    (item) => item.occurrence_id === occurrence.id,
  );
  return status?.status_ids || [];
}

export function dateValue(isoDate) {
  const value = Date.parse(`${isoDate}T00:00:00Z`);
  if (!Number.isFinite(value)) throw new Error(`Invalid publication date: ${isoDate}`);
  return value;
}

export function formatDate(isoDate) {
  return new Intl.DateTimeFormat("en", {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(dateValue(isoDate)));
}

export function datePosition(isoDate, startDate, endDate) {
  const start = dateValue(startDate);
  const end = dateValue(endDate);
  if (end <= start) return 0;
  return Math.max(0, Math.min(100, ((dateValue(isoDate) - start) / (end - start)) * 100));
}

export function dateFromPosition(percent, startDate, endDate) {
  const start = dateValue(startDate);
  const end = dateValue(endDate);
  const span = end - start;
  const ms = start + (Number(percent) / 100) * (span || 0);
  return new Date(ms).toISOString().slice(0, 10);
}

export function captureCenterDate(frame, startDate, endDate) {
  if (!frame || !frame.scrollWidth) return endDate;
  const percent = ((frame.scrollLeft + frame.clientWidth / 2) / frame.scrollWidth) * 100;
  return dateFromPosition(percent, startDate, endDate);
}

export function restoreCenterDate(frame, centerDate, startDate, endDate) {
  if (!frame) return;
  const percent = datePosition(centerDate, startDate, endDate);
  const centerPx = (percent / 100) * frame.scrollWidth;
  const maxScroll = Math.max(0, frame.scrollWidth - frame.clientWidth);
  frame.scrollLeft = Math.min(maxScroll, Math.max(0, centerPx - frame.clientWidth / 2));
}

export function scrollToNewest(frame) {
  if (!frame) return;
  frame.scrollLeft = Math.max(0, frame.scrollWidth - frame.clientWidth);
}

export function collisionRows(positions, minimumGap) {
  if (!Number.isFinite(minimumGap) || minimumGap <= 0) throw new Error("Collision spacing must be a positive number.");
  const rowEnds = [];
  return positions.map((position) => {
    if (!Number.isFinite(position)) throw new Error("Collision positions must be finite numbers.");
    let row = rowEnds.findIndex((end) => position - end >= minimumGap);
    if (row === -1) row = rowEnds.length;
    rowEnds[row] = position;
    return row;
  });
}

export function timelineTicks(startDate, endDate, desired = 8) {
  const start = new Date(dateValue(startDate));
  const end = new Date(dateValue(endDate));
  const span = end.getTime() - start.getTime();
  const ticks = [];
  for (let index = 0; index <= desired; index += 1) {
    const date = new Date(start.getTime() + (span * index) / desired);
    ticks.push(date.toISOString().slice(0, 10));
  }
  return [...new Set(ticks)];
}

export function disclosureText(disclosure) {
  return disclosure?.status === "disclosed" ? disclosure.value : "Not disclosed";
}

export function revisionText(revision) {
  if (!revision) return "Revision state unavailable";
  if (revision.identifier) return revision.identifier;
  return `Unavailable: ${revision.unavailable_reason.replaceAll("_", " ")} · retrieved ${formatDate(revision.retrieval_date)}`;
}

export function validateInterface(data) {
  const requiredArrays = [
    "labs",
    "categories",
    "lineages",
    "models",
    "releases",
    "benchmarks",
    "sources",
    "coverage",
    "occurrences",
    "derived_statuses",
    "canonical_definitions",
    "quarantine",
  ];
  const missing = requiredArrays.filter((key) => !Array.isArray(data[key]));
  if (missing.length) throw new Error(`Generated data is missing: ${missing.join(", ")}`);
  if (!data.corpus?.publication_window?.start || !data.corpus?.publication_window?.end) {
    throw new Error("Generated data is missing the inclusive publication window.");
  }
  return data;
}

export const COMBOBOX_OPTION_LIMIT = 50;

export function createSearchableCombobox({
  id,
  label,
  value = "",
  options,
  emptyLabel,
  placeholder = "Type to search",
  onChange,
}) {
  const field = document.createElement("div");
  field.className = "field combobox-field";
  const labelNode = document.createElement("label");
  labelNode.htmlFor = id;
  labelNode.textContent = label;
  const shell = document.createElement("div");
  shell.className = "combobox";
  const input = document.createElement("input");
  const listbox = document.createElement("ul");
  const clear = document.createElement("button");
  const listboxId = `${id}-listbox`;
  const status = document.createElement("p");
  let selectedValue = options.some((option) => option.value === value) ? value : "";
  let visibleOptions = [];
  let activeIndex = -1;

  input.id = id;
  input.type = "text";
  input.autocomplete = "off";
  input.placeholder = placeholder;
  input.setAttribute("role", "combobox");
  input.setAttribute("aria-autocomplete", "list");
  input.setAttribute("aria-controls", listboxId);
  input.setAttribute("aria-expanded", "false");
  listbox.id = listboxId;
  listbox.className = "combobox-listbox";
  listbox.setAttribute("role", "listbox");
  listbox.hidden = true;
  status.id = `${id}-window-status`;
  status.className = "combobox-window-status visually-hidden";
  status.setAttribute("role", "status");
  clear.type = "button";
  clear.id = `${id}-clear`;
  clear.className = "combobox-clear";
  clear.textContent = "×";
  clear.setAttribute("aria-label", `Clear ${label}`);

  const optionLabel = (candidate) => candidate.value === "" ? emptyLabel : candidate.label;
  const selectedLabel = () => optionLabel(options.find((option) => option.value === selectedValue) || { value: "", label: "" });
  const close = () => {
    listbox.hidden = true;
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
    activeIndex = -1;
  };
  const setActive = (nextIndex) => {
    if (!visibleOptions.length) return;
    activeIndex = Math.max(0, Math.min(nextIndex, visibleOptions.length - 1));
    const optionNodes = [...listbox.querySelectorAll('[role="option"]')];
    optionNodes.forEach((node, index) => {
      node.setAttribute("aria-selected", String(index === activeIndex));
      if (index === activeIndex) {
        input.setAttribute("aria-activedescendant", node.id);
        node.scrollIntoView({ block: "nearest" });
      }
    });
  };
  const select = (option) => {
    selectedValue = option.value;
    input.value = optionLabel(option);
    close();
    onChange(option.value);
  };
  const renderOptions = (query = "") => {
    const needle = normalize(query);
    const matches = options.filter((option) => !needle || normalize(`${option.label} ${option.searchText || ""}`).includes(needle));
    visibleOptions = matches.slice(0, COMBOBOX_OPTION_LIMIT);
    listbox.replaceChildren();
    visibleOptions.forEach((option, index) => {
      const item = document.createElement("li");
      item.id = `${listboxId}-option-${index}`;
      item.dataset.value = option.value;
      item.setAttribute("role", "option");
      item.setAttribute("aria-selected", String(option.value === selectedValue));
      item.textContent = optionLabel(option);
      item.addEventListener("mousedown", (event) => event.preventDefault());
      item.addEventListener("click", () => select(option));
      listbox.append(item);
    });
    status.textContent = matches.length > COMBOBOX_OPTION_LIMIT
      ? `Showing ${visibleOptions.length} of ${matches.length} choices`
      : "";
    if (status.textContent) status.setAttribute("aria-live", "polite");
    else status.removeAttribute("aria-live");
    listbox.hidden = false;
    input.setAttribute("aria-expanded", "true");
    activeIndex = visibleOptions.findIndex((option) => option.value === selectedValue);
    if (activeIndex >= 0) setActive(activeIndex);
    else input.removeAttribute("aria-activedescendant");
  };
  const setValue = (nextValue) => {
    selectedValue = options.some((option) => option.value === nextValue) ? nextValue : "";
    input.value = selectedLabel();
  };

  input.addEventListener("click", () => renderOptions(""));
  input.addEventListener("input", () => renderOptions(input.value));
  input.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      input.value = selectedLabel();
      close();
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End", "Enter"].includes(event.key)) return;
    if (event.key === "Enter" && !listbox.hidden && activeIndex >= 0) {
      event.preventDefault();
      select(visibleOptions[activeIndex]);
      return;
    }
    if (event.key === "Enter") return;
    event.preventDefault();
    if (listbox.hidden) renderOptions("");
    if (event.key === "Home") setActive(0);
    else if (event.key === "End") setActive(visibleOptions.length - 1);
    else if (event.key === "ArrowDown") setActive(activeIndex + 1);
    else setActive(activeIndex < 0 ? visibleOptions.length - 1 : activeIndex - 1);
  });
  input.addEventListener("blur", () => {
    input.value = selectedLabel();
    close();
  });
  clear.addEventListener("click", () => {
    if (!selectedValue && !input.value) return;
    selectedValue = "";
    input.value = "";
    close();
    onChange("");
    requestAnimationFrame(() => input.focus());
  });
  setValue(selectedValue);
  shell.append(input, clear, listbox);
  field.append(labelNode, shell, status);
  return { element: field, input, setValue, close, status };
}
