from __future__ import annotations

import copy
import importlib.util
from collections import Counter
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("observatory_source_windows", ROOT / "scripts/compile.py")
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("could not load compiler")
compiler = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(compiler)


class SourceWindowRepairTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.catalog = compiler.load_yaml(ROOT / "data/catalog.yaml")
        cls.overlay = compiler.load_json(ROOT / "data/audit-overlay.json")
        cls.occurrences = {r["id"]: r for r in cls.catalog["occurrences"]}
        cls.discovery = {r["unit_id"]: r for r in cls.overlay["discovery_evidence"]}

    def test_publication_supplements_preserve_complete_denominator(self):
        windows = [r["publication_window"] for r in self.discovery.values() if "publication_window" in r]
        self.assertEqual(len(windows), 17)
        self.assertEqual(Counter(w["verdict"] for w in windows), {"IN_WINDOW": 14, "OUTSIDE_WINDOW": 1, "UNRESOLVED": 2})
        acl = self.discovery["inventory:url_c91c6f92149825dc3c2a"]["publication_window"]
        self.assertEqual((acl["interval_start"], acl["interval_end"]), ("2024-12-01", "2024-12-31"))
        for window in windows:
            if window["verdict"] == "UNRESOLVED":
                self.assertIsNone(window["interval_start"])
                self.assertIsNone(window["interval_end"])
        self.assertFalse(self.overlay["semantic_corpus_approval"])

    def test_conditional_protocol_does_not_become_per_row_disclosure(self):
        prefix = "occurrence_deepseek_occurrence_deepseek_v4_flash_0731_"
        for suffix in ("agents_last_exam", "automationbench", "cybergym", "deepswe", "nl2repo", "terminal_bench_2_1", "toolathlon_verified"):
            row = self.occurrences[prefix + suffix]
            for field in ("evaluation_harness", "prompting"):
                self.assertEqual(row["evaluation_setup"][field], {"status": "not_disclosed"})
            self.assertEqual(row["review_status"], "needs_review")
            self.assertIn("does not identify this row", row["summary"])
        self.assertEqual(self.occurrences[prefix + "dsbench_fullstack"]["review_status"], "verified")

    def test_unsupported_o1_associations_are_withheld_not_absence(self):
        source = "source_openai_source_https_openai_com_index_openai_o1_system_card"
        selected = [r for r in self.catalog["occurrences"] if r["source_id"] == source and r["summary"].startswith("Withheld source association:")]
        self.assertEqual(len(selected), 37)
        self.assertTrue(all(r["review_status"] == "quarantined" for r in selected))
        self.assertTrue(all("No reporting-absence claim" in r["summary"] for r in selected))
        self.assertTrue(all(v == {"status": "not_disclosed"} for r in selected for v in r["evaluation_setup"].values()))
        for row in selected:
            if "20241217" in row["id"]:
                self.assertIn("o1-dec5-release", row["summary"])
                self.assertIn("o1-near-final-checkpoint", row["summary"])

    def test_reporting_model_set_does_not_require_invented_checkpoint(self):
        prefix = "occurrence_qwen_occurrence_qwen_20240328_qwen1_5_moe_matching_7b_model_performance_with_1_3_a_qwen_moe_"
        for suffix in ("mmlu", "gsm8k", "humaneval", "mt_bench"):
            row = self.occurrences[prefix + suffix]
            config = "chat" if suffix == "mt_bench" else "base"
            self.assertIn(f"{config} configuration of Qwen1.5-MoE-A2.7B", row["summary"])
            self.assertIn("reporting model set", row["summary"])
            self.assertEqual(row["review_status"], "needs_review")

    def validate_window(self, verdict, start, end):
        overlay = copy.deepcopy(self.overlay)
        overlay["discovery_evidence"][0]["publication_window"] = {
            "verdict": verdict, "interval_start": start, "interval_end": end,
            "date_basis": "publisher_month", "edition_join": "EXACT_LINKED_PDF_BYTES",
        }
        compiler.validate_audit_overlay(self.catalog, overlay)

    def test_publication_interval_membership_not_arbitrary_day(self):
        self.validate_window("IN_WINDOW", "2024-08-01", "2024-08-31")
        self.validate_window("OUTSIDE_WINDOW", "2023-12-01", "2023-12-31")
        self.validate_window("UNRESOLVED", None, None)
        with self.assertRaisesRegex(compiler.ValidationError, "contradicts"):
            self.validate_window("IN_WINDOW", "2023-12-31", "2024-01-02")
        with self.assertRaisesRegex(compiler.ValidationError, "contradicts"):
            self.validate_window("OUTSIDE_WINDOW", "2024-08-01", "2024-08-31")

    def test_publication_dates_cannot_be_partial_inverted_or_inferred(self):
        with self.assertRaisesRegex(compiler.ValidationError, "inferred dates"):
            self.validate_window("UNRESOLVED", "2024-01-01", None)
        with self.assertRaisesRegex(compiler.ValidationError, "complete interval"):
            self.validate_window("IN_WINDOW", "2024-01-01", None)
        with self.assertRaisesRegex(compiler.ValidationError, "inverted"):
            self.validate_window("IN_WINDOW", "2024-08-31", "2024-08-01")


if __name__ == "__main__":
    unittest.main()
