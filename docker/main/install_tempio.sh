#!/bin/bash

set -euxo pipefail

tempio_version="2021.09.0"

if [[ "${TARGETARCH}" == "amd64" ]]; then
    arch="amd64"
elif [[ "${TARGETARCH}" == "arm64" ]]; then
    arch="aarch64"
fi

# Our copy (TroyJ/frigate-build-deps), checked by sha256. Original:
#   https://github.com/home-assistant/tempio/releases/download/${tempio_version}/tempio_${arch}
case "${arch}" in
    aarch64) tempio_sha256="3a5c32981ba68b75ed9b28497429e5a5cecbeb74c3b821b035a48b37609bb895" ;;
    amd64) tempio_sha256="b7b93ebfd24c1161cec7aecfad62ab51f2241149358cef354b86cdbc6a60546f" ;;
esac

mkdir -p /rootfs/usr/local/tempio/bin

wget -q -O /rootfs/usr/local/tempio/bin/tempio "https://github.com/TroyJ/frigate-build-deps/releases/download/tempio-${tempio_version}/tempio_${arch}"
echo "${tempio_sha256}  /rootfs/usr/local/tempio/bin/tempio" | sha256sum -c -
chmod 755 /rootfs/usr/local/tempio/bin/tempio
