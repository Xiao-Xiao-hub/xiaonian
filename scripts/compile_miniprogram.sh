#!/usr/bin/env bash
# WCC_DIR must identify an installed WeChat SDK. --required remains an explicit
# release-check alias; missing compilers always fail.
# wcc exits 0 even on errors, so any output from it counts as a failure.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)/miniprogram"
case "${1:-}" in
  --required) shift ;;
  "") ;;
  *) echo "compile: unknown option $1" >&2; exit 2 ;;
esac
[ "$#" -eq 0 ] || { echo "compile: unexpected arguments" >&2; exit 2; }
WCC_DIR="${WCC_DIR:-}"
if [ -z "$WCC_DIR" ]; then
  echo "compile: native compilation NOT VERIFIED; WCC_DIR is required and must identify the installed WeChat SDK compiler directory" >&2
  exit 1
fi
if [ ! -x "$WCC_DIR/wcc" ] || [ ! -x "$WCC_DIR/wcsc" ]; then
  echo "compile: native compilation NOT VERIFIED; set WCC_DIR to the WeChat SDK compiler directory" >&2
  exit 1
fi
OUT="$(mktemp -d)"
trap 'rm -rf "$OUT"' EXIT
cd "$ROOT"
failed=0 wxml=0 wxss=0
wxs=()
while IFS= read -r file; do wxs+=("$file"); done < <(find . -name '*.wxs' | sort)
while IFS= read -r file; do
  wxml=$((wxml + 1))
  if ! "$WCC_DIR/wcc" -d -o "$OUT/out.js" "./$file" "${wxs[@]}" >"$OUT/log" 2>&1 || [ -s "$OUT/log" ]; then
    echo "compile: $file"; head -c 400 "$OUT/log"; echo; failed=1
  fi
done < <(find pages components -name '*.wxml' | sort)
styles=()
while IFS= read -r file; do styles+=("$file"); done < <(find . -name '*.wxss' | sort)
while IFS= read -r file; do
  wxss=$((wxss + 1))
  dependencies=()
  for style in "${styles[@]}"; do [ "$style" = "$file" ] || dependencies+=("$style"); done
  if ! "$WCC_DIR/wcsc" -d -o "$OUT/out.css" "$file" "${dependencies[@]}" >"$OUT/log" 2>&1 || [ -s "$OUT/log" ]; then
    echo "compile: $file"; head -c 400 "$OUT/log"; echo; failed=1
  fi
done < <(find . -name '*.wxss' | sort)
if [ "$wxml" -eq 0 ] || [ "$wxss" -eq 0 ]; then
  echo "compile: no WXML or WXSS source files found" >&2
  failed=1
fi
[ "$failed" = 0 ] && echo "compile: $wxml WXML and $wxss WXSS files compiled"
exit "$failed"
