from __future__ import annotations

import copy
import importlib.util
from collections import Counter
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("observatory_discovery", ROOT / "scripts/compile.py")
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("could not load compiler")
compiler = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(compiler)
COMMIT = "1f89f8c81adb85e3808f9cc15180ab1fdacbb900"
QWEN_PREFIX = f"https://raw.githubusercontent.com/QwenLM/qwenlm.github.io/{COMMIT}/"
QVEN = "occurrence_qwen_occurrence_qwen_20250327_qvq_max_think_with_evidence_qvq_max_preview_mathvision"
RECOVERED = {
    "inventory:url_084d45fe1b943b16fac9",
    "inventory:url_c95c66e90efeaf3c7cb1",
    "inventory:url_e712ddc3d4da2450b652",
}


class DiscoveryIntegrationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.catalog = compiler.load_yaml(ROOT / "data/catalog.yaml")
        cls.overlay = compiler.load_json(ROOT / "data/audit-overlay.json")
        cls.occurrences = {row["id"]: row for row in cls.catalog["occurrences"]}

    def test_exact_discovery_projection_and_recovered_boundary(self):
        rows = self.overlay["discovery_evidence"]
        self.assertEqual(len(rows), 794)
        self.assertEqual(len({r["unit_id"] for r in rows}), 794)
        self.assertEqual(Counter(r["semantic_status"] for r in rows), {
            "PROCESSED_BOUNDED": 700, "BOUNDED_SEMANTIC_ADJUDICATION": 94,
        })
        self.assertFalse(any(r["semantic_status"] == "UNPROCESSED" for r in rows))
        for row in rows:
            if row["unit_id"] in RECOVERED:
                self.assertEqual(row["reporting_lab"], "qwen")
                self.assertEqual(row["semantic_status"], "BOUNDED_SEMANTIC_ADJUDICATION")
                self.assertEqual(row["evidence_task_id"], "t_df560505")
        self.assertEqual(sum(len(r["proposal_ids"]) for r in rows), 787)
        for row in rows:
            self.assertFalse(row["whole_record_approved"])
            self.assertFalse(row["historical_equivalence"])
            self.assertEqual(row["binding"], "discovery_only_not_catalog_identity")
        self.assertFalse(self.overlay["semantic_corpus_approval"])

    def test_duplicate_unit_and_cross_unit_proposal_are_rejected(self):
        duplicate = copy.deepcopy(self.overlay)
        duplicate["discovery_evidence"].append(copy.deepcopy(duplicate["discovery_evidence"][0]))
        with self.assertRaisesRegex(compiler.ValidationError, "duplicate discovery evidence"):
            compiler.validate_audit_overlay(self.catalog, duplicate)
        duplicate = copy.deepcopy(self.overlay)
        rows = [r for r in duplicate["discovery_evidence"] if r["proposal_ids"]]
        rows[1]["proposal_ids"].append(rows[0]["proposal_ids"][0])
        with self.assertRaisesRegex(compiler.ValidationError, "duplicate discovery proposal"):
            compiler.validate_audit_overlay(self.catalog, duplicate)

    def test_stale_unread_labels_and_unread_associations_are_rejected(self):
        for status in ("PROCESSED_BOUNDED", "BOUNDED_SEMANTIC_ADJUDICATION"):
            overlay = copy.deepcopy(self.overlay)
            row = overlay["discovery_evidence"][0]
            row["semantic_status"] = status
            row["semantic_outcome"] = "UNPROCESSED"
            with self.assertRaisesRegex(compiler.ValidationError, "contradictory discovery unread"):
                compiler.validate_audit_overlay(self.catalog, overlay)
        overlay = copy.deepcopy(self.overlay)
        row = overlay["discovery_evidence"][0]
        row["semantic_status"] = "UNPROCESSED"
        row["semantic_outcome"] = "UNPROCESSED"
        row["reporting_lab"] = "qwen"
        with self.assertRaisesRegex(compiler.ValidationError, "unread discovery has semantic association"):
            compiler.validate_audit_overlay(self.catalog, overlay)

    def test_discovery_cannot_create_catalog_identity_or_approval(self):
        for field, value in (("model_id", "guessed_model"), ("whole_record_approved", True), ("historical_equivalence", True)):
            overlay = copy.deepcopy(self.overlay)
            overlay["discovery_evidence"][0][field] = value
            with self.assertRaises(compiler.ValidationError):
                compiler.validate_audit_overlay(self.catalog, overlay)

    def test_pdf_locators_and_per_benchmark_exceptions(self):
        rows = [r for r in self.catalog["occurrences"] if r["source_id"] == "source_anthropic_technical_a7729a0e5eb61dc6818f553ae3c27ab774411cd5ab4ed7f414456d74a05c26d2"]
        self.assertEqual(len(rows), 29)
        for row in rows:
            self.assertTrue(row["locator"]["value"].startswith("PDF p"))
            record = next(r for r in self.overlay["records"] if r["entity_type"] == "occurrences" and r["record_id"] == row["id"])
            self.assertTrue(any(ref.startswith("t_8e496830:proposal_occurrence_") for ref in record["supplemental_evidence_ids"]))
        by = {r["benchmark_id"]: r for r in rows}
        self.assertIn("Thinking disabled", by["benchmark_terminal_bench_2_0"]["summary"])
        self.assertIn("Thinking off", by["benchmark_browsecomp"]["summary"])
        self.assertIn("HIGH effort", by["benchmark_finance_agent"]["summary"])
        self.assertIn("MEDIUM effort", by["benchmark_usamo_2026"]["summary"])
        self.assertIn("root-owned", by["benchmark_osworld"]["summary"])

    def test_base_math_shot_counts_do_not_transfer_to_instruct(self):
        prefix = "occurrence_qwen_occurrence_qwen_20240807_introducing_qwen2_math_qwen2_math_"
        shots = {"gsm8k": "8-shot", "math": "4-shot", "mmlu_stem": "4-shot", "cmath": "6-shot", "gaokao_math_cloze": "5-shot", "gaokao_math_qa": "5-shot"}
        for suffix, shot in shots.items():
            row = self.occurrences[prefix + suffix]
            value = row["evaluation_setup"]["shot_configuration"]["value"]
            self.assertTrue(value.startswith(shot + " for the base-model rows"))
            self.assertIn("instruction-tuned settings are distinct", value)
            self.assertIn("historical image equivalence is unproven", value)
            self.assertIn("aggregate model identity remains under review", row["summary"])
            self.assertEqual(row["review_status"], "needs_review")

    def test_qvq_source_revision_and_checks_are_coupled(self):
        sources = [s for s in self.catalog["sources"] if s["url"].startswith(QWEN_PREFIX)]
        self.assertEqual(len(sources), 26)
        row = self.occurrences[QVEN]
        source = next(s for s in sources if s["id"] == row["source_id"])
        self.assertEqual(source["url"], QWEN_PREFIX + "content/blog/qvq-max-preview/index.md")
        self.assertEqual(source["revision"]["identifier"], f"git:{COMMIT}:content/blog/qvq-max-preview/index.md")
        self.assertEqual(row["source_revision_id"], source["revision"]["id"])
        self.assertEqual(source["publication_date"], "2025-03-27")
        checks = [c for c in self.overlay["source_checks"] if c["source_id"] == source["id"]]
        self.assertEqual(len(checks), 2)
        current = next(c for c in checks if c["exact_url"] == source["url"])
        self.assertEqual(current["fingerprint"], "8ae04c793b1fc2d365d9884a7a0efb84228a2956e73c86952dc13499d9c50aca")
        self.assertIn("no model-name label", row["summary"])
        self.assertEqual(row["review_status"], "needs_review")  # bounded figure binding is not whole-record approval

    def test_url_escaped_space_is_not_a_percentage_but_encoded_scores_fail(self):
        url = "https://example.org/Claude%20Sonnet%205%20System%20Card.pdf"
        compiler.assert_no_score_like({"url": url})
        self.assertIn("%205%20", url)  # literal URL identity is not rewritten
        for key in ("url", "exact_url"):
            for value in ("https://example.org/accuracy%208", "https://example.org/95%25", "https://example.org/95%"):
                with self.assertRaisesRegex(compiler.ValidationError, "forbidden score-like text"):
                    compiler.assert_no_score_like({key: value})
        with self.assertRaisesRegex(compiler.ValidationError, "forbidden score-like text"):
            compiler.assert_no_score_like({"summary": "accuracy 8"})


if __name__ == "__main__":
    unittest.main()
