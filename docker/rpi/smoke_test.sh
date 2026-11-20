#!/bin/bash
# Smoke test of a built Raspberry Pi image (docker/rpi/rpi.hcl, target rpi) on any arm64
# machine with Docker: a GitHub Arm runner, or a Mac with OrbStack. No Coral, no camera:
# Frigate runs the CPU detector on a synthetic picture (ffmpeg's testsrc) with a sine tone
# as the audio input, so object detection and audio detection both load their models.
#
#   docker/rpi/smoke_test.sh frigate:pi-check
#
# Checks, failing on the first that does not hold:
#   - what the trimmed image must not contain (Hailo, MemryX, the generic ffmpeg builds,
#     the OpenVINO model) and what it must (the Pi ffmpeg, the Coral runtime, the models);
#   - the Python imports Frigate makes, with the detector plugins;
#   - the export-thumbnail path without libwebp (Pi ffmpeg to PNG, OpenCV to webp);
#   - Frigate starts, /api/version and /api/stats answer on the internal port 5000, the
#     test camera reaches the detector, and the log has no import errors or tracebacks.
set -euo pipefail

IMAGE="${1:?usage: smoke_test.sh IMAGE}"
NAME="frigate-pi-smoke"
WORK="$(mktemp -d)"
trap 'docker rm -f "$NAME" >/dev/null 2>&1 || true; rm -rf "$WORK"' EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }
inimg() { docker run --rm --entrypoint /bin/bash "$IMAGE" -c "$1"; }

echo "== image size"
docker image inspect --format '{{.Size}}' "$IMAGE" | awk '{printf "%.0f MB\n", $1/1000000}'

echo "== removed pieces are absent"
inimg '
  set -e
  for p in /usr/lib/ffmpeg/5.0 /usr/lib/ffmpeg/7.0 /openvino-model /opt/mx_accl_frigate \
           /usr/local/lib/libhailort.so /usr/local/bin/hailortcli; do
    if [ -e "$p" ]; then echo "still present: $p"; exit 1; fi
  done
  ls /usr/lib/aarch64-linux-gnu/libmemx.so* 2>/dev/null && { echo "libmemx present"; exit 1; }
  if python3 -c "import hailo_platform" 2>/dev/null; then echo "hailo_platform importable"; exit 1; fi
  if python3 -c "import memryx" 2>/dev/null; then echo "memryx importable"; exit 1; fi
  echo ok
' || fail "a removed piece is still in the image"

echo "== kept pieces are present"
inimg '
  set -e
  test -x /usr/lib/ffmpeg/rpi/bin/ffmpeg
  test -x /usr/lib/ffmpeg/rpi/bin/ffprobe
  /usr/lib/ffmpeg/rpi/bin/ffmpeg -hide_banner -version | head -1
  test -f /edgetpu_model.tflite
  test -f /cpu_model.tflite
  test -f /cpu_audio_model.tflite
  test -f /labelmap.txt
  test -f /audio-labelmap.txt
  ldconfig -p | grep -q libedgetpu.so.1
  echo "DEFAULT_FFMPEG_VERSION=$DEFAULT_FFMPEG_VERSION INCLUDED_FFMPEG_VERSIONS=$INCLUDED_FFMPEG_VERSIONS"
  test "$DEFAULT_FFMPEG_VERSION" = rpi
  echo ok
' || fail "a piece the Pi needs is missing"

echo "== Python imports, detector plugins, audio model"
inimg '
  set -e
  cd /opt/frigate
  python3 - <<EOF
import logging, sys
logging.basicConfig(level=logging.INFO)
errors = []
class Catch(logging.Handler):
    def emit(self, record):
        if record.levelno >= logging.ERROR:
            errors.append(record.getMessage())
logging.getLogger().addHandler(Catch())

