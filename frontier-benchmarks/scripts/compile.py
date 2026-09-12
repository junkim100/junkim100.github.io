#!/usr/bin/env python3
"""Validate and deterministically compile Observatory YAML sources."""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import re
import sys
import unicodedata
from collections import Counter, defaultdict
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any, Dict, Iterable, List, Mapping, Optional, Sequence, Tuple
from urllib.parse import unquote, urlparse

import yaml
from jsonschema import Draft202012Validator, FormatChecker

ROOT = Path(__file__).resolve().parents[1]
CATALOG_PATH = ROOT / "data" / "catalog.yaml"
DEFINITIONS_PATH = ROOT / "data" / "definitions.yaml"
CATALOG_SCHEMA_PATH = ROOT / "schema" / "observatory.schema.json"
DEFINITIONS_SCHEMA_PATH = ROOT / "schema" / "definitions.schema.json"
AUDIT_OVERLAY_PATH = ROOT / "data" / "audit-overlay.json"
AUDIT_OVERLAY_SCHEMA_PATH = ROOT / "schema" / "audit-overlay.schema.json"
PUBLIC_JSON_PATH = ROOT / "public" / "observatory.json"

REQUIRED_DEFINITIONS = {
    "first_reported",
    "continued",
    "returning",
    "not_reported_in_reviewed_successor",
    "dormant_in_public_reporting",
    "outdated_in_public_reporting",
    "insufficient_evidence",
    "quarantined",
}
CATALOG_COLLECTIONS = (
    "labs",
    "categories",
    "lineages",
    "models",
    "release_candidates",
    "releases",
    "benchmarks",
    "sources",
    "coverage",
    "quarantine",
    "occurrences",
)
SOURCE_EDGE_FIELDS = {
    "release_candidates": ("source_id",),
    "coverage": ("reviewed_source_ids",),
    "occurrences": ("source_id",),
    "quarantine": ("source_id",),
}
AUDIT_STRUCTURAL_COUNT_KEYS = {
    "baseline_audit_units",
    "named_candidates",
    "url_candidates",
    "partition_units",
    "current_catalog_rows",
    "typed_source_edges",
    "overlay_records",
    "unresolved_named_candidates",
    "unresolved",
    "retained",
    "corrected",
    "added",
    "used",
    "quarantined",
    "inaccessible",
    "duplicate",
    "irrelevant",
}
FORBIDDEN_KEY = re.compile(
    r"(?:^|_)(?:scores?|results?|ratings?|points?|rank(?:ing)?s?|win_rates?|accurac(?:y|ies)|performance|elo|pass_at|competitor_rows?)(?:$|_)",
    re.IGNORECASE,
)
AMBIGUOUS_BARE_NUMERIC_TEXT = (
    re.compile(r"^\s*[-+]?\d+(?:\.\d+)?\s*$"),
    re.compile(r"^\s*[-+]?\d+\s*/\s*\d+\s*$"),
)
FORBIDDEN_TEXT = [
    re.compile(r"\b\d+(?:\.\d+)?\s*%"),
    re.compile(
        r"\b(?:win\s*rate|accuracy|performance|elo|score|ranking?|ratings?|results?)"
        r"\s*(?:of|is|was|value|[:=])?\s*[-+]?\d",
        re.IGNORECASE,
    ),
    re.compile(r"\bpass\s*(?:@|[-_ ]at[-_ ])\s*\d", re.IGNORECASE),
    re.compile(r"(?:^|\s)#\s*\d+\b"),
    re.compile(r"\b(?:ranked?|ranking)\s+(?:first|second|third|\d+)", re.IGNORECASE),
    re.compile(r"\b(?:competitor|competing model)\s+(?:row|result|value)s?\b", re.IGNORECASE),
    re.compile(r"\b(?:achieved|attained|earned|obtained|scored|yielded)\s+[-+]?\d", re.IGNORECASE),
    re.compile(r"\b[-+]?\d+(?:\.\d+)?\s+(?:points?|rating)\b", re.IGNORECASE),
    *AMBIGUOUS_BARE_NUMERIC_TEXT,
]
SAFE_NUMERIC_KEYS = {
    "omission_count",
    "consecutive_reviewed_omissions",
    "distinct_model_count",
    "inclusive_days",
    *AUDIT_STRUCTURAL_COUNT_KEYS,
}
SAFE_STRUCTURAL_TEXT_KEYS = {
    "schema_version", "definitions_version", "version", "id", "identifier", "name", "label",
    "title", "publication_date", "retrieval_date", "review_date", "url", "source_revision",
    "row_id", "record_id", "record_ids", "provenance_record_ids", "canonical_name",
    "benchmark_id", "label",
}


class ValidationError(ValueError):
    """A deterministic, user-readable validation failure."""


class UniqueKeyLoader(yaml.SafeLoader):
    pass


def _construct_mapping(loader: UniqueKeyLoader, node: yaml.MappingNode, deep: bool = False) -> dict:
    mapping: dict = {}
    for key_node, value_node in node.value:
        key = loader.construct_object(key_node, deep=deep)
        if key in mapping:
            raise ValidationError(f"duplicate YAML key: {key!r}")
        mapping[key] = loader.construct_object(value_node, deep=deep)
    return mapping


UniqueKeyLoader.add_constructor(
    yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG, _construct_mapping
)


