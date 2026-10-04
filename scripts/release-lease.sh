#!/usr/bin/env bash
# release-lease.sh — the one-wheel lock (human-approved 2026-09-30).
# Acquire BEFORE cutting/attempting a release tag; release AFTER the push lands.
# Advisory flock (cooperative seats), plus the pre-push hook enforces the record.
#   scripts/release-lease.sh acquire <version> <who>
#   scripts/release-lease.sh status
#   scripts/release-lease.sh release
set -u -o pipefail
LEASE_FILE="${SIBYL_RELEASE_LEASE:-$HOME/.config/sibyl/release-lease.json}"
LOCK_FILE="$LEASE_FILE.lock"
cmd="${1:-status}"
mkdir -p "$(dirname "$LEASE_FILE")"
case "$cmd" in
  acquire)
    ver="${2:?usage: acquire <version> <who>}"; who="${3:?usage: acquire <version> <who>}"
    (
      flock -n 9 || { echo "release-lease: LOCK BUSY — another seat holds the wheel"; exit 1; }
      if [ -f "$LEASE_FILE" ]; then
        echo "release-lease: refused, existing lease:"; cat "$LEASE_FILE"; exit 1
      fi
      printf '{"version":"%s","who":"%s","acquired":"%s"}\n' "$ver" "$who" "$(date -u +%FT%TZ)" > "$LEASE_FILE"
      echo "release-lease: acquired $ver by $who @ $(date -u +%FT%TZ)"
    ) 9>"$LOCK_FILE"
    ;;
  status)
    if [ -f "$LEASE_FILE" ]; then cat "$LEASE_FILE"; else echo "release-lease: free"; fi
    ;;
  release)
    (
      flock -n 9 || { echo "release-lease: LOCK BUSY"; exit 1; }
      rm -f "$LEASE_FILE" && echo "release-lease: released @ $(date -u +%FT%TZ)"
    ) 9>"$LOCK_FILE"
    ;;
  *) echo "usage: release-lease.sh acquire|status|release [version] [who]"; exit 2 ;;
esac
