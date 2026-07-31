import collections
import datetime
import logging
import os
import tempfile
import unittest
from unittest.mock import MagicMock, patch

from peewee import DoesNotExist
from peewee_migrate import Router
from playhouse.sqlite_ext import SqliteExtDatabase
from playhouse.sqliteq import SqliteQueueDatabase

from frigate.config import FrigateConfig
from frigate.models import Event, Recordings
from frigate.storage import StorageMaintainer
from frigate.test.const import TEST_DB, TEST_DB_CLEANUPS


class TestHttp(unittest.TestCase):
    def setUp(self):
        # setup clean database for each test run
        migrate_db = SqliteExtDatabase("test.db")
        del logging.getLogger("peewee_migrate").handlers[:]
        router = Router(migrate_db)
        router.run()
        migrate_db.close()
        self.db = SqliteQueueDatabase(TEST_DB)
        models = [Event, Recordings]
        self.db.bind(models)
        self.test_dir = tempfile.mkdtemp()

        self.minimal_config = {
            "mqtt": {"host": "mqtt"},
            "cameras": {
                "front_door": {
                    "ffmpeg": {
                        "inputs": [
                            {"path": "rtsp://10.0.0.1:554/video", "roles": ["detect"]}
                        ]
                    },
                    "detect": {
                        "height": 1080,
                        "width": 1920,
                        "fps": 5,
                    },
                }
            },
        }
        self.double_cam_config = {
            "mqtt": {"host": "mqtt"},
            "cameras": {
                "front_door": {
                    "ffmpeg": {
                        "inputs": [
                            {"path": "rtsp://10.0.0.1:554/video", "roles": ["detect"]}
                        ]
                    },
                    "detect": {
                        "height": 1080,
                        "width": 1920,
                        "fps": 5,
                    },
                },
                "back_door": {
                    "ffmpeg": {
                        "inputs": [
                            {"path": "rtsp://10.0.0.2:554/video", "roles": ["detect"]}
                        ]
                    },
                    "detect": {
                        "height": 1080,
                        "width": 1920,
                        "fps": 5,
                    },
                },
            },
        }

    def tearDown(self):
        if not self.db.is_closed():
            self.db.close()

        for file in TEST_DB_CLEANUPS:
            try:
                os.remove(file)
            except OSError:
                pass

    def test_segment_calculations(self):
        """Test that the segment calculations are correct."""
        config = FrigateConfig(**self.double_cam_config)
        storage = StorageMaintainer(config, MagicMock())

        time_keep = datetime.datetime.now().timestamp()
        rec_fd_id = "1234567.frontdoor"
        rec_bd_id = "1234568.backdoor"
        _insert_mock_recording(
            rec_fd_id,
            os.path.join(self.test_dir, f"{rec_fd_id}.tmp"),
            time_keep,
            time_keep + 10,
            camera="front_door",
            seg_size=4,
            seg_dur=10,
        )
        _insert_mock_recording(
            rec_bd_id,
            os.path.join(self.test_dir, f"{rec_bd_id}.tmp"),
            time_keep + 10,
            time_keep + 20,
            camera="back_door",
            seg_size=8,
            seg_dur=20,
        )
        storage.calculate_camera_bandwidth()
        assert storage.camera_storage_stats == {
            "front_door": {"bandwidth": 1440, "needs_refresh": True},
            "back_door": {"bandwidth": 2880, "needs_refresh": True},
        }

    def test_segment_calculations_with_zero_segments(self):
        """Ensure segment calculation does not fail when migrating from previous version."""
        config = FrigateConfig(**self.minimal_config)
        storage = StorageMaintainer(config, MagicMock())

        time_keep = datetime.datetime.now().timestamp()
        rec_fd_id = "1234567.frontdoor"
        _insert_mock_recording(
            rec_fd_id,
            os.path.join(self.test_dir, f"{rec_fd_id}.tmp"),
            time_keep,
            time_keep + 10,
            camera="front_door",
            seg_size=0,
            seg_dur=10,
        )
        storage.calculate_camera_bandwidth()
        assert storage.camera_storage_stats == {
            "front_door": {"bandwidth": 0, "needs_refresh": True},
        }

    def test_storage_cleanup(self):
        """Ensure that all recordings are cleaned up when necessary."""
        config = FrigateConfig(**self.minimal_config)
        storage = StorageMaintainer(config, MagicMock())

        id = "123456.keep"
        time_keep = datetime.datetime.now().timestamp()
        _insert_mock_event(
            id,
            time_keep,
            time_keep + 30,
            True,
        )
        rec_k_id = "1234567.keep"
        rec_k2_id = "1234568.keep"
        rec_k3_id = "1234569.keep"
        _insert_mock_recording(
            rec_k_id,
            os.path.join(self.test_dir, f"{rec_k_id}.tmp"),
            time_keep,
            time_keep + 10,
        )
        _insert_mock_recording(
            rec_k2_id,
            os.path.join(self.test_dir, f"{rec_k2_id}.tmp"),
            time_keep + 10,
            time_keep + 20,
        )
        _insert_mock_recording(
            rec_k3_id,
            os.path.join(self.test_dir, f"{rec_k3_id}.tmp"),
            time_keep + 20,
            time_keep + 30,
        )

        id2 = "7890.delete"
        time_delete = datetime.datetime.now().timestamp() - 360
        _insert_mock_event(id2, time_delete, time_delete + 30, False)
        rec_d_id = "78901.delete"
        rec_d2_id = "78902.delete"
        rec_d3_id = "78903.delete"
        _insert_mock_recording(
            rec_d_id,
            os.path.join(self.test_dir, f"{rec_d_id}.tmp"),
            time_delete,
            time_delete + 10,
        )
        _insert_mock_recording(
            rec_d2_id,
            os.path.join(self.test_dir, f"{rec_d2_id}.tmp"),
            time_delete + 10,
            time_delete + 20,
        )
        _insert_mock_recording(
            rec_d3_id,
            os.path.join(self.test_dir, f"{rec_d3_id}.tmp"),
            time_delete + 20,
            time_delete + 30,
        )

        storage.calculate_camera_bandwidth()
        storage.reduce_storage_consumption()
        with self.assertRaises(DoesNotExist):
            assert Recordings.get(Recordings.id == rec_k_id)
            assert Recordings.get(Recordings.id == rec_k2_id)
            assert Recordings.get(Recordings.id == rec_k3_id)
            Recordings.get(Recordings.id == rec_d_id)
            Recordings.get(Recordings.id == rec_d2_id)
            Recordings.get(Recordings.id == rec_d3_id)

    def test_storage_cleanup_keeps_retained(self):
        """Ensure that all recordings are cleaned up when necessary."""
        config = FrigateConfig(**self.minimal_config)
        storage = StorageMaintainer(config, MagicMock())

        id = "123456.keep"
        time_keep = datetime.datetime.now().timestamp()
        _insert_mock_event(
            id,
            time_keep,
            time_keep + 30,
            True,
        )
        rec_k_id = "1234567.keep"
        rec_k2_id = "1234568.keep"
        rec_k3_id = "1234569.keep"
        _insert_mock_recording(
            rec_k_id,
            os.path.join(self.test_dir, f"{rec_k_id}.tmp"),
            time_keep,
            time_keep + 10,
        )
        _insert_mock_recording(
            rec_k2_id,
            os.path.join(self.test_dir, f"{rec_k2_id}.tmp"),
            time_keep + 10,
            time_keep + 20,
        )
        _insert_mock_recording(
            rec_k3_id,
            os.path.join(self.test_dir, f"{rec_k3_id}.tmp"),
            time_keep + 20,
            time_keep + 30,
        )

        time_delete = datetime.datetime.now().timestamp() - 7200
        for i in range(0, 59):
            id = f"{123456 + i}.delete"
            _insert_mock_recording(
                id,
                os.path.join(self.test_dir, f"{id}.tmp"),
                time_delete,
                time_delete + 600,
            )

        storage.calculate_camera_bandwidth()
        storage.reduce_storage_consumption()
        assert Recordings.get(Recordings.id == rec_k_id)
        assert Recordings.get(Recordings.id == rec_k2_id)
        assert Recordings.get(Recordings.id == rec_k3_id)

    # ---- fork addition: record.min_disk_free_gb free-space floor ----

    def test_reclaim_target_governs_deletion(self):
        """reduce_storage_consumption deletes up to the pending reclaim target."""
        config = FrigateConfig(**self.minimal_config)
        storage = StorageMaintainer(config, MagicMock())
        storage.camera_storage_stats = {
            "front_door": {"bandwidth": 512, "needs_refresh": False}
        }

        time_old = datetime.datetime.now().timestamp() - 7200
        for i in range(0, 10):
            id = f"{700000 + i}.delete"
            _insert_mock_recording(
                id,
                os.path.join(self.test_dir, f"{id}.tmp"),
                time_old + i * 10,
                time_old + (i + 1) * 10,
                seg_size=512,
            )

        storage.pending_reclaim_mb = 2048
        storage.reduce_storage_consumption()

        # reduce_storage_consumption breaks out of its recordings iterator early,
        # leaving an unexhausted cursor that pins this connection's WAL snapshot;
        # reconnect so the assertion sees the committed deletes
        self.db.close()

        # deletion stops once cumulative size exceeds 2048 MB (5 x 512 = 2560)
        assert Recordings.select().count() == 5
        # target is consumed so a direct re-run falls back to hourly bandwidth
        assert storage.pending_reclaim_mb is None


