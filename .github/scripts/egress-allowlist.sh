#!/bin/bash
# Block a GitHub runner's outbound network except for our copies, for the offline
# build proof (.github/workflows/offline-build-proof.yml).
#
#   sudo .github/scripts/egress-allowlist.sh start
#   sudo .github/scripts/egress-allowlist.sh report LABEL [--fail]
#
# What is blocked:
#   - Every Docker container (build steps, BuildKit itself, the devcontainer, the MQTT
#     broker): may connect only to the addresses of the allowed host names, as
#     resolved through our resolver. Everything else is rejected (iptables DOCKER-USER).
#   - Every process running as root on the runner (dockerd pulling images, containerd,
#     sudo): the same allowlist (iptables OUTPUT, owner uid 0).
#   - The runner's own user (the Actions runner, node, the devcontainer CLI) is not
#     blocked, or the job could not report back to GitHub; its DNS lookups are logged
#     and listed by `report`, so anything unexpected it fetched is still visible.
# How: dnsmasq answers every DNS query on the runner and for Docker, and puts the
# addresses of the allowed names (and their subdomains) into an ipset; iptables
# accepts only those addresses. IPv6 is rejected for containers and root.
#
# Allowed: github.com (release files of TroyJ/frigate-build-deps; the redirect goes to
# release-assets.githubusercontent.com or objects.githubusercontent.com), ghcr.io and
# pkg-containers.githubusercontent.com (our image copies), snapshot.debian.org (Debian's
# dated archive), registry.npmjs.org (npm packages, sha512-pinned by the lockfile).
# Limit: the check is by host name. github.com is allowed as a whole, so a download from
# another owner's repository on github.com would pass the block; `report` therefore
# also lists every github.com URL the build fetched, from the build log (see the workflow).
#
# `report LABEL` prints what was rejected and which names were looked up since the last
# report; with --fail it exits 1 if a container or root process was rejected or a
# container looked up a name outside the allowlist.
set -euo pipefail

ALLOWED=(
  github.com
  objects.githubusercontent.com
  release-assets.githubusercontent.com
  ghcr.io
  pkg-containers.githubusercontent.com
  snapshot.debian.org
  registry.npmjs.org
)
STATE=/var/tmp/egress
LOG="${STATE}/dnsmasq.log"

allowed_name() {
  local n="${1%.}" a
  for a in "${ALLOWED[@]}"; do
    [[ "$n" == "$a" || "$n" == *".${a}" ]] && return 0
  done
  return 1
}

start() {
  mkdir -p "$STATE"
  export DEBIAN_FRONTEND=noninteractive
  apt-get -qq update >/dev/null
  apt-get -qq install -y dnsmasq-base ipset >/dev/null

  bridge_ip="$(ip -4 -o addr show docker0 | awk '{print $4}' | cut -d/ -f1)"
  ipset create egress-allow hash:ip -exist
  ipset_names="$(IFS=/; echo "${ALLOWED[*]}")"
  touch "$LOG"; chmod 666 "$LOG"
  cat > "${STATE}/dnsmasq.conf" <<EOF
no-resolv
no-hosts
server=127.0.0.53
listen-address=127.0.0.1,${bridge_ip}
bind-interfaces
cache-size=0
log-queries=extra
log-facility=${LOG}
ipset=/${ipset_names}/egress-allow
user=nobody
EOF
  dnsmasq --conf-file="${STATE}/dnsmasq.conf" --pid-file="${STATE}/dnsmasq.pid"

  # The runner and dockerd resolve through dnsmasq; containers too (daemon "dns").
  cp /etc/resolv.conf "${STATE}/resolv.conf.orig"
  rm -f /etc/resolv.conf
  echo "nameserver 127.0.0.1" > /etc/resolv.conf
  python3 - "$bridge_ip" <<'EOF'
import json, os, sys
p = "/etc/docker/daemon.json"
d = json.load(open(p)) if os.path.exists(p) else {}
d["dns"] = [sys.argv[1]]
json.dump(d, open(p, "w"), indent=2)
EOF
  systemctl restart docker
  for _ in $(seq 1 30); do docker info >/dev/null 2>&1 && break; sleep 1; done

  # Containers (forwarded traffic)
  iptables -N EGRESS-FWD 2>/dev/null || iptables -F EGRESS-FWD
  iptables -A EGRESS-FWD -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
  iptables -A EGRESS-FWD -d 172.16.0.0/12 -j RETURN
  iptables -A EGRESS-FWD -d 192.168.0.0/16 -j RETURN
  iptables -A EGRESS-FWD -m set --match-set egress-allow dst -j RETURN
  iptables -A EGRESS-FWD -j LOG --log-prefix "EGRESS-BLOCK container " --log-uid
  iptables -A EGRESS-FWD -j REJECT
  iptables -I DOCKER-USER 1 -j EGRESS-FWD
  # Root processes on the runner
  iptables -N EGRESS-ROOT 2>/dev/null || iptables -F EGRESS-ROOT
  iptables -A EGRESS-ROOT -o lo -j RETURN
  iptables -A EGRESS-ROOT -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
  iptables -A EGRESS-ROOT -d 172.16.0.0/12 -j RETURN
  iptables -A EGRESS-ROOT -d 192.168.0.0/16 -j RETURN
  iptables -A EGRESS-ROOT -d 169.254.0.0/16 -j RETURN   # the cloud's instance metadata
  # Azure's platform endpoint (WireServer): the runner VM's own agent reports to it as
  # root; seen rejected on the first run (ports 80 and 32526). Not build traffic.
  iptables -A EGRESS-ROOT -d 168.63.129.16 -j RETURN
  iptables -A EGRESS-ROOT -m set --match-set egress-allow dst -j RETURN
  iptables -A EGRESS-ROOT -j LOG --log-prefix "EGRESS-BLOCK root " --log-uid
  iptables -A EGRESS-ROOT -j REJECT
  iptables -I OUTPUT 1 -m owner --uid-owner 0 -j EGRESS-ROOT
  # IPv6: containers and root get none
  ip6tables -I FORWARD 1 -j REJECT || true
  ip6tables -I OUTPUT 1 -m owner --uid-owner 0 ! -o lo -j REJECT || true

  echo 0 > "${STATE}/log.pos"
  echo 0 > "${STATE}/kern.pos"
  # Prove the block works before the build relies on it.
  if docker run --rm ghcr.io/troyj/debian:12-slim@sha256:734a72b3d6142a71993b4bc580ca01d8ca687f77a2c422d96a961d3376b179bc \
       bash -c 'exec 3<>/dev/tcp/deb.debian.org/80' 2>/dev/null; then
    echo "egress block NOT working: a container reached deb.debian.org" >&2; exit 1
  fi
  if ! docker run --rm ghcr.io/troyj/debian:12-slim@sha256:734a72b3d6142a71993b4bc580ca01d8ca687f77a2c422d96a961d3376b179bc \
       bash -c 'exec 3<>/dev/tcp/snapshot.debian.org/80'; then
    echo "egress allowlist NOT working: a container could not reach snapshot.debian.org" >&2; exit 1
  fi
  echo "egress block on: containers and root may reach only: ${ALLOWED[*]}"
  report "self-test" >/dev/null
}