def load_yaml(path: Path) -> dict:
    try:
        value = yaml.load(path.read_text(encoding="utf-8"), Loader=UniqueKeyLoader)
    except (OSError, yaml.YAMLError) as exc:
        raise ValidationError(f"cannot load {path}: {exc}") from exc
    if not isinstance(value, dict):
        raise ValidationError(f"{path} must contain a mapping at its root")
    return value


def load_json(path: Path) -> dict:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ValidationError(f"cannot load {path}: {exc}") from exc


def validate_json_schema(document: dict, schema: dict, label: str) -> None:
    validator = Draft202012Validator(schema, format_checker=FormatChecker())
    errors = sorted(validator.iter_errors(document), key=lambda error: list(error.absolute_path))
    if errors:
        rendered = []
        for error in errors:
            location = ".".join(str(part) for part in error.absolute_path) or "<root>"
            rendered.append(f"{label}:{location}: {error.message}")
        raise ValidationError("schema validation failed:\n" + "\n".join(rendered))


def records_by_id(document: Mapping[str, Any], collection: str) -> Dict[str, dict]:
    result: Dict[str, dict] = {}
    for record in document[collection]:
        identifier = record["id"]
        if identifier in result:
            raise ValidationError(f"duplicate id in {collection}: {identifier}")
        result[identifier] = record
    return result


def parse_iso_date(value: str, location: str) -> date:
    try:
        return date.fromisoformat(value)
    except (TypeError, ValueError) as exc:
        raise ValidationError(f"invalid ISO date at {location}: {value!r}") from exc


def validate_date_windows(catalog: dict) -> None:
    start = parse_iso_date(catalog["corpus"]["publication_window"]["start"], "corpus.window.start")
    end = parse_iso_date(catalog["corpus"]["publication_window"]["end"], "corpus.window.end")
    if start > end:
        raise ValidationError("publication window start follows end")
    for collection in ("release_candidates", "releases", "sources", "occurrences"):
        for record in catalog[collection]:
            value = parse_iso_date(record["publication_date"], f"{collection}.{record['id']}.publication_date")
            if not start <= value <= end:
                raise ValidationError(
                    f"{collection}.{record['id']}.publication_date is outside the inclusive publication window"
                )
    retrieval = parse_iso_date(catalog["corpus"]["retrieval_date"], "corpus.retrieval_date")
    for source in catalog["sources"]:
        fallback = source["revision"].get("retrieval_date")
        if fallback and parse_iso_date(fallback, f"sources.{source['id']}.revision.retrieval_date") > retrieval:
            raise ValidationError(f"source {source['id']} retrieval date follows corpus retrieval date")
    for coverage in catalog["coverage"]:
        if parse_iso_date(coverage["review_date"], f"coverage.{coverage['id']}.review_date") > retrieval:
            raise ValidationError(f"coverage {coverage['id']} review date follows corpus retrieval date")


def validate_source_domains(catalog: dict) -> None:
    labs = records_by_id(catalog, "labs")
    for source in catalog["sources"]:
        parsed = urlparse(source["url"])
        if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password:
            raise ValidationError(
                f"source {source['id']} must use an absolute HTTPS URL without userinfo"
            )
        host = parsed.hostname.lower().rstrip(".")
        allowed = labs[source["lab_id"]]["official_domains"] if source["lab_id"] in labs else []
        if not any(host == domain or host.endswith("." + domain) for domain in allowed):
            raise ValidationError(
                f"source {source['id']} host {host!r} is not allowlisted for lab {source['lab_id']}"
            )


def _require_ref(record: dict, field: str, target: Mapping[str, Any], context: str) -> None:
    if record[field] not in target:
        raise ValidationError(f"{context}.{field} references missing id {record[field]!r}")


