#!/bin/bash
# Home Assistant liveness monitoring script.
# Pings the HA host, checks that the web port accepts connections, and probes
# HTTP GET / for a response. Alerts via Telegram when HA goes down (repeat
# alerts rate-limited) and again once it comes back online.
#
# Cron: every 2 minutes

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_FILE="$HOME/jarvis/logs/ha-monitor.log"
STATE_FILE="$HOME/jarvis/state/ha-monitor.state"
TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')
NOW=$(date +%s)

HA_HOST="192.168.68.113"
HA_PORT=8123

# Minimum seconds between repeat "still down" alerts, to avoid spam.
ALERT_COOLDOWN=300

mkdir -p "$(dirname "$LOG_FILE")" "$(dirname "$STATE_FILE")"

log() {
    echo "[$TIMESTAMP] $*" >> "$LOG_FILE"
}

# Render a duration in seconds as "Xm Ys".
fmt_duration() {
    local secs="$1"
    echo "$((secs / 60))m $((secs % 60))s"
}

# --- Previous state: STATUS DOWN_SINCE LAST_ALERT ---
PREV_STATUS="up"
DOWN_SINCE=0
LAST_ALERT=0
if [ -f "$STATE_FILE" ]; then
    read -r PREV_STATUS DOWN_SINCE LAST_ALERT < "$STATE_FILE"
    PREV_STATUS="${PREV_STATUS:-up}"
    DOWN_SINCE="${DOWN_SINCE:-0}"
    LAST_ALERT="${LAST_ALERT:-0}"
fi

# --- Checks ---
failures=()

if ping -c 1 -W 3 "$HA_HOST" > /dev/null 2>&1; then
    PING_RESULT="reachable"
else
    PING_RESULT="no ICMP reply"
fi

if ! nc -z -w 3 "$HA_HOST" "$HA_PORT" > /dev/null 2>&1; then
    failures+=("Port $HA_PORT is not accepting connections")
fi

HTTP_CODE=$(curl -s -o /dev/null -m 8 -w '%{http_code}' "http://$HA_HOST:$HA_PORT/" 2>/dev/null)
if [ -z "$HTTP_CODE" ] || [ "$HTTP_CODE" = "000" ] || [ "$HTTP_CODE" -ge 500 ]; then
    failures+=("HTTP check failed (GET / returned ${HTTP_CODE:-no response})")
fi

# ICMP alone is not treated as an outage — HA responding on HTTP is what counts.
if [ "$PING_RESULT" != "reachable" ] && [ ${#failures[@]} -eq 0 ]; then
    log "NOTE: $HA_HOST gave no ICMP reply but the web service is healthy"
fi

# --- Act on the result ---
if [ ${#failures[@]} -eq 0 ]; then
    log "OK: HA healthy at $HA_HOST:$HA_PORT (ping $PING_RESULT, HTTP $HTTP_CODE)"

    if [ "$PREV_STATUS" = "down" ]; then
        OUTAGE=$((NOW - DOWN_SINCE))
        log "RECOVERY: HA back online after $(fmt_duration "$OUTAGE")"

        MSG="✅ <b>Home Assistant Back Online</b>

$HA_HOST:$HA_PORT is responding again (HTTP $HTTP_CODE).
Downtime: $(fmt_duration "$OUTAGE")"

        bash "$SCRIPT_DIR/notify.sh" "$MSG" "ha-monitor"
    fi

    echo "up 0 0" > "$STATE_FILE"
    exit 0
fi

# Down: record the start of the outage on the first failing run.
if [ "$PREV_STATUS" != "down" ]; then
    DOWN_SINCE=$NOW
    LAST_ALERT=0
fi
OUTAGE=$((NOW - DOWN_SINCE))

log "ALERT: HA unhealthy at $HA_HOST:$HA_PORT (down $(fmt_duration "$OUTAGE")) — $(printf '%s; ' "${failures[@]}")"

if [ $((NOW - LAST_ALERT)) -ge $ALERT_COOLDOWN ]; then
    MSG="🔴 <b>Home Assistant Alert</b>

$(printf '• %s\n' "${failures[@]}")
• Ping: $PING_RESULT

Host: <code>$HA_HOST:$HA_PORT</code>
Down for: $(fmt_duration "$OUTAGE")"

    bash "$SCRIPT_DIR/notify.sh" "$MSG" "ha-monitor"
    LAST_ALERT=$NOW
fi

echo "down $DOWN_SINCE $LAST_ALERT" > "$STATE_FILE"
