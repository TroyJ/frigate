# syntax=ghcr.io/troyj/dockerfile:1.4@sha256:9ba7531bd80fb0a858632727cf7a112fbfd19b17e94c4e84ced81e24ef1a0dbc
# (copy of docker/dockerfile:1.4 at the same digest; TroyJ/frigate-build-deps manifest.json)

# https://askubuntu.com/questions/972516/debian-frontend-environment-variable
ARG DEBIAN_FRONTEND=noninteractive

# Debian's dated archive, the same time as docker/main/Dockerfile
ARG DEBIAN_SNAPSHOT=20261119T000000Z

# Raspberry Pi-patched ffmpeg, built from source (see docker/rpi/build_ffmpeg.sh
# for why the APT package is not used).
# (our copy of debian:12 at the original's digest)
FROM ghcr.io/troyj/debian:12@sha256:268fb24c39bca92d326dd83ea3abebe4a3f7751c804ffef23bb6d857dd343ff8 AS rpi-ffmpeg-build
ARG DEBIAN_SNAPSHOT
RUN --mount=type=bind,source=docker/main/use_debian_snapshot.sh,target=/deps/use_debian_snapshot.sh \
    /deps/use_debian_snapshot.sh
RUN --mount=type=bind,source=docker/rpi/build_ffmpeg.sh,target=/deps/build_ffmpeg.sh \
    --mount=type=bind,source=docker/rpi/patches,target=/deps/patches \
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