def validate_referential_integrity(catalog: dict) -> None:
    indexes = {
        collection: records_by_id(catalog, collection)
        for collection in (
            "labs", "categories", "lineages", "models", "release_candidates", "releases",
            "benchmarks", "sources", "coverage", "quarantine", "occurrences"
        )
    }
    labs, categories = indexes["labs"], indexes["categories"]
    lineages, models = indexes["lineages"], indexes["models"]
    candidates, releases = indexes["release_candidates"], indexes["releases"]
    benchmarks, sources = indexes["benchmarks"], indexes["sources"]
    coverage = indexes["coverage"]

    for lineage in catalog["lineages"]:
        _require_ref(lineage, "lab_id", labs, f"lineages.{lineage['id']}")
    for model in catalog["models"]:
        _require_ref(model, "lab_id", labs, f"models.{model['id']}")
        _require_ref(model, "lineage_id", lineages, f"models.{model['id']}")
        if lineages[model["lineage_id"]]["lab_id"] != model["lab_id"]:
            raise ValidationError(f"model {model['id']} lab does not match its lineage")
    for benchmark in catalog["benchmarks"]:
        _require_ref(benchmark, "category_id", categories, f"benchmarks.{benchmark['id']}")
    for source in catalog["sources"]:
        _require_ref(source, "lab_id", labs, f"sources.{source['id']}")
    revision_ids = [source["revision"]["id"] for source in catalog["sources"]]
    if len(revision_ids) != len(set(revision_ids)):
        raise ValidationError("source revision ids must be globally unique")
    for candidate in catalog["release_candidates"]:
        context = f"release_candidates.{candidate['id']}"
        _require_ref(candidate, "lab_id", labs, context)
        _require_ref(candidate, "source_id", sources, context)
        if sources[candidate["source_id"]]["lab_id"] != candidate["lab_id"]:
            raise ValidationError(f"candidate {candidate['id']} source belongs to another lab")
        if candidate["disposition"] == "duplicate_or_alias":
            _require_ref(candidate, "canonical_candidate_id", candidates, context)
            canonical = candidates[candidate["canonical_candidate_id"]]
            if canonical["disposition"] != "included" or canonical["lab_id"] != candidate["lab_id"]:
                raise ValidationError(f"candidate {candidate['id']} alias target must be an included candidate from the same lab")
    for release in catalog["releases"]:
        context = f"releases.{release['id']}"
        for field, target in (("candidate_id", candidates), ("lab_id", labs), ("model_id", models), ("lineage_id", lineages), ("coverage_id", coverage)):
            _require_ref(release, field, target, context)
        candidate = candidates[release["candidate_id"]]
        if candidate["disposition"] != "included":
            raise ValidationError(f"release {release['id']} must reference an included candidate")
        if candidate["lab_id"] != release["lab_id"] or candidate["publication_date"] != release["publication_date"]:
            raise ValidationError(f"release {release['id']} disagrees with its candidate")
        if models[release["model_id"]]["lineage_id"] != release["lineage_id"]:
            raise ValidationError(f"release {release['id']} model does not match its lineage")
        lineage = lineages[release["lineage_id"]]
        if any(lineage[field] != release[field] for field in ("lab_id", "modality_class", "use_class")):
            raise ValidationError(f"release {release['id']} is not comparable to its declared lineage")
    for item in catalog["coverage"]:
        context = f"coverage.{item['id']}"
        _require_ref(item, "release_id", releases, context)
        _require_ref(item, "lab_id", labs, context)
        for source_id in item["reviewed_source_ids"]:
            if source_id not in sources:
                raise ValidationError(f"{context}.reviewed_source_ids references missing id {source_id!r}")
        if releases[item["release_id"]]["coverage_id"] != item["id"] or releases[item["release_id"]]["lab_id"] != item["lab_id"]:
            raise ValidationError(f"coverage {item['id']} disagrees with its release")
    for item in catalog["quarantine"]:
        context = f"quarantine.{item['id']}"
        for field, target in (("candidate_id", candidates), ("lab_id", labs), ("source_id", sources)):
            _require_ref(item, field, target, context)
        candidate = candidates[item["candidate_id"]]
        if candidate["disposition"] != "quarantined" or candidate["reason_code"] != item["reason_code"]:
            raise ValidationError(f"quarantine {item['id']} does not reconcile with its candidate")
    seen_occurrence_keys = set()
    for occurrence in catalog["occurrences"]:
        context = f"occurrences.{occurrence['id']}"
        for field, target in (("lab_id", labs), ("release_id", releases), ("model_id", models), ("lineage_id", lineages), ("benchmark_id", benchmarks), ("source_id", sources)):
            _require_ref(occurrence, field, target, context)
        release, source = releases[occurrence["release_id"]], sources[occurrence["source_id"]]
        for field in ("lab_id", "model_id", "lineage_id"):
            if occurrence[field] != release[field]:
                raise ValidationError(f"occurrence {occurrence['id']} {field} disagrees with its release")
        if (
            occurrence["source_type"] != source["source_type"]
            or occurrence["source_revision_id"] != source["revision"]["id"]
            or occurrence["lab_id"] != source["lab_id"]
            or occurrence["publication_date"] != source["publication_date"]
        ):
            raise ValidationError(f"occurrence {occurrence['id']} disagrees with its source")
        if occurrence["source_id"] not in coverage[release["coverage_id"]]["reviewed_source_ids"]:
            raise ValidationError(f"occurrence {occurrence['id']} source is outside its reviewed source bundle")
        key = (occurrence["release_id"], occurrence["benchmark_id"])
        if key in seen_occurrence_keys:
            raise ValidationError(f"duplicate benchmark occurrence for release: {key}")
        seen_occurrence_keys.add(key)


def validate_terminal_dispositions(catalog: dict) -> None:
    releases_by_candidate: Dict[str, List[dict]] = defaultdict(list)
    for release in catalog["releases"]:
        releases_by_candidate[release["candidate_id"]].append(release)
    quarantine_by_candidate: Dict[str, List[dict]] = defaultdict(list)
    for item in catalog["quarantine"]:
        quarantine_by_candidate[item["candidate_id"]].append(item)
    for candidate in catalog["release_candidates"]:
        release_count = len(releases_by_candidate[candidate["id"]])
        quarantine_count = len(quarantine_by_candidate[candidate["id"]])
        disposition = candidate["disposition"]
        if disposition == "included" and (release_count < 1 or quarantine_count != 0):
            raise ValidationError(f"included candidate {candidate['id']} must map to at least one release")
        if disposition == "quarantined" and (release_count != 0 or quarantine_count != 1):
            raise ValidationError(f"quarantined candidate {candidate['id']} must map to exactly one quarantine record")
        if disposition in {"excluded", "duplicate_or_alias"} and (release_count or quarantine_count):
            raise ValidationError(f"{disposition} candidate {candidate['id']} must not map to release or quarantine records")
    counts = defaultdict(int)
    for candidate in catalog["release_candidates"]:
        counts[candidate["disposition"]] += 1
    if sum(counts.values()) != len(catalog["release_candidates"]):
        raise ValidationError("candidate disposition reconciliation failed")


