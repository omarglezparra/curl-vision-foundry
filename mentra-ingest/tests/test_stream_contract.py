from __future__ import annotations

import sys
from pathlib import Path
import unittest


sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from stream_contract import (  # noqa: E402
    authorize_publish_stream_path,
    parse_signed_stream_path,
    signature_for_prefix,
)


class StreamContractTests(unittest.TestCase):
    def setUp(self) -> None:
        self.secret = "test-stream-secret"
        self.expires_at = 2_000_000_000
        self.nonce = "AbCdEfGhIjKlMnOpQrStUv"
        self.prefix = (
            "ajc_mentra_20260730T010203Z_ab12cd34"
            "__p_mp_9f00aa11bb22cc33__r_90__s_1__m_0"
            f"__e_{self.expires_at}__n_{self.nonce}"
        )
        self.stream_id = f"{self.prefix}__h_{signature_for_prefix(self.prefix, self.secret)}"

    def test_valid_signed_path_round_trips_metadata(self) -> None:
        metadata = parse_signed_stream_path(self.stream_id, self.secret)

        self.assertEqual(metadata.session_id, "mentra_20260730T010203Z_ab12cd34")
        self.assertEqual(metadata.profile_id, "mp_9f00aa11bb22cc33")
        self.assertEqual(metadata.rotation_degrees, 90)
        self.assertTrue(metadata.scene_reflected)
        self.assertFalse(metadata.source_pixels_mirrored)
        self.assertEqual(metadata.expires_at_epoch, self.expires_at)
        self.assertEqual(metadata.nonce, self.nonce)

    def test_publish_authorization_enforces_expiry_and_maximum_lifetime(self) -> None:
        metadata = authorize_publish_stream_path(
            self.stream_id,
            self.secret,
            now=self.expires_at - 60,
            max_future_seconds=60,
        )
        self.assertEqual(metadata.stream_id, self.stream_id)

        with self.assertRaisesRegex(ValueError, "expired"):
            authorize_publish_stream_path(self.stream_id, self.secret, now=self.expires_at)
        with self.assertRaisesRegex(ValueError, "permitted lifetime"):
            authorize_publish_stream_path(
                self.stream_id,
                self.secret,
                now=self.expires_at - 61,
                max_future_seconds=60,
            )
        skew_tolerated = authorize_publish_stream_path(
            self.stream_id,
            self.secret,
            now=self.expires_at - 61,
            max_future_seconds=60,
            future_clock_skew_seconds=1,
        )
        self.assertEqual(skew_tolerated.stream_id, self.stream_id)

    def test_expired_stream_still_parses_for_delayed_segment_uploads(self) -> None:
        metadata = parse_signed_stream_path(self.stream_id, self.secret)
        self.assertEqual(metadata.expires_at_epoch, self.expires_at)

    def test_live_prefix_is_supported(self) -> None:
        metadata = parse_signed_stream_path(f"live/{self.stream_id}", self.secret)
        self.assertEqual(metadata.stream_id, self.stream_id)

    def test_tampering_and_reader_like_paths_are_rejected(self) -> None:
        with self.assertRaises(ValueError):
            parse_signed_stream_path(self.stream_id.replace("__r_90", "__r_180"), self.secret)
        with self.assertRaises(ValueError):
            parse_signed_stream_path(f"archive/{self.stream_id}", self.secret)
        with self.assertRaises(ValueError):
            parse_signed_stream_path(self.stream_id, "wrong-secret")

    def test_legacy_stream_parses_for_migration_but_cannot_publish(self) -> None:
        legacy_prefix = "ajc_session__p_profile__r_0__s_0__m_0"
        legacy_id = f"{legacy_prefix}__h_{signature_for_prefix(legacy_prefix, self.secret)}"
        metadata = parse_signed_stream_path(legacy_id, self.secret)
        self.assertIsNone(metadata.expires_at_epoch)
        self.assertIsNone(metadata.nonce)
        with self.assertRaisesRegex(ValueError, "expiry and nonce"):
            authorize_publish_stream_path(legacy_id, self.secret, now=1_900_000_000)

    def test_short_nonce_stream_id_is_rejected(self) -> None:
        short_nonce_prefix = "ajc_session__p_profile__r_0__s_0__m_0__e_2000000000__n_short"
        short_nonce_id = (
            f"{short_nonce_prefix}__h_{signature_for_prefix(short_nonce_prefix, self.secret)}"
        )
        with self.assertRaisesRegex(ValueError, "format"):
            parse_signed_stream_path(short_nonce_id, self.secret)


if __name__ == "__main__":
    unittest.main()
