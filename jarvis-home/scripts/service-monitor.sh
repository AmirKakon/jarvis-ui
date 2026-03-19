#!/bin/bash
# Service and Docker monitor — alerts on failed services and unhealthy/exited containers.
# Intended to run via cron every 15 minutes.
# Logs to ~/jarvis/logs/service-monitor.log

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_DIR="$HOME/jarvis/logs"
LOG_FILE="$LOG_DIR/service-monitor.log"

mkdir -p "$LOG_DIR"

# Cron doesn't have the user session env vars needed by systemctl --user
export XDG_RUNTIME_DIR="/run/user/$(id -u)"
export DBUS_SESSION_BUS_ADDRESS="unix:path=${XDG_RUNTIME_DIR}/bus"

TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')
ALERTS=""

# --- Check systemd services ---
SYSTEM_SERVICES="docker smbd nginx"
for SVC in $SYSTEM_SERVICES; do
    if ! systemctl is-active --quiet "$SVC" 2>/dev/null; then
        ALERTS="${ALERTS}\n🔴 System service <b>${SVC}</b> is not running"
    fi
done

# --- Check user-level systemd services ---
USER_SERVICES="jarvis-telegram-bot"
for SVC in $USER_SERVICES; do
    if ! systemctl --user is-active --quiet "$SVC" 2>/dev/null; then
        ALERTS="${ALERTS}\n🔴 User service <b>${SVC}</b> is not running"
    fi
done

# --- Check port-based services (not managed by systemd) ---
# Format: "name|port|check_method" (http = curl, tcp = port open check)
PORT_SERVICES="n8n|20003|http PostgreSQL|20004|tcp Jarvis-Backend|20005|http Jarvis-Frontend|20006|http"
for ENTRY in $PORT_SERVICES; do
    NAME=$(echo "$ENTRY" | cut -d'|' -f1)
    PORT=$(echo "$ENTRY" | cut -d'|' -f2)
    METHOD=$(echo "$ENTRY" | cut -d'|' -f3)

    if [ "$METHOD" = "http" ]; then
        if ! curl -s --max-time 5 "http://localhost:${PORT}" > /dev/null 2>&1; then
            ALERTS="${ALERTS}\n🔴 <b>${NAME}</b> (port ${PORT}) is not responding"
        fi
    else
        if ! ss -tlnp | grep -q ":${PORT} " 2>/dev/null; then
            ALERTS="${ALERTS}\n🔴 <b>${NAME}</b> (port ${PORT}) is not listening"
        fi
    fi
done

# --- Check Docker containers ---
EXITED=$(docker ps -a --filter "status=exited" --format "{{.Names}} (exited {{.Status}})" 2>/dev/null)
if [ -n "$EXITED" ]; then
    while IFS= read -r CONTAINER; do
        ALERTS="${ALERTS}\n🟡 Container: ${CONTAINER}"
    done <<< "$EXITED"
fi

UNHEALTHY=$(docker ps --filter "health=unhealthy" --format "{{.Names}}" 2>/dev/null)
if [ -n "$UNHEALTHY" ]; then
    while IFS= read -r CONTAINER; do
        ALERTS="${ALERTS}\n🔴 Unhealthy container: <b>${CONTAINER}</b>"
    done <<< "$UNHEALTHY"
fi

# --- Auto-restart known-safe containers ---
SAFE_RESTART="jarvis-backend jarvis-frontend"
for CONTAINER in $SAFE_RESTART; do
    STATUS=$(docker inspect --format '{{.State.Status}}' "$CONTAINER" 2>/dev/null)
    if [ "$STATUS" = "exited" ]; then
        docker restart "$CONTAINER" > /dev/null 2>&1
        ALERTS="${ALERTS}\n🔄 Auto-restarted <b>${CONTAINER}</b>"
        echo "[$TIMESTAMP] Auto-restarted $CONTAINER" >> "$LOG_FILE"
    fi
done

echo "[$TIMESTAMP] Service check complete." >> "$LOG_FILE"

if [ -n "$ALERTS" ]; then
    MESSAGE="<b>Jarvis Service Alert</b>\n<i>${TIMESTAMP}</i>\n${ALERTS}"
    echo "[$TIMESTAMP] Alerts found:$ALERTS" >> "$LOG_FILE"
    "$SCRIPT_DIR/notify.sh" "$(echo -e "$MESSAGE")"
else
    echo "[$TIMESTAMP] All services and containers OK." >> "$LOG_FILE"
fi
