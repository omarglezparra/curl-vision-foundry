from __future__ import annotations

import sys
import unittest
from pathlib import Path

import numpy as np


SRC_DIR = Path(__file__).resolve().parents[1] / "src"
sys.path.insert(0, str(SRC_DIR))

from video_geometry import VideoGeometry, apply_analysis_transform  # noqa: E402


class VideoGeometryTests(unittest.TestCase):
    def setUp(self) -> None:
        # Distinct values make corner position and transform order observable.
        self.frame = np.array([[1, 2, 3], [4, 5, 6]], dtype=np.uint8)

    def test_all_clockwise_rotations_preserve_expected_pixels_and_dimensions(self) -> None:
        expected = {
            0: np.array([[1, 2, 3], [4, 5, 6]], dtype=np.uint8),
            90: np.array([[4, 1], [5, 2], [6, 3]], dtype=np.uint8),
            180: np.array([[6, 5, 4], [3, 2, 1]], dtype=np.uint8),
            270: np.array([[3, 6], [2, 5], [1, 4]], dtype=np.uint8),
        }

        for rotation, expected_frame in expected.items():
            with self.subTest(rotation=rotation):
                actual = apply_analysis_transform(
                    self.frame,
                    VideoGeometry(rotation_cw_to_upright=rotation),
                )
                np.testing.assert_array_equal(actual, expected_frame)
                self.assertEqual(actual.shape, expected_frame.shape)

    def test_reflection_parity_flips_when_exactly_one_source_is_mirrored(self) -> None:
        expected_flipped = np.array([[3, 2, 1], [6, 5, 4]], dtype=np.uint8)
        for scene_reflected, source_pixels_mirrored in ((True, False), (False, True)):
            with self.subTest(
                scene_reflected=scene_reflected,
                source_pixels_mirrored=source_pixels_mirrored,
            ):
                geometry = VideoGeometry(
                    scene_reflected=scene_reflected,
                    source_pixels_mirrored=source_pixels_mirrored,
                )
                self.assertTrue(geometry.horizontal_flip_applied)
                np.testing.assert_array_equal(
                    apply_analysis_transform(self.frame, geometry),
                    expected_flipped,
                )

        for scene_reflected, source_pixels_mirrored in ((False, False), (True, True)):
            with self.subTest(
                scene_reflected=scene_reflected,
                source_pixels_mirrored=source_pixels_mirrored,
            ):
                geometry = VideoGeometry(
                    scene_reflected=scene_reflected,
                    source_pixels_mirrored=source_pixels_mirrored,
                )
                self.assertFalse(geometry.horizontal_flip_applied)
                np.testing.assert_array_equal(
                    apply_analysis_transform(self.frame, geometry),
                    self.frame,
                )

    def test_rotation_happens_before_horizontal_parity_flip(self) -> None:
        geometry = VideoGeometry(rotation_cw_to_upright=90, scene_reflected=True)
        expected = np.array([[1, 4], [2, 5], [3, 6]], dtype=np.uint8)

        actual = apply_analysis_transform(self.frame, geometry)

        np.testing.assert_array_equal(actual, expected)
        self.assertEqual(actual.shape, (3, 2))

    def test_metadata_round_trip_and_default_are_safe(self) -> None:
        geometry = VideoGeometry(
            rotation_cw_to_upright=270,
            scene_reflected=True,
            source_pixels_mirrored=False,
        )

        metadata = geometry.to_metadata()

        self.assertEqual(VideoGeometry.from_metadata(metadata), geometry)
        self.assertEqual(VideoGeometry.from_metadata({}), VideoGeometry())
        self.assertEqual(VideoGeometry.from_metadata(None), VideoGeometry())

    def test_invalid_rotation_and_inconsistent_parity_are_rejected(self) -> None:
        for invalid_rotation in (-90, 45, 360, "90", True):
            with self.subTest(rotation=invalid_rotation):
                with self.assertRaises(ValueError):
                    VideoGeometry(rotation_cw_to_upright=invalid_rotation)  # type: ignore[arg-type]

        with self.assertRaises(ValueError):
            VideoGeometry.from_metadata(
                {
                    "scene_reflected": True,
                    "source_pixels_mirrored": False,
                    "horizontal_flip_applied": False,
                }
            )


if __name__ == "__main__":
    unittest.main()
