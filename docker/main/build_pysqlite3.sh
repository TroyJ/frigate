#!/bin/bash

set -euxo pipefail

SQLITE3_VERSION="3.46.1"
PYSQLITE3_VERSION="0.5.3"
# Our copies (TroyJ/frigate-build-deps), checked by sha256. Originals:
#   https://www.sqlite.org/2024/sqlite-amalgamation-3460100.zip
#   https://github.com/coleifer/pysqlite3.git, tag 0.5.3 = commit 67014040 (git archive of it)
SQLITE_URL="https://github.com/TroyJ/frigate-build-deps/releases/download/sqlite-3.46.1/sqlite-amalgamation-3460100.zip"
SQLITE_SHA256="77823cb110929c2bcb0f5d48e4833b5c59a8a6e40cdea3936b99e199dbbe5784"
PYSQLITE3_COMMIT="67014040e4eb5ab2abc0c7bdcf2dfefea13332ab"
PYSQLITE3_URL="https://github.com/TroyJ/frigate-build-deps/releases/download/pysqlite3-${PYSQLITE3_VERSION}/pysqlite3-${PYSQLITE3_VERSION}-${PYSQLITE3_COMMIT}.tar.gz"
PYSQLITE3_SHA256="290c078d148b962b42297db7f4b35950e76794a283d467c2f3a5d6c8cc8e0ca0"

# Install libsqlite3-dev if not present (needed for some base images like NVIDIA TensorRT)
if ! dpkg -l | grep -q libsqlite3-dev; then
  echo "Installing libsqlite3-dev for compilation..."
  apt-get update && apt-get install -y libsqlite3-dev && rm -rf /var/lib/apt/lists/*
fi

# Fetch the pre-built sqlite amalgamation instead of building from source
if [[ ! -d "sqlite" ]]; then
  mkdir sqlite
  cd sqlite

  # Download the pre-built amalgamation from sqlite.org
  # For SQLite 3.46.1, the amalgamation version is 3460100
  SQLITE_AMALGAMATION_VERSION="3460100"

  wget -nv "${SQLITE_URL}" -O sqlite-amalgamation.zip
  echo "${SQLITE_SHA256}  sqlite-amalgamation.zip" | sha256sum -c -
  unzip sqlite-amalgamation.zip
  mv sqlite-amalgamation-${SQLITE_AMALGAMATION_VERSION}/* .
  rmdir sqlite-amalgamation-${SQLITE_AMALGAMATION_VERSION}
  rm sqlite-amalgamation.zip

  cd ../
fi

# Grab the pysqlite3 source code.
if [[ ! -d "./pysqlite3" ]]; then
  wget -nv "${PYSQLITE3_URL}" -O pysqlite3.tar.gz
  echo "${PYSQLITE3_SHA256}  pysqlite3.tar.gz" | sha256sum -c -
  tar -xzf pysqlite3.tar.gz   # unpacks into pysqlite3/
  rm pysqlite3.tar.gz
fi

cd pysqlite3/

# Copy the sqlite3 source amalgamation into the pysqlite3 directory so we can
# create a self-contained extension module.
cp "../sqlite/sqlite3.c" ./
cp "../sqlite/sqlite3.h" ./

# Create the wheel and put it in the /wheels dir.
sed -i "s|name='pysqlite3-binary'|name=PACKAGE_NAME|g" setup.py
python3 setup.py build_static
# setuptools and wheel are already installed (install_pip.sh); no build isolation, so
# pip reads no package index.
pip3 wheel --no-build-isolation --no-deps --no-index . -w /wheels