RECENT_MODEL_WINDOW_START = date.fromisoformat("2026-06-06")
RECENT_MODEL_WINDOW_END = date.fromisoformat("2026-09-03")
RECENT_MODEL_COUNT_LABEL = "models in latest 90 days"


def typed_source_edge_ids(catalog: Mapping[str, Any]) -> List[str]:
    edges = []
    for collection, fields in SOURCE_EDGE_FIELDS.items():
        for record in catalog[collection]:
            for field in fields:
                values = record[field] if isinstance(record[field], list) else [record[field]]
                for source_id in values:
                    edges.append(f"{collection}:{record['id']}:{field}:{source_id}")
    return edges


def validate_audit_overlay(catalog: dict, overlay: dict) -> None:
    validate_json_schema(overlay, load_json(AUDIT_OVERLAY_SCHEMA_PATH), "audit overlay")

    # Discovery URL units are evidence associations, never catalog entities or approvals.
    discovery_ids = set()
    discovery_proposals = set()
    for evidence in overlay.get("discovery_evidence", []):
        unit_id = evidence["unit_id"]
        if unit_id in discovery_ids:
            raise ValidationError(f"duplicate discovery evidence unit {unit_id!r}")
        discovery_ids.add(unit_id)
        unread = evidence["semantic_status"] == "UNPROCESSED"
        if unread != (evidence["semantic_outcome"] == "UNPROCESSED"):
            raise ValidationError(f"contradictory discovery unread state {unit_id!r}")
        if unread and (evidence["reporting_lab"] is not None or evidence["proposal_ids"]):
            raise ValidationError(f"unread discovery has semantic association {unit_id!r}")
        for proposal_id in evidence["proposal_ids"]:
            if proposal_id in discovery_proposals:
                raise ValidationError(f"duplicate discovery proposal {proposal_id!r}")
            discovery_proposals.add(proposal_id)

    window = overlay["recent_window"]
    window_start = parse_iso_date(window["start"], "audit_overlay.recent_window.start")
    window_end = parse_iso_date(window["end"], "audit_overlay.recent_window.end")
    actual_days = (window_end - window_start).days + 1
    if actual_days != 90 or window["inclusive_days"] != actual_days:
        raise ValidationError(f"recent model window must span 90 inclusive dates, found {actual_days}")
    cutoff = datetime.fromisoformat(overlay["intake_cutoff"].replace("Z", "+00:00"))
    if cutoff.utcoffset() != timedelta(0):
        raise ValidationError("audit overlay intake cutoff must use UTC")
    if window_end != cutoff.date():
        raise ValidationError("audit overlay recent window end must match intake cutoff date")
    corpus_start = parse_iso_date(catalog["corpus"]["publication_window"]["start"], "corpus.window.start")
    corpus_end = parse_iso_date(catalog["corpus"]["publication_window"]["end"], "corpus.window.end")
    if window_start < corpus_start or window_end > corpus_end or window_end != corpus_end:
        raise ValidationError("audit overlay recent window must match the catalog publication window end")

    for evidence in overlay.get("discovery_evidence", []):
        publication = evidence.get("publication_window")
        if publication is None:
            continue  # Older bounded adjudications need not invent date precision.
        start, end = publication["interval_start"], publication["interval_end"]
        if publication["verdict"] == "UNRESOLVED":
            if start is not None or end is not None:
                raise ValidationError("unresolved discovery publication window contains inferred dates")
            continue
        if start is None or end is None:
            raise ValidationError("resolved discovery publication window requires a complete interval")
        start = parse_iso_date(start, "discovery.publication_window.interval_start")
        end = parse_iso_date(end, "discovery.publication_window.interval_end")
        if start > end:
            raise ValidationError("discovery publication window has an inverted interval")
        expected = (
            "IN_WINDOW" if corpus_start <= start <= end <= corpus_end
            else "OUTSIDE_WINDOW" if end < corpus_start or start > corpus_end
            else "UNRESOLVED"
        )
        if publication["verdict"] != expected:
            raise ValidationError("discovery publication window verdict contradicts its complete interval")

    expected_record_keys = {
        (collection, record["id"])
        for collection in CATALOG_COLLECTIONS
        for record in catalog[collection]
    }
    edge_ids = typed_source_edge_ids(catalog)
    if len(edge_ids) != len(set(edge_ids)):
        raise ValidationError("catalog has duplicate typed source edges")
    expected_record_keys.update(("source_associations", edge_id) for edge_id in edge_ids)

    ledger_ids = set()
    record_keys = set()
    baseline_dispositions: Counter = Counter()
    candidate_added = 0
    for record in overlay["records"]:
        if record["ledger_id"] in ledger_ids:
            raise ValidationError(f"duplicate audit overlay ledger_id {record['ledger_id']!r}")
        ledger_ids.add(record["ledger_id"])
        key = (record["entity_type"], record["record_id"])
        if key in record_keys:
            raise ValidationError(f"duplicate audit overlay record key {key!r}")
        record_keys.add(key)
        if record["resulting_ids"] != [record["record_id"]]:
            raise ValidationError(f"audit overlay record {record['ledger_id']!r} has mismatched resulting_ids")
        if record["origin"] == "baseline":
            baseline_dispositions[record["disposition"]] += 1
            expected_implementation = (
                "patch_listed_fields_only"
                if record["disposition"] == "corrected"
                else "preserve_baseline_with_uncertainty"
            )
            if record["disposition"] == "added" or record["implementation_disposition"] != expected_implementation:
                raise ValidationError(f"audit overlay baseline disposition mismatch at {record['ledger_id']!r}")
        else:
            candidate_added += 1
            if record["disposition"] != "added" or record["implementation_disposition"] != "add_scoped":
                raise ValidationError(f"audit overlay candidate disposition mismatch at {record['ledger_id']!r}")

    missing = expected_record_keys - record_keys
    orphaned = record_keys - expected_record_keys
    if missing:
        raise ValidationError(f"audit overlay missing current record keys: {sorted(missing)[:3]!r}")
    if orphaned:
        raise ValidationError(f"audit overlay has orphan record keys: {sorted(orphaned)[:3]!r}")

    sources = {source["id"]: source["url"] for source in catalog["sources"]}
    source_check_keys = set()
    current_source_checks = set()
    for check in overlay["source_checks"]:
        source_id = check["source_id"]
        if source_id not in sources:
            raise ValidationError(f"audit overlay source check references missing source {source_id!r}")
        key = (source_id, check["exact_url"])
        if key in source_check_keys:
            raise ValidationError(f"duplicate audit overlay source check {key!r}")
        source_check_keys.add(key)
        if check["exact_url"] == sources[source_id]:
            current_source_checks.add(key)
        if check["access_status"] is None and any(
            check[field] is not None for field in ("accessed_at", "fingerprint", "fingerprint_kind")
        ):
            raise ValidationError(f"unknown source check {key!r} contains guessed retrieval metadata")
        if (check["fingerprint"] is None) != (check["fingerprint_kind"] is None):
            raise ValidationError(f"source check {key!r} has incomplete fingerprint metadata")
    expected_source_checks = set(sources.items())
    missing_source_checks = expected_source_checks - current_source_checks
    if missing_source_checks:
        raise ValidationError(f"audit overlay missing current source checks: {sorted(missing_source_checks)[:3]!r}")

    summary = overlay["summary"]
    current_catalog_rows = sum(len(catalog[collection]) for collection in CATALOG_COLLECTIONS)
    expected_summary_values = {
        "baseline_audit_units": sum(baseline_dispositions.values()),
        "baseline_audit_dispositions": dict(baseline_dispositions),
        "current_catalog_rows": current_catalog_rows,
        "typed_source_edges": len(edge_ids),
        "overlay_records": len(overlay["records"]),
        "unresolved_named_candidates": summary["candidate_dispositions"]["unresolved"],
    }
    for field, expected in expected_summary_values.items():
        if summary[field] != expected:
            raise ValidationError(f"audit overlay summary {field} does not reconcile")
    if sum(summary["candidate_dispositions"].values()) != summary["named_candidates"]:
        raise ValidationError("audit overlay named candidate dispositions do not reconcile")
    if summary["candidate_dispositions"]["added"] != candidate_added:
        raise ValidationError("audit overlay added candidate count does not reconcile")
    if sum(summary["url_dispositions"].values()) != summary["url_candidates"]:
        raise ValidationError("audit overlay URL dispositions do not reconcile")
    if (
        summary["baseline_audit_units"] + summary["named_candidates"] + summary["url_candidates"]
        != summary["partition_units"]
    ):
        raise ValidationError("audit overlay partition units do not reconcile")
    if summary["baseline_audit_units"] + candidate_added != summary["overlay_records"]:
        raise ValidationError("audit overlay projected record count does not reconcile")


