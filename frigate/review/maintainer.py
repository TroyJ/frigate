"""Maintain review segments in db."""

import copy
import datetime
import json
import logging
import os
import random
import shutil
import string
import sys
import threading
from multiprocessing.synchronize import Event as MpEvent
from pathlib import Path
from typing import Any, Optional

import cv2
import numpy as np

from frigate.comms.detections_updater import DetectionSubscriber, DetectionTypeEnum
from frigate.comms.inter_process import InterProcessRequestor
from frigate.comms.review_updater import ReviewDataPublisher
from frigate.config import CameraConfig, FrigateConfig
from frigate.config.camera.updater import (
    CameraConfigUpdateEnum,
    CameraConfigUpdateSubscriber,
)
from frigate.const import (
    CLEAR_ONGOING_REVIEW_SEGMENTS,
    CLIPS_DIR,
    UPSERT_REVIEW_SEGMENT,
)
from frigate.models import ReviewSegment
from frigate.review.types import SeverityEnum
from frigate.track.object_processing import ManualEventState, TrackedObject
from frigate.util.image import SharedMemoryFrameManager, calculate_16_9_crop

logger = logging.getLogger(__name__)


THUMB_HEIGHT = 180
THUMB_WIDTH = 320


class PendingReviewSegment:
    def __init__(
        self,
        camera: str,
        frame_time: float,
        severity: SeverityEnum,
        detections: dict[str, str],
        sub_labels: dict[str, str],
        zones: list[str],
        audio: set[str],
    ):
        rand_id = "".join(random.choices(string.ascii_lowercase + string.digits, k=6))
        self.id = f"{frame_time}-{rand_id}"
        self.camera = camera
        self.start_time = frame_time
        self.severity = severity
        self.detections = detections
        self.sub_labels = sub_labels
        self.zones = zones
        self.audio = audio
        self.thumb_time: float | None = None
        self.last_alert_time: float | None = None
        self.last_detection_time: float = frame_time
        # Set only on segments produced by review.alerts.mirror_from: names the
        # camera this segment was copied from. Mirrors are never themselves
        # mirrored, so this doubles as the recursion guard.
        self.mirrored_from: str | None = None

        if severity == SeverityEnum.alert:
            self.last_alert_time = frame_time

        # thumbnail
        self._frame = np.zeros((THUMB_HEIGHT * 3 // 2, THUMB_WIDTH), np.uint8)
        self.has_frame = False
        self.frame_active_count = 0
        self.frame_path = os.path.join(
            CLIPS_DIR, f"review/thumb-{self.camera}-{self.id}.webp"
        )

    def update_frame(
        self, camera_config: CameraConfig, frame, objects: list[TrackedObject]
    ):
        min_x = camera_config.frame_shape[1]
        min_y = camera_config.frame_shape[0]
        max_x = 0
        max_y = 0

        # find bounds for all boxes
        for o in objects:
            min_x = min(o["box"][0], min_x)
            min_y = min(o["box"][1], min_y)
            max_x = max(o["box"][2], max_x)
            max_y = max(o["box"][3], max_y)

        region = calculate_16_9_crop(
            camera_config.frame_shape, min_x, min_y, max_x, max_y
        )

        # could not find suitable 16:9 region
        if not region:
            return

        self.frame_active_count = len(objects)
        color_frame = cv2.cvtColor(frame, cv2.COLOR_YUV2BGR_I420)
        color_frame = color_frame[region[1] : region[3], region[0] : region[2]]
        width = int(THUMB_HEIGHT * color_frame.shape[1] / color_frame.shape[0])
        self._frame = cv2.resize(
            color_frame, dsize=(width, THUMB_HEIGHT), interpolation=cv2.INTER_AREA
        )

        if self._frame is not None:
            self.thumb_time = datetime.datetime.now().timestamp()
            self.has_frame = True
            cv2.imwrite(
                self.frame_path, self._frame, [int(cv2.IMWRITE_WEBP_QUALITY), 60]
            )

    def save_full_frame(self, camera_config: CameraConfig, frame):
        color_frame = cv2.cvtColor(frame, cv2.COLOR_YUV2BGR_I420)
        width = int(THUMB_HEIGHT * color_frame.shape[1] / color_frame.shape[0])
        self._frame = cv2.resize(
            color_frame, dsize=(width, THUMB_HEIGHT), interpolation=cv2.INTER_AREA
        )

        if self._frame is not None:
            self.has_frame = True
            cv2.imwrite(
                self.frame_path, self._frame, [int(cv2.IMWRITE_WEBP_QUALITY), 60]
            )

    def get_data(self, ended: bool) -> dict:
        end_time = None

        if ended:
            if self.severity == SeverityEnum.alert:
                end_time = self.last_alert_time
            else:
                end_time = self.last_detection_time

        data = {
            "detections": list(set(self.detections.keys())),
            "objects": list(set(self.detections.values())),
            "verified_objects": [
                o for o in self.detections.values() if "-verified" in o
            ],
            "sub_labels": list(self.sub_labels.values()),
            "zones": self.zones,
            "audio": list(self.audio),
            "thumb_time": self.thumb_time,
            "metadata": None,
        }

        # Added only for mirrors, so native segments keep their exact prior shape.
        if self.mirrored_from:
            data["mirrored_from"] = self.mirrored_from

        return copy.deepcopy(
            {
                ReviewSegment.id.name: self.id,
                ReviewSegment.camera.name: self.camera,
                ReviewSegment.start_time.name: self.start_time,
                ReviewSegment.end_time.name: end_time,
                ReviewSegment.severity.name: self.severity.value,
                ReviewSegment.thumb_path.name: self.frame_path,
                ReviewSegment.data.name: data,
            }
        )


class ActiveObjects:
    def __init__(
        self,
        frame_time: float,
        camera_config: CameraConfig,
        all_objects: list[TrackedObject],
    ):
        self.camera_config = camera_config

        # get current categorization of objects to know if
        # these objects are currently being categorized
        self.categorized_objects = {
            "alerts": [],
            "detections": [],
        }

        for o in all_objects:
            if (
                o["motionless_count"] >= camera_config.detect.stationary.threshold
                and not o["pending_loitering"]
            ):
                # no stationary objects unless loitering
                continue

            if o["position_changes"] == 0:
                # object must have moved at least once
                continue

            if o["frame_time"] != frame_time:
                # object must be detected in this frame
                continue

            if o["false_positive"]:
                # object must not be a false positive
                continue

            if (
                o["label"] in camera_config.review.alerts.labels
                and (
                    not camera_config.review.alerts.required_zones
                    or (
                        len(o["current_zones"]) > 0
                        and set(o["current_zones"])
                        & set(camera_config.review.alerts.required_zones)
                    )
                )
                and camera_config.review.alerts.enabled
            ):
                self.categorized_objects["alerts"].append(o)
                continue

            if (
                (
                    camera_config.review.detections.labels is None
                    or o["label"] in camera_config.review.detections.labels
                )
                and (
                    not camera_config.review.detections.required_zones
                    or (
                        len(o["current_zones"]) > 0
                        and set(o["current_zones"])
                        & set(camera_config.review.detections.required_zones)
                    )
                )
                and camera_config.review.detections.enabled
            ):
                self.categorized_objects["detections"].append(o)
                continue

    def has_active_objects(self) -> bool:
        return (
            len(self.categorized_objects["alerts"]) > 0
            or len(self.categorized_objects["detections"]) > 0
        )

    def has_activity_category(self, severity: SeverityEnum) -> bool:
        if (
            severity == SeverityEnum.alert
            and len(self.categorized_objects["alerts"]) > 0
        ):
            return True

        if (
            severity == SeverityEnum.detection
            and len(self.categorized_objects["detections"]) > 0
        ):
            return True

        return False

    def get_all_objects(self) -> list[TrackedObject]:
        return (
            self.categorized_objects["alerts"] + self.categorized_objects["detections"]
        )


class ReviewSegmentMaintainer(threading.Thread):
    """Maintain review segments."""

    def __init__(self, config: FrigateConfig, stop_event: MpEvent):
        super().__init__(name="review_segment_maintainer")
        self.config = config
        self.active_review_segments: dict[str, Optional[PendingReviewSegment]] = {}
        self.frame_manager = SharedMemoryFrameManager()

        # create communication for review segments
        self.requestor = InterProcessRequestor()
        self.config_subscriber = CameraConfigUpdateSubscriber(
            config,
            config.cameras,
            [
                CameraConfigUpdateEnum.add,
                CameraConfigUpdateEnum.enabled,
                CameraConfigUpdateEnum.record,
                CameraConfigUpdateEnum.remove,
                CameraConfigUpdateEnum.review,
            ],
        )
        self.detection_subscriber = DetectionSubscriber(DetectionTypeEnum.all.value)
        self.review_publisher = ReviewDataPublisher("")

        # manual events
        self.indefinite_events: dict[str, dict[str, Any]] = {}

        # review.alerts.mirror_from fan-out: source camera -> {target camera -> mirror}.
        # Deliberately NOT stored in active_review_segments: that dict is keyed by
        # camera and owned by each camera's own detection loop, so putting a mirror
        # there would collide with a native segment on a camera that both detects
        # and mirrors.
        self.mirrored_segments: dict[str, dict[str, PendingReviewSegment]] = {}

        # ensure dirs
        Path(os.path.join(CLIPS_DIR, "review")).mkdir(exist_ok=True)

        self.stop_event = stop_event

        # clear ongoing review segments from last instance
        self.requestor.send_data(CLEAR_ONGOING_REVIEW_SEGMENTS, "")

    def _publish_segment_start(
        self,
        segment: PendingReviewSegment,
    ) -> None:
        """New segment."""
        new_data = segment.get_data(ended=False)
        self.requestor.send_data(UPSERT_REVIEW_SEGMENT, new_data)
        start_data = {k: v for k, v in new_data.items()}
        review_update = {
            "type": "new",
            "before": start_data,
            "after": start_data,
        }
        self.requestor.send_data(
            "reviews",
            json.dumps(review_update),
        )
        self.review_publisher.publish(review_update, segment.camera)
        self.requestor.send_data(
            f"{segment.camera}/review_status", segment.severity.value.upper()
        )
        self._update_mirrored_segments(segment)

    def _publish_segment_update(
        self,
        segment: PendingReviewSegment,
        camera_config: CameraConfig,
        frame,
        objects: list[TrackedObject],
        prev_data: dict[str, Any],
    ) -> None:
        """Update segment."""
        if frame is not None:
            segment.update_frame(camera_config, frame, objects)

        new_data = segment.get_data(ended=False)
        self.requestor.send_data(UPSERT_REVIEW_SEGMENT, new_data)
        review_update = {
            "type": "update",
            "before": {k: v for k, v in prev_data.items()},
            "after": {k: v for k, v in new_data.items()},
        }
        self.requestor.send_data(
            "reviews",
            json.dumps(review_update),
        )
        self.review_publisher.publish(review_update, segment.camera)
        self.requestor.send_data(
            f"{segment.camera}/review_status", segment.severity.value.upper()
        )
        self._update_mirrored_segments(segment)

    def _publish_segment_end(
        self,
        segment: PendingReviewSegment,
        prev_data: dict[str, Any],
    ) -> float:
        """End segment."""
        final_data = segment.get_data(ended=True)
        end_time = final_data[ReviewSegment.end_time.name]
        self.requestor.send_data(UPSERT_REVIEW_SEGMENT, final_data)
        review_update = {
            "type": "end",
            "before": {k: v for k, v in prev_data.items()},
            "after": {k: v for k, v in final_data.items()},
        }
        self.requestor.send_data(
            "reviews",
            json.dumps(review_update),
        )
        self.review_publisher.publish(review_update, segment.camera)
        self.requestor.send_data(f"{segment.camera}/review_status", "NONE")

        # A mirror does not own its camera's active slot, so it must not clear it.
        if not segment.mirrored_from:
            self.active_review_segments[segment.camera] = None
            self._end_mirrored_segments(segment)

        return end_time

    def forcibly_end_segment(self, camera: str) -> float:
        """Forcibly end the pending segment for a camera."""
        segment = self.active_review_segments.get(camera)
        if segment:
            prev_data = segment.get_data(False)
            return self._publish_segment_end(segment, prev_data)

    def _mirror_targets(self, source_camera: str) -> list[str]:
        """Cameras currently eligible to mirror source_camera's alert segments.

        Scanned on demand rather than cached as a reverse map:
        CameraConfigUpdateSubscriber mutates self.config in place, so a cached map
        would go stale on a config update, and the scan is trivial at any realistic
        camera count.
        """
        targets: list[str] = []

        for name, camera in self.config.cameras.items():
            if name == source_camera:
                continue

            if source_camera not in camera.review.alerts.mirror_from:
                continue

            # Same gates the run loop applies to a camera's own segments.
            if not camera.enabled or not camera.record.enabled:
                continue

            if not camera.review.alerts.enabled:
                continue

            targets.append(name)

        return targets

    def _sync_mirror_thumb(
        self, source: PendingReviewSegment, mirror: PendingReviewSegment
    ) -> None:
        """Give the mirror its own copy of the source's thumbnail.

        Copied, not shared: cleanup.py unlinks thumb_path when a review segment
        expires, so two rows pointing at one file would leave a dangling reference
        as soon as the first of them expired. The thumbnail shows the *source*
        camera's view, which is the wanted behaviour — it depicts what triggered
        the alert, which is exactly what a detection-free camera cannot show.
        """
        if not source.has_frame or source.thumb_time == mirror.thumb_time:
            return

        try:
            shutil.copyfile(source.frame_path, mirror.frame_path)
        except OSError as e:
            logger.debug(f"Could not mirror review thumbnail for {mirror.camera}: {e}")
            return

        mirror.has_frame = True
        mirror.thumb_time = source.thumb_time

    def _update_mirrored_segments(self, source: PendingReviewSegment) -> None:
        """Fan an alert segment out onto the cameras configured to mirror it."""
        # Mirrors are never themselves mirrored (guards recursion, since this runs
        # from the same _publish_* methods used to emit mirrors), and only alerts
        # are mirrored — review.alerts.mirror_from says nothing about detections.
        if source.mirrored_from or source.severity != SeverityEnum.alert:
            return

        mirrors = self.mirrored_segments.setdefault(source.camera, {})

        for target in self._mirror_targets(source.camera):
            mirror = mirrors.get(target)

            if mirror is None:
                mirror = PendingReviewSegment(
                    target,
                    # The SOURCE's start_time, not now: a segment that escalated
                    # from detection to alert must still protect its whole window.
                    source.start_time,
                    SeverityEnum.alert,
                    dict(source.detections),
                    sub_labels=dict(source.sub_labels),
                    # Zones belong to the source camera's coordinate space and
                    # mean nothing on this one.
                    zones=[],
                    audio=set(source.audio),
                )
                mirror.mirrored_from = source.camera
                mirror.last_alert_time = source.last_alert_time
                mirror.last_detection_time = source.last_detection_time
                mirrors[target] = mirror
                self._sync_mirror_thumb(source, mirror)
                self._publish_segment_start(mirror)
                continue

            prev_data = mirror.get_data(False)
            mirror.detections = dict(source.detections)
            mirror.sub_labels = dict(source.sub_labels)
            mirror.audio = set(source.audio)
            mirror.last_alert_time = source.last_alert_time
            mirror.last_detection_time = source.last_detection_time
            self._sync_mirror_thumb(source, mirror)
            self._publish_segment_update(
                mirror, self.config.cameras[target], None, [], prev_data
            )

    def _end_mirrored_segments(self, source: PendingReviewSegment) -> None:
        """End every mirror of a source segment, matching its end time."""
        for mirror in self.mirrored_segments.pop(source.camera, {}).values():
            prev_data = mirror.get_data(False)
            mirror.last_alert_time = source.last_alert_time
            mirror.last_detection_time = source.last_detection_time
            self._sync_mirror_thumb(source, mirror)
            self._publish_segment_end(mirror, prev_data)

    def update_existing_segment(
        self,
        segment: PendingReviewSegment,
        frame_name: str,
        frame_time: float,
        objects: list[TrackedObject],
    ) -> None:
        """Validate if existing review segment should continue."""
        camera_config = self.config.cameras[segment.camera]

        # get active objects + objects loitering in loitering zones
        activity = ActiveObjects(frame_time, camera_config, objects)
        prev_data = segment.get_data(False)
        has_activity = False

        if activity.has_active_objects():
            has_activity = True
            should_update_image = False
            should_update_state = False

            if activity.has_activity_category(SeverityEnum.alert):
                # update current time for last alert activity
                segment.last_alert_time = frame_time

                if segment.severity != SeverityEnum.alert:
                    # if segment is not alert category but current activity is
                    # update this segment to be an alert
                    segment.severity = SeverityEnum.alert
                    should_update_state = True
                    should_update_image = True

            if activity.has_activity_category(SeverityEnum.detection):
                segment.last_detection_time = frame_time

            for object in activity.get_all_objects():
                # Alert-level objects should always be added (they extend/upgrade the segment)
                # Detection-level objects should only be added if:
                #   - The segment is a detection segment (matching severity), OR
                #   - The segment is an alert AND the object started before the alert ended
                #     (objects starting after will be in the new detection segment)
                is_alert_object = object in activity.categorized_objects["alerts"]

                if not is_alert_object and segment.severity == SeverityEnum.alert:
                    # This is a detection-level object
                    # Only add if it started during the alert's active period
                    if object["start_time"] > segment.last_alert_time:
                        continue

                if not object["sub_label"]:
                    segment.detections[object["id"]] = object["label"]
                elif object["sub_label"][0] in self.config.model.all_attributes:
                    segment.detections[object["id"]] = object["sub_label"][0]
                else:
                    segment.detections[object["id"]] = f"{object['label']}-verified"
                    segment.sub_labels[object["id"]] = object["sub_label"][0]

                # keep zones up to date
                if len(object["current_zones"]) > 0:
                    for zone in object["current_zones"]:
                        if zone not in segment.zones:
                            segment.zones.append(zone)

            if len(activity.get_all_objects()) > segment.frame_active_count:
                should_update_state = True
                should_update_image = True

            if prev_data["data"]["sub_labels"] != list(segment.sub_labels.values()):
                should_update_state = True

            if should_update_state:
                try:
                    if should_update_image:
                        yuv_frame = self.frame_manager.get(
                            frame_name, camera_config.frame_shape_yuv
                        )

                        if yuv_frame is None:
                            logger.debug(f"Failed to get frame {frame_name} from SHM")
                            return
                    else:
                        yuv_frame = None

                    self._publish_segment_update(
                        segment,
                        camera_config,
                        yuv_frame,
                        activity.get_all_objects(),
                        prev_data,
                    )
                    self.frame_manager.close(frame_name)
                except FileNotFoundError:
                    return

        if not has_activity:
            if not segment.has_frame:
                try:
                    yuv_frame = self.frame_manager.get(
                        frame_name, camera_config.frame_shape_yuv
                    )

                    if yuv_frame is None:
                        logger.debug(f"Failed to get frame {frame_name} from SHM")
                        return

                    segment.save_full_frame(camera_config, yuv_frame)
                    self.frame_manager.close(frame_name)
                    self._publish_segment_update(
                        segment, camera_config, None, [], prev_data
                    )
                except FileNotFoundError:
                    return

            if segment.severity == SeverityEnum.alert and frame_time > (
                segment.last_alert_time + camera_config.review.alerts.cutoff_time
            ):
                needs_new_detection = (
                    segment.last_detection_time > segment.last_alert_time
                    and (
                        segment.last_detection_time
                        + camera_config.review.detections.cutoff_time
                    )
                    > frame_time
                )
                last_detection_time = segment.last_detection_time

                end_time = self._publish_segment_end(segment, prev_data)

                if needs_new_detection:
                    new_detections: dict[str, str] = {}
                    new_zones = set()

                    for o in activity.categorized_objects["detections"]:
                        new_detections[o["id"]] = o["label"]
                        new_zones.update(o["current_zones"])

                    if new_detections:
                        self.active_review_segments[activity.camera_config.name] = (
                            PendingReviewSegment(
                                activity.camera_config.name,
                                end_time,
                                SeverityEnum.detection,
                                new_detections,
                                sub_labels={},
                                audio=set(),
                                zones=list(new_zones),
                            )
                        )
                        self._publish_segment_start(
                            self.active_review_segments[activity.camera_config.name]
                        )
                        self.active_review_segments[
                            activity.camera_config.name
                        ].last_detection_time = last_detection_time
            elif segment.severity == SeverityEnum.detection and frame_time > (
                segment.last_detection_time
                + camera_config.review.detections.cutoff_time
            ):
                self._publish_segment_end(segment, prev_data)

    def check_if_new_segment(
        self,
        camera: str,
        frame_name: str,
        frame_time: float,
        objects: list[TrackedObject],
    ) -> None:
        """Check if a new review segment should be created."""
        camera_config = self.config.cameras[camera]
        activity = ActiveObjects(frame_time, camera_config, objects)

        if activity.has_active_objects():
            detections: dict[str, str] = {}
            sub_labels: dict[str, str] = {}
            zones: list[str] = []
            severity: SeverityEnum | None = None

            # if activity is alert category mark this review as alert
            if severity != SeverityEnum.alert and activity.has_activity_category(
                SeverityEnum.alert
            ):
                severity = SeverityEnum.alert

            # if object is detection label and not already higher severity
            # mark this review as detection
            if not severity and activity.has_activity_category(SeverityEnum.detection):
                severity = SeverityEnum.detection

            for object in activity.get_all_objects():
                if not object["sub_label"]:
                    detections[object["id"]] = object["label"]
                elif object["sub_label"][0] in self.config.model.all_attributes:
                    detections[object["id"]] = object["sub_label"][0]
                else:
                    detections[object["id"]] = f"{object['label']}-verified"
                    sub_labels[object["id"]] = object["sub_label"][0]

                for zone in object["current_zones"]:
                    if zone not in zones:
                        zones.append(zone)

            if severity:
                self.active_review_segments[camera] = PendingReviewSegment(
                    camera,
                    frame_time,
                    severity,
                    detections,
                    sub_labels=sub_labels,
                    audio=set(),
                    zones=zones,
                )

                try:
                    yuv_frame = self.frame_manager.get(
                        frame_name, camera_config.frame_shape_yuv
                    )

                    if yuv_frame is None:
                        logger.debug(f"Failed to get frame {frame_name} from SHM")
                        return

                    self.active_review_segments[camera].update_frame(
                        camera_config, yuv_frame, activity.get_all_objects()
                    )
                    self.frame_manager.close(frame_name)
                    self._publish_segment_start(self.active_review_segments[camera])
                except FileNotFoundError:
                    return

    def run(self) -> None:
        while not self.stop_event.is_set():
            # check if there is an updated config
            updated_topics = self.config_subscriber.check_for_updates()

            if "record" in updated_topics:
                for camera in updated_topics["record"]:
                    self.forcibly_end_segment(camera)

            if "enabled" in updated_topics:
                for camera in updated_topics["enabled"]:
                    self.forcibly_end_segment(camera)

            (topic, data) = self.detection_subscriber.check_for_update(timeout=1)

            if not topic:
                continue

            if topic == DetectionTypeEnum.video.value:
                (
                    camera,
                    frame_name,
                    frame_time,
                    current_tracked_objects,
                    _,
                    _,
                ) = data
            elif topic == DetectionTypeEnum.audio.value:
                (
                    camera,
                    frame_time,
                    _,
                    audio_detections,
                ) = data
            elif topic == DetectionTypeEnum.api.value or DetectionTypeEnum.lpr.value:
                (
                    camera,
                    frame_time,
                    manual_info,
                ) = data

                if camera not in self.indefinite_events:
                    self.indefinite_events[camera] = {}

            if (
                not self.config.cameras[camera].enabled
                or not self.config.cameras[camera].record.enabled
            ):
                continue

            current_segment = self.active_review_segments.get(camera)

            # Check if the current segment should be processed based on enabled settings
            if current_segment:
                if (
                    current_segment.severity == SeverityEnum.alert
                    and not self.config.cameras[camera].review.alerts.enabled
                ) or (
                    current_segment.severity == SeverityEnum.detection
                    and not self.config.cameras[camera].review.detections.enabled
                ):
                    self.forcibly_end_segment(camera)
                    continue

            # If we reach here, the segment can be processed (if it exists)
            if current_segment is not None:
                if topic == DetectionTypeEnum.video:
                    self.update_existing_segment(
                        current_segment,
                        frame_name,
                        frame_time,
                        current_tracked_objects,
                    )
                elif topic == DetectionTypeEnum.audio and len(audio_detections) > 0:
                    camera_config = self.config.cameras[camera]

                    for audio in audio_detections:
                        if (
                            audio in camera_config.review.alerts.labels
                            and camera_config.review.alerts.enabled
                        ):
                            current_segment.audio.add(audio)
                            current_segment.severity = SeverityEnum.alert
                            current_segment.last_alert_time = frame_time
                        elif (
                            camera_config.review.detections.labels is None
                            or audio in camera_config.review.detections.labels
                        ) and camera_config.review.detections.enabled:
                            current_segment.audio.add(audio)
                            current_segment.last_detection_time = frame_time
                elif topic == DetectionTypeEnum.api or topic == DetectionTypeEnum.lpr:
                    if manual_info["state"] == ManualEventState.complete:
                        current_segment.detections[manual_info["event_id"]] = (
                            manual_info["label"]
                        )
                        if (
                            topic == DetectionTypeEnum.api
                            and self.config.cameras[camera].review.alerts.enabled
                        ):
                            current_segment.severity = SeverityEnum.alert
                        elif (
                            topic == DetectionTypeEnum.lpr
                            and self.config.cameras[camera].review.detections.enabled
                        ):
                            current_segment.severity = SeverityEnum.detection
                        current_segment.last_alert_time = manual_info["end_time"]
                    elif manual_info["state"] == ManualEventState.start:
                        self.indefinite_events[camera][manual_info["event_id"]] = (
                            manual_info["label"]
                        )
                        current_segment.detections[manual_info["event_id"]] = (
                            manual_info["label"]
                        )
                        if (
                            topic == DetectionTypeEnum.api
                            and self.config.cameras[camera].review.alerts.enabled
                        ):
                            current_segment.severity = SeverityEnum.alert
                        elif (
                            topic == DetectionTypeEnum.lpr
                            and self.config.cameras[camera].review.detections.enabled
                        ):
                            current_segment.severity = SeverityEnum.detection

                        # temporarily make it so this event can not end
                        current_segment.last_alert_time = sys.maxsize
                        current_segment.last_detection_time = sys.maxsize
                    elif manual_info["state"] == ManualEventState.end:
                        event_id = manual_info["event_id"]

                        if event_id in self.indefinite_events[camera]:
                            self.indefinite_events[camera].pop(event_id)

                            if len(self.indefinite_events[camera]) == 0:
                                current_segment.last_alert_time = manual_info[
                                    "end_time"
                                ]
                                current_segment.last_detection_time = manual_info[
                                    "end_time"
                                ]
                        else:
                            logger.error(
                                f"Event with ID {event_id} has a set duration and can not be ended manually."
                            )
            else:
                if topic == DetectionTypeEnum.video:
                    if (
                        self.config.cameras[camera].review.alerts.enabled
                        or self.config.cameras[camera].review.detections.enabled
                    ):
                        self.check_if_new_segment(
                            camera,
                            frame_name,
                            frame_time,
                            current_tracked_objects,
                        )
                elif topic == DetectionTypeEnum.audio and len(audio_detections) > 0:
                    severity = None

                    camera_config = self.config.cameras[camera]
                    detections = set()

                    for audio in audio_detections:
                        if (
                            audio in camera_config.review.alerts.labels
                            and camera_config.review.alerts.enabled
                        ):
                            detections.add(audio)
                            severity = SeverityEnum.alert
                        elif (
                            camera_config.review.detections.labels is None
                            or audio in camera_config.review.detections.labels
                        ) and camera_config.review.detections.enabled:
                            detections.add(audio)

                            if not severity:
                                severity = SeverityEnum.detection

                    if severity:
                        self.active_review_segments[camera] = PendingReviewSegment(
                            camera,
                            frame_time,
                            severity,
                            {},
                            {},
                            [],
                            detections,
                        )
                elif topic == DetectionTypeEnum.api:
                    if self.config.cameras[camera].review.alerts.enabled:
                        self.active_review_segments[camera] = PendingReviewSegment(
                            camera,
                            frame_time,
                            SeverityEnum.alert,
                            {manual_info["event_id"]: manual_info["label"]},
                            {},
                            [],
                            set(),
                        )

                        if manual_info["state"] == ManualEventState.start:
                            self.indefinite_events[camera][manual_info["event_id"]] = (
                                manual_info["label"]
                            )
                            # temporarily make it so this event can not end
                            self.active_review_segments[
                                camera
                            ].last_alert_time = sys.maxsize
                            self.active_review_segments[
                                camera
                            ].last_detection_time = sys.maxsize
                        elif manual_info["state"] == ManualEventState.complete:
                            self.active_review_segments[
                                camera
                            ].last_alert_time = manual_info["end_time"]
                            self.active_review_segments[
                                camera
                            ].last_detection_time = manual_info["end_time"]
                    else:
                        logger.warning(
                            f"Manual event API has been called for {camera}, but alerts are disabled. This manual event will not appear as an alert."
                        )
                elif topic == DetectionTypeEnum.lpr:
                    if self.config.cameras[camera].review.detections.enabled:
                        self.active_review_segments[camera] = PendingReviewSegment(
                            camera,
                            frame_time,
                            SeverityEnum.detection,
                            {manual_info["event_id"]: manual_info["label"]},
                            {},
                            [],
                            set(),
                        )

                        if manual_info["state"] == ManualEventState.start:
                            self.indefinite_events[camera][manual_info["event_id"]] = (
                                manual_info["label"]
                            )
                            # temporarily make it so this event can not end
                            self.active_review_segments[
                                camera
                            ].last_alert_time = sys.maxsize
                            self.active_review_segments[
                                camera
                            ].last_detection_time = sys.maxsize
                        elif manual_info["state"] == ManualEventState.complete:
                            self.active_review_segments[
                                camera
                            ].last_alert_time = manual_info["end_time"]
                            self.active_review_segments[
                                camera
                            ].last_detection_time = manual_info["end_time"]
                    else:
                        logger.warning(
                            f"Dedicated LPR camera API has been called for {camera}, but detections are disabled. LPR events will not appear as a detection."
                        )

        self.config_subscriber.stop()
        self.requestor.stop()
        self.detection_subscriber.stop()
        logger.info("Exiting review maintainer...")
