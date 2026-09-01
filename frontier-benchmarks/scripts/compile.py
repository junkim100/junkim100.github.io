#!/usr/bin/env python3
"""Validate and deterministically compile Observatory YAML sources."""

from __future__ import annotations

import argparse
import copy
import csv
import hashlib
import io
import json
import re
import sys
import unicodedata
from collections import defaultdict
from datetime import date
from pathlib import Path
from typing import Any, Dict, Iterable, List, Mapping, Sequence, Tuple
from urllib.parse import urlparse

import yaml
from jsonschema import Draft202012Validator, FormatChecker

ROOT = Path(__file__).resolve().parents[1]
CATALOG_PATH = ROOT / "data" / "catalog.yaml"
DEFINITIONS_PATH = ROOT / "data" / "definitions.yaml"
CATALOG_SCHEMA_PATH = ROOT / "schema" / "observatory.schema.json"
DEFINITIONS_SCHEMA_PATH = ROOT / "schema" / "definitions.schema.json"
PUBLIC_JSON_PATH = ROOT / "public" / "observatory.json"
PUBLIC_CSV_PATH = ROOT / "public" / "observatory.csv"

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
FORBIDDEN_KEY = re.compile(
    r"(?:^|_)(?:scores?|rank(?:ing)?s?|win_rates?|accurac(?:y|ies)|performance|elo|pass_at|competitor_rows?)(?:$|_)",
    re.IGNORECASE,
)
FORBIDDEN_TEXT = [
    re.compile(r"\b\d+(?:\.\d+)?\s*%"),
    re.compile(r"\b(?:win\s*rate|accuracy|performance|elo|score|ranking?)\s*(?:of|is|was|[:=])?\s*[-+]?\d", re.IGNORECASE),
    re.compile(r"\bpass\s*(?:@|[-_ ]at[-_ ])\s*\d", re.IGNORECASE),
    re.compile(r"(?:^|\s)#\s*\d+\b"),
    re.compile(r"\b(?:ranked?|ranking)\s+(?:first|second|third|\d+)", re.IGNORECASE),
    re.compile(r"\b(?:competitor|competing model)\s+(?:row|result|value)s?\b", re.IGNORECASE),
    re.compile(r"\b\d+\.\d+\b"),
    re.compile(r"\b\d+\s*/\s*\d+\b"),
]
SAFE_NUMERIC_KEYS = {"omission_count", "consecutive_reviewed_omissions"}
SAFE_STRUCTURAL_TEXT_KEYS = {
    "schema_version", "definitions_version", "version", "id", "identifier", "name", "label",
    "title", "publication_date", "retrieval_date", "review_date", "url", "source_revision",
    "row_id", "record_id", "record_ids", "provenance_record_ids",
}
CSV_FIELDS = [
    "row_type",
    "row_id",
    "lab_id",
    "lineage_id",
    "model_id",
    "release_id",
    "publication_date",
    "benchmark_id",
    "source_id",
    "source_type",
    "source_url",
    "source_revision",
    "locator",
    "summary",
    "evaluation_setup",
    "derived_status_ids",
    "provenance_file",
    "provenance_record_type",
    "provenance_record_ids",
]


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
        host = (urlparse(source["url"]).hostname or "").lower().rstrip(".")
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
        if disposition == "included" and (release_count != 1 or quarantine_count != 0):
            raise ValidationError(f"included candidate {candidate['id']} must map to exactly one release")
        if disposition == "quarantined" and (release_count != 0 or quarantine_count != 1):
            raise ValidationError(f"quarantined candidate {candidate['id']} must map to exactly one quarantine record")
        if disposition in {"excluded", "duplicate_or_alias"} and (release_count or quarantine_count):
            raise ValidationError(f"{disposition} candidate {candidate['id']} must not map to release or quarantine records")
    counts = defaultdict(int)
    for candidate in catalog["release_candidates"]:
        counts[candidate["disposition"]] += 1
    if sum(counts.values()) != len(catalog["release_candidates"]):
        raise ValidationError("candidate disposition reconciliation failed")


def normalize_search_term(value: str) -> str:
    normalized = unicodedata.normalize("NFKD", value).casefold()
    normalized = "".join(character for character in normalized if not unicodedata.combining(character))
    return " ".join(re.sub(r"[^a-z0-9]+", " ", normalized).split())


