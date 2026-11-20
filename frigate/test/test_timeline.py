"""TimelineProcessor.pre_event_cache must not outlive the tracked objects it caches for.

Fork backport of upstream blakeblackshear/frigate e37041c8 (PR #24510) test, adapted to
0.17.1: the enums live in frigate.events.maintainer and the processor reads
config.cameras[camera] rather than config.cameras.get(camera).
"""

import unittest
from unittest.mock import MagicMock, patch

from frigate.events.maintainer import EventStateEnum
from frigate.models import Timeline
from frigate.timeline import TimelineProcessor


def make_event(event_id: str, has_clip: bool, has_snapshot: bool) -> dict:
    return {
        "id": event_id,
        "frame_time": 1000.0,
        "box": [0, 0, 10, 10],
        "region": [0, 0, 100, 100],
        "label": "car",
        "sub_label": None,
        "score": 0.8,
        "has_clip": has_clip,
        "has_snapshot": has_snapshot,
        "current_zones": [],
        "stationary": False,
        "attributes": {},
        "current_attributes": [],
    }


class TestTimelineProcessor(unittest.TestCase):
    def setUp(self):
        camera_config = MagicMock()
        camera_config.detect.width = 1280
        camera_config.detect.height = 720
        config = MagicMock()
        config.cameras = {"front": camera_config}
        self.processor = TimelineProcessor(config, MagicMock(), MagicMock())

    @patch.object(Timeline, "insert")
    def test_unsaved_event_writes_no_timeline_rows(self, insert):
        event = make_event("event-1", has_clip=False, has_snapshot=False)
        self.processor.handle_object_detection(
            "front", EventStateEnum.start, None, event
        )
        self.assertIn("event-1", self.processor.pre_event_cache)

        self.processor.handle_object_detection(
            "front", EventStateEnum.end, event, event
        )

        insert.assert_not_called()
        self.assertEqual(self.processor.pre_event_cache, {})

    @patch.object(Timeline, "insert")
    def test_cached_entries_flush_when_event_is_saved(self, insert):
        start = make_event("event-1", has_clip=False, has_snapshot=False)
        self.processor.handle_object_detection(
            "front", EventStateEnum.start, None, start
        )
        insert.assert_not_called()

        end = make_event("event-1", has_clip=True, has_snapshot=False)
        self.processor.handle_object_detection("front", EventStateEnum.end, start, end)

        class_types = [c.args[0][Timeline.class_type] for c in insert.call_args_list]
        self.assertEqual(class_types, ["visible", "gone"])
        self.assertEqual(self.processor.pre_event_cache, {})

    @patch.object(Timeline, "insert")
    def test_many_unsaved_objects_leave_nothing_behind(self, insert):
        """The leak itself: before the fix each of these left a list behind."""
        for i in range(1000):
            event = make_event(f"event-{i}", has_clip=False, has_snapshot=False)
            self.processor.handle_object_detection(
                "front", EventStateEnum.start, None, event
            )
            moved = dict(event, stationary=True)
            self.processor.handle_object_detection(
                "front", EventStateEnum.update, event, moved
            )
            self.processor.handle_object_detection(
                "front", EventStateEnum.end, moved, moved
            )

        insert.assert_not_called()
        self.assertEqual(self.processor.pre_event_cache, {})


if __name__ == "__main__":
    unittest.main()
