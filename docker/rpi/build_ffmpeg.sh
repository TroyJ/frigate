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
set -euxo pipefail

RPI_FFMPEG_REPO="https://github.com/jc-kynesim/rpi-ffmpeg.git"
RPI_FFMPEG_BRANCH="test/7.1.2/main"
RPI_FFMPEG_COMMIT="9e9bbb199ce41f2ed2f87628acc755ca099e3a96"   # 2026-01-29
PREFIX="/usr/lib/ffmpeg/rpi"

export DEBIAN_FRONTEND=noninteractive
apt-get -qq update
apt-get -qq install -y --no-install-recommends \
    build-essential pkg-config git ca-certificates nasm yasm \
    libdrm-dev libudev-dev libx264-dev libopus-dev zlib1g-dev libssl-dev libv4l-dev

git clone --depth 50 -b "${RPI_FFMPEG_BRANCH}" "${RPI_FFMPEG_REPO}" /src/rpi-ffmpeg
cd /src/rpi-ffmpeg
git checkout --detach "${RPI_FFMPEG_COMMIT}"

# dma_heap name patch (see header). Applied to both allocator name lists.
grep -q '"/dev/dma_heap/reserved",' libavcodec/v4l2_req_dmabufs.c
sed -i 's|        "/dev/dma_heap/reserved",|        "/dev/dma_heap/default_cma_region",\n        "/dev/dma_heap/reserved",|' \
    libavcodec/v4l2_req_dmabufs.c
grep -c 'default_cma_region' libavcodec/v4l2_req_dmabufs.c | grep -qx 2

./configure --prefix="${PREFIX}" \
    --enable-gpl --enable-nonfree --disable-debug --disable-doc \
    --enable-libdrm --enable-v4l2-request --enable-libudev --enable-sand --enable-libv4l2 \
    --enable-libx264 --enable-libopus --enable-openssl \
    --disable-static --enable-shared --enable-rpath
make -j"$(nproc)"
make install
rm -rf "${PREFIX}/include" "${PREFIX}/share" "${PREFIX}/lib/pkgconfig"

"${PREFIX}/bin/ffmpeg" -hide_banner -hwaccels | grep -qx drm
