from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Mapping

import cv2
import numpy as np


GEOMETRY_SCHEMA_VERSION = 1
VALID_ROTATIONS = frozenset({0, 90, 180, 270})
GEOMETRY_METADATA_FIELDS = (
    "geometry_schema_version",
    "rotation_cw_to_upright",
    "scene_reflected",
    "source_pixels_mirrored",
    "horizontal_flip_applied",
)


def _metadata_bool(value: Any, field_name: str) -> bool:
    if isinstance(value, bool):
        return value
    raise ValueError(f"{field_name} must be a JSON boolean, got {value!r}.")


@dataclass(frozen=True)
class VideoGeometry:
    """Deterministic transform from source pixels to upright analysis pixels.

    Rotation is applied clockwise first. A horizontal flip is then applied when
    exactly one of the physical scene or the encoded source pixels is mirrored.
    """

    rotation_cw_to_upright: int = 0
    scene_reflected: bool = False
    source_pixels_mirrored: bool = False

    def __post_init__(self) -> None:
        if type(self.rotation_cw_to_upright) is not int or self.rotation_cw_to_upright not in VALID_ROTATIONS:
            allowed = ", ".join(str(value) for value in sorted(VALID_ROTATIONS))
            raise ValueError(f"rotation_cw_to_upright must be one of {allowed} degrees.")
        if type(self.scene_reflected) is not bool:
            raise ValueError("scene_reflected must be a boolean.")
        if type(self.source_pixels_mirrored) is not bool:
            raise ValueError("source_pixels_mirrored must be a boolean.")

    @property
    def horizontal_flip_applied(self) -> bool:
        return self.scene_reflected != self.source_pixels_mirrored

    def to_metadata(self) -> dict[str, int | bool]:
        return {
            "geometry_schema_version": GEOMETRY_SCHEMA_VERSION,
            "rotation_cw_to_upright": self.rotation_cw_to_upright,
            "scene_reflected": self.scene_reflected,
            "source_pixels_mirrored": self.source_pixels_mirrored,
            "horizontal_flip_applied": self.horizontal_flip_applied,
        }

    @classmethod
    def from_metadata(cls, metadata: Mapping[str, Any] | None) -> "VideoGeometry":
        """Build geometry from capture metadata, defaulting to no transform.

        New capture clients may place the fields at the metadata root or inside
        a ``video_geometry`` object. ``rotation_cw_to_upright`` is canonical;
        the two rotation aliases are accepted for early capture clients.
        Ambiguous legacy fields such as ``mirrored_input`` are intentionally not
        inferred.
        """

        if metadata is None:
            return cls()
        if not isinstance(metadata, Mapping):
            raise ValueError("Video geometry metadata must be an object.")

        raw_geometry = metadata.get("video_geometry", metadata)
        if not isinstance(raw_geometry, Mapping):
            raise ValueError("video_geometry must be an object.")

        version = raw_geometry.get("geometry_schema_version", GEOMETRY_SCHEMA_VERSION)
        if type(version) is not int or version != GEOMETRY_SCHEMA_VERSION:
            raise ValueError(
                f"Unsupported geometry_schema_version {version!r}; expected {GEOMETRY_SCHEMA_VERSION}."
            )

        rotation = raw_geometry.get(
            "rotation_cw_to_upright",
            raw_geometry.get("rotation_degrees", raw_geometry.get("source_rotation_degrees", 0)),
        )
        scene_reflected = _metadata_bool(raw_geometry.get("scene_reflected", False), "scene_reflected")
        source_pixels_mirrored = _metadata_bool(
            raw_geometry.get("source_pixels_mirrored", False),
            "source_pixels_mirrored",
        )
        geometry = cls(
            rotation_cw_to_upright=rotation,
            scene_reflected=scene_reflected,
            source_pixels_mirrored=source_pixels_mirrored,
        )

        if "horizontal_flip_applied" in raw_geometry:
            recorded_flip = _metadata_bool(
                raw_geometry["horizontal_flip_applied"],
                "horizontal_flip_applied",
            )
            if recorded_flip != geometry.horizontal_flip_applied:
                raise ValueError(
                    "horizontal_flip_applied conflicts with scene_reflected/source_pixels_mirrored parity."
                )
        return geometry


def apply_analysis_transform(frame: np.ndarray, geometry: VideoGeometry) -> np.ndarray:
    """Rotate to upright, then remove odd horizontal reflection parity."""

    if not isinstance(frame, np.ndarray) or frame.ndim not in {2, 3} or frame.size == 0:
        raise ValueError("frame must be a non-empty 2D or 3D NumPy array.")

    transformed = frame
    if geometry.rotation_cw_to_upright == 90:
        transformed = cv2.rotate(transformed, cv2.ROTATE_90_CLOCKWISE)
    elif geometry.rotation_cw_to_upright == 180:
        transformed = cv2.rotate(transformed, cv2.ROTATE_180)
    elif geometry.rotation_cw_to_upright == 270:
        transformed = cv2.rotate(transformed, cv2.ROTATE_90_COUNTERCLOCKWISE)

    if geometry.horizontal_flip_applied:
        transformed = cv2.flip(transformed, 1)
    return transformed
