const labSpecs = [
  ["openai", "OpenAI", "openai.com"],
  ["anthropic", "Anthropic", "anthropic.com"],
  ["google_deepmind", "Google DeepMind", "deepmind.google"],
  ["meta", "Meta", "ai.meta.com"],
  ["deepseek", "DeepSeek", "deepseek.com"],
  ["qwen", "Qwen", "qwenlm.github.io"],
];

const benchmarkSpecs = [
  ["reasoning_atlas", "Reasoning Atlas", "reasoning", ["RA collection", "logic atlas"]],
  ["code_harbor", "Code Harbor", "coding", ["CH tasks", "program synthesis harbor"]],
  ["knowledge_garden", "Knowledge Garden", "knowledge", ["KGarden"]],
  ["vision_compass", "Vision Compass", "multimodal", ["visual compass"]],
  ["agent_trail", "Agent Trail", "agents", ["tool trail"]],
  ["math_forge", "Math Forge", "mathematics", ["MF set"]],
  ["safety_lantern", "Safety Lantern", "safety", ["SL review"]],
  ["long_context_map", "Long Context Map with an intentionally extended canonical label", "long_context", ["LC map"]],
];

const categories = [
  ["reasoning", "Reasoning", ["logic"]],
  ["coding", "Coding", ["programming"]],
  ["knowledge", "Knowledge", ["factuality"]],
  ["multimodal", "Multimodal", ["vision language"]],
  ["agents", "Agents", ["tool use"]],
  ["mathematics", "Mathematics", ["math"]],
  ["safety", "Safety", ["responsible AI"]],
  ["long_context", "Long context", ["extended context"]],
].map(([id, name, aliases]) => ({ id, name, aliases }));

const labs = labSpecs.map(([id, name, domain]) => ({ id, name, official_domains: [domain] }));
const lineages = labSpecs.map(([id, name]) => ({
  id: `${id}_frontier`,
  lab_id: id,
  name: `${name} frontier fixture lineage`,
  modality_class: "text",
  use_class: "general",
}));
const models = labSpecs.map(([id, name]) => ({
  id: `${id}_fixture_model`,
  lab_id: id,
  lineage_id: `${id}_frontier`,
  name: `${name} Fixture Model`,
}));
const benchmarks = benchmarkSpecs.map(([id, name, category_id, aliases]) => ({ id, name, category_id, aliases }));

const releaseDates = ["2024-01-01", "2024-05-16", "2024-09-23", "2025-01-28", "2025-06-04", "2026-09-01"];
const releases = [];
const coverage = [];
const sources = [];
const occurrences = [];
const derived_statuses = [];

labSpecs.forEach(([labId, labName, domain], labIndex) => {
  [0, 1].forEach((sequence) => {
    const releaseId = `${labId}_release_${sequence + 1}`;
    const sourceId = `${releaseId}_source`;
    const date = releaseDates[(labIndex + sequence) % releaseDates.length];
    releases.push({
      id: releaseId,
      candidate_id: `${releaseId}_candidate`,
      lab_id: labId,
      model_id: `${labId}_fixture_model`,
      lineage_id: `${labId}_frontier`,
      name: `${labName} ${sequence ? "Horizon" : "Origin"}`,
      publication_date: date,
      modality_class: labIndex % 2 ? "vision_language" : "text",
      use_class: labIndex % 3 === 1 ? "reasoning" : labIndex % 3 === 2 ? "coding" : "general",
      coverage_id: `${releaseId}_coverage`,
    });
    coverage.push({
      id: `${releaseId}_coverage`,
      release_id: releaseId,
      lab_id: labId,
      review_status: labId === "qwen" && sequence === 1 ? "incomplete" : "complete",
      reviewed_source_ids: [sourceId],
      review_date: "2026-09-01",
    });
    sources.push({
      id: sourceId,
      lab_id: labId,
      url: `https://${domain}/fixture/${releaseId}`,
      source_type: sequence ? "technical_report" : "launch_page",
      publication_date: date,
      revision: sequence
        ? { id: `${sourceId}_revision`, identifier: `fixture-revision-${labIndex + 1}` }
        : { id: `${sourceId}_revision`, unavailable_reason: "mutable_web_page", retrieval_date: "2026-09-01" },
    });

    const occurrenceCount = sequence ? 6 : 5;
    for (let offset = 0; offset < occurrenceCount; offset += 1) {
      const benchmark = benchmarks[(labIndex + offset + sequence) % benchmarks.length];
      const occurrenceId = `${releaseId}_${benchmark.id}`;
      occurrences.push({
        id: occurrenceId,
        lab_id: labId,
        release_id: releaseId,
        model_id: `${labId}_fixture_model`,
        lineage_id: `${labId}_frontier`,
        benchmark_id: benchmark.id,
        source_id: sourceId,
        source_revision_id: `${sourceId}_revision`,
        source_type: sequence ? "technical_report" : "launch_page",
        publication_date: date,
        locator: { kind: offset % 2 ? "table" : "section", value: `Evaluation inventory ${offset + 1}` },
        summary: offset === 5
          ? "The reviewed first-party material names this benchmark for the released model and provides a deliberately long score-free evidence summary that exercises wrapping without asserting anything about unreported internal evaluation activity."
          : "The reviewed first-party material names this benchmark for the released model.",
        evaluation_setup: {
          prompting: offset % 2 ? { status: "disclosed", value: "Published prompt protocol" } : { status: "not_disclosed" },
          shot_configuration: { status: "not_disclosed" },
          tool_use: offset % 3 ? { status: "not_disclosed" } : { status: "disclosed", value: "Published tool protocol" },
          evaluation_harness: { status: "not_disclosed" },
          sample_selection: { status: "not_disclosed" },
        },
        review_status: "verified",
      });
      derived_statuses.push({
        id: `${occurrenceId}_status`,
        lab_id: labId,
        release_id: releaseId,
        model_id: `${labId}_fixture_model`,
        lineage_id: `${labId}_frontier`,
        benchmark_id: benchmark.id,
        occurrence_id: occurrenceId,
        publication_date: date,
        consecutive_reviewed_omissions: 0,
        status_ids: [sequence ? "continued" : "first_reported"],
      });
    }
  });
});

