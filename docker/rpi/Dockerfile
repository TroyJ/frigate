# syntax=docker/dockerfile:1.4

# https://askubuntu.com/questions/972516/debian-frontend-environment-variable
ARG DEBIAN_FRONTEND=noninteractive

# Raspberry Pi-patched ffmpeg, built from source (see docker/rpi/build_ffmpeg.sh
# for why the APT package is not used).
FROM debian:12 AS rpi-ffmpeg-build
RUN --mount=type=bind,source=docker/rpi/build_ffmpeg.sh,target=/deps/build_ffmpeg.sh \
    /deps/build_ffmpeg.sh

FROM deps AS rpi-deps
ARG TARGETARCH

# Install dependencies
RUN --mount=type=bind,source=docker/rpi/install_deps.sh,target=/deps/install_deps.sh \
    /deps/install_deps.sh

COPY --from=rpi-ffmpeg-build /usr/lib/ffmpeg/rpi /usr/lib/ffmpeg/rpi

ENV DEFAULT_FFMPEG_VERSION="rpi"
ENV INCLUDED_FFMPEG_VERSIONS="${DEFAULT_FFMPEG_VERSION}:${INCLUDED_FFMPEG_VERSIONS}"

WORKDIR /opt/frigate/
COPY --from=rootfs / /