def identity_status(record: Mapping[str, Any]) -> str:
    return str(record.get("identity_status") or "canonical")


def canonical_benchmark_id(record: Mapping[str, Any]) -> str | None:
    status = identity_status(record)
    if status == "quarantined":
        return None
    if status == "merged":
        return record.get("canonical_benchmark_id")
    return record["id"]


def is_live_canonical(record: Mapping[str, Any]) -> bool:
    return identity_status(record) == "canonical"


def normalize_search_term(value: str) -> str:
    normalized = unicodedata.normalize("NFKD", value).casefold()
    normalized = "".join(character for character in normalized if not unicodedata.combining(character))
    normalized = normalized.replace("+", " plus ")
    return " ".join(re.sub(r"[^a-z0-9]+", " ", normalized).split())


def build_search_index(catalog: dict) -> List[dict]:
    name_owner: Dict[Tuple[str, str], str] = {}
    alias_candidates: Dict[Tuple[str, str], List[str]] = defaultdict(list)
    for collection, kind in (("categories", "category"), ("benchmarks", "benchmark")):
        for record in catalog[collection]:
            if kind == "benchmark" and not is_live_canonical(record):
                continue
            name_term = normalize_search_term(record["name"])
            if not name_term:
                raise ValidationError(f"{kind} {record['id']} has an empty normalized search term")
            name_key = (kind, name_term)
            existing = name_owner.get(name_key)
            if existing and existing != record["id"]:
                raise ValidationError(
                    f"normalized search term collision for {kind} {name_term!r}: {existing} and {record['id']}"
                )
            name_owner[name_key] = record["id"]
            for alias in record["aliases"]:
                term = normalize_search_term(alias)
                if not term:
                    raise ValidationError(f"{kind} {record['id']} has an empty normalized search term")
                alias_candidates[(kind, term)].append(record["id"])
    chosen: Dict[Tuple[str, str], str] = dict(name_owner)
    for key, record_ids in alias_candidates.items():
        unique_ids = sorted(set(record_ids))
        if key in chosen:
            continue
        if len(unique_ids) > 1:
            raise ValidationError(
                f"normalized search term collision for {key[0]} {key[1]!r}: {unique_ids[0]} and {unique_ids[1]}"
            )
        chosen[key] = unique_ids[0]
    rows = [{"term": term, "kind": kind, "record_id": record_id} for (kind, term), record_id in chosen.items()]
    return sorted(rows, key=lambda row: (row["term"], row["kind"], row["record_id"]))


