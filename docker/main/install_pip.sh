#!/bin/bash
# Install pip, setuptools and wheel at the exact versions of
# docker/main/requirements-build-arm64.lock, from our copies (TroyJ/frigate-build-deps),
# every file checked by sha256: a frozen copy of get-pip.py, run offline against the three
# wheels. Replaces `wget https://bootstrap.pypa.io/get-pip.py` (always the latest, patched
# with sed to pin setuptools 77.0.3). The three wheels are pure Python, so this serves
# every architecture.
#
#   install_pip.sh /path/to/requirements-build-arm64.lock
set -euo pipefail

LOCK="${1:?usage: install_pip.sh LOCKFILE}"

# Original: https://bootstrap.pypa.io/get-pip.py (Last-Modified 2026-11-03)
GETPIP_URL="https://github.com/TroyJ/frigate-build-deps/releases/download/get-pip-2026-11-03/get-pip.py"
GETPIP_SHA256="356e0d0de21cdc348c3394084d90939b85e4246c4d14c76aee6ca4f46646ea98"

dir="$(mktemp -d)"
echo "fetching ${GETPIP_URL}"
wget -q -O "${dir}/get-pip.py" "${GETPIP_URL}"
echo "${GETPIP_SHA256}  ${dir}/get-pip.py" | sha256sum -c -

pins=()
for pkg in pip setuptools wheel; do
    line="$(grep -E "^${pkg} @ " "${LOCK}")"
    url="$(echo "${line}" | awk '{print $3}')"
    sha="$(echo "${line}" | sed -n 's/.*--hash=sha256:\([0-9a-f]*\).*/\1/p')"
    file="${dir}/$(basename "${url}")"
    echo "fetching ${url}"
    wget -q -O "${file}" "${url}"
    echo "${sha}  ${file}" | sha256sum -c -
    version="$(basename "${url}" | cut -d- -f2)"
    pins+=("${pkg}==${version}")
done

python3 "${dir}/get-pip.py" --no-index --find-links "${dir}" "${pins[@]}"
rm -rf "${dir}"
python3 -m pip --version
