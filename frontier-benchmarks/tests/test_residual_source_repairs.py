from __future__ import annotations

import json
from pathlib import Path
import unittest

import yaml

ROOT = Path(__file__).resolve().parents[1]


class ResidualSourceRepairTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.catalog = yaml.safe_load((ROOT / "data/catalog.yaml").read_text())
        cls.occurrences = {r["id"]: r for r in cls.catalog["occurrences"]}
        cls.overlay = json.loads((ROOT / "data/audit-overlay.json").read_text())
        cls.discovery = {r["unit_id"]: r for r in cls.overlay["discovery_evidence"]}

    def test_exact_archived_editions_keep_bounded_intervals(self):
        cases = {
            "5f15cdc654f2c07ad3e8": ("2024-08-12", "2024-08-23"),
            "5f87fd9294cc3152f447": ("2026-06-18", "2026-06-24"),
            "c69ac33d0951629266c1": ("2025-09-25", "2025-09-25"),
        }
        for key, interval in cases.items():
            row = self.discovery["inventory:url_" + key]
            window = row["publication_window"]
            self.assertEqual((window["interval_start"], window["interval_end"]), interval)
            self.assertEqual(window["verdict"], "IN_WINDOW")
            self.assertEqual(window["edition_join"], "EXACT_ARCHIVED_PUBLISHER_BYTES")
            self.assertIn("publisher_edition_timestamp", window["date_basis"])
            self.assertFalse(row["whole_record_approved"])
            self.assertFalse(row["historical_equivalence"])
        for key in ("43df9cadd55a0cc26d0c", "c1a3f9dd955eb86068ce"):
            window = self.discovery["inventory:url_" + key]["publication_window"]
            self.assertEqual(window["verdict"], "UNRESOLVED")
            self.assertIsNone(window["interval_start"])
            self.assertIsNone(window["interval_end"])

    def test_selected_unapproved_claims_cannot_supply_positive_reporting(self):
        fixture = json.loads((ROOT / "tests/fixtures/residual-unapproved-occurrence-ids.json").read_text())
        selected = fixture["selected_ids"]
        held = fixture["newly_withheld_ids"]
        self.assertEqual(len(selected), 281)
        self.assertEqual(len(set(selected)), 281)
        self.assertEqual(len(held), 29)
        self.assertTrue(set(held) <= set(selected))
        for identifier in selected:
            self.assertIn(self.occurrences[identifier]["review_status"], {"needs_review", "quarantined"})
        document = json.loads((ROOT / "public/observatory.json").read_text())
        positive_ids = {r["occurrence_id"] for r in document["derived_statuses"] if r["occurrence_id"]}
        self.assertFalse(set(selected) & positive_ids)
        for identifier in held:
            row = self.occurrences[identifier]
            self.assertEqual(row["review_status"], "needs_review")
            coverage = next(r for r in self.catalog["coverage"] if r["release_id"] == row["release_id"])
            self.assertEqual(coverage["review_status"], "incomplete", "withholding cannot become reviewed absence")
            overlay = next(r for r in self.overlay["records"] if r["record_id"] == identifier)
            self.assertEqual(overlay["disposition"], "unresolved")
            self.assertIn("t_ed310046:" + identifier, overlay["supplemental_evidence_ids"])
            self.assertIn("needs_review is not an absence finding", overlay["uncertainty"])

    def test_pinned_qwen_table_ordinals_include_intervening_table(self):
        prefix = "occurrence_qwen_occurrence_qwen_20240918_qwen2_5_llm_extending_the_boundary_of_llms_qwen2_5_llm_"
        selected = [r for k, r in self.occurrences.items() if k.startswith(prefix)]
        checked = 0
        for row in selected:
            locator = row["locator"]["value"]
            if "Performances on Multilingualism;" in locator:
                self.assertIn("table 12 counting document tables", locator)
                checked += 1
            elif "Qwen2.5-72B-Instruct Performance;" in locator:
                self.assertIn("table 7 counting document tables", locator)
                checked += 1
        self.assertEqual(checked, 13)

    def test_extended_mgsm_is_not_merged_into_canonical_version(self):
        selected = [r for r in self.occurrences.values() if "MGSM8K (extended)" in r["locator"]["value"]]
        self.assertEqual(len(selected), 1)
        self.assertEqual(selected[0]["review_status"], "quarantined")
        self.assertIn("equivalence to the canonical MGSM benchmark is not established", selected[0]["summary"])

    def test_reported_minerva_dataset_is_not_declared_absent(self):
        selected = [r for k, r in self.occurrences.items() if k.endswith("qwen2_5_math_minerva_math")]
        self.assertEqual(len(selected), 1)
        self.assertEqual(selected[0]["review_status"], "needs_review")
        self.assertIn("reported evaluation datasets", selected[0]["summary"])
        self.assertIn("does not isolate a model/configuration-specific result", selected[0]["summary"])
        self.assertFalse(self.overlay["semantic_corpus_approval"])


if __name__ == "__main__":
    unittest.main()
