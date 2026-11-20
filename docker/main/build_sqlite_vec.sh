#!/bin/bash

set -euxo pipefail

SQLITE_VEC_VERSION="0.1.3"
# Our copies (TroyJ/frigate-build-deps), checked by sha256. Originals:
#   https://github.com/asg017/sqlite-vec/archive/refs/tags/v${SQLITE_VEC_VERSION}.tar.gz
#   https://www.sqlite.org/2024/sqlite-amalgamation-3450300.zip
SQLITE_VEC_URL="https://github.com/TroyJ/frigate-build-deps/releases/download/sqlite-vec-v${SQLITE_VEC_VERSION}/sqlite-vec-v${SQLITE_VEC_VERSION}.tar.gz"
SQLITE_VEC_SHA256="6cd2946c8fec018704daadfad7d1299a0a637863d4c393114cfcd3b8e140d88e"
SQLITE_URL="https://github.com/TroyJ/frigate-build-deps/releases/download/sqlite-3.45.3/sqlite-amalgamation-3450300.zip"
SQLITE_SHA256="ea170e73e447703e8359308ca2e4366a3ae0c4304a8665896f068c736781c651"

source /etc/os-release

if [[ "$VERSION_ID" == "12" ]]; then
    sed -i '/^Types:/s/deb/& deb-src/' /etc/apt/sources.list.d/debian.sources
else
    cp /etc/apt/sources.list /etc/apt/sources.list.d/sources-src.list
    sed -i 's|deb http|deb-src http|g' /etc/apt/sources.list.d/sources-src.list
fi

apt-get update
apt-get -yqq build-dep sqlite3 gettext git

mkdir /tmp/sqlite_vec
# Grab the sqlite_vec source code.
wget -nv -O v${SQLITE_VEC_VERSION}.tar.gz "${SQLITE_VEC_URL}"
echo "${SQLITE_VEC_SHA256}  v${SQLITE_VEC_VERSION}.tar.gz" | sha256sum -c -
tar -zxf v${SQLITE_VEC_VERSION}.tar.gz -C /tmp/sqlite_vec

cd /tmp/sqlite_vec/sqlite-vec-${SQLITE_VEC_VERSION}

mkdir -p vendor
wget -nv -O sqlite-amalgamation.zip "${SQLITE_URL}"
echo "${SQLITE_SHA256}  sqlite-amalgamation.zip" | sha256sum -c -
unzip sqlite-amalgamation.zip
mv sqlite-amalgamation-3450300/* vendor/
rmdir sqlite-amalgamation-3450300
rm sqlite-amalgamation.zip

# build loadable module
make loadable

# install it
cp dist/vec0.* /usr/local/lib