def validate_benchmark_identities(catalog: dict) -> None:
    benchmarks = records_by_id(catalog, "benchmarks")
    for benchmark in catalog["benchmarks"]:
        status = identity_status(benchmark)
        if status == "merged":
            target_id = benchmark.get("canonical_benchmark_id")
            if not target_id or target_id not in benchmarks:
                raise ValidationError(f"merged benchmark {benchmark['id']} references missing canonical_benchmark_id")
            target = benchmarks[target_id]
            if not is_live_canonical(target):
                raise ValidationError(f"merged benchmark {benchmark['id']} must map onto a live canonical identity")
        elif "canonical_benchmark_id" in benchmark and status != "merged":
            raise ValidationError(f"benchmark {benchmark['id']} has canonical_benchmark_id without merged status")


def build_recent_model_counts(catalog: dict, recent_window: Optional[Mapping[str, Any]] = None) -> dict:
    benchmarks = records_by_id(catalog, "benchmarks")
    if recent_window is None:
        window_start = RECENT_MODEL_WINDOW_START
        window_end = RECENT_MODEL_WINDOW_END
    else:
        window_start = parse_iso_date(recent_window["start"], "recent_window.start")
        window_end = parse_iso_date(recent_window["end"], "recent_window.end")
    models_by_benchmark: Dict[str, set[str]] = defaultdict(set)
    for occurrence in catalog["occurrences"]:
        if occurrence.get("review_status") != "verified":
            continue
        published = parse_iso_date(occurrence["publication_date"], f"occurrences.{occurrence['id']}.publication_date")
        if not window_start <= published <= window_end:
            continue
        source = benchmarks.get(occurrence["benchmark_id"])
        if source is None:
            raise ValidationError(f"occurrence {occurrence['id']} references missing benchmark {occurrence['benchmark_id']}")
        canonical_id = canonical_benchmark_id(source)
        if not canonical_id or canonical_id not in benchmarks or not is_live_canonical(benchmarks[canonical_id]):
            continue
        models_by_benchmark[canonical_id].add(occurrence["model_id"])
    window_days = (window_end - window_start).days + 1
    if window_days != 90 or (recent_window is not None and recent_window["inclusive_days"] != window_days):
        raise ValidationError(f"recent model window must span 90 inclusive dates, found {window_days}")
    counts = []
    for benchmark in catalog["benchmarks"]:
        if not is_live_canonical(benchmark):
            continue
        counts.append(
            {
                "benchmark_id": benchmark["id"],
                "canonical_name": benchmark["name"],
                "distinct_model_count": len(models_by_benchmark.get(benchmark["id"], set())),
            }
        )
    counts.sort(key=lambda row: row["benchmark_id"])
    return {
        "window": {
            "start": window_start.isoformat(),
            "end": window_end.isoformat(),
            "inclusive_days": window_days,
        },
        "label": RECENT_MODEL_COUNT_LABEL,
        "counts": counts,
    }


def validate_definitions(definitions: dict) -> None:
    records = records_by_id(definitions, "definitions")
    missing = sorted(REQUIRED_DEFINITIONS - set(records))
    extra = sorted(set(records) - REQUIRED_DEFINITIONS)
    if missing or extra:
        raise ValidationError(f"definition set mismatch; missing={missing}, unexpected={extra}")
    expected = {
        "not_reported_in_reviewed_successor": 1,
        "dormant_in_public_reporting": 1,
        "outdated_in_public_reporting": 2,
    }
    for identifier, omission_count in expected.items():
        if records[identifier]["algorithm"]["omission_count"] != omission_count:
            raise ValidationError(f"definition {identifier} has inconsistent omission_count")
    for record in records.values():
        if record["version"] != definitions["definitions_version"]:
            raise ValidationError(f"definition {record['id']} version does not match definitions_version")
        if record["algorithm"]["comparable_scope"] != "same_lineage_modality_and_use_class":
            raise ValidationError(f"definition {record['id']} has inconsistent comparable scope")