const canonical_definitions = [
  ["first_reported", "First reported", "present_without_prior_occurrence", 0, "Present in reviewed public reporting with no earlier qualifying occurrence in the comparable lineage."],
  ["continued", "Continued", "present_after_immediately_prior_presence", 0, "Present in consecutive comparable reviewed releases."],
  ["returning", "Returning", "present_after_prior_omission", 0, "Present after a comparable reviewed successor omission."],
  ["not_reported_in_reviewed_successor", "Not reported in reviewed successor", "absent_after_prior_presence", 1, "A comparable fully reviewed successor does not name a previously reported benchmark."],
  ["dormant_in_public_reporting", "Dormant in public reporting", "consecutive_reviewed_omissions", 1, "The first consecutive comparable reviewed successor omission."],
  ["outdated_in_public_reporting", "Outdated in public reporting", "consecutive_reviewed_omissions", 2, "The second and each later consecutive comparable reviewed successor omission."],
  ["insufficient_evidence", "Insufficient evidence", "coverage_or_comparability_uncertain", 0, "Coverage, order, lineage, or comparability is not strong enough to derive an omission state."],
  ["quarantined", "Quarantined", "evidence_gap_requires_exclusion", 0, "A record is withheld from verified occurrences because a concrete evidence gap remains."],
].map(([id, label, kind, omission_count, description]) => ({
  id,
  label,
  version: "1.0.0",
  description,
  algorithm: { kind, comparable_scope: "same_lineage_modality_and_use_class", omission_count },
  examples: ["A bounded example in the reviewed public-reporting sequence."],
  cautions: ["This term describes reviewed public reporting only, not private evaluation activity or benchmark quality."],
}));

export const fixture = {
  schema_version: "1.0.0",
  definitions_version: "1.0.0",
  corpus: {
    id: "six_lab_ui_fixture",
    title: "Deterministic six-lab interface fixture",
    publication_window: { start: "2024-01-01", end: "2026-09-01" },
    retrieval_date: "2026-09-01",
  },
  labs,
  categories,
  lineages,
  models,
  releases,
  benchmarks,
  sources,
  coverage,
  occurrences,
  derived_statuses,
  canonical_definitions,
  release_candidates: releases.map((release) => ({
    id: release.candidate_id,
    lab_id: release.lab_id,
    publication_date: release.publication_date,
    title: release.name,
    source_id: `${release.id}_source`,
    disposition: "included",
  })),
  quarantine: [{
    id: "anthropic_fixture_quarantine",
    candidate_id: "anthropic_uncertain_candidate",
    lab_id: "anthropic",
    reason_code: "insufficient_public_model_identity",
    evidence_gap: "The reviewed material does not identify the model lineage precisely enough.",
    source_id: "anthropic_release_1_source",
  }],
};
