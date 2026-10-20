#!/usr/bin/env bash
# Local development server on synthetic data (Linux/macOS twin of dev-local.ps1).
# Binds 127.0.0.1:8788 with development login, never loads server/.env and
# never inherits model, WeChat or admin credentials from the shell.
#   bash scripts/dev-local.sh [--data-dir DIR] [--port N] [--no-watch] [--admin-preview]
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DATA_DIR="$ROOT/server/data/local-synthetic"
PORT=8788
WATCH=1
ADMIN_PREVIEW=0
while [ $# -gt 0 ]; do
  case "$1" in
    --data-dir) DATA_DIR="$(realpath -m "$2")"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --no-watch) WATCH=0; shift ;;
    --admin-preview) ADMIN_PREVIEW=1; shift ;;
    *) echo "dev-local: unknown option $1" >&2; exit 2 ;;
  esac
done
fail() { echo "dev-local: $*" >&2; exit 1; }
[[ "$PORT" =~ ^[0-9]+$ ]] && [ "$PORT" -ge 1 ] && [ "$PORT" -le 65535 ] || fail "invalid port $PORT"
node -e 'process.exit(parseInt(process.versions.node, 10) < 24 ? 1 : 0)' || fail "Node.js 24 or newer is required."

# An existing unmarked directory may hold real data: never adopt it, never delete.
MARKER="$DATA_DIR/.zhiye-local-synthetic"
[ -L "$DATA_DIR" ] && fail "the synthetic data path must not be a symlink."
if [ -e "$DATA_DIR" ]; then
  [ -d "$DATA_DIR" ] || fail "the synthetic data path must be a directory."
  [ -z "$(find "$DATA_DIR" -type l -print -quit)" ] || fail "refusing a symlink inside the synthetic data directory."
  if [ ! -f "$MARKER" ] && [ -n "$(ls -A "$DATA_DIR")" ]; then
    fail "refusing an existing nonempty directory without the synthetic-data marker. Choose a new directory."
  fi
else
  mkdir -p "$(dirname "$DATA_DIR")" && mkdir -m 700 "$DATA_DIR"
fi
[ -f "$MARKER" ] || printf 'Local synthetic development data only.\n' > "$MARKER"

EXTRA=()
if [ "$ADMIN_PREVIEW" = 1 ]; then
  # A new random key for this loopback synthetic instance only; rotates each start.
  KEY_FILE="$DATA_DIR/admin-preview.key"
  [ -L "$KEY_FILE" ] && fail "refusing a symlinked preview key path."
  (umask 077 && openssl rand -hex 32 > "$KEY_FILE")
  EXTRA+=("ADMIN_API_KEY=$(cat "$KEY_FILE")" "ADMIN_ORIGIN=http://127.0.0.1:$PORT")
fi

echo "dev-local: http://127.0.0.1:$PORT (synthetic data, development login)"
echo "dev-local: $DATA_DIR"
if [ "$ADMIN_PREVIEW" = 1 ]; then
  echo "dev-local: admin preview http://127.0.0.1:$PORT/admin/"
  echo "dev-local: disposable access key is in $KEY_FILE"
fi
NODE_ARGS=(--import tsx src/index.ts)
[ "$WATCH" = 1 ] && NODE_ARGS=(--watch "${NODE_ARGS[@]}")
cd "$ROOT/server"
# Bypasses npm run dev, which adds --env-file-if-exists=.env.
exec env \
  -u NODE_OPTIONS -u ADMIN_API_KEY -u ADMIN_ORIGIN -u TRUST_PROXY \
  -u WECHAT_APP_ID -u WECHAT_APP_SECRET \
  -u LLM_BASE_URL -u LLM_API_KEY -u LLM_MODEL -u LLM_EXTRA_BODY \
  -u JEV_API_KEY -u TENCENT_SECRET_ID -u TENCENT_SECRET_KEY -u OCR_VISION_MODEL \
  NODE_ENV=development HOST=127.0.0.1 PORT="$PORT" DEV_LOGIN_ENABLED=true \
  DATABASE_PATH="$DATA_DIR/app.sqlite" UPLOAD_DIR="$DATA_DIR/uploads" \
  FORMULA_DIR="$DATA_DIR/formulas" LOG_LEVEL=info \
  "${EXTRA[@]}" node "${NODE_ARGS[@]}"
