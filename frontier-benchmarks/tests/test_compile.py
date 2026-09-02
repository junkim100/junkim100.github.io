from __future__ import annotations

import copy
import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("observatory_compile", ROOT / "scripts" / "compile.py")
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("could not load Observatory compiler module")
compiler = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(compiler)


class CompilerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.catalog = compiler.load_yaml(ROOT / "tests" / "fixtures" / "synthetic_catalog.yaml")
        cls.definitions = compiler.load_yaml(ROOT / "data" / "definitions.yaml")

    def fresh_catalog(self) -> dict:
        return copy.deepcopy(self.catalog)

    def fresh_definitions(self) -> dict:
        return copy.deepcopy(self.definitions)

    def test_valid_catalog_compiles_and_matches_status_fixture(self) -> None:
        json_bytes, document = compiler.compile_catalog(
            ROOT / "tests" / "fixtures" / "synthetic_catalog.yaml",
            ROOT / "data" / "definitions.yaml",
        )
        self.assertEqual(json.loads(json_bytes)["definitions_version"], "1.0.0")
        expected = compiler.load_yaml(ROOT / "tests" / "fixtures" / "expected_statuses.yaml")["statuses"]
        actual = [
            {
                "release_id": row["release_id"],
                "benchmark_id": row["benchmark_id"],
                "status_ids": row["status_ids"],
            }
            for row in document["derived_statuses"]
        ]
        self.assertEqual(actual, expected)

    def test_two_clean_compilations_are_byte_identical(self) -> None:
        first_json, _ = compiler.compile_catalog()
        second_json, _ = compiler.compile_catalog()
        self.assertEqual(first_json, second_json)

    def test_committed_artifacts_are_current(self) -> None:
        result = subprocess.run(
            [sys.executable, str(ROOT / "scripts" / "compile.py"), "--check"],
            cwd=ROOT,
            check=False,
            capture_output=True,
            text=True,
        )
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_check_and_write_use_only_json_artifact(self) -> None:
        json_bytes, _ = compiler.compile_catalog()
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            (output / "observatory.json").write_bytes(json_bytes)
            check_result = subprocess.run(
                [sys.executable, str(ROOT / "scripts" / "compile.py"), "--check", "--output-dir", str(output)],
                cwd=ROOT,
                check=False,
                capture_output=True,
                text=True,
            )
            self.assertEqual(check_result.returncode, 0, check_result.stderr)
            generated = output / "generated"
            write_result = subprocess.run(
                [sys.executable, str(ROOT / "scripts" / "compile.py"), "--output-dir", str(generated)],
                cwd=ROOT,
                check=False,
                capture_output=True,
                text=True,
            )
            self.assertEqual(write_result.returncode, 0, write_result.stderr)
            self.assertEqual([path.name for path in generated.iterdir()], ["observatory.json"])

    def test_json_schema_rejects_incomplete_setup_disclosure(self) -> None:
        catalog = self.fresh_catalog()
        del catalog["occurrences"][0]["evaluation_setup"]["prompting"]["value"]
        with self.assertRaisesRegex(compiler.ValidationError, "schema validation failed"):
            compiler.validate_json_schema(catalog, compiler.load_json(compiler.CATALOG_SCHEMA_PATH), "catalog")

    def test_invalid_path_fixtures_are_rejected(self) -> None:
        fixture = compiler.load_yaml(ROOT / "tests" / "fixtures" / "invalid_cases.yaml")
        validators = {
            "referential_integrity": compiler.validate_referential_integrity,
            "source_domain_allowlist": compiler.validate_source_domains,
            "date_window": compiler.validate_date_windows,
            "search_normalization": compiler.build_search_index,
        }
        for case in fixture["cases"]:
            with self.subTest(case=case["id"]):
                catalog = self.fresh_catalog()
                record = next(item for item in catalog[case["collection"]] if item["id"] == case["record_id"])
                record[case["field"]] = copy.deepcopy(case["replacement"])
                with self.assertRaises(compiler.ValidationError):
                    validators[case["validator"]](catalog)

    def test_source_urls_must_be_https_without_userinfo(self) -> None:
        catalog = self.fresh_catalog()
        source = next(item for item in catalog["sources"] if item["id"] == "source_alpha_seed")
        source["url"] = "http://alpha.example/releases/seed"
        with self.assertRaisesRegex(compiler.ValidationError, "absolute HTTPS URL"):
            compiler.validate_source_domains(catalog)
        source["url"] = "https://reader@alpha.example/releases/seed"
        with self.assertRaisesRegex(compiler.ValidationError, "without userinfo"):
            compiler.validate_source_domains(catalog)

    def test_terminal_disposition_reconciliation_rejects_orphan(self) -> None:
        catalog = self.fresh_catalog()
        catalog["releases"] = [item for item in catalog["releases"] if item["id"] != "release_alpha_seed"]
        with self.assertRaisesRegex(compiler.ValidationError, "at least one release"):
            compiler.validate_terminal_dispositions(catalog)

    def test_definition_consistency_is_executable(self) -> None:
        definitions = self.fresh_definitions()
        record = next(item for item in definitions["definitions"] if item["id"] == "outdated_in_public_reporting")
        record["algorithm"]["omission_count"] = 1
        with self.assertRaisesRegex(compiler.ValidationError, "inconsistent omission_count"):
            compiler.validate_definitions(definitions)

    def test_incomplete_coverage_pauses_omission_count(self) -> None:
        catalog = self.fresh_catalog()
        coverage = next(item for item in catalog["coverage"] if item["id"] == "coverage_alpha_spring")
        coverage["review_status"] = "incomplete"
        statuses = compiler.derive_statuses(catalog)
        row = next(item for item in statuses if item["release_id"] == "release_alpha_spring" and item["benchmark_id"] == "reasoning_suite")
        self.assertEqual(row["status_ids"], ["insufficient_evidence"])
        next_row = next(item for item in statuses if item["release_id"] == "release_alpha_summer" and item["benchmark_id"] == "reasoning_suite")
        self.assertEqual(next_row["status_ids"], ["insufficient_evidence"])
        returning_row = next(item for item in statuses if item["release_id"] == "release_alpha_autumn" and item["benchmark_id"] == "reasoning_suite")
        self.assertEqual(returning_row["status_ids"], ["insufficient_evidence"])

    def test_unrelated_lineage_does_not_advance_successor_omissions(self) -> None:
        catalog = self.fresh_catalog()
        catalog["coverage"].append({
            "id": "coverage_alpha_side",
            "release_id": "release_alpha_side",
            "lab_id": "alpha_research",
            "review_status": "complete",
            "reviewed_source_ids": ["source_alpha_spring"],
            "review_date": "2026-09-01",
        })
        catalog["releases"].append({
            "id": "release_alpha_side",
            "candidate_id": "candidate_alpha_spring",
            "lab_id": "alpha_research",
            "model_id": "alpha_core_base",
            "lineage_id": "alpha_side",
            "name": "Alpha Side",
            "publication_date": "2025-02-10",
            "modality_class": "text",
            "use_class": "general",
            "coverage_id": "coverage_alpha_side",
        })
        statuses = compiler.derive_statuses(catalog)
        self.assertFalse(any(row["release_id"] == "release_alpha_side" for row in statuses))
        spring = next(item for item in statuses if item["release_id"] == "release_alpha_spring" and item["benchmark_id"] == "reasoning_suite")
        self.assertEqual(spring["status_ids"], ["not_reported_in_reviewed_successor", "dormant_in_public_reporting"])

    def test_derived_status_reproduction_detects_tampering(self) -> None:
        rows = compiler.derive_statuses(self.catalog)
        tampered = copy.deepcopy(rows)
        tampered[0]["status_ids"] = ["continued"]
        with self.assertRaisesRegex(compiler.ValidationError, "cannot be reproduced"):
            compiler.validate_derived_status_reproduction(self.catalog, tampered)

    def test_every_generated_json_row_has_provenance(self) -> None:
        _, document = compiler.compile_catalog()
        compiler.validate_generated_provenance(document)

    def test_no_score_guard_rejects_fields_and_value_shapes(self) -> None:
        forbidden_key = "benchmark_" + "".join(("sco", "re"))
        forbidden_result_key = "benchmark_" + "".join(("res", "ult"))
        examples = [
            {forbidden_key: "redacted"},
            {forbidden_result_key: "redacted"},
            {"summary": str(7 * 10) + "%"},
            {"summary": "win " + "rate: " + str(4)},
            {"summary": "accur" + "acy " + str(8)},
            {"summary": "perfor" + "mance " + str(9)},
            {"summary": "E" + "lo " + str(1000)},
            {"summary": "pass" + "@" + str(1) + " " + str(2)},
            {"summary": "ranked #" + str(3)},
            {"summary": "compet" + "itor row"},
            {"summary": str(4) + "." + str(2)},
            {"summary": str(3) + "/" + str(4)},
            {"summary": str(4)},
            {"summary": "rating " + str(4) + "." + str(2)},
            {"summary": "result was " + str(4) + "." + str(2)},
            {"summary": "achieved " + str(4) + "." + str(2)},
            {"summary": str(4) + "." + str(2) + " points"},
        ]
        for example in examples:
            with self.subTest(example=example):
                with self.assertRaises(compiler.ValidationError):
                    compiler.assert_no_score_like(example, ("test",))

    def test_no_score_guard_allows_safe_structural_numerics(self) -> None:
        compiler.assert_no_score_like(
            {
                "schema_version": "1.0.0",
                "publication_date": "2025-01-10",
                "model_id": "alpha_2_5",
                "name": "Alpha 2.5",
                "algorithm": {"omission_count": 2},
            },
            ("test",),
        )

    def test_no_score_guard_allows_qwen_benchmark_versions_in_evidence_text(self) -> None:
        compiler.assert_no_score_like(
            {
                "benchmark": {
                    "name": "MMBench EN 1.1 dev",
                    "aliases": ["Terminal Bench 2.1"],
                },
                "locator": {
                    "value": "Figure under Qwen2.5 performance; benchmark label AlignBench 1.1",
                },
                "summary": "The official Qwen release reporting names AlpacaEval 2.0 for the released Qwen model.",
            },
            ("test",),
        )

    def test_duplicate_yaml_keys_are_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "duplicate.yaml"
            path.write_text("schema_version: one\nschema_version: two\n", encoding="utf-8")
            with self.assertRaisesRegex(compiler.ValidationError, "duplicate YAML key"):
                compiler.load_yaml(path)

    def test_fixture_and_public_artifacts_pass_no_score_scan(self) -> None:
        compiler.assert_no_score_like(self.catalog, ("catalog",))
        compiler.assert_no_score_like(self.definitions, ("definitions",))
        for path in sorted((ROOT / "tests" / "fixtures").glob("*.yaml")):
            compiler.assert_no_score_like(compiler.load_yaml(path), ("fixture", path.name))
        compiler.assert_no_score_like(json.loads((ROOT / "public" / "observatory.json").read_text(encoding="utf-8")), ("public_json",))
        compiler.validate_score_free_repository_payloads()


if __name__ == "__main__":
    unittest.main()
