#!/bin/bash
# Grab a still from ustreamer and send it to Telegram.
# Usage: webcam-snapshot.sh [caption]
# Does NOT use notify.sh (that script has a 1-hour identical-message cooldown).

set -euo pipefail

JARVIS_ENV="${HOME}/jarvis/.env"
SNAP_DIR="${HOME}/jarvis/webcam"
WEBCAM_SNAPSHOT_URL="${WEBCAM_SNAPSHOT_URL:-${GO2RTC_URL:-http://127.0.0.1:20011/snapshot}}"
CAPTION="${1:-Mini-PC webcam}"

if [ ! -f "$JARVIS_ENV" ]; then
  echo "Error: $JARVIS_ENV not found" >&2
  exit 1
fi
# shellcheck disable=SC1090
source "$JARVIS_ENV"

if [ -z "${TG_BOT_TOKEN:-}" ] || [ -z "${TG_CHAT_ID:-}" ]; then
  echo "Error: TG_BOT_TOKEN or TG_CHAT_ID not set" >&2
  exit 1
fi

mkdir -p "$SNAP_DIR"
STAMP=$(date +%Y%m%d-%H%M%S)
FILE="${SNAP_DIR}/webcam-${STAMP}.jpg"

if ! curl -sf --max-time 8 -o "$FILE" "$WEBCAM_SNAPSHOT_URL"; then
  echo "Error: failed to fetch snapshot from $WEBCAM_SNAPSHOT_URL" >&2
  exit 1
fi

if [ ! -s "$FILE" ]; then
  echo "Error: snapshot is empty" >&2
  rm -f "$FILE"
  exit 1
fi

curl -sf -X POST "https://api.telegram.org/bot${TG_BOT_TOKEN}/sendPhoto" \
  -F "chat_id=${TG_CHAT_ID}" \
  -F "photo=@${FILE}" \
  -F "caption=${CAPTION}" \
  >/dev/null

# Keep the last 40 stills
ls -1t "$SNAP_DIR"/webcam-*.jpg 2>/dev/null | tail -n +41 | xargs -r rm -f

echo "Sent $FILE"
