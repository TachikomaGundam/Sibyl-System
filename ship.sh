#!/bin/sh
# Sibyl-System release gate. Green = the package is shippable. Offline only:
# no network, no LLM, no writes outside a throwaway temp dir.
#
# Gates, in order (all must pass):
#   1 typecheck   tsc --noEmit (strict)
#   2 unit tests  node --test, fully offline
#   3 build       esbuild -> dist/index.js + dist/cli.js
#   4 smoke       offline exercise of the built entry (tool surface, DISABLED
#                 path, state seam) - smoke/run-smoke.mjs
#   5 pack        npm pack tarball: surface allowlist + portability scan
#
# Gate 5 enforces the standing release principle (operator, 2026-10-01):
# portable packages must NOT pin device-side model authorizations. No vendor
# model id may appear on ANY shipped surface; operator machines carry their
# own config (modelPool / modelPolicy / --model). The scan runs against the
# extracted tarball, not the source tree, so the gate judges exactly what an
# install would receive.

set -eu

cd "$(dirname "$0")"
ROOT=$(pwd)

say() { printf '==> %s\n' "$*"; }
die() { printf 'SHIP FAIL: %s\n' "$*" >&2; exit 1; }

say "1/5 typecheck"
npm run --silent typecheck

say "2/5 unit tests"
npm test >/tmp/sibyl-ship-tests.$$ 2>&1 || { tail -40 /tmp/sibyl-ship-tests.$$; rm -f /tmp/sibyl-ship-tests.$$; die "unit tests red"; }
FAILED=$(grep -E '^# fail [0-9]+' /tmp/sibyl-ship-tests.$$ | awk '{print $3}')
PASSED=$(grep -E '^# pass [0-9]+' /tmp/sibyl-ship-tests.$$ | awk '{print $3}')
rm -f /tmp/sibyl-ship-tests.$$
[ "${FAILED:-x}" = "0" ] || die "unit tests: # fail=$FAILED (expected 0)"
say "   unit tests green: pass=$PASSED fail=0"

say "3/5 build"
npm run --silent build
[ -f dist/index.js ] && [ -f dist/cli.js ] || die "build produced no dist/index.js + dist/cli.js"

say "4/5 smoke (built surface, offline)"
node smoke/run-smoke.mjs || die "smoke red"

say "5/5 pack: surface allowlist + portability scan"
WORK=$(mktemp -d "${TMPDIR:-/tmp}/sibyl-ship-XXXXXX")
trap 'rm -rf "$WORK"' EXIT

npm pack --pack-destination "$WORK" >/dev/null
TARBALL=$(ls "$WORK"/*.tgz | head -n 1)
[ -n "$TARBALL" ] || die "npm pack produced no tarball"

tar -xzf "$TARBALL" -C "$WORK"
PKG="$WORK/package"
[ -d "$PKG" ] || die "unexpected tarball layout (no package/ root)"

# 5a. shipped surface allowlist: only dist/, README.md, LICENSE, package.json.
ALLOWED='^package/(dist/[^/]*|README\.md|LICENSE|package\.json)$'
UNEXPECTED=$(tar -tzf "$TARBALL" | grep -Ev "$ALLOWED" || true)
[ -z "$UNEXPECTED" ] || die "packed surface contains unexpected files: $(echo "$UNEXPECTED" | tr '\n' ' ')"

# 5b. portability scan (closed pattern list of device/vendor model ids).
# Case-insensitive; "-" in glm- keeps generic prose out, add families as
# devices accrue. The sentinel defaults (empty providerID/modelID) and the
# generic "local-" prefix pattern are NOT pins and stay legal.
PINS='qwen|qwq|deepseek|glm-|kimi|doubao|hunyuan'
HITS=$(grep -rniE "$PINS" "$PKG" 2>/dev/null || true)
if [ -n "$HITS" ]; then
  printf '%s\n' "$HITS" >&2
  die "device-side model authorization found on a shipped surface (see hits above); de-pin into operator-local config, keep the capability configurable"
fi

# 5c. default config surface carries no concrete model id: the shipped
# options schema must only ever yield empty sentinels / slot names.
grep -q 'providerID: ""' "$PKG/dist/index.js" || die "modelPool empty-sentinel default missing from built bundle (defaults may have been replaced by a concrete model)"

say "SHIP PASS"
