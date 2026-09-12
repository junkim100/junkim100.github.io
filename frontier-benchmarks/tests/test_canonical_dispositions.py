from __future__ import annotations

import importlib.util
import json
from collections import Counter
from datetime import date
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("observatory_compile_dispositions", ROOT / "scripts" / "compile.py")
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("could not load Observatory compiler module")
compiler = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(compiler)


class CanonicalDispositionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.catalog = compiler.load_yaml(ROOT / "data" / "catalog.yaml")
        cls.document = json.loads((ROOT / "public" / "observatory.json").read_text(encoding="utf-8"))

    def test_identity_denominator_is_exact_once(self) -> None:
        ids = [row["id"] for row in self.catalog["benchmarks"]]
        self.assertEqual(len(ids), 873)
        self.assertEqual(len(set(ids)), 873)
        self.assertIn("benchmark_terminal_bench_3_0", ids)
        self.assertIn("benchmark_terminal_bench_4_0", ids)
        live = [row for row in self.catalog["benchmarks"] if row.get("identity_status", "canonical") == "canonical"]
        merged = [row for row in self.catalog["benchmarks"] if row.get("identity_status") == "merged"]
        quarantined = [row for row in self.catalog["benchmarks"] if row.get("identity_status") == "quarantined"]
        self.assertEqual(len(live), 807)
        self.assertEqual(len(merged), 35)
        self.assertEqual(len(quarantined), 31)
        self.assertTrue(all(row.get("canonical_benchmark_id") for row in merged))

    def test_association_denominator_is_exact_once(self) -> None:
        ids = [row["id"] for row in self.catalog["occurrences"]]
        self.assertEqual(len(ids), 2824)
        self.assertEqual(len(set(ids)), 2824)
        self.assertEqual(Counter(row["review_status"] for row in self.catalog["occurrences"]), Counter({"verified": 1826, "needs_review": 709, "quarantined": 289}))

    def test_terminal_bench_versions_are_explicit(self) -> None:
        names = {row["id"]: row["name"] for row in self.catalog["benchmarks"]}
        self.assertEqual(names["benchmark_terminal_bench"], "Terminal-Bench")
        self.assertEqual(names["benchmark_terminal_bench_2_0"], "Terminal-Bench 2.0")
        self.assertEqual(names["benchmark_terminal_bench_2_1"], "Terminal-Bench 2.1")
        self.assertEqual(names["benchmark_terminal_bench_3_0"], "Terminal-Bench 3.0")
        self.assertEqual(names["benchmark_terminal_bench_4_0"], "Terminal-Bench 4.0")
        verified = Counter(
            row["benchmark_id"]
            for row in self.catalog["occurrences"]
            if row["review_status"] == "verified" and row["benchmark_id"].startswith("benchmark_terminal_bench")
        )
        self.assertEqual(verified["benchmark_terminal_bench"], 7)
        self.assertEqual(verified["benchmark_terminal_bench_2_0"], 12)
        self.assertEqual(verified["benchmark_terminal_bench_2_1"], 6)
        self.assertEqual(verified["benchmark_terminal_bench_3_0"], 0)
        self.assertEqual(verified["benchmark_terminal_bench_4_0"], 1)

    def test_recent_model_window_is_ninety_inclusive_days(self) -> None:
        window = self.document["recent_model_counts"]["window"]
        start = date.fromisoformat(window["start"])
        end = date.fromisoformat(window["end"])
        self.assertEqual(window, {"start": "2026-06-11", "end": "2026-09-08", "inclusive_days": 90})
        self.assertEqual((end - start).days + 1, 90)
        self.assertEqual(self.document["recent_model_counts"]["label"], "models in latest 90 days")
        self.assertEqual(len(self.document["recent_model_counts"]["counts"]), 807)
        self.assertEqual(sum(1 for row in self.document["recent_model_counts"]["counts"] if row["distinct_model_count"]), 188)

    def test_preview_results_do_not_approve_other_model_configurations(self) -> None:
        occurrences = {row["id"]: row for row in self.catalog["occurrences"]}
        next_model = occurrences["occurrence_openai_occurrence_openai_20240912_introducing_openai_o1_preview_codeforces"]
        self.assertEqual(next_model["review_status"], "quarantined")
        self.assertIn("next model update", next_model["summary"])
        mini = occurrences["occurrence_openai_occurrence_openai_20240912_openai_o1_mini_protocolqa_open_ended"]
        self.assertEqual(mini["review_status"], "quarantined")
        dated = occurrences["occurrence_openai_occurrence_openai_20241217_openai_o1_and_new_tools_for_developers_biolp_bench"]
        self.assertEqual(dated["review_status"], "quarantined")

    def test_internal_flash_results_do_not_approve_public_snapshot(self) -> None:
        occurrences = {row["id"]: row for row in self.catalog["occurrences"]}
        suffixes = ["agents_last_exam", "automationbench", "cybergym", "deepswe", "nl2repo", "terminal_bench_2_1", "toolathlon_verified"]
        for suffix in suffixes:
            row = occurrences[f"occurrence_deepseek_occurrence_deepseek_v4_flash_0731_{suffix}"]
            self.assertEqual(row["review_status"], "needs_review", row["id"])
        public = occurrences["occurrence_deepseek_occurrence_deepseek_v4_flash_0731_dsbench_fullstack"]
        self.assertEqual(public["review_status"], "verified")

    def test_explicit_o1_mini_subsets_are_not_parent_benchmarks(self) -> None:
        occurrences = {row["id"]: row for row in self.catalog["occurrences"]}
        prefix = "occurrence_openai_occurrence_openai_20240912_openai_o1_mini_"
        self.assertEqual(occurrences[prefix + "gpqa"]["benchmark_id"], "benchmark_gpqa_diamond")
        self.assertEqual(occurrences[prefix + "math"]["benchmark_id"], "benchmark_math_500")

    def test_search_plus_disambiguation(self) -> None:
        self.assertEqual(compiler.normalize_search_term("HumanEval+"), "humaneval plus")
        self.assertEqual(compiler.normalize_search_term("HumanEval"), "humaneval")
        self.assertNotEqual(compiler.normalize_search_term("HumanEval+"), compiler.normalize_search_term("HumanEval"))


if __name__ == "__main__":
    unittest.main()