def build_search_index(catalog: dict) -> List[dict]:
    owner_by_term: Dict[Tuple[str, str], str] = {}
    rows: List[dict] = []
    for collection, kind in (("categories", "category"), ("benchmarks", "benchmark")):
        for record in catalog[collection]:
            terms = sorted({normalize_search_term(value) for value in [record["name"], *record["aliases"]]})
            if "" in terms:
                raise ValidationError(f"{kind} {record['id']} has an empty normalized search term")
            for term in terms:
                key = (kind, term)
                owner = owner_by_term.get(key)
                if owner and owner != record["id"]:
                    raise ValidationError(
                        f"normalized search term collision for {kind} {term!r}: {owner} and {record['id']}"
                    )
                owner_by_term[key] = record["id"]
                rows.append({"term": term, "kind": kind, "record_id": record["id"]})
    return sorted(rows, key=lambda row: (row["term"], row["kind"], row["record_id"]))


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
            if structural_text and pattern in FORBIDDEN_TEXT[-2:]:
                continue
            if pattern.search(value):
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


def build_document(catalog: dict, definitions: dict) -> dict:
    search_index = build_search_index(catalog)
    derived_statuses = derive_statuses(catalog)
    output = {
        "schema_version": catalog["schema_version"],
        "generated_from": {
            "catalog": "data/catalog.yaml",
            "definitions": "data/definitions.yaml",
            "compiler": "scripts/compile.py",
        },
        "corpus": copy.deepcopy(catalog["corpus"]),
        "definitions_version": definitions["definitions_version"],
        "canonical_definitions": _provenanced_records(definitions["definitions"], "definition", "data/definitions.yaml"),
    }
    for collection in ("labs", "categories", "lineages", "models", "release_candidates", "releases", "benchmarks", "sources", "coverage", "quarantine", "occurrences"):
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


def _revision_text(source: dict) -> str:
    revision = source["revision"]
    if "identifier" in revision:
        return revision["identifier"]
    return f"unavailable:{revision['unavailable_reason']}@{revision['retrieval_date']}"


def build_csv_bytes(catalog: dict, document: dict) -> bytes:
    sources = records_by_id(catalog, "sources")
    occurrences = records_by_id(catalog, "occurrences")
    rows = []
    for release in sorted(catalog["releases"], key=lambda item: (item["publication_date"], item["id"])):
        candidate = next(item for item in catalog["release_candidates"] if item["id"] == release["candidate_id"])
        source = sources[candidate["source_id"]]
        rows.append({
            "row_type": "release", "row_id": release["id"], "lab_id": release["lab_id"],
            "lineage_id": release["lineage_id"], "model_id": release["model_id"], "release_id": release["id"],
            "publication_date": release["publication_date"], "benchmark_id": "", "source_id": source["id"],
            "source_type": source["source_type"], "source_url": source["url"], "source_revision": _revision_text(source),
            "locator": "", "summary": "", "evaluation_setup": "", "derived_status_ids": "",
            "provenance_file": "data/catalog.yaml", "provenance_record_type": "release",
            "provenance_record_ids": release["id"],
        })
    for occurrence in sorted(catalog["occurrences"], key=lambda item: (item["publication_date"], item["id"])):
        source = sources[occurrence["source_id"]]
        rows.append({
            "row_type": "occurrence", "row_id": occurrence["id"], "lab_id": occurrence["lab_id"],
            "lineage_id": occurrence["lineage_id"], "model_id": occurrence["model_id"], "release_id": occurrence["release_id"],
            "publication_date": occurrence["publication_date"], "benchmark_id": occurrence["benchmark_id"],
            "source_id": source["id"], "source_type": source["source_type"], "source_url": source["url"],
            "source_revision": _revision_text(source), "locator": json.dumps(occurrence["locator"], sort_keys=True, separators=(",", ":")),
            "summary": occurrence["summary"], "evaluation_setup": json.dumps(occurrence["evaluation_setup"], sort_keys=True, separators=(",", ":")),
            "derived_status_ids": "", "provenance_file": "data/catalog.yaml", "provenance_record_type": "occurrence",
            "provenance_record_ids": occurrence["id"],
        })
    for status in document["derived_statuses"]:
        occurrence = occurrences.get(status["occurrence_id"]) if status["occurrence_id"] else None
        source = sources[occurrence["source_id"]] if occurrence else None
        rows.append({
            "row_type": "derived_status", "row_id": status["id"], "lab_id": status["lab_id"],
            "lineage_id": status["lineage_id"], "model_id": status["model_id"], "release_id": status["release_id"],
            "publication_date": status["publication_date"], "benchmark_id": status["benchmark_id"],
            "source_id": source["id"] if source else "", "source_type": source["source_type"] if source else "",
            "source_url": source["url"] if source else "", "source_revision": _revision_text(source) if source else "",
            "locator": "", "summary": "", "evaluation_setup": "", "derived_status_ids": "|".join(status["status_ids"]),
            "provenance_file": status["provenance"]["source_file"], "provenance_record_type": status["provenance"]["record_type"],
            "provenance_record_ids": "|".join(status["provenance"]["record_ids"]),
        })
    rows.sort(key=lambda row: (row["publication_date"], row["row_type"], row["row_id"]))
    stream = io.StringIO(newline="")
    writer = csv.DictWriter(stream, fieldnames=CSV_FIELDS, lineterminator="\r\n", quoting=csv.QUOTE_MINIMAL)
    writer.writeheader()
    writer.writerows(rows)
    return stream.getvalue().encode("utf-8")


