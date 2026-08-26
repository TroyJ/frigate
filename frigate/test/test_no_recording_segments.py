"""fork: pins compute_no_recording_segments() to upstream's original per-segment scan.

The original algorithm is reproduced here verbatim as the oracle so that the O(n) sweep
can never silently diverge from it. See docs/work/frigate-infinite-timeline-handover.md F21.
"""

import random
import unittest

from frigate.api.media import compute_no_recording_segments


def _oracle(recordings, after, before, scale):
    no_recording_segments = []
    current = after
    current_gap_start = None
    while current < before:
        segment_end = min(current + scale, before)
        has_recording = any(
            rec_start < segment_end and rec_end > current
            for rec_start, rec_end in recordings
        )
        if not has_recording:
            if current_gap_start is None:
                current_gap_start = current
        else:
            if current_gap_start is not None:
                no_recording_segments.append(
                    {"start_time": int(current_gap_start), "end_time": int(current)}
                )
                current_gap_start = None
        current = segment_end
    if current_gap_start is not None:
        no_recording_segments.append(
            {"start_time": int(current_gap_start), "end_time": int(before)}
        )
    return no_recording_segments


class TestNoRecordingSegments(unittest.TestCase):
    def test_empty(self):
        self.assertEqual(
            compute_no_recording_segments([], 0, 100, 10),
            [{"start_time": 0, "end_time": 100}],
        )

    def test_full_coverage(self):
        self.assertEqual(compute_no_recording_segments([(0, 100)], 0, 100, 10), [])

    def test_matches_oracle_random(self):
        rng = random.Random(1234)
        for _ in range(300):
            after = rng.uniform(0, 1000)
            before = after + rng.uniform(1, 2000)
            scale = rng.choice([1, 5, 10, 15, 30, 60])
            recs = []
            for _ in range(rng.randint(0, 40)):
                start = rng.uniform(after - 100, before + 100)
                recs.append((start, start + rng.uniform(0.1, 60)))
            recs.sort()
            self.assertEqual(
                compute_no_recording_segments(recs, after, before, scale),
                _oracle(recs, after, before, scale),
                (recs, after, before, scale),
            )
