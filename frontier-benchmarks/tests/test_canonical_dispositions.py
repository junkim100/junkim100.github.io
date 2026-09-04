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
        self.assertEqual(len(ids), 870)
        self.assertEqual(len(set(ids)), 870)
        self.assertIn("benchmark_terminal_bench_3_0", ids)
        self.assertNotIn("benchmark_terminal_bench_4_0", ids)
        live = [row for row in self.catalog["benchmarks"] if row.get("identity_status", "canonical") == "canonical"]
        merged = [row for row in self.catalog["benchmarks"] if row.get("identity_status") == "merged"]
        quarantined = [row for row in self.catalog["benchmarks"] if row.get("identity_status") == "quarantined"]
        self.assertEqual(len(live), 803)
        self.assertEqual(len(merged), 36)
        self.assertEqual(len(quarantined), 31)
        self.assertTrue(all(row.get("canonical_benchmark_id") for row in merged))

    def test_association_denominator_is_exact_once(self) -> None:
        ids = [row["id"] for row in self.catalog["occurrences"]]
        self.assertEqual(len(ids), 2821)
        self.assertEqual(len(set(ids)), 2821)
        self.assertEqual(Counter(row["review_status"] for row in self.catalog["occurrences"]), Counter({"verified": 2571, "quarantined": 250}))

    def test_terminal_bench_versions_are_explicit(self) -> None:
        names = {row["id"]: row["name"] for row in self.catalog["benchmarks"]}
        self.assertEqual(names["benchmark_terminal_bench"], "Terminal-Bench")
        self.assertEqual(names["benchmark_terminal_bench_2_0"], "Terminal-Bench 2.0")
        self.assertEqual(names["benchmark_terminal_bench_2_1"], "Terminal-Bench 2.1")
        self.assertEqual(names["benchmark_terminal_bench_3_0"], "Terminal-Bench 3.0")
        verified = Counter(
            row["benchmark_id"]
            for row in self.catalog["occurrences"]
            if row["review_status"] == "verified" and row["benchmark_id"].startswith("benchmark_terminal_bench")
        )
        self.assertEqual(verified["benchmark_terminal_bench"], 7)
        self.assertEqual(verified["benchmark_terminal_bench_2_0"], 21)
        self.assertEqual(verified["benchmark_terminal_bench_2_1"], 10)
        self.assertEqual(verified["benchmark_terminal_bench_3_0"], 0)

    def test_recent_model_window_is_ninety_inclusive_days(self) -> None:
        window = self.document["recent_model_counts"]["window"]
        start = date.fromisoformat(window["start"])
        end = date.fromisoformat(window["end"])
        self.assertEqual(window, {"start": "2026-06-06", "end": "2026-09-03", "inclusive_days": 90})
        self.assertEqual((end - start).days + 1, 90)
        self.assertEqual(self.document["recent_model_counts"]["label"], "models in latest 90 days")
        self.assertEqual(len(self.document["recent_model_counts"]["counts"]), 803)
        self.assertEqual(sum(1 for row in self.document["recent_model_counts"]["counts"] if row["distinct_model_count"]), 213)

    def test_search_plus_disambiguation(self) -> None:
        self.assertEqual(compiler.normalize_search_term("HumanEval+"), "humaneval plus")
        self.assertEqual(compiler.normalize_search_term("HumanEval"), "humaneval")
        self.assertNotEqual(compiler.normalize_search_term("HumanEval+"), compiler.normalize_search_term("HumanEval"))


if __name__ == "__main__":
    unittest.main()
