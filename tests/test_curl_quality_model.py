import json
from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]
MODEL_PATH = ROOT / "docs" / "models" / "curl-quality-v1.json"
LABELS_PATH = ROOT / "training-videos" / "curl-training-segments" / "quality-labels.json"


class CurlQualityModelArtifactTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.model = json.loads(MODEL_PATH.read_text(encoding="utf-8"))
        cls.labels = json.loads(LABELS_PATH.read_text(encoding="utf-8"))

    def test_model_passed_grouped_video_and_full_attempt_gates(self):
        evaluation = self.model["evaluation"]
        self.assertTrue(evaluation["deployment_gate"]["eligible"])
        self.assertGreaterEqual(evaluation["roc_auc"], 0.75)
        self.assertGreaterEqual(evaluation["good_recall"], 0.80)
        self.assertGreaterEqual(evaluation["bad_rejection_rate"], 0.65)
        attempts = evaluation["labeled_attempt_sanity_check"]
        self.assertGreaterEqual(attempts["good_attempt_acceptance"], 0.80)
        self.assertGreaterEqual(attempts["bad_attempt_rejection"], 0.75)

    def test_runtime_feature_order_matches_all_coefficients(self):
        features = self.model["features"]
        self.assertEqual(len(features), 10)
        self.assertEqual(len(self.model["standard_scaler"]["mean"]), len(features))
        self.assertEqual(len(self.model["standard_scaler"]["scale"]), len(features))
        self.assertEqual(len(self.model["classifier"]["coefficients"]), len(features))

    def test_ambiguous_and_variant_clips_are_reference_only(self):
        training_files = {item["file"] for item in self.labels["videos"]}
        reference_files = {item["file"] for item in self.labels["reference_only"]}
        self.assertEqual(len(training_files), 4)
        self.assertIn("Curl training_2.mp4", reference_files)
        self.assertIn("Curl_martillo.mp4", reference_files)
        self.assertIn("Biceps con barra.mp4", reference_files)
        self.assertTrue(training_files.isdisjoint(reference_files))

    def test_raw_videos_are_not_part_of_the_web_model(self):
        self.assertEqual(self.model["dataset"]["rights_status"], "unverified_private_training_only")
        self.assertFalse(any(path.suffix.lower() == ".mp4" for path in (ROOT / "docs").rglob("*")))


if __name__ == "__main__":
    unittest.main()
