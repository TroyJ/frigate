"""Tests for review.alerts.mirror_from — fanning one camera's alert review
segments onto other cameras so a detection-free camera can inherit alert-tier
recording retention without a second detector."""

import os
import sys
import tempfile
import unittest
from unittest.mock import MagicMock, patch

# Mock complex imports before importing the maintainer
sys.modules["frigate.comms.inter_process"] = MagicMock()
sys.modules["frigate.comms.detections_updater"] = MagicMock()
sys.modules["frigate.comms.review_updater"] = MagicMock()
sys.modules["frigate.config.camera.updater"] = MagicMock()

from frigate.review.maintainer import (  # noqa: E402
    PendingReviewSegment,
    ReviewSegmentMaintainer,
)
from frigate.review.types import SeverityEnum  # noqa: E402


def camera_mock(mirror_from=None, enabled=True, record=True, alerts=True):
    cam = MagicMock()
    cam.enabled = enabled
    cam.record.enabled = record
    cam.review.alerts.enabled = alerts
    cam.review.alerts.mirror_from = mirror_from or []
    return cam


def make_maintainer(cameras):
    config = MagicMock()
    config.cameras = cameras
    with patch("frigate.review.maintainer.Path"):
        return ReviewSegmentMaintainer(config, MagicMock())


def segment(camera="wide", severity=SeverityEnum.alert, start=1000.0):
    return PendingReviewSegment(
        camera, start, severity, {"obj1": "person"}, sub_labels={}, zones=[], audio=set()
    )


