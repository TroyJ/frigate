#!/bin/bash
# List the github.com repositories a build log shows downloads from, and fail if any
# belongs to someone other than TroyJ. Complements egress-allowlist.sh, which can only
# allow github.com as a whole host. Covers the URLs a build prints (scripts run with
# `set -x`, wget -nv, pip's "Collecting ... @ URL"); a quiet download is not seen
# here, so the scripts in docker/ print theirs.
#
#   .github/scripts/github-owners.sh build.log [more.log ...]
set -euo pipefail

# Download-shaped URLs only (release files, archives, raw files, git clones); links in
# messages, such as npm's "Changelog: .../releases/tag/...", are not downloads.
owners="$(cat "$@" | grep -oE 'https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+(/releases/download/|/archive/|/raw/|\.git)' |
  grep -oE 'https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+' | sed 's/\.git$//' | sort | uniq -c | sort -rn || true)"
echo "github.com repositories downloaded from, per the log (count, repository):"
echo "${owners:-  none}"
others="$(echo "$owners" | awk '{print $2}' | grep -v '^https://github\.com/TroyJ/' | grep -v '^$' || true)"
if [[ -n "$others" ]]; then
  echo "FAIL: downloads from repositories that are not TroyJ's:"
  echo "$others"
  exit 1
fi
echo "all TroyJ"
