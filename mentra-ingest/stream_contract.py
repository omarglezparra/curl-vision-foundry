from __future__ import annotations

from dataclasses import dataclass
import hashlib
import hmac
import re
import time


STREAM_PATTERN = re.compile(
    r"^ajc_(?P<session>[A-Za-z0-9_-]{1,80})"
    r"__p_(?P<profile>[A-Za-z0-9_-]{1,80})"
    r"__r_(?P<rotation>0|90|180|270)"
    r"__s_(?P<scene>[01])"
    r"__m_(?P<source>[01])"
    r"__e_(?P<expires>[0-9]{10,12})"
    r"__n_(?P<nonce>[A-Za-z0-9_-]{16,64})"
    r"__h_(?P<signature>[a-f0-9]{32})$"
)

# Read-only migration support for segments recorded before expiring publisher
# credentials were introduced. Authorization never accepts this legacy form.
LEGACY_STREAM_PATTERN = re.compile(
    r"^ajc_(?P<session>[A-Za-z0-9_-]{1,80})"
    r"__p_(?P<profile>[A-Za-z0-9_-]{1,80})"
    r"__r_(?P<rotation>0|90|180|270)"
    r"__s_(?P<scene>[01])"
    r"__m_(?P<source>[01])"
    r"__h_(?P<signature>[a-f0-9]{32})$"
)


@dataclass(frozen=True)
class StreamMetadata:
    session_id: str
    profile_id: str
    rotation_degrees: int
    scene_reflected: bool
    source_pixels_mirrored: bool
    expires_at_epoch: int | None
    nonce: str | None
    stream_id: str


def _stream_id_from_path(path: str) -> str:
    normalized = str(path or "").strip().strip("/")
    if normalized.startswith("live/"):
        normalized = normalized.removeprefix("live/")
    if not normalized or "/" in normalized:
        raise ValueError("Stream path must contain one signed AI Javier stream ID.")
    return normalized


def signature_for_prefix(prefix: str, secret: str) -> str:
    if not secret:
        raise ValueError("STREAM_KEY_SECRET is required.")
    return hmac.new(
        secret.encode("utf-8"),
        prefix.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()[:32]


def parse_signed_stream_path(path: str, secret: str) -> StreamMetadata:
    """Verify a stream ID and return its immutable recording metadata.

    This parser deliberately does not reject an expired ID. Completed segments
    can remain on disk beyond the publish window and must still be uploadable by
    the retry worker. New publishers must use ``authorize_publish_stream_path``.
    """
    stream_id = _stream_id_from_path(path)
    match = STREAM_PATTERN.fullmatch(stream_id)
    legacy = False
    if not match:
        match = LEGACY_STREAM_PATTERN.fullmatch(stream_id)
        legacy = match is not None
    if match is None:
        raise ValueError("Stream ID format is invalid.")

    signed_prefix, separator, supplied_signature = stream_id.rpartition("__h_")
    if not separator:
        raise ValueError("Stream ID signature is missing.")
    expected_signature = signature_for_prefix(signed_prefix, secret)
    if not hmac.compare_digest(supplied_signature, expected_signature):
        raise ValueError("Stream ID signature is invalid.")

    return StreamMetadata(
        session_id=match.group("session"),
        profile_id=match.group("profile"),
        rotation_degrees=int(match.group("rotation")),
        scene_reflected=match.group("scene") == "1",
        source_pixels_mirrored=match.group("source") == "1",
        expires_at_epoch=None if legacy else int(match.group("expires")),
        nonce=None if legacy else match.group("nonce"),
        stream_id=stream_id,
    )


def authorize_publish_stream_path(
    path: str,
    secret: str,
    *,
    now: float | None = None,
    max_future_seconds: int | None = None,
    future_clock_skew_seconds: int = 0,
) -> StreamMetadata:
    """Verify a signed ID and enforce its short-lived publishing window."""
    metadata = parse_signed_stream_path(path, secret)
    current_epoch = int(time.time() if now is None else now)

    if metadata.expires_at_epoch is None or metadata.nonce is None:
        raise ValueError("Stream ID lacks an expiry and nonce.")
    if metadata.expires_at_epoch <= current_epoch:
        raise ValueError("Stream ID has expired.")
    if max_future_seconds is not None:
        if max_future_seconds < 1:
            raise ValueError("Maximum stream credential lifetime is invalid.")
        if future_clock_skew_seconds < 0:
            raise ValueError("Stream credential clock skew allowance is invalid.")
        if metadata.expires_at_epoch > current_epoch + max_future_seconds + future_clock_skew_seconds:
            raise ValueError("Stream ID expiry exceeds the permitted lifetime.")

    return metadata
