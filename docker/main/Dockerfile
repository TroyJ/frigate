# syntax=ghcr.io/troyj/dockerfile:1.6@sha256:ac85f380a63b13dfcefa89046420e1781752bab202122f8f50032edf31be0021
# (copy of docker/dockerfile:1.6 at the same digest; TroyJ/frigate-build-deps manifest.json)

# https://askubuntu.com/questions/972516/debian-frontend-environment-variable
ARG DEBIAN_FRONTEND=noninteractive

# Globally set pip break-system-packages option to avoid having to specify it every time
ARG PIP_BREAK_SYSTEM_PACKAGES=1

# Our copies of debian:12 and debian:12-slim, pinned by the originals' digests
# (TroyJ/frigate-build-deps manifest.json lists every copy and its original).
ARG BASE_IMAGE=ghcr.io/troyj/debian:12@sha256:268fb24c39bca92d326dd83ea3abebe4a3f7751c804ffef23bb6d857dd343ff8
ARG SLIM_BASE=ghcr.io/troyj/debian:12-slim@sha256:734a72b3d6142a71993b4bc580ca01d8ca687f77a2c422d96a961d3376b179bc

# Debian packages come from Debian's dated archive frozen at this time
# (docker/main/use_debian_snapshot.sh), so every build gets the same versions.
ARG DEBIAN_SNAPSHOT=20261119T000000Z

# A hook that allows us to inject commands right after the base images
ARG BASE_HOOK=

# Optional runtimes in the shared `deps` image. The defaults install everything, as
# upstream does; docker/rpi/rpi.hcl turns off what the Raspberry Pi image never uses.
#   INSTALL_HAILO           Hailo runtime and Python wheel (hailo8l detector)
#   INSTALL_MEMRYX          MemryX runtime (memryx detector)
#   INSTALL_GENERIC_FFMPEG  the generic ffmpeg 5.0 and 7.0 builds in /usr/lib/ffmpeg
#   OPENVINO_MODEL          "include" or "skip": the converted SSDLite model in
#                           /openvino-model (openvino detector's default model)
ARG INSTALL_HAILO=true
ARG INSTALL_MEMRYX=true
ARG INSTALL_GENERIC_FFMPEG=true
ARG OPENVINO_MODEL=include

FROM ${BASE_IMAGE} AS base
ARG PIP_BREAK_SYSTEM_PACKAGES
ARG BASE_HOOK
ARG DEBIAN_SNAPSHOT

RUN sh -c "$BASE_HOOK"
RUN --mount=type=bind,source=docker/main/use_debian_snapshot.sh,target=/deps/use_debian_snapshot.sh \
    /deps/use_debian_snapshot.sh

FROM --platform=${BUILDPLATFORM} ghcr.io/troyj/debian:12@sha256:268fb24c39bca92d326dd83ea3abebe4a3f7751c804ffef23bb6d857dd343ff8 AS base_host
ARG PIP_BREAK_SYSTEM_PACKAGES
ARG DEBIAN_SNAPSHOT
RUN --mount=type=bind,source=docker/main/use_debian_snapshot.sh,target=/deps/use_debian_snapshot.sh \
    /deps/use_debian_snapshot.sh

FROM ${SLIM_BASE} AS slim-base
ARG PIP_BREAK_SYSTEM_PACKAGES
ARG BASE_HOOK
ARG DEBIAN_SNAPSHOT

RUN sh -c "$BASE_HOOK"
RUN --mount=type=bind,source=docker/main/use_debian_snapshot.sh,target=/deps/use_debian_snapshot.sh \
    /deps/use_debian_snapshot.sh

FROM slim-base AS wget
ARG DEBIAN_FRONTEND
RUN apt-get update \
    && apt-get install -y wget xz-utils \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /rootfs

FROM base AS nginx
ARG DEBIAN_FRONTEND
ENV CCACHE_DIR /root/.ccache
ENV CCACHE_MAXSIZE 2G

