#!/bin/bash
# go2rtc (camera stream relay) binary, from our copy, checked by sha256.
set -euxo pipefail

# Originals: https://github.com/AlexxIT/go2rtc/releases/download/v1.9.10/go2rtc_linux_${TARGETARCH}
# (sha256s match the digests GitHub publishes for those release files)
go2rtc_url="https://github.com/TroyJ/frigate-build-deps/releases/download/go2rtc-v1.9.10/go2rtc_linux_${TARGETARCH}"
case "${TARGETARCH}" in
    arm64) go2rtc_sha256="f4e3f56e991d5540c3c4790269044d864acbc3380f9896ef4fe1862c79c66367" ;;
    amd64) go2rtc_sha256="825bffa9caf585a008bcdea6b354418263d94aea73674f1a5bcacfb26c2c35f9" ;;
    *) echo "no go2rtc copy for ${TARGETARCH}" >&2; exit 1 ;;
esac

mkdir -p /rootfs/usr/local/go2rtc/bin
wget -q -O /rootfs/usr/local/go2rtc/bin/go2rtc "${go2rtc_url}"
echo "${go2rtc_sha256}  /rootfs/usr/local/go2rtc/bin/go2rtc" | sha256sum -c -
chmod 755 /rootfs/usr/local/go2rtc/bin/go2rtc
