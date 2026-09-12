from __future__ import annotations

import copy
import importlib.util
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("observatory_coupled_repair", ROOT / "scripts" / "compile.py")
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("could not load Observatory compiler module")
compiler = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(compiler)
COMMIT = "1f89f8c81adb85e3808f9cc15180ab1fdacbb900"
PREFIX = f"https://raw.githubusercontent.com/QwenLM/qwenlm.github.io/{COMMIT}/"


class CoupledSourceRepairTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.catalog = compiler.load_yaml(ROOT / "data/catalog.yaml")
        cls.overlay = compiler.load_json(ROOT / "data/audit-overlay.json")
        cls.occurrences = {row["id"]: row for row in cls.catalog["occurrences"]}
        # Keep the original 25-source regression denominator separate from the
        # subsequent QVQ-Max integration, covered by test_discovery_integration.
        cls.sources = [row for row in cls.catalog["sources"] if row["url"].startswith(PREFIX) and not row["url"].endswith("/qvq-max-preview/index.md")]

    def test_exact_pinned_sources_have_coupled_current_checks(self) -> None:
        self.assertEqual(len(self.sources), 25)
        for source in self.sources:
            self.assertEqual(source["lab_id"], "qwen")
            self.assertEqual(source["revision"]["identifier"], f"git:{COMMIT}:" + source["url"][len(PREFIX):])
            checks = [row for row in self.overlay["source_checks"] if row["source_id"] == source["id"]]
            self.assertEqual(len(checks), 2)
            current = [row for row in checks if row["exact_url"] == source["url"]]
            self.assertEqual(len(current), 1)
            self.assertEqual(current[0]["access_status"], "retrieved")
            self.assertTrue(any(row["exact_url"].startswith("https://qwen.ai/research/") for row in checks))

    def test_old_url_check_cannot_stand_in_for_new_url(self) -> None:
        self.assertEqual(len(self.sources), 25)
        source = self.sources[0]
        overlay = copy.deepcopy(self.overlay)
        overlay["source_checks"] = [row for row in overlay["source_checks"] if (row["source_id"], row["exact_url"]) != (source["id"], source["url"])]
        with self.assertRaisesRegex(compiler.ValidationError, "missing current source checks"):
            compiler.validate_audit_overlay(self.catalog, overlay)

    def test_supplemental_evidence_preserves_original_audit(self) -> None:
        self.assertEqual(len(self.sources), 25)
        for source in self.sources:
            record = next(row for row in self.overlay["records"] if row["entity_type"] == "sources" and row["record_id"] == source["id"])
            self.assertTrue(record["evidence_ids"])
            self.assertTrue(any(item.startswith("t_9c2331a7:") for item in record["supplemental_evidence_ids"]))
            self.assertEqual(record["disposition"], "unresolved")
        self.assertFalse(self.overlay["semantic_corpus_approval"])

    def test_o1_mmmlu_does_not_approve_december_17_checkpoint(self) -> None:
        row = self.occurrences["occurrence_openai_occurrence_openai_20241217_openai_o1_and_new_tools_for_developers_mmmlu"]
        self.assertEqual(row["review_status"], "quarantined")
        self.assertIn("o1-dec5-release", row["locator"]["value"])
        self.assertIn("excludes the December 17 checkpoint", row["locator"]["value"])
        self.assertEqual(row["benchmark_id"], "benchmark_mmmlu")

    def test_qwen_moe_separates_base_and_chat_reporting(self) -> None:
        rows = [row for row in self.catalog["occurrences"] if "qwen_moe" in row["source_id"] and row["benchmark_id"] in {"benchmark_massive_multitask_language_understanding", "benchmark_gsm8k", "benchmark_humaneval", "benchmark_mt_bench"}]
        self.assertEqual(len(rows), 4)
        for row in rows:
            self.assertIn("assigns MT-Bench to chat", row["locator"]["value"])
            self.assertIn("MMLU/GSM8K/HumanEval to base", row["locator"]["value"])
            self.assertNotEqual(row["review_status"], "verified")

    def test_o1_mini_figure_presence_is_benchmark_specific(self) -> None:
        prefix = "occurrence_openai_occurrence_openai_20240912_openai_o1_mini_"
        for suffix in ("quantbench", "swe_bench_verified", "makemesay", "openai_research_engineer_interview"):
            row = self.occurrences[prefix + suffix]
            self.assertIn("explicitly labeled o1-mini series", row["locator"]["value"])
            self.assertEqual(row["review_status"], "needs_review")
        for suffix in ("biolp_bench", "mle_bench", "protocolqa_open_ended"):
            self.assertIn("no o1-mini series", self.occurrences[prefix + suffix]["summary"])
            self.assertEqual(self.occurrences[prefix + suffix]["review_status"], "quarantined")

    def test_gpt45_simpleqa_uses_explicit_chart_metadata(self) -> None:
        row = self.occurrences["occurrence_openai_occurrence_openai_20250227_introducing_gpt_4_5_simpleqa"]
        self.assertIn("chartData explicitly names GPT-4.5", row["locator"]["value"])
        self.assertEqual(row["review_status"], "needs_review")


if __name__ == "__main__":
    unittest.main()
