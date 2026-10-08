#!/bin/bash
# Self-heal the USB webcam stream.
#
# ustreamer can wedge on a stale device handle after a USB re-enumeration and
# serve its built-in "NO SIGNAL" placeholder (a valid ~13.8KB JPEG — so byte
# size is NOT a reliable health signal). The authoritative signal is ustreamer's
# /state API: result.source.online. When it reports offline, a service restart
# reopens the device and recovers the feed. Meant to run from cron every minute.

set -uo pipefail

STATE_URL="${WEBCAM_STATE_URL:-http://127.0.0.1:20011/state}"
SERVICE="jarvis-ustreamer.service"
LOG="${HOME}/jarvis/logs/webcam-watchdog.log"

# systemctl --user needs the user session bus when invoked from cron.
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"

mkdir -p "$(dirname "$LOG")"

# Returns "online", "offline", or "unreachable".
probe() {
  local body
  body="$(curl -s --max-time 6 "$STATE_URL" 2>/dev/null)" || { echo unreachable; return; }
  [ -z "$body" ] && { echo unreachable; return; }
  if printf '%s' "$body" | grep -q '"online"[[:space:]]*:[[:space:]]*true'; then
    echo online
  else
    echo offline
  fi
}

# Two strikes to avoid restarting during a normal brief re-open window.
first="$(probe)"
[ "$first" = "online" ] && exit 0
sleep 5
second="$(probe)"
[ "$second" = "online" ] && exit 0

echo "$(date '+%Y-%m-%d %H:%M:%S') source not online (${first}, ${second}) — restarting ${SERVICE}" >> "$LOG"
systemctl --user restart "$SERVICE"
sleep 6
echo "$(date '+%Y-%m-%d %H:%M:%S') after restart: $(probe)" >> "$LOG"

# Keep the log from growing unbounded.
if [ -f "$LOG" ]; then
  tail -n 500 "$LOG" > "${LOG}.tmp" 2>/dev/null && mv "${LOG}.tmp" "$LOG"
fi