class TestMinDiskFreeFloor(unittest.TestCase):
    """Fork addition: record.min_disk_free_gb free-space floor.

    These tests only exercise check_storage_needs_cleanup(), which never
    touches the database, so they deliberately skip the DB fixture above.
    """

    def setUp(self):
        self.minimal_config = {
            "mqtt": {"host": "mqtt"},
            "cameras": {
                "front_door": {
                    "ffmpeg": {
                        "inputs": [
                            {"path": "rtsp://10.0.0.1:554/video", "roles": ["detect"]}
                        ]
                    },
                    "detect": {
                        "height": 1080,
                        "width": 1920,
                        "fps": 5,
                    },
                }
            },
        }

    def _storage_with_min_free(self, gb: float) -> StorageMaintainer:
        config = dict(self.minimal_config)
        if gb:
            config["record"] = {"min_disk_free_gb": gb}
        storage = StorageMaintainer(FrigateConfig(**config), MagicMock())
        storage.camera_storage_stats = {
            "front_door": {"bandwidth": 1440, "needs_refresh": False}
        }
        return storage

    def test_min_disk_free_disabled_by_default(self):
        """With the floor unset, only the bandwidth threshold applies."""
        storage = self._storage_with_min_free(0)
        assert storage.min_free_mb == 0

        with patch(
            "frigate.storage.shutil.disk_usage",
            return_value=_mock_disk_usage(total_gb=60, free_gb=4),
        ):
            # 4096 MB free > 1440 MB hourly bandwidth: upstream behaviour, no cleanup
            assert storage.check_storage_needs_cleanup() is False

    def test_min_disk_free_triggers_cleanup(self):
        """The floor triggers cleanup even when bandwidth alone would not."""
        storage = self._storage_with_min_free(8)
        assert storage.min_free_mb == 8 * 1024

        with patch(
            "frigate.storage.shutil.disk_usage",
            return_value=_mock_disk_usage(total_gb=60, free_gb=4),
        ):
            assert storage.check_storage_needs_cleanup() is True

        # reclaim past the floor plus one hour of bandwidth slack
        assert storage.pending_reclaim_mb == 8 * 1024 + 1440 - 4 * 1024

    def test_min_disk_free_not_breached(self):
        """No cleanup when free space is above both thresholds."""
        storage = self._storage_with_min_free(8)

        with patch(
            "frigate.storage.shutil.disk_usage",
            return_value=_mock_disk_usage(total_gb=60, free_gb=12),
        ):
            assert storage.check_storage_needs_cleanup() is False
        assert storage.pending_reclaim_mb is None

    def test_min_disk_free_clamped_to_half_disk(self):
        """A floor larger than half the disk is clamped, not obeyed."""
        storage = self._storage_with_min_free(100)

        with patch(
            "frigate.storage.shutil.disk_usage",
            return_value=_mock_disk_usage(total_gb=60, free_gb=40),
        ):
            # 40 GB free > clamped 30 GB floor: no cleanup despite 100 GB setting
            assert storage.check_storage_needs_cleanup() is False
        assert storage.warned_min_free_clamp is True

        with patch(
            "frigate.storage.shutil.disk_usage",
            return_value=_mock_disk_usage(total_gb=60, free_gb=20),
        ):
            # 20 GB free < clamped 30 GB floor: cleanup
            assert storage.check_storage_needs_cleanup() is True