def assert_no_score_like(value: Any, path: Tuple[str, ...] = ()) -> None:
    if isinstance(value, Mapping):
        for key, child in value.items():
            if FORBIDDEN_KEY.search(str(key)):
                raise ValidationError(f"forbidden field name at {'.'.join((*path, str(key)))}")
            assert_no_score_like(child, (*path, str(key)))
        return
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        for index, child in enumerate(value):
            assert_no_score_like(child, (*path, str(index)))
        return
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        if not path or path[-1] not in SAFE_NUMERIC_KEYS:
            raise ValidationError(f"numeric value is not structurally allowlisted at {'.'.join(path)}")
        return
    if isinstance(value, str):
        for pattern in FORBIDDEN_TEXT:
            leaf = path[-1] if path else ""
            parent = path[-2] if len(path) > 1 else ""
            structural_text = (
                leaf in SAFE_STRUCTURAL_TEXT_KEYS
                or leaf.endswith("_id")
                or leaf.endswith("_ids")
                or parent in {"aliases", "official_domains"}
            )
            if structural_text and pattern in AMBIGUOUS_BARE_NUMERIC_TEXT:
                continue
            # Inspect decoded URL text without rewriting its literal identity.
            # An escaped space after a model number is not a percentage; an
            # encoded percentage or score claim must still be rejected.
            inspected = unquote(value) if leaf in {"url", "exact_url"} else value
            if pattern.search(inspected):
                raise ValidationError(f"forbidden score-like text at {'.'.join(path)}")


def _provenanced_records(records: Iterable[dict], record_type: str, source_file: str) -> List[dict]:
    output = []
    for record in sorted(records, key=lambda item: item["id"]):
        copied = copy.deepcopy(record)
        copied["provenance"] = {
            "source_file": source_file,
            "record_type": record_type,
            "record_ids": [record["id"]],
        }
        output.append(copied)
    return output


def derive_statuses(catalog: dict) -> List[dict]:
    occurrences_by_release: Dict[str, Dict[str, dict]] = defaultdict(dict)
    for occurrence in catalog["occurrences"]:
        if occurrence["review_status"] == "verified":
            occurrences_by_release[occurrence["release_id"]][occurrence["benchmark_id"]] = occurrence
    coverage = records_by_id(catalog, "coverage")
    groups: Dict[Tuple[str, str, str], List[dict]] = defaultdict(list)
    for release in catalog["releases"]:
        groups[(release["lineage_id"], release["modality_class"], release["use_class"])].append(release)
    rows: List[dict] = []
    for key in sorted(groups):
        seen = set()
        omissions: Dict[str, int] = defaultdict(int)
        uncertain = set()
        previous_present = set()
        for release in sorted(groups[key], key=lambda item: (item["publication_date"], item["id"])):
            present = set(occurrences_by_release[release["id"]])
            complete = coverage[release["coverage_id"]]["review_status"] == "complete"
            for benchmark_id in sorted(seen | present):
                occurrence = occurrences_by_release[release["id"]].get(benchmark_id)
                if benchmark_id in present:
                    if occurrence is None:
                        raise ValidationError(
                            f"internal occurrence index mismatch for {release['id']} and {benchmark_id}"
                        )
                    if benchmark_id not in seen:
                        status_ids = ["first_reported"]
                    elif benchmark_id in uncertain:
                        status_ids = ["insufficient_evidence"]
                    elif benchmark_id in previous_present and omissions[benchmark_id] == 0:
                        status_ids = ["continued"]
                    else:
                        status_ids = ["returning"]
                    omissions[benchmark_id] = 0
                    uncertain.discard(benchmark_id)
                    source_ids = [release["id"], occurrence["id"]]
                    occurrence_id = occurrence["id"]
                elif not complete or benchmark_id in uncertain:
                    status_ids = ["insufficient_evidence"]
                    uncertain.add(benchmark_id)
                    source_ids = [release["id"], release["coverage_id"]]
                    occurrence_id = None
                else:
                    omissions[benchmark_id] += 1
                    lifecycle = "dormant_in_public_reporting" if omissions[benchmark_id] == 1 else "outdated_in_public_reporting"
                    status_ids = ["not_reported_in_reviewed_successor", lifecycle]
                    source_ids = [release["id"], release["coverage_id"]]
                    occurrence_id = None
                row_id = f"status_{release['id']}_{benchmark_id}"
                row = {
                    "id": row_id,
                    "lab_id": release["lab_id"],
                    "lineage_id": release["lineage_id"],
                    "model_id": release["model_id"],
                    "release_id": release["id"],
                    "publication_date": release["publication_date"],
                    "benchmark_id": benchmark_id,
                    "occurrence_id": occurrence_id,
                    "status_ids": status_ids,
                    "consecutive_reviewed_omissions": omissions[benchmark_id],
                    "provenance": {
                        "source_file": "data/catalog.yaml",
                        "record_type": "derived_status",
                        "record_ids": sorted(source_ids),
                    },
                }
                rows.append(row)
            seen.update(present)
            previous_present = present
    return sorted(rows, key=lambda row: (row["publication_date"], row["release_id"], row["benchmark_id"]))


def validate_derived_status_reproduction(catalog: dict, generated_rows: Sequence[dict]) -> None:
    expected = derive_statuses(catalog)
    if list(generated_rows) != expected:
        raise ValidationError("derived reporting statuses cannot be reproduced from canonical records")


