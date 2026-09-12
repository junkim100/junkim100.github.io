from __future__ import annotations

import copy
import importlib.util
import json
import unittest
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("observatory_compile_overlay", ROOT / "scripts" / "compile.py")
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("could not load Observatory compiler module")
compiler = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(compiler)


class AuditOverlayTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.catalog = compiler.load_yaml(ROOT / "data" / "catalog.yaml")
        cls.definitions = compiler.load_yaml(ROOT / "data" / "definitions.yaml")
        cls.overlay = compiler.load_json(ROOT / "data" / "audit-overlay.json")

    def fresh_overlay(self) -> dict:
        return copy.deepcopy(self.overlay)

    def test_overlay_schema_projection_and_counts_are_exact(self) -> None:
        compiler.validate_audit_overlay(self.catalog, self.overlay)
        summary = self.overlay["summary"]
        self.assertEqual(summary["baseline_audit_units"], 8_599)
        self.assertEqual(summary["baseline_audit_dispositions"], {"unresolved": 8_346, "retained": 231, "corrected": 22})
        self.assertEqual(summary["candidate_dispositions"], {"added": 18, "unresolved": 235})
        self.assertEqual(summary["url_candidates"], 7_353)
        self.assertEqual(summary["partition_units"], 16_205)
        self.assertEqual(summary["current_catalog_rows"], 5_245)
        self.assertEqual(summary["typed_source_edges"], 3_372)
        self.assertEqual(summary["overlay_records"], 8_617)
        self.assertEqual(len(self.overlay["source_checks"]), 565)
        self.assertEqual(Counter(record["origin"] for record in self.overlay["records"]), Counter({"baseline": 8_599, "candidate": 18}))

    def test_generated_document_uses_overlay_window(self) -> None:
        _, document = compiler.compile_catalog()
        self.assertEqual(document["recent_model_counts"]["window"], self.overlay["recent_window"])
        self.assertEqual(document["audit_overlay"], self.overlay)

    def test_duplicate_ledger_id_is_rejected(self) -> None:
        overlay = self.fresh_overlay()
        duplicate = copy.deepcopy(overlay["records"][0])
        duplicate["record_id"] = "orphan_record"
        duplicate["resulting_ids"] = ["orphan_record"]
        overlay["records"].append(duplicate)
        with self.assertRaisesRegex(compiler.ValidationError, "duplicate audit overlay ledger_id"):
            compiler.validate_audit_overlay(self.catalog, overlay)

    def test_duplicate_record_key_is_rejected(self) -> None:
        overlay = self.fresh_overlay()
        duplicate = copy.deepcopy(overlay["records"][0])
        duplicate["ledger_id"] = "duplicate_ledger"
        overlay["records"].append(duplicate)
        with self.assertRaisesRegex(compiler.ValidationError, "duplicate audit overlay record key"):
            compiler.validate_audit_overlay(self.catalog, overlay)

    def test_orphan_and_missing_record_keys_are_rejected(self) -> None:
        orphaned = self.fresh_overlay()
        extra = copy.deepcopy(orphaned["records"][0])
        extra.update(ledger_id="orphan_ledger", record_id="orphan_record", resulting_ids=["orphan_record"])
        orphaned["records"].append(extra)
        with self.assertRaisesRegex(compiler.ValidationError, "orphan record keys"):
            compiler.validate_audit_overlay(self.catalog, orphaned)

        missing = self.fresh_overlay()
        missing["records"].pop()
        with self.assertRaisesRegex(compiler.ValidationError, "missing current record keys"):
            compiler.validate_audit_overlay(self.catalog, missing)

    def test_mismatched_resulting_ids_are_rejected(self) -> None:
        overlay = self.fresh_overlay()
        overlay["records"][0]["resulting_ids"] = ["different_record"]
        with self.assertRaisesRegex(compiler.ValidationError, "mismatched resulting_ids"):
            compiler.validate_audit_overlay(self.catalog, overlay)

    def test_duplicate_or_missing_source_checks_are_rejected(self) -> None:
        duplicate = self.fresh_overlay()
        duplicate["source_checks"].append(copy.deepcopy(duplicate["source_checks"][0]))
        with self.assertRaisesRegex(compiler.ValidationError, "duplicate audit overlay source check"):
            compiler.validate_audit_overlay(self.catalog, duplicate)

        missing = self.fresh_overlay()
        missing["source_checks"].pop()
        with self.assertRaisesRegex(compiler.ValidationError, "missing current source checks"):
            compiler.validate_audit_overlay(self.catalog, missing)

    def test_unknown_source_metadata_cannot_be_partially_populated(self) -> None:
        overlay = self.fresh_overlay()
        check = overlay["source_checks"][0]
        check.update(access_status=None, fingerprint=None, fingerprint_kind=None)
        with self.assertRaisesRegex(compiler.ValidationError, "guessed retrieval metadata"):
            compiler.validate_audit_overlay(self.catalog, overlay)

    def test_mismatched_recent_windows_are_rejected(self) -> None:
        wrong_span = self.fresh_overlay()
        wrong_span["recent_window"]["start"] = "2026-06-12"
        with self.assertRaisesRegex(compiler.ValidationError, "90 inclusive"):
            compiler.validate_audit_overlay(self.catalog, wrong_span)

        wrong_end = self.fresh_overlay()
        wrong_end["recent_window"].update(start="2026-06-10", end="2026-09-07")
        with self.assertRaisesRegex(compiler.ValidationError, "intake cutoff"):
            compiler.validate_audit_overlay(self.catalog, wrong_end)

    def test_summary_tampering_and_score_injection_are_rejected(self) -> None:
        bad_count = self.fresh_overlay()
        bad_count["summary"]["typed_source_edges"] -= 1
        with self.assertRaisesRegex(compiler.ValidationError, "typed_source_edges does not reconcile"):
            compiler.validate_audit_overlay(self.catalog, bad_count)

        score_text = self.fresh_overlay()
        score_text["records"][0]["uncertainty"] = "accuracy 8"
        with self.assertRaisesRegex(compiler.ValidationError, "forbidden score-like text"):
            compiler.validate_all(self.catalog, self.definitions, score_text)


if __name__ == "__main__":
    unittest.main()
