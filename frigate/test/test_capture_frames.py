"""capture_frames must not open a ZMQ subscriber of its own (fork change).

Every capture-thread start (every ffmpeg restart by the camera watchdog) used to open a
CameraConfigUpdateSubscriber connected to the main process's config publisher; the idle
publisher kept each dead connection's memory. The enabled state now comes from the
watchdog's CameraConfig object, which the watchdog's own subscriber keeps current.
"""

import unittest
from unittest.mock import MagicMock, patch

from frigate.video import capture_frames


def run_capture(config, ffmpeg_process):
    stop_event = MagicMock()
    stop_event.is_set.return_value = False
    frame_manager = MagicMock()
    frame_manager.write.return_value = bytearray(4 * 4)
    capture_frames(
        ffmpeg_process,
        config,
        2,
        0,
        (4, 4),
        frame_manager,
        MagicMock(),
        MagicMock(),
        MagicMock(),
        MagicMock(),
        stop_event,
    )
    return frame_manager


class TestCaptureFrames(unittest.TestCase):
    def setUp(self):
        self.config = MagicMock()
        self.config.name = "cam"
        self.config.enabled = True

    @patch("frigate.video.CameraConfigUpdateSubscriber")
    def test_dead_ffmpeg_exits_without_a_subscriber(self, subscriber):
        ffmpeg_process = MagicMock()
        ffmpeg_process.stdout.read.side_effect = ValueError("read of closed file")
        ffmpeg_process.poll.return_value = 1

        run_capture(self.config, ffmpeg_process)

        subscriber.assert_not_called()
        ffmpeg_process.stdout.read.assert_called_once()

    @patch("frigate.video.CameraConfigUpdateSubscriber")
    def test_disabled_camera_stops_before_reading(self, subscriber):
        self.config.enabled = False
        ffmpeg_process = MagicMock()

        frame_manager = run_capture(self.config, ffmpeg_process)

        subscriber.assert_not_called()
        ffmpeg_process.stdout.read.assert_not_called()
        frame_manager.write.assert_not_called()


if __name__ == "__main__":
    unittest.main()
