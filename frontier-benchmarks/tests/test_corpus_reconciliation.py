from __future__ import annotations

import importlib.util
import hashlib
import json
from collections import Counter, defaultdict
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("observatory_compile_reconciliation", ROOT / "scripts" / "compile.py")
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("could not load Observatory compiler module")
compiler = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(compiler)


class CorpusReconciliationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.catalog = compiler.load_yaml(ROOT / "data" / "catalog.yaml")
        cls.public_bytes = (ROOT / "public" / "observatory.json").read_bytes()
        cls.document = json.loads(cls.public_bytes)

    def test_exact_six_lab_release_and_occurrence_counts(self) -> None:
        expected_releases = {
            "openai": 33,
            "anthropic": 16,
            "google_deepmind": 39,
            "meta": 16,
            "deepseek": 20,
            "qwen": 48,
        }
        expected_occurrences = {
            "openai": 322,
            "anthropic": 528,
            "google_deepmind": 218,
            "meta": 395,
            "deepseek": 254,
            "qwen": 1104,
        }
        self.assertEqual({row["id"] for row in self.catalog["labs"]}, set(expected_releases))
        self.assertEqual(Counter(row["lab_id"] for row in self.catalog["releases"]), Counter(expected_releases))
        self.assertEqual(Counter(row["lab_id"] for row in self.catalog["occurrences"]), Counter(expected_occurrences))
        self.assertEqual(len(self.catalog["releases"]), 172)
        self.assertEqual(len(self.catalog["occurrences"]), 2821)

    def test_denominator_terminal_dispositions_and_meta_splits(self) -> None:
        expected = {"included": 169, "excluded": 111, "duplicate_or_alias": 18, "quarantined": 1}
        self.assertEqual(Counter(row["disposition"] for row in self.catalog["release_candidates"]), Counter(expected))
        self.assertEqual(len(self.catalog["release_candidates"]), 299)
        releases_by_candidate = defaultdict(list)
        for release in self.catalog["releases"]:
            releases_by_candidate[release["candidate_id"]].append(release["id"])
        included = [row for row in self.catalog["release_candidates"] if row["disposition"] == "included"]
        self.assertTrue(all(releases_by_candidate[row["id"]] for row in included))
        self.assertEqual(Counter(len(releases_by_candidate[row["id"]]) for row in included), Counter({1: 166, 2: 3}))
        self.assertEqual(len(self.catalog["quarantine"]), 1)

    def test_occurrence_provenance_and_setup_are_complete(self) -> None:
        source_by_id = {row["id"]: row for row in self.catalog["sources"]}
        release_by_id = {row["id"]: row for row in self.catalog["releases"]}
        occurrence_ids = set()
        for occurrence in self.catalog["occurrences"]:
            self.assertNotIn(occurrence["id"], occurrence_ids)
            occurrence_ids.add(occurrence["id"])
            self.assertEqual(occurrence["review_status"], "verified")
            self.assertTrue(occurrence["summary"])
            self.assertTrue(occurrence["locator"]["kind"])
            self.assertTrue(occurrence["locator"]["value"])
            self.assertEqual(
                set(occurrence["evaluation_setup"]),
                {"prompting", "shot_configuration", "tool_use", "evaluation_harness", "sample_selection"},
            )
            source = source_by_id[occurrence["source_id"]]
            self.assertEqual(occurrence["source_revision_id"], source["revision"]["id"])
            self.assertEqual(occurrence["lab_id"], release_by_id[occurrence["release_id"]]["lab_id"])

    def test_zero_occurrence_releases_and_canonical_benchmarks_are_retained(self) -> None:
        releases_with_occurrences = {row["release_id"] for row in self.catalog["occurrences"]}
        zero_occurrence = {row["id"] for row in self.catalog["releases"]} - releases_with_occurrences
        self.assertEqual(len(zero_occurrence), 24)
        self.assertEqual(len(self.catalog["benchmarks"]), 869)
        self.assertEqual(len(self.catalog["categories"]), 106)

    def test_generated_corpus_counts_unions_and_references_are_exact(self) -> None:
        expected_counts = {
            "labs": 6,
            "releases": 172,
            "benchmarks": 869,
            "occurrences": 2821,
            "derived_statuses": 5593,
            "sources": 537,
            "canonical_definitions": 8,
            "quarantine": 1,
        }
        self.assertEqual({key: len(self.document[key]) for key in expected_counts}, expected_counts)
        self.assertEqual(len(self.public_bytes), 11_980_016)
        self.assertEqual(hashlib.sha256(self.public_bytes).hexdigest(), "a945abe22b49e9cd6d309aa47b2979f2a069691ff3d2da1411b10de4ac3c93f5")
        ids = {
            key: {record["id"] for record in self.document[key]}
            for key in ("labs", "releases", "benchmarks", "occurrences", "derived_statuses", "sources", "canonical_definitions")
        }
        self.assertEqual(len(ids["releases"]), 172)
        self.assertEqual(len(ids["derived_statuses"]), 5593)
        for occurrence in self.document["occurrences"]:
            self.assertIn(occurrence["lab_id"], ids["labs"])
            self.assertIn(occurrence["release_id"], ids["releases"])
            self.assertIn(occurrence["benchmark_id"], ids["benchmarks"])
            self.assertIn(occurrence["source_id"], ids["sources"])
        for status in self.document["derived_statuses"]:
            self.assertIn(status["lab_id"], ids["labs"])
            self.assertIn(status["release_id"], ids["releases"])
            self.assertIn(status["benchmark_id"], ids["benchmarks"])
            self.assertTrue(set(status["status_ids"]) <= ids["canonical_definitions"])
            if status["occurrence_id"]:
                self.assertIn(status["occurrence_id"], ids["occurrences"])
        compiler.assert_no_score_like(self.document, ("public_json",))

    def test_private_raw_packages_are_not_repository_payloads(self) -> None:
        forbidden_suffixes = {".xz", ".tar", ".tgz"}
        tracked_payloads = [path for path in ROOT.rglob("*") if path.is_file()]
        self.assertFalse(any(path.suffix in forbidden_suffixes for path in tracked_payloads))
        self.assertFalse(any("private-inputs" in path.parts for path in tracked_payloads))


if __name__ == "__main__":
    unittest.main()