RUN --mount=type=bind,source=docker/main/build_nginx.sh,target=/deps/build_nginx.sh \
    /deps/build_nginx.sh

FROM wget AS sqlite-vec
ARG DEBIAN_FRONTEND

# Build sqlite_vec from source
COPY docker/main/build_sqlite_vec.sh /deps/build_sqlite_vec.sh
RUN --mount=type=tmpfs,target=/tmp --mount=type=tmpfs,target=/var/cache/apt \
    --mount=type=bind,source=docker/main/build_sqlite_vec.sh,target=/deps/build_sqlite_vec.sh \
    --mount=type=cache,target=/root/.ccache \
    /deps/build_sqlite_vec.sh

FROM wget AS go2rtc
ARG TARGETARCH
RUN --mount=type=bind,source=docker/main/install_go2rtc.sh,target=/deps/install_go2rtc.sh \
    /deps/install_go2rtc.sh

FROM wget AS tempio
ARG TARGETARCH
RUN --mount=type=bind,source=docker/main/install_tempio.sh,target=/deps/install_tempio.sh \
    /deps/install_tempio.sh

####
#
# OpenVino Support
#
# 1. Download and convert a model from Intel's Public Open Model Zoo
#
####
# Download and Convert OpenVino model
FROM base_host AS ov-converter
ARG DEBIAN_FRONTEND

# Install OpenVino Runtime and Dev library
COPY docker/main/requirements-ov.txt /requirements-ov.txt
RUN apt-get -qq update \
    && apt-get -qq install -y wget python3 python3-dev python3-distutils gcc pkg-config libhdf5-dev \
    && wget -q https://bootstrap.pypa.io/get-pip.py -O get-pip.py \
    && sed -i 's/args.append("setuptools")/args.append("setuptools==77.0.3")/' get-pip.py \
    && python3 get-pip.py "pip" \
    && pip3 install -r /requirements-ov.txt

# Get OpenVino Model
RUN --mount=type=bind,source=docker/main/build_ov_model.py,target=/build_ov_model.py \
    mkdir /models && cd /models \
    && wget http://download.tensorflow.org/models/object_detection/ssdlite_mobilenet_v2_coco_2018_05_09.tar.gz \
    && tar -xvf ssdlite_mobilenet_v2_coco_2018_05_09.tar.gz \
    && python3 /build_ov_model.py

####
#
# Coral Compatibility
#
# Builds libusb without udev. Needed for synology and other devices with USB coral
####
# libUSB - No Udev
FROM wget as libusb-build
ARG TARGETARCH
ARG DEBIAN_FRONTEND
ENV CCACHE_DIR /root/.ccache
ENV CCACHE_MAXSIZE 2G

# Build libUSB without udev.  Needed for Openvino NCS2 support
WORKDIR /opt
RUN apt-get update && apt-get install -y unzip build-essential automake libtool ccache pkg-config
# Original: https://github.com/libusb/libusb/archive/v1.0.26.zip
RUN --mount=type=cache,target=/root/.ccache wget -q https://github.com/TroyJ/frigate-build-deps/releases/download/libusb-v1.0.26/libusb-v1.0.26.zip -O v1.0.26.zip && \
    echo "4175f942e74f3c34b71d01b107d33e713f9ff47563f49bcc6e8b2534f414dd54  v1.0.26.zip" | sha256sum -c - && \
    unzip v1.0.26.zip && cd libusb-1.0.26 && \
    ./bootstrap.sh && \
    ./configure CC='ccache gcc' CCX='ccache g++' --disable-udev --enable-shared && \
    make -j $(nproc --all)
