#!/bin/bash
# Point apt at Debian's dated archive (snapshot.debian.org) frozen at DEBIAN_SNAPSHOT,
# instead of deb.debian.org, so every build installs the same package versions.
#
#   DEBIAN_SNAPSHOT=20261119T000000Z use_debian_snapshot.sh
#
# Rewrites the deb822 sources of a Debian 12 image (debian, bookworm-updates and
# debian-security), turns off the Release-file expiry check (a snapshot's Release files
# expire a week after their date; apt still checks every signature), and writes the
# archive's base URL to /etc/apt/debian-snapshot-base for scripts that add a suite or
# component (backports, non-free). Does nothing on an image without Debian's
# deb.debian.org sources (the Ubuntu-based images of other boards), or when
# DEBIAN_SNAPSHOT is empty.
set -euo pipefail

SOURCES=/etc/apt/sources.list.d/debian.sources
if [[ -z "${DEBIAN_SNAPSHOT:-}" ]] || ! grep -qs 'deb.debian.org' "${SOURCES}"; then
    echo "use_debian_snapshot: nothing to do"
    exit 0
fi

BASE="http://snapshot.debian.org/archive/debian/${DEBIAN_SNAPSHOT}"
SECURITY="http://snapshot.debian.org/archive/debian-security/${DEBIAN_SNAPSHOT}"
sed -i \
    -e "s|http://deb.debian.org/debian-security|${SECURITY}|" \
    -e "s|http://deb.debian.org/debian\$|${BASE}|" \
    "${SOURCES}"
if grep -q 'deb.debian.org' "${SOURCES}"; then
    echo "use_debian_snapshot: unexpected source left in ${SOURCES}:" >&2
    cat "${SOURCES}" >&2
    exit 1
fi
cat > /etc/apt/apt.conf.d/99debian-snapshot <<'EOF'
Acquire::Check-Valid-Until "false";
Acquire::Retries "5";
EOF
echo "${BASE}" > /etc/apt/debian-snapshot-base
echo "use_debian_snapshot: apt reads ${BASE}"