def _mock_disk_usage(total_gb: float, free_gb: float):
    usage = collections.namedtuple("usage", ["total", "used", "free"])
    return usage(
        total=total_gb * pow(2, 30),
        used=(total_gb - free_gb) * pow(2, 30),
        free=free_gb * pow(2, 30),
    )


def _insert_mock_event(
    id: str,
    start: int,
    end: int,
    retain: bool,
    camera: str = "front_door",
    label: str = "Mock",
) -> Event:
    """Inserts a basic event model with a given id."""
    return Event.insert(
        id=id,
        label=label,
        camera=camera,
        start_time=start,
        end_time=end,
        top_score=100,
        false_positive=False,
        zones=list(),
        thumbnail="",
        region=[],
        box=[],
        area=0,
        has_clip=True,
        has_snapshot=True,
        retain_indefinitely=retain,
    ).execute()


def _insert_mock_recording(
    id: str,
    file: str,
    start: int,
    end: int,
    camera="front_door",
    seg_size=8,
    seg_dur=10,
) -> Event:
    """Inserts a basic recording model with a given id."""
    # we must open the file so storage maintainer will delete it
    with open(file, "w"):
        pass

    return Recordings.insert(
        id=id,
        camera=camera,
        path=file,
        start_time=start,
        end_time=end,
        duration=seg_dur,
        motion=True,
        objects=True,
        segment_size=seg_size,
    ).execute()