class TestReviewMirroring(unittest.TestCase):
    def setUp(self):
        self.cameras = {
            "wide": camera_mock(),
            "tele": camera_mock(mirror_from=["wide"]),
        }
        self.m = make_maintainer(self.cameras)

    # -- target resolution ------------------------------------------------
    def test_mirror_targets_finds_configured_camera(self):
        self.assertEqual(self.m._mirror_targets("wide"), ["tele"])

    def test_mirror_targets_excludes_self(self):
        self.cameras["wide"].review.alerts.mirror_from = ["wide"]
        self.assertNotIn("wide", self.m._mirror_targets("wide"))

    def test_mirror_targets_respects_disabled_gates(self):
        for attr, value in (
            ("enabled", False),
            ("record.enabled", False),
            ("review.alerts.enabled", False),
        ):
            with self.subTest(gate=attr):
                self.cameras["tele"] = camera_mock(mirror_from=["wide"])
                obj = self.cameras["tele"]
                *path, last = attr.split(".")
                for part in path:
                    obj = getattr(obj, part)
                setattr(obj, last, value)
                self.assertEqual(self.m._mirror_targets("wide"), [])

    # -- creation ---------------------------------------------------------
    def test_alert_segment_creates_mirror(self):
        src = segment()
        self.m._publish_segment_start(src)

        mirrors = self.m.mirrored_segments["wide"]
        self.assertEqual(list(mirrors), ["tele"])
        mirror = mirrors["tele"]
        self.assertEqual(mirror.camera, "tele")
        self.assertEqual(mirror.severity, SeverityEnum.alert)
        self.assertEqual(mirror.mirrored_from, "wide")

    def test_mirror_borrows_source_start_time(self):
        """A segment that escalated detection -> alert must still protect its
        whole window, so the mirror starts when the SOURCE did, not now."""
        src = segment(severity=SeverityEnum.detection, start=500.0)
        src.severity = SeverityEnum.alert  # escalation, as maintainer.py:402 does
        src.last_alert_time = 900.0
        self.m._publish_segment_start(src)

        self.assertEqual(self.m.mirrored_segments["wide"]["tele"].start_time, 500.0)

    def test_detection_segment_is_not_mirrored(self):
        self.m._publish_segment_start(segment(severity=SeverityEnum.detection))
        self.assertEqual(self.m.mirrored_segments.get("wide", {}), {})

    def test_mirror_does_not_mirror_itself(self):
        """Mirrors are emitted through the same _publish_* methods that trigger
        fan-out, so the mirrored_from guard is what prevents infinite recursion."""
        self.cameras["tele"].review.alerts.mirror_from = ["wide"]
        self.cameras["wide"].review.alerts.mirror_from = []
        self.m._publish_segment_start(segment())

        self.assertEqual(len(self.m.mirrored_segments["wide"]), 1)
        self.assertNotIn("tele", self.m.mirrored_segments)

    def test_repeated_updates_reuse_one_mirror(self):
        src = segment()
        self.m._publish_segment_start(src)
        first = self.m.mirrored_segments["wide"]["tele"]
        for _ in range(3):
            self.m._publish_segment_update(
                src, self.cameras["wide"], None, [], src.get_data(False)
            )
        self.assertIs(self.m.mirrored_segments["wide"]["tele"], first)

    # -- lifecycle --------------------------------------------------------
    def test_mirror_ends_with_source_and_matches_end_time(self):
        src = segment()
        self.m._publish_segment_start(src)
        mirror = self.m.mirrored_segments["wide"]["tele"]

        src.last_alert_time = 1234.0
        self.m._publish_segment_end(src, src.get_data(False))

        self.assertEqual(self.m.mirrored_segments.get("wide", {}), {})
        self.assertEqual(
            mirror.get_data(ended=True)["end_time"],
            src.get_data(ended=True)["end_time"],
        )

    def test_ending_mirror_does_not_clear_targets_active_slot(self):
        """active_review_segments is owned by each camera's own detection loop;
        a mirror must not blank a native segment sitting in that slot."""
        native = segment(camera="tele")
        self.m.active_review_segments["tele"] = native

        src = segment()
        self.m._publish_segment_start(src)
        self.m._publish_segment_end(src, src.get_data(False))

        self.assertIs(self.m.active_review_segments["tele"], native)
        self.assertIsNone(self.m.active_review_segments["wide"])

    # -- data / thumbnail -------------------------------------------------
    def test_mirrored_from_only_present_on_mirrors(self):
        src = segment()
        self.m._publish_segment_start(src)
        mirror = self.m.mirrored_segments["wide"]["tele"]

        self.assertNotIn("mirrored_from", src.get_data(False)["data"])
        self.assertEqual(mirror.get_data(False)["data"]["mirrored_from"], "wide")

    def test_thumbnail_is_copied_not_shared(self):
        """cleanup.py unlinks thumb_path on expiry, so sharing one file between
        two rows would dangle as soon as the first expired."""
        src, mirror = segment(), segment(camera="tele")
        with tempfile.TemporaryDirectory() as tmp:
            src.frame_path = os.path.join(tmp, "src.webp")
            mirror.frame_path = os.path.join(tmp, "mirror.webp")
            with open(src.frame_path, "wb") as fh:
                fh.write(b"thumbdata")
            src.has_frame = True
            src.thumb_time = 42.0

            self.m._sync_mirror_thumb(src, mirror)

            self.assertNotEqual(src.frame_path, mirror.frame_path)
            self.assertTrue(os.path.exists(mirror.frame_path))
            with open(mirror.frame_path, "rb") as fh:
                self.assertEqual(fh.read(), b"thumbdata")
            self.assertTrue(mirror.has_frame)
            self.assertEqual(mirror.thumb_time, 42.0)

    def test_thumb_copied_when_source_thumb_time_is_none(self):
        """Regression: save_full_frame() sets has_frame but never thumb_time, so a
        source thumbnail written by the no-activity path stays None — equal to a
        fresh mirror's None. Gating only on thumb_time skipped the copy forever,
        leaving mirrored review items with a dangling thumb_path (seen live on
        entrance_tele, 2026-08-06)."""
        src, mirror = segment(), segment(camera="tele")
        with tempfile.TemporaryDirectory() as tmp:
            src.frame_path = os.path.join(tmp, "src.webp")
            mirror.frame_path = os.path.join(tmp, "mirror.webp")
            with open(src.frame_path, "wb") as fh:
                fh.write(b"fullframe")
            src.has_frame = True
            src.thumb_time = None  # exactly what save_full_frame leaves behind
            self.assertIsNone(mirror.thumb_time)

            self._sync = self.m._sync_mirror_thumb(src, mirror)

            self.assertTrue(os.path.exists(mirror.frame_path))
            self.assertTrue(mirror.has_frame)

    def test_thumb_not_recopied_when_unchanged(self):
        """Once synced, an unchanged source must not trigger repeated file copies."""
        src, mirror = segment(), segment(camera="tele")
        with tempfile.TemporaryDirectory() as tmp:
            src.frame_path = os.path.join(tmp, "src.webp")
            mirror.frame_path = os.path.join(tmp, "mirror.webp")
            with open(src.frame_path, "wb") as fh:
                fh.write(b"one")
            src.has_frame = True
            src.thumb_time = 10.0

            self.m._sync_mirror_thumb(src, mirror)
            with open(src.frame_path, "wb") as fh:
                fh.write(b"two")  # source changed but thumb_time did not
            self.m._sync_mirror_thumb(src, mirror)

            with open(mirror.frame_path, "rb") as fh:
                self.assertEqual(fh.read(), b"one")

    def test_missing_source_thumb_is_not_fatal(self):
        src, mirror = segment(), segment(camera="tele")
        src.has_frame = True
        src.thumb_time = 1.0
        src.frame_path = "/nonexistent/nope.webp"

        self.m._sync_mirror_thumb(src, mirror)  # must not raise

        self.assertFalse(mirror.has_frame)


if __name__ == "__main__":
    unittest.main()
