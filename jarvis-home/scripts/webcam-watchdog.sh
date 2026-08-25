#!/bin/bash
# Self-heal the USB webcam stream.
#
# This cheap Jieli cam (1224:2a25) periodically re-enumerates on the USB bus.
# When it does, ustreamer (running with --persistent) can hold a stale device
# handle and serve empty frames ("NO SIGNAL") until it is restarted. A restart
# always recovers it, so this watchdog checks the local snapshot and bounces the
# service when it comes back empty. Meant to run from cron every minute.

set -uo pipefail

SNAP_URL="${WEBCAM_SNAPSHOT_URL:-http://127.0.0.1:20011/snapshot}"
SERVICE="jarvis-ustreamer.service"
LOG="${HOME}/jarvis/logs/webcam-watchdog.log"
MIN_BYTES=1000

# systemctl --user needs the user session bus when invoked from cron.
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"

mkdir -p "$(dirname "$LOG")"

# Returns the byte size of a fresh snapshot, or 0 on any failure.
grab_size() {
  local tmp size
  tmp="$(mktemp)"
  if curl -s --max-time 6 -o "$tmp" "$SNAP_URL" 2>/dev/null; then
    size=$(stat -c '%s' "$tmp" 2>/dev/null || echo 0)
  else
    size=0
  fi
  rm -f "$tmp"
  echo "${size:-0}"
}

# Two strikes to avoid restarting during a normal brief re-enumeration window.
first=$(grab_size)
if [ "$first" -ge "$MIN_BYTES" ]; then
  exit 0
fi
sleep 3
second=$(grab_size)
if [ "$second" -ge "$MIN_BYTES" ]; then
  exit 0
fi

echo "$(date '+%Y-%m-%d %H:%M:%S') empty snapshot (${first}B, ${second}B) — restarting ${SERVICE}" >> "$LOG"
systemctl --user restart "$SERVICE"
sleep 4
after=$(grab_size)
echo "$(date '+%Y-%m-%d %H:%M:%S') after restart: ${after}B" >> "$LOG"

# Keep the log from growing unbounded.
if [ -f "$LOG" ]; then
  tail -n 500 "$LOG" > "${LOG}.tmp" 2>/dev/null && mv "${LOG}.tmp" "$LOG"
fi
