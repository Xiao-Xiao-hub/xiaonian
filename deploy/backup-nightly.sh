#!/usr/bin/env bash
# Nightly full backup of the Docker deployment (D052). Stops the API so the
# database and photos match, copies both out of the app_data volume with
# scripts/backup.py, starts the API again (also when the backup fails) and
# keeps the newest KEEP finished backups.
#
# Run as root from anywhere; set COMPOSE_FILE the same way you start the app:
#   COMPOSE_FILE=compose.yaml:compose.production.example.yaml deploy/backup-nightly.sh /srv/zhiye/backups
# The API is down for the few seconds the copy takes.
set -euo pipefail

DEST=${1:?usage: deploy/backup-nightly.sh <backup directory>}
KEEP=${KEEP:-14}
[ "$(id -u)" = 0 ] || { echo "run as root: backups hold users' photos and are root-only" >&2; exit 1; }
cd "$(dirname "$0")/.."

mkdir -p "$DEST"
chmod 700 "$DEST"
DEST=$(cd "$DEST" && pwd)
stamp=$(date +%Y-%m-%d-%H%M%S)
# A leftover old container could be listed too; any of them mounts the same volume.
container=$(docker compose ps -aq api | head -n 1)
[ -n "$container" ] || { echo "no api container; start the app first" >&2; exit 1; }

docker compose stop api
trap 'docker compose start api' EXIT
docker run --rm --network none --volumes-from "$container" \
  -v "$DEST:/backups" -v "$PWD/scripts:/scripts:ro" python:3.12-slim \
  python3 /scripts/backup.py backup-bundle --source /app/data/app.sqlite \
  --uploads /app/data/uploads --target "/backups/$stamp" --stopped
trap - EXIT
docker compose start api
echo "backup written: $DEST/$stamp"

# Only finished backups (with bundle.manifest.json) named by this script count;
# a failed attempt is left in place for inspection and never deleted here.
mapfile -t done_backups < <(
  find "$DEST" -mindepth 1 -maxdepth 1 -type d -regextype posix-extended \
    -regex '.*/[0-9]{4}-[0-9]{2}-[0-9]{2}-[0-9]{6}' \
    -exec test -f '{}/bundle.manifest.json' ';' -print | sort
)
excess=$(( ${#done_backups[@]} - KEEP ))
for (( i = 0; i < excess; i++ )); do
  rm -rf -- "${done_backups[$i]}"
  echo "old backup removed: ${done_backups[$i]}"
done