def validate_csv_provenance(payload: bytes) -> None:
    rows = list(csv.DictReader(io.StringIO(payload.decode("utf-8"), newline="")))
    for index, row in enumerate(rows, start=2):
        if not row["provenance_file"] or not row["provenance_record_type"] or not row["provenance_record_ids"]:
            raise ValidationError(f"generated CSV row {index} lacks provenance")
    assert_no_score_like(rows, ("generated_csv",))


def validate_score_free_repository_payloads(root: Path = ROOT) -> None:
    """Scan canonical, fixture, snapshot, and renderable payloads, not validator source."""
    paths = set((root / "data").glob("*.yaml"))
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
        elif suffix == ".csv":
            payload = list(csv.DictReader(io.StringIO(path.read_text(encoding="utf-8"), newline="")))
        elif suffix in {".html", ".md", ".txt"}:
            payload = path.read_text(encoding="utf-8")
        else:
            continue
        assert_no_score_like(payload, ("repository_payload", relative))


def validate_all(catalog: dict, definitions: dict) -> None:
    validate_json_schema(catalog, load_json(CATALOG_SCHEMA_PATH), "catalog")
    validate_json_schema(definitions, load_json(DEFINITIONS_SCHEMA_PATH), "definitions")
    validate_definitions(definitions)
    validate_date_windows(catalog)
    validate_referential_integrity(catalog)
    validate_source_domains(catalog)
    validate_terminal_dispositions(catalog)
    build_search_index(catalog)
    assert_no_score_like(catalog, ("catalog",))
    assert_no_score_like(definitions, ("definitions",))


def compile_catalog(catalog_path: Path = CATALOG_PATH, definitions_path: Path = DEFINITIONS_PATH) -> Tuple[bytes, bytes, dict]:
    catalog = load_yaml(catalog_path)
    definitions = load_yaml(definitions_path)
    validate_all(catalog, definitions)
    document = build_document(catalog, definitions)
    validate_derived_status_reproduction(catalog, document["derived_statuses"])
    validate_generated_provenance(document)
    assert_no_score_like(document, ("generated_json",))
    json_bytes = canonical_json_bytes(document)
    csv_bytes = build_csv_bytes(catalog, document)
    validate_csv_provenance(csv_bytes)
    return json_bytes, csv_bytes, document


def _sha256(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--catalog", type=Path, default=CATALOG_PATH)
    parser.add_argument("--definitions", type=Path, default=DEFINITIONS_PATH)
    parser.add_argument("--output-dir", type=Path, default=PUBLIC_JSON_PATH.parent)
    parser.add_argument("--check", action="store_true", help="fail if committed generated files differ")
    args = parser.parse_args(argv)
    try:
        json_bytes, csv_bytes, _ = compile_catalog(args.catalog, args.definitions)
        targets = {
            args.output_dir / PUBLIC_JSON_PATH.name: json_bytes,
            args.output_dir / PUBLIC_CSV_PATH.name: csv_bytes,
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
        print(f"observatory.csv sha256={_sha256(csv_bytes)} bytes={len(csv_bytes)}")
        return 0
    except ValidationError as exc:
        print(f"validation error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