report() {
  local label="$1" fail="${2:-}" bad=0
  local lpos kpos
  lpos="$(cat "${STATE}/log.pos")"; kpos="$(cat "${STATE}/kern.pos")"
  local lines; lines="$(wc -l < "$LOG")"
  dmesg > "${STATE}/kern.now"
  local klines; klines="$(wc -l < "${STATE}/kern.now")"

  echo "== egress report: ${label}"
  local blocks; blocks="$(tail -n +"$((kpos + 1))" "${STATE}/kern.now" | grep 'EGRESS-BLOCK' || true)"
  if [[ -n "$blocks" ]]; then
    echo "rejected connections:"
    echo "$blocks" | sed -E 's/.*(EGRESS-BLOCK [a-z]+).* SRC=([^ ]+) DST=([^ ]+).*PROTO=([A-Z]+).*DPT=([0-9]+).*/  \1 \2 -> \3:\5 \4/' | sort | uniq -c
    bad=1
  else
    echo "rejected connections: none"
  fi

  # dnsmasq "extra" log lines: "... query[A] name from 172.17.0.2"
  echo "names looked up (count, name, from where, allowed?):"
  tail -n +"$((lpos + 1))" "$LOG" | sed -nE 's/.* query\[(A|AAAA)\] ([^ ]+) from ([0-9a-f.:]+).*/\2 \3/p' |
  while read -r name src; do
    case "$src" in 127.*|::1) who="runner" ;; *) who="container" ;; esac
    echo "$name $who"
  done | sort | uniq -c | while read -r count name who; do
    if allowed_name "$name"; then ok="allowed"; else ok="NOT ALLOWED"; fi
    printf '  %5s %-60s %-9s %s\n' "$count" "$name" "$who" "$ok"
    if [[ "$who" == "container" && "$ok" == "NOT ALLOWED" ]]; then echo "$name" >> "${STATE}/bad-names"; fi
  done
  if [[ -s "${STATE}/bad-names" ]]; then bad=1; rm -f "${STATE}/bad-names"; fi

  echo "$lines" > "${STATE}/log.pos"
  echo "$klines" > "${STATE}/kern.pos"
  if [[ "$fail" == "--fail" && "$bad" == 1 ]]; then
    echo "FAIL: something outside the allowlist was reached for or looked up during: ${label}"
    return 1
  fi
  return 0
}

case "${1:-}" in
  start) start ;;
  report) shift; report "$@" ;;
  *) echo "usage: $0 start | report LABEL [--fail]" >&2; exit 2 ;;
esac
