#!/usr/bin/env bash
# Compile the Triage executable (src/index.triage.ts) for macOS.
#   scripts/build-triage.sh <outdir> [--check]
# Prints the sha256 of each output. --check builds twice and fails when the
# two outputs differ. TRAUL_BUILD_TARGETS ("bun-target:outfile ...") overrides
# the default targets, e.g. CI uses "bun-linux-x64:traul-linux-x64".
set -euo pipefail

OUT=""
CHECK=0
for arg in "$@"; do
  case "$arg" in
    --check) CHECK=1 ;;
    -*) echo "unknown option: $arg" >&2; exit 2 ;;
    *) OUT="$arg" ;;
  esac
done
[ -n "$OUT" ] || { echo "usage: $0 <outdir> [--check]" >&2; exit 2; }

cd "$(dirname "$0")/.."
TARGETS="${TRAUL_BUILD_TARGETS:-bun-darwin-arm64:traul-arm64 bun-darwin-x64:traul-x86_64}"

sha() { if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }

build_all() {
  local dir="$1" pair
  mkdir -p "$dir"
  for pair in $TARGETS; do
    bun build --compile --external node-llama-cpp "--target=${pair%%:*}" \
      src/index.triage.ts --outfile "$dir/${pair#*:}"
  done
}

bun install --frozen-lockfile
build_all "$OUT"
for pair in $TARGETS; do echo "$(sha "$OUT/${pair#*:}")  ${pair#*:}"; done

if [ "$CHECK" = 1 ]; then
  # Same output file names: the name is part of the compiled bytes.
  SECOND="$(mktemp -d)"
  trap 'rm -rf "$SECOND"' EXIT
  build_all "$SECOND"
  for pair in $TARGETS; do
    f="${pair#*:}"
    [ "$(sha "$OUT/$f")" = "$(sha "$SECOND/$f")" ] || { echo "not reproducible: $f" >&2; exit 1; }
  done
  echo "reproducible: ok"
fi
