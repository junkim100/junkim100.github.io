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

export function matchingBenchmarkIds(indexed, query = "", categoryId = "") {
  const needle = normalize(query);
  return new Set(
    indexed.data.benchmarks
      .filter((benchmark) => !categoryId || benchmark.category_id === categoryId)
      .filter((benchmark) => !needle || benchmarkSearchText(benchmark, indexed.categories).includes(needle))
      .map((benchmark) => benchmark.id),
  );
}

export function occurrenceFrequency(data) {
  const counts = new Map();
  for (const occurrence of data.occurrences || []) {
    counts.set(occurrence.benchmark_id, (counts.get(occurrence.benchmark_id) || 0) + 1);
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
    .filter((occurrence) => !matchingIds || matchingIds.has(occurrence.benchmark_id))
    .sort((left, right) => {
      const firstDelta = Number(firstReported.has(right.id)) - Number(firstReported.has(left.id));
      if (firstDelta) return firstDelta;
      const frequencyDelta = (frequencies.get(right.benchmark_id) || 0) - (frequencies.get(left.benchmark_id) || 0);
      if (frequencyDelta) return frequencyDelta;
      return indexed.benchmarks.get(left.benchmark_id).name.localeCompare(indexed.benchmarks.get(right.benchmark_id).name, "en");
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
