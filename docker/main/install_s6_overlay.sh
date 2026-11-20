#!/bin/bash

set -euxo pipefail

s6_version="3.2.1.0"

if [[ "${TARGETARCH}" == "amd64" ]]; then
    s6_arch="x86_64"
elif [[ "${TARGETARCH}" == "arm64" ]]; then
    s6_arch="aarch64"
fi

# Our copies (TroyJ/frigate-build-deps), checked by sha256 (the same as the project's
# .sha256 files). Originals:
#   https://github.com/just-containers/s6-overlay/releases/download/v${s6_version}/s6-overlay-{noarch,${s6_arch}}.tar.xz
s6_url="https://github.com/TroyJ/frigate-build-deps/releases/download/s6-overlay-v${s6_version}"
noarch_sha256="42e038a9a00fc0fef70bf0bc42f625a9c14f8ecdfe77d4ad93281edf717e10c5"
case "${s6_arch}" in
    aarch64) arch_sha256="c8fd6b1f0380d399422fc986a1e6799f6a287e2cfa24813ad0b6a4fb4fa755cc" ;;
    x86_64) arch_sha256="8bcbc2cada58426f976b159dcc4e06cbb1454d5f39252b3bb0c778ccf71c9435" ;;
esac

mkdir -p /rootfs/

for part in "noarch:${noarch_sha256}" "${s6_arch}:${arch_sha256}"; do
    name="s6-overlay-${part%%:*}.tar.xz"
    wget -q -O "/tmp/${name}" "${s6_url}/${name}"
    echo "${part#*:}  /tmp/${name}" | sha256sum -c -
    tar -C /rootfs/ -Jxpf "/tmp/${name}"
    rm "/tmp/${name}"
done
