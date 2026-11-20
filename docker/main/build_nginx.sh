#!/bin/bash

set -euxo pipefail

# Every source archive this script downloads: where from, and its sha256.
# Each archive is checked with `sha256sum -c` before it is unpacked, so the
# build fails if a file changes or a tag is moved. To fetch from another
# place (a mirror or our own copy), change only the *_URL line.
NGINX_VERSION="1.30.7"
NGINX_URL="https://nginx.org/download/nginx-${NGINX_VERSION}.tar.gz"
NGINX_SHA256="2565b5c837050e958f70fb0f73c48e2bca4542ad349fd356f46fb0c72610bc6e"

# Maintained fork of kaltura/nginx-vod-module (deleted from GitHub in Nov 2026)
VOD_MODULE_VERSION="v1.9.1"
VOD_MODULE_URL="https://github.com/dio-az/nginx-vod-module/archive/refs/tags/${VOD_MODULE_VERSION}.tar.gz"
VOD_MODULE_SHA256="62870bb0c4001041a459361d9b163a3afe1ec32d06a6b70969826e8ca823c97d"

SET_MISC_MODULE_VERSION="v0.33"
SET_MISC_MODULE_URL="https://github.com/openresty/set-misc-nginx-module/archive/refs/tags/${SET_MISC_MODULE_VERSION}.tar.gz"
SET_MISC_MODULE_SHA256="cd5e2cc834bcfa30149e7511f2b5a2183baf0b70dc091af717a89a64e44a2985"

NGX_DEVEL_KIT_VERSION="v0.3.3"
NGX_DEVEL_KIT_URL="https://github.com/vision5/ngx_devel_kit/archive/refs/tags/${NGX_DEVEL_KIT_VERSION}.tar.gz"
NGX_DEVEL_KIT_SHA256="faa2fcd5168b10764d35081356511d5f84db5c526a1aa4b6add2db94b6853b2b"

# fetch_source URL SHA256 DEST: download URL, verify its sha256, unpack it
# into DEST (dropping the archive's top-level directory), delete the archive.
fetch_source() {
    local url="$1" sha256="$2" dest="$3"
    local archive
    archive="$(mktemp /tmp/source-XXXXXX.tar.gz)"
    wget -nv -O "${archive}" "${url}"
    echo "${sha256}  ${archive}" | sha256sum -c -
    mkdir -p "${dest}"
    tar -zxf "${archive}" -C "${dest}" --strip-components=1
    rm "${archive}"
}

source /etc/os-release

if [[ "$VERSION_ID" == "12" ]]; then
    sed -i '/^Types:/s/deb/& deb-src/' /etc/apt/sources.list.d/debian.sources
else
    cp /etc/apt/sources.list /etc/apt/sources.list.d/sources-src.list
    sed -i 's|deb http|deb-src http|g' /etc/apt/sources.list.d/sources-src.list
fi

apt-get update
apt-get -yqq build-dep nginx

apt-get -yqq install --no-install-recommends ca-certificates wget
update-ca-certificates -f
apt install -y ccache

export PATH="/usr/lib/ccache:$PATH"

fetch_source "${NGINX_URL}" "${NGINX_SHA256}" /tmp/nginx

fetch_source "${VOD_MODULE_URL}" "${VOD_MODULE_SHA256}" /tmp/nginx-vod-module
    # Patch MAX_CLIPS to allow more clips to be added than the default 128
sed -i 's/MAX_CLIPS (128)/MAX_CLIPS (1080)/g' /tmp/nginx-vod-module/vod/media_set.h
grep -q 'MAX_CLIPS (1080)' /tmp/nginx-vod-module/vod/media_set.h
patch -d /tmp/nginx-vod-module/ -p1 << 'EOF'
--- a/vod/avc_hevc_parser.c
+++ b/vod/avc_hevc_parser.c
@@ -2,6 +2,9 @@

 bool_t
 avc_hevc_parser_rbsp_trailing_bits(bit_reader_state_t* reader) {
+	// https://github.com/blakeblackshear/frigate/issues/4572
+	return TRUE;
+
 	uint32_t one_bit;

 	if (reader->stream.eof_reached) {
EOF

fetch_source "${NGX_DEVEL_KIT_URL}" "${NGX_DEVEL_KIT_SHA256}" /tmp/ngx_devel_kit

fetch_source "${SET_MISC_MODULE_URL}" "${SET_MISC_MODULE_SHA256}" /tmp/nginx-set-misc-module

cd /tmp/nginx

./configure --prefix=/usr/local/nginx \
    --with-file-aio \
    --with-http_sub_module \
    --with-http_ssl_module \
    --with-http_auth_request_module \
    --with-http_realip_module \
    --with-threads \
    --add-module=../ngx_devel_kit \
    --add-module=../nginx-set-misc-module \
    --add-module=../nginx-vod-module \
    --with-cc-opt="-O3 -Wno-error=implicit-fallthrough"

make CC="ccache gcc" -j$(nproc) && make install
rm -rf /usr/local/nginx/html /usr/local/nginx/conf/*.default
