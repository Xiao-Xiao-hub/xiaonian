#!/usr/bin/env bash
set -euo pipefail
TASK_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NATIVE=1
export TZ="${TZ:-Asia/Shanghai}"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --skip-native) NATIVE=0; shift ;;
    --timezone)
      [ "$#" -ge 2 ] || { echo "check: --timezone requires a value" >&2; exit 2; }
      export TZ="$2"; shift 2 ;;
    *) echo "check: unknown option $1" >&2; exit 2 ;;
  esac
done
case "$TZ" in
  Asia/Shanghai|America/New_York) ;;
  *) echo "check: use --timezone Asia/Shanghai or America/New_York" >&2; exit 2 ;;
esac
# Windows has python, and a python3 that only opens the Store.
PYTHON=python3
python3 -c "" 2>/dev/null || PYTHON=python
echo "check: timezone $TZ; test files run one at a time"
cd "$TASK_ROOT/server"
npm run typecheck
npm run build
node --test --test-concurrency=1 --import tsx ../tests/*.test.ts
cd "$TASK_ROOT"
node --test --test-concurrency=1 tests/frontend*.test.cjs tests/admin*.test.mjs
if [ "$NATIVE" = 1 ]; then
  bash scripts/compile_miniprogram.sh --required
else
  echo "check: native compilation NOT RUN (--skip-native); a separate required SDK check is needed before release"
fi
"$PYTHON" scripts/verify.py
"$PYTHON" -m unittest discover -s tests -p '*_test.py'
if [ "$NATIVE" = 1 ]; then
  echo "check: all stages passed (including native compilation)"
else
  echo "check: source and behavior stages passed; native compilation NOT VERIFIED"
fi