def build_document(catalog: dict, definitions: dict, overlay: Optional[dict] = None) -> dict:
    search_index = build_search_index(catalog)
    derived_statuses = derive_statuses(catalog)
    generated_from = {
        "catalog": "data/catalog.yaml",
        "definitions": "data/definitions.yaml",
        "compiler": "scripts/compile.py",
    }
    if overlay is not None:
        generated_from["audit_overlay"] = "data/audit-overlay.json"
    output = {
        "schema_version": catalog["schema_version"],
        "generated_from": generated_from,
        "corpus": copy.deepcopy(catalog["corpus"]),
        "definitions_version": definitions["definitions_version"],
        "canonical_definitions": _provenanced_records(definitions["definitions"], "definition", "data/definitions.yaml"),
    }
    for collection in CATALOG_COLLECTIONS:
        output[collection] = _provenanced_records(catalog[collection], collection, "data/catalog.yaml")
    output["derived_statuses"] = derived_statuses
    output["search_index"] = [
        {
            **row,
            "provenance": {
                "source_file": "data/catalog.yaml",
                "record_type": "normalized_search_term",
                "record_ids": [row["record_id"]],
            },
        }
        for row in search_index
    ]
    output["recent_model_counts"] = build_recent_model_counts(
        catalog, overlay["recent_window"] if overlay is not None else None
    )
    if overlay is not None:
        output["audit_overlay"] = copy.deepcopy(overlay)
    return output


def validate_generated_provenance(document: dict) -> None:
    for collection, records in document.items():
        if not isinstance(records, list):
            continue
        for index, record in enumerate(records):
            provenance = record.get("provenance") if isinstance(record, dict) else None
            if not provenance or not provenance.get("source_file") or not provenance.get("record_type") or not provenance.get("record_ids"):
                raise ValidationError(f"generated row lacks provenance: {collection}[{index}]")


def canonical_json_bytes(document: dict) -> bytes:
    return (json.dumps(document, ensure_ascii=False, sort_keys=True, indent=2) + "\n").encode("utf-8")




def validate_score_free_repository_payloads(root: Path = ROOT) -> None:
    """Scan canonical, fixture, snapshot, and renderable payloads, not validator source."""
    paths = set((root / "data").glob("*.yaml"))
    paths.update((root / "data").glob("*.json"))
    for directory in (root / "tests" / "fixtures", root / "tests" / "snapshots", root / "public"):
        if directory.exists():
            paths.update(path for path in directory.rglob("*") if path.is_file())
    paths.update(path for path in root.rglob("*.html") if path.is_file())
    paths.update(path for path in root.rglob("*.md") if path.is_file())
    for path in sorted(paths):
        suffix = path.suffix.lower()
        relative = str(path.relative_to(root))
        if suffix in {".yaml", ".yml"}:
            payload: Any = load_yaml(path)
        elif suffix == ".json":
            payload = load_json(path)
        elif suffix in {".html", ".md", ".txt"}:
            payload = path.read_text(encoding="utf-8")
        else:
            continue
        assert_no_score_like(payload, ("repository_payload", relative))


def validate_all(catalog: dict, definitions: dict, overlay: Optional[dict] = None) -> None:
    validate_json_schema(catalog, load_json(CATALOG_SCHEMA_PATH), "catalog")
    validate_json_schema(definitions, load_json(DEFINITIONS_SCHEMA_PATH), "definitions")
    validate_definitions(definitions)
    validate_date_windows(catalog)
    validate_referential_integrity(catalog)
    validate_source_domains(catalog)
    validate_terminal_dispositions(catalog)
    validate_benchmark_identities(catalog)
    build_search_index(catalog)
    build_recent_model_counts(catalog, overlay["recent_window"] if overlay is not None else None)
    if overlay is not None:
        validate_audit_overlay(catalog, overlay)
        assert_no_score_like(overlay, ("audit_overlay",))
    assert_no_score_like(catalog, ("catalog",))
    assert_no_score_like(definitions, ("definitions",))


def compile_catalog(
    catalog_path: Path = CATALOG_PATH,
    definitions_path: Path = DEFINITIONS_PATH,
    overlay_path: Optional[Path] = None,
) -> Tuple[bytes, dict]:
    catalog = load_yaml(catalog_path)
    definitions = load_yaml(definitions_path)
    if overlay_path is None and catalog_path.resolve() == CATALOG_PATH.resolve():
        overlay_path = AUDIT_OVERLAY_PATH
    overlay = load_json(overlay_path) if overlay_path is not None else None
    validate_all(catalog, definitions, overlay)
    document = build_document(catalog, definitions, overlay)
    validate_derived_status_reproduction(catalog, document["derived_statuses"])
    validate_generated_provenance(document)
    assert_no_score_like(document, ("generated_json",))
    return canonical_json_bytes(document), document


def _sha256(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--catalog", type=Path, default=CATALOG_PATH)
    parser.add_argument("--definitions", type=Path, default=DEFINITIONS_PATH)
    parser.add_argument("--overlay", type=Path)
    parser.add_argument("--output-dir", type=Path, default=PUBLIC_JSON_PATH.parent)
    parser.add_argument("--check", action="store_true", help="fail if committed generated files differ")
    args = parser.parse_args(argv)
    try:
        json_bytes, _ = compile_catalog(args.catalog, args.definitions, args.overlay)
        targets = {
            args.output_dir / PUBLIC_JSON_PATH.name: json_bytes,
        }
        if args.check:
            stale = [str(path) for path, payload in targets.items() if not path.exists() or path.read_bytes() != payload]
            if stale:
                raise ValidationError("generated artifacts are stale: " + ", ".join(stale))
        else:
            args.output_dir.mkdir(parents=True, exist_ok=True)
            for path, payload in targets.items():
                path.write_bytes(payload)
        print(f"observatory.json sha256={_sha256(json_bytes)} bytes={len(json_bytes)}")
        return 0
    except ValidationError as exc:
        print(f"validation error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