import onnxruntime, numpy, cv2, openvino
print("onnxruntime", onnxruntime.__version__, "numpy", numpy.__version__, "cv2", cv2.__version__)
from tflite_runtime.interpreter import Interpreter, load_delegate
from frigate.detectors.detector_types import api_types
print("detector types:", sorted(api_types))
for key in ("edgetpu", "cpu", "hailo8l", "memryx", "openvino"):
    assert key in api_types, f"detector type {key} missing"
interp = Interpreter(model_path="/cpu_audio_model.tflite")
interp.allocate_tensors()
interp = Interpreter(model_path="/cpu_model.tflite")
interp.allocate_tensors()
import frigate.app, frigate.events.audio, frigate.record.export, frigate.util.classification
if errors:
    print("logged errors:", errors)
    sys.exit(1)
print("ok")
EOF
' || fail "Python imports or model loads failed"

echo "== export thumbnail without libwebp"
inimg '
  set -e
  /usr/lib/ffmpeg/rpi/bin/ffmpeg -hide_banner -loglevel error -f lavfi -i testsrc=size=320x180 \
      -frames:v 1 -c:v png -f image2pipe - > /tmp/frame.png
  python3 -c "
import cv2, numpy as np
frame = cv2.imdecode(np.fromfile(\"/tmp/frame.png\", np.uint8), cv2.IMREAD_COLOR)
assert frame is not None and cv2.imwrite(\"/tmp/thumb.webp\", frame)
print(\"ok\", frame.shape)
"
' || fail "PNG-to-webp thumbnail path failed"

echo "== start Frigate"
mkdir -p "$WORK/config" "$WORK/media"
cat > "$WORK/config/config.yml" <<'EOF'
mqtt:
  enabled: false
detectors:
  cpu1:
    type: cpu
ffmpeg:
  hwaccel_args: []
audio:
  enabled: true
cameras:
  test:
    ffmpeg:
      inputs:
        - path: testsrc=size=640x360:rate=5
          input_args: -re -f lavfi
          roles: [detect]
        - path: sine=frequency=440:sample_rate=16000
          input_args: -re -f lavfi
          roles: [audio]
    detect:
      width: 640
      height: 360
      fps: 5
EOF

docker run -d --name "$NAME" --shm-size=256m \
  -v "$WORK/config:/config" -v "$WORK/media:/media/frigate" \
  -p 127.0.0.1:5000:5000 "$IMAGE" >/dev/null

ok=""
for _ in $(seq 1 60); do
  if curl -fsS http://127.0.0.1:5000/api/version >/dev/null 2>&1; then ok=1; break; fi
  sleep 5
done
[ -n "$ok" ] || { docker logs "$NAME" | tail -100; fail "/api/version did not answer within 5 minutes"; }
echo "version: $(curl -fsS http://127.0.0.1:5000/api/version)"

# let the camera and detector run a while, so stats have numbers
sleep 60
curl -fsS http://127.0.0.1:5000/api/stats > "$WORK/stats.json" || fail "/api/stats did not answer"
python3 - "$WORK/stats.json" <<'EOF' || fail "stats do not show the camera and detector running"
import json, sys
s = json.load(open(sys.argv[1]))
cam = s["cameras"]["test"]
det = s["detectors"]["cpu1"]
print("camera fps", cam.get("camera_fps"), "detection fps", cam.get("detection_fps"),
      "inference ms", det.get("inference_speed"), "audio dBFS", cam.get("audio_dBFS"))
assert cam.get("camera_fps", 0) > 0, "camera_fps is 0"
assert det.get("inference_speed", 0) > 0, "detector never ran"
EOF

docker logs "$NAME" > "$WORK/frigate.log" 2>&1
if grep -nE "Traceback|ImportError|ModuleNotFoundError|Error importing detector runtime|No such file or directory.*(/usr/lib/ffmpeg|openvino|hailo|memx)" "$WORK/frigate.log"; then
  fail "errors in Frigate's log (above)"
fi
echo "PASS"
