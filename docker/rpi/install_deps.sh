#!/bin/bash

set -euxo pipefail

apt-get -qq update

apt-get -qq install --no-install-recommends -y \
    apt-transport-https \
    gnupg \
    wget \
    procps vainfo \
    unzip locales tzdata libxml2 xz-utils \
    python3-pip \
    curl \
    jq \
    nethogs

mkdir -p -m 600 /root/.gnupg

# enable non-free repo
echo "deb http://deb.debian.org/debian bookworm main contrib non-free non-free-firmware" | tee -a /etc/apt/sources.list
apt update

# ffmpeg -> arm64
# The rpi-tuned ffmpeg is built from source in the rpi-ffmpeg-build stage
# (docker/rpi/build_ffmpeg.sh) and copied into /usr/lib/ffmpeg/rpi; the Pi APT
# package (5.1.9+rpt1) is too old for kernel 6.18's HEVC driver. Install its
# runtime dependencies here.
if [[ "${TARGETARCH}" == "arm64" ]]; then
    apt-get -qq install --no-install-recommends --no-install-suggests -y \
        libx264-164 libopus0 libv4l-0 libdrm2 libudev1 libssl3
fi
