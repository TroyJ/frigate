#!/bin/bash
# Build the Raspberry Pi-patched ffmpeg (jc-kynesim/rpi-ffmpeg) from source into
# /usr/lib/ffmpeg/rpi, replacing the Raspberry Pi APT package that upstream
# Frigate installs.
#
# Why: the Pi APT repo for bookworm ships ffmpeg 5.1.9+rpt1, whose V4L2-request
# HEVC hwaccel predates the kernel 6.18 rpi-hevc-dec API change (slice bit_size
# semantics — raspberrypi/linux#7228, #7306). On Home Assistant OS 18 (kernel
# 6.18) that ffmpeg gets every slice rejected ("data_byte_offset ... > bytesused")
# and emits all-zero (green) frames. The fixed ffmpeg only ships in the trixie
# package (7.1.5+rpt1), which does not install on Frigate's bookworm base, so we
# build jc-kynesim's 7.1.2 branch here. It detects the driver version and works
# with both 6.12 and 6.18 kernels.
#
# Patch: the dmabuf allocator opens /dev/dma_heap/{vidbuf_cached,linux,cma,
# reserved}. HAOS 18's kernel exposes the CMA heap as
# /dev/dma_heap/default_cma_region only, and the add-on container's /dev is
# read-only so it cannot be aliased at runtime; falling through to "reserved"
# (5 MiB) fails with ENOMEM. Add default_cma_region ahead of reserved.
#
# Patch 2 (docker/rpi/patches/hevc-clear-missing-refs-on-idr.patch): libavcodec's
# HEVC decoder in 7.1.x never recovers once it has started on a P-frame whose IDR
# it has not seen — the generated "missing reference" placeholder carries the
# IDR's POC, survives ff_hevc_clear_refs(), and makes every later IDR fail the
# duplicate-POC check, so keyframes are skipped for the life of the process
# (on the V4L2-request path that is a solid-green picture). Seen live after the
# 05:00 router power-cycle reconnects; reproduced by stripping the first IDR from
# any recorded segment. The patch header carries the full mechanism and evidence;
# bali-home-assistant/frigate-fork/docs/hevc-decoder-poisoning.md the analysis.
# Applied with `git apply` from /deps/patches (bind-mounted by the Dockerfiles);
# the build fails loudly if the patch no longer applies, so a future bump of
# RPI_FFMPEG_COMMIT must re-validate it (or confirm the 8.x behaviour, see doc).
set -euxo pipefail

# Source: our copy (TroyJ/frigate-build-deps), a `git archive` of the pinned commit,
# checked by sha256. Original: https://github.com/jc-kynesim/rpi-ffmpeg.git, branch
# test/7.1.2/main (until this change the build cloned its last 50 commits and checked
# out the commit). ffmpeg takes its version string from git; an archive has no git, so
# it is written to VERSION: the string the 50-commit clone gave (git describe).
RPI_FFMPEG_COMMIT="9e9bbb199ce41f2ed2f87628acc755ca099e3a96"   # 2026-01-29
RPI_FFMPEG_URL="https://github.com/TroyJ/frigate-build-deps/releases/download/rpi-ffmpeg-9e9bbb1/rpi-ffmpeg-${RPI_FFMPEG_COMMIT}.tar.gz"
RPI_FFMPEG_SHA256="00e450bb656c91d66de7b3afa1631859a0d45f1a856afe5b7ac0c80c3741943e"
RPI_FFMPEG_VERSION="pi/7.1.2/rpi_28-1-g9e9bbb1"
PREFIX="/usr/lib/ffmpeg/rpi"

export DEBIAN_FRONTEND=noninteractive
apt-get -qq update
apt-get -qq install -y --no-install-recommends \
    build-essential pkg-config git ca-certificates wget nasm yasm \
    libdrm-dev libudev-dev libx264-dev libopus-dev zlib1g-dev libssl-dev libv4l-dev

mkdir -p /src
wget -nv -O /src/rpi-ffmpeg.tar.gz "${RPI_FFMPEG_URL}"
echo "${RPI_FFMPEG_SHA256}  /src/rpi-ffmpeg.tar.gz" | sha256sum -c -
tar -xzf /src/rpi-ffmpeg.tar.gz -C /src   # unpacks into /src/rpi-ffmpeg/
rm /src/rpi-ffmpeg.tar.gz
cd /src/rpi-ffmpeg
echo "${RPI_FFMPEG_VERSION}" > VERSION

# dma_heap name patch (see header). Applied to both allocator name lists.
grep -q '"/dev/dma_heap/reserved",' libavcodec/v4l2_req_dmabufs.c
sed -i 's|        "/dev/dma_heap/reserved",|        "/dev/dma_heap/default_cma_region",\n        "/dev/dma_heap/reserved",|' \
    libavcodec/v4l2_req_dmabufs.c
grep -c 'default_cma_region' libavcodec/v4l2_req_dmabufs.c | grep -qx 2

# HEVC missing-reference poisoning patch (see header, patch 2).
PATCH_DIR="${PATCH_DIR:-/deps/patches}"
git apply --check "${PATCH_DIR}/hevc-clear-missing-refs-on-idr.patch"
git apply "${PATCH_DIR}/hevc-clear-missing-refs-on-idr.patch"
grep -c 'HEVC_FRAME_FLAG_UNAVAILABLE);' libavcodec/hevc/refs.c | grep -qx 1

./configure --prefix="${PREFIX}" \
    --enable-gpl --enable-nonfree --disable-debug --disable-doc \
    --enable-libdrm --enable-v4l2-request --enable-libudev --enable-sand --enable-libv4l2 \
    --enable-libx264 --enable-libopus --enable-openssl \
    --disable-static --enable-shared --enable-rpath
grep -E '^(CFLAGS|CC)=' ffbuild/config.mak   # ISA audit: no -march/-mcpu of the build host
make -j"$(nproc)"
make install
rm -rf "${PREFIX}/include" "${PREFIX}/share" "${PREFIX}/lib/pkgconfig"

"${PREFIX}/bin/ffmpeg" -hide_banner -hwaccels | grep -qx drm