RUN apt-get update && \
    apt-get install -y --no-install-recommends libusb-1.0-0-dev && \
    rm -rf /var/lib/apt/lists/*
WORKDIR /opt/libusb-1.0.26/libusb
RUN /bin/mkdir -p '/usr/local/lib' && \
    /bin/bash ../libtool  --mode=install /usr/bin/install -c libusb-1.0.la '/usr/local/lib' && \
    /bin/mkdir -p '/usr/local/include/libusb-1.0' && \
    /usr/bin/install -c -m 644 libusb.h '/usr/local/include/libusb-1.0' && \
    /bin/mkdir -p '/usr/local/lib/pkgconfig' && \
    cd  /opt/libusb-1.0.26/ && \
    /usr/bin/install -c -m 644 libusb-1.0.pc '/usr/local/lib/pkgconfig' && \
    ldconfig

# OpenVino model, or nothing (OPENVINO_MODEL=skip: ov-converter is then never built)
FROM wget AS openvino-model-include
COPY --from=ov-converter /models/ssdlite_mobilenet_v2.xml openvino-model/
COPY --from=ov-converter /models/ssdlite_mobilenet_v2.bin openvino-model/
RUN wget -q https://github.com/openvinotoolkit/open_model_zoo/raw/master/data/dataset_classes/coco_91cl_bkgr.txt -O openvino-model/coco_91cl_bkgr.txt && \
    sed -i 's/truck/car/g' openvino-model/coco_91cl_bkgr.txt

FROM scratch AS openvino-model-skip
WORKDIR /rootfs

FROM openvino-model-${OPENVINO_MODEL} AS openvino-model

FROM wget AS models

# Get model and labels (our copies; originals:
#   https://github.com/google-coral/test_data/raw/release-frogfish/ssdlite_mobiledet_coco_qat_postprocess_edgetpu.tflite
#   https://github.com/google-coral/test_data/raw/release-frogfish/ssdlite_mobiledet_coco_qat_postprocess.tflite)
RUN wget -qO edgetpu_model.tflite https://github.com/TroyJ/frigate-build-deps/releases/download/coral-models-release-frogfish/ssdlite_mobiledet_coco_qat_postprocess_edgetpu.tflite && \
    echo "4a2be2bbb614e576d56dcb914fa52752bf0f13411512710d355d97faa1b35641  edgetpu_model.tflite" | sha256sum -c -
RUN wget -qO cpu_model.tflite https://github.com/TroyJ/frigate-build-deps/releases/download/coral-models-release-frogfish/ssdlite_mobiledet_coco_qat_postprocess.tflite && \
    echo "90bb33a634e041914cc1819aa5df99818e6c396c4d2db952c0fd7a9cffc4724f  cpu_model.tflite" | sha256sum -c -
COPY labelmap.txt .
# Copy OpenVino model
COPY --from=openvino-model /rootfs/ ./
# Get Audio Model and labels (our copy; original:
#   https://www.kaggle.com/api/v1/models/google/yamnet/tfLite/classification-tflite/1/download)
RUN wget -qO yamnet.tar.gz https://github.com/TroyJ/frigate-build-deps/releases/download/yamnet-tflite-classification-1/yamnet-classification-tflite-1.tar.gz && \
    echo "1b971b2132760273a5fb8f5dc504e86783b27853bb3135d555ae06f1e1e365f3  yamnet.tar.gz" | sha256sum -c - && \
    tar xvzf yamnet.tar.gz && rm yamnet.tar.gz && mv 1.tflite cpu_audio_model.tflite
COPY audio-labelmap.txt .


FROM wget AS s6-overlay
ARG TARGETARCH
RUN --mount=type=bind,source=docker/main/install_s6_overlay.sh,target=/deps/install_s6_overlay.sh \
    /deps/install_s6_overlay.sh


FROM base AS wheels
ARG DEBIAN_FRONTEND
ARG TARGETARCH
ARG DEBUG=false

# Use a separate container to build wheels to prevent build dependencies in final image
RUN apt-get -qq update \
    && apt-get -qq install -y \
    apt-transport-https wget unzip \
    && apt-get -qq update \
    && apt-get -qq install -y \
    python3.11 \
    python3.11-dev \
    # opencv dependencies
    build-essential cmake git pkg-config libgtk-3-dev \
    libavcodec-dev libavformat-dev libswscale-dev libv4l-dev \
    libxvidcore-dev libx264-dev libjpeg-dev libpng-dev libtiff-dev \
    gfortran openexr libatlas-base-dev libssl-dev\
    libtbbmalloc2 libtbb-dev libdc1394-dev libopenexr-dev \
    libgstreamer-plugins-base1.0-dev libgstreamer1.0-dev \
    # sqlite3 dependencies
    tclsh \
    # scipy dependencies
    gcc gfortran libopenblas-dev liblapack-dev && \
    rm -rf /var/lib/apt/lists/*

RUN update-alternatives --install /usr/bin/python3 python3 /usr/bin/python3.11 1

# pip, setuptools 77.0.3 and wheel from our copies (was: the latest get-pip.py)
RUN --mount=type=bind,source=docker/main/install_pip.sh,target=/deps/install_pip.sh \
    --mount=type=bind,source=docker/main/requirements-build-arm64.lock,target=/deps/requirements-build-arm64.lock \
    /deps/install_pip.sh /deps/requirements-build-arm64.lock

COPY docker/main/requirements.txt /requirements.txt
COPY docker/main/requirements-dev.txt /requirements-dev.txt
COPY docker/main/requirements-wheels.txt /requirements-wheels.txt
COPY docker/main/requirements-build-arm64.lock docker/main/requirements-wheels-arm64.lock /

# arm64 (the Raspberry Pi image, the Arm test devcontainer): the exact packages of the
# lock files, every file one of our copies (TroyJ/frigate-build-deps, built for Debian 12 /
# CPython 3.11) checked by sha256; nothing is resolved or compiled here, and no package
# index is read. Other architectures: upstream's lists from PyPI, as before.
RUN if [ "$TARGETARCH" = "arm64" ]; then \
        pip3 install --no-index --no-deps --require-hashes -r /requirements-build-arm64.lock; \
    else \
        pip3 install -r /requirements.txt; \
    fi

# Build pysqlite3 from source
COPY docker/main/build_pysqlite3.sh /build_pysqlite3.sh
RUN /build_pysqlite3.sh

RUN if [ "$TARGETARCH" = "arm64" ]; then \
        pip3 wheel --no-index --no-deps --require-hashes --wheel-dir=/wheels -r /requirements-wheels-arm64.lock; \
    else \
        pip3 wheel --wheel-dir=/wheels -r /requirements-wheels.txt; \
    fi && \
    if [ "$DEBUG" = "true" ]; then \
        pip3 wheel --wheel-dir=/wheels -r /requirements-dev.txt; \
    fi

# Install HailoRT & Wheels
# (the Hailo archive is the only thing that fills /rootfs here, which deps-rootfs copies)
ARG INSTALL_HAILO
RUN --mount=type=bind,source=docker/main/install_hailort.sh,target=/deps/install_hailort.sh \
    if [ "$INSTALL_HAILO" = "true" ]; then /deps/install_hailort.sh; else mkdir -p /rootfs; fi

# Collect deps in a single layer
FROM scratch AS deps-rootfs
COPY --from=nginx /usr/local/nginx/ /usr/local/nginx/
COPY --from=sqlite-vec /usr/local/lib/ /usr/local/lib/
COPY --from=go2rtc /rootfs/ /
COPY --from=libusb-build /usr/local/lib /usr/local/lib
COPY --from=tempio /rootfs/ /
COPY --from=s6-overlay /rootfs/ /
COPY --from=models /rootfs/ /
COPY --from=wheels /rootfs/ /
COPY docker/main/rootfs/ /


# Frigate deps (ffmpeg, python, nginx, go2rtc, s6-overlay, etc)
FROM slim-base AS deps
ARG TARGETARCH
ARG BASE_IMAGE

ARG DEBIAN_FRONTEND
# http://stackoverflow.com/questions/48162574/ddg#49462622
ARG APT_KEY_DONT_WARN_ON_DANGEROUS_USAGE=DontWarn

# https://github.com/NVIDIA/nvidia-docker/wiki/Installation-(Native-GPU-Support)
ENV NVIDIA_VISIBLE_DEVICES=all
ENV NVIDIA_DRIVER_CAPABILITIES="compute,video,utility"

# Disable tokenizer parallelism warning
# https://stackoverflow.com/questions/62691279/how-to-disable-tokenizers-parallelism-true-false-warning/72926996#72926996
ENV TOKENIZERS_PARALLELISM=true
# https://github.com/huggingface/transformers/issues/27214
ENV TRANSFORMERS_NO_ADVISORY_WARNINGS=1

# Set OpenCV ffmpeg loglevel to fatal: https://ffmpeg.org/doxygen/trunk/log_8h.html
ENV OPENCV_FFMPEG_LOGLEVEL=8

# Set NumPy to ignore getlimits warning
ENV PYTHONWARNINGS="ignore:::numpy.core.getlimits"

# Set HailoRT to disable logging
ENV HAILORT_LOGGER_PATH=NONE

# TensorFlow C++ logging suppression (must be set before import)
# TF_CPP_MIN_LOG_LEVEL: 0=all, 1=INFO+, 2=WARNING+, 3=ERROR+ (we use 3 for errors only)
ENV TF_CPP_MIN_LOG_LEVEL=3
# Suppress verbose logging from TensorFlow C++ code
ENV TF_CPP_MIN_VLOG_LEVEL=3
# Disable oneDNN optimization messages ("optimized with oneDNN...")
ENV TF_ENABLE_ONEDNN_OPTS=0
# Suppress AutoGraph verbosity during conversion
ENV AUTOGRAPH_VERBOSITY=0
# Google Logging (GLOG) suppression for TensorFlow components
ENV GLOG_minloglevel=3
ENV GLOG_logtostderr=0

ENV PATH="/usr/local/go2rtc/bin:/usr/local/tempio/bin:/usr/local/nginx/sbin:${PATH}"

# Install dependencies
ARG INSTALL_GENERIC_FFMPEG
RUN --mount=type=bind,source=docker/main/install_deps.sh,target=/deps/install_deps.sh \
    /deps/install_deps.sh

ENV DEFAULT_FFMPEG_VERSION="7.0"
ENV INCLUDED_FFMPEG_VERSIONS="${DEFAULT_FFMPEG_VERSION}:5.0"

RUN --mount=type=bind,source=docker/main/install_pip.sh,target=/deps/install_pip.sh \
    --mount=type=bind,source=docker/main/requirements-build-arm64.lock,target=/deps/requirements-build-arm64.lock \
    /deps/install_pip.sh /deps/requirements-build-arm64.lock

# /wheels holds every package and dependency, so no package index is needed
RUN --mount=type=bind,from=wheels,source=/wheels,target=/deps/wheels \
    pip3 install -U --no-index /deps/wheels/*.whl

# Install MemryX runtime (requires libgomp (OpenMP) in the final docker image)
ARG INSTALL_MEMRYX
RUN --mount=type=bind,source=docker/main/install_memryx.sh,target=/deps/install_memryx.sh \
    if [ "$INSTALL_MEMRYX" = "true" ]; then bash -c "bash /deps/install_memryx.sh"; fi

COPY --from=deps-rootfs / /

RUN ldconfig

EXPOSE 5000
EXPOSE 8554
EXPOSE 8555/tcp 8555/udp

# Configure logging to prepend timestamps, log to stdout, keep 0 archives and rotate on 10MB
ENV S6_LOGGING_SCRIPT="T 1 n0 s10000000 T"
# Do not fail on long-running download scripts
ENV S6_CMD_WAIT_FOR_SERVICES_MAXTIME=0

ENTRYPOINT ["/init"]
CMD []

# D16/F21 — widened from `--timeout=5s --retries=3`. Keep probing the app (a static path
# would report healthy with Frigate dead), but `/api/version` traverses nginx's
# `auth_request` into the single uvicorn worker: block that worker for ~45 s and Docker
# marks the container unhealthy, whereupon the Supervisor watchdog recreates the add-on —
# a ~40 s camera outage (measured 2026-08-26). 10 s x 6 tolerates ~2 min, so a slow API
# degrades instead of restarting. Do not lower these without re-reading F21.
HEALTHCHECK --start-period=300s --start-interval=5s --interval=15s --timeout=10s --retries=6 \
    CMD test -f /dev/shm/.frigate-is-stopping && exit 0; curl --fail --silent --show-error http://127.0.0.1:5000/api/version || exit 1

# Frigate deps with Node.js and NPM for devcontainer
FROM deps AS devcontainer
ARG TARGETARCH

# Do not start the actual Frigate service on devcontainer as it will be started by VS Code
# But start a fake service for simulating the logs
COPY docker/main/fake_frigate_run /etc/s6-overlay/s6-rc.d/frigate/run

# Create symbolic link to the frigate source code, as go2rtc's create_config.sh uses it
RUN mkdir -p /opt/frigate \
    && ln -svf /workspace/frigate/frigate /opt/frigate/frigate

RUN apt-get update \
    && apt-get install make xz-utils -y \
    && rm -rf /var/lib/apt/lists/*

# Install Node 20. arm64: our copy of the official Node.js 20.20.2 build (npm 10.8.2 inside;
# original https://nodejs.org/dist/v20.20.2/node-v20.20.2-linux-arm64.tar.xz, sha256 as in
# its SHASUMS256.txt). Other architectures: NodeSource's repository, as before.
RUN if [ "$TARGETARCH" = "arm64" ]; then \
        wget -qO /tmp/node.tar.xz https://github.com/TroyJ/frigate-build-deps/releases/download/nodejs-v20.20.2/node-v20.20.2-linux-arm64.tar.xz && \
        echo "73093db209e4e9e09dd7d15a47aeaab1b74833830df03efa5f942a1122c5fa71  /tmp/node.tar.xz" | sha256sum -c - && \
        tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1 && \
        rm /tmp/node.tar.xz && node --version && npm --version; \
    else \
        curl -SLO https://deb.nodesource.com/nsolid_setup_deb.sh && \
        chmod 500 nsolid_setup_deb.sh && \
        ./nsolid_setup_deb.sh 20 && \
        apt-get install nodejs -y \
        && rm -rf /var/lib/apt/lists/* \
        && npm install -g npm@10; \
    fi

WORKDIR /workspace/frigate

RUN --mount=type=bind,source=./docker/main/requirements-dev.txt,target=/workspace/frigate/requirements-dev.txt \
    --mount=type=bind,source=./docker/main/requirements-dev-arm64.lock,target=/workspace/frigate/requirements-dev-arm64.lock \
    if [ "$TARGETARCH" = "arm64" ]; then \
        pip3 install --no-index --no-deps --require-hashes -r requirements-dev-arm64.lock; \
    else \
        pip3 install -r requirements-dev.txt; \
    fi

HEALTHCHECK NONE

CMD ["sleep", "infinity"]


# Frigate web build
# This should be architecture agnostic, so speed up the build on multiarch by not using QEMU.
# (our copy of node:20 at the original's digest)
FROM --platform=$BUILDPLATFORM ghcr.io/troyj/node:20@sha256:8f693eaa7e0a8e71560c9a82b55fd54c2ae920a2ba5d2cde28bac7d1c01c9ba5 AS web-build

WORKDIR /work
COPY web/package.json web/package-lock.json ./
RUN npm install

COPY web/ ./
RUN npm run build \
    && mv dist/BASE_PATH/monacoeditorwork/* dist/assets/ \
    && rm -rf dist/BASE_PATH

# Collect final files in a single layer
FROM scratch AS rootfs

WORKDIR /opt/frigate/
COPY frigate frigate/
COPY migrations migrations/
COPY --from=web-build /work/dist/ web/

# Frigate final container
FROM deps AS frigate

WORKDIR /opt/frigate/
COPY --from=rootfs / /
