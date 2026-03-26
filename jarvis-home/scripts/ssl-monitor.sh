#!/bin/bash
# SSL certificate monitor — alerts on expiring certificates.
# Checks configured endpoints and auto-discovers local SSL.
# Runs via cron daily at 07:00.
# Logs to ~/jarvis/logs/ssl-monitor.log

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_DIR="$HOME/jarvis/logs"
LOG_FILE="$LOG_DIR/ssl-monitor.log"
ENDPOINTS_FILE="$HOME/jarvis/ssl-endpoints.txt"

mkdir -p "$LOG_DIR"

TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')
WARN_DAYS=14
CRIT_DAYS=3

ENDPOINTS=""

# Load configured endpoints
if [ -f "$ENDPOINTS_FILE" ]; then
    while IFS= read -r line; do
        line=$(echo "$line" | xargs)
        [[ -z "$line" || "$line" == \#* ]] && continue
        ENDPOINTS="${ENDPOINTS} ${line}"
    done < "$ENDPOINTS_FILE"
fi

# Auto-discover local SSL on common ports
for PORT in 443 8443; do
    if ss -tlnp | grep -q ":${PORT} " 2>/dev/null; then
        ENDPOINTS="${ENDPOINTS} localhost:${PORT}"
    fi
done

ENDPOINTS=$(echo "$ENDPOINTS" | xargs)

if [ -z "$ENDPOINTS" ]; then
    echo "[$TIMESTAMP] No SSL endpoints configured or discovered — nothing to monitor." >> "$LOG_FILE"
    exit 0
fi

ALERTS=""
CHECKED=0

for ENDPOINT in $ENDPOINTS; do
    HOST=$(echo "$ENDPOINT" | cut -d: -f1)
    PORT=$(echo "$ENDPOINT" | cut -d: -f2)
    [ -z "$PORT" ] && PORT=443

    EXPIRY_DATE=$(echo | openssl s_client -servername "$HOST" -connect "${HOST}:${PORT}" 2>/dev/null | openssl x509 -enddate -noout 2>/dev/null | cut -d= -f2)

    if [ -z "$EXPIRY_DATE" ]; then
        echo "[$TIMESTAMP] Could not check ${HOST}:${PORT} — connection or cert error" >> "$LOG_FILE"
        continue
    fi

    CHECKED=$((CHECKED + 1))
    EXPIRY_EPOCH=$(date -d "$EXPIRY_DATE" +%s 2>/dev/null)
    NOW_EPOCH=$(date +%s)
    DAYS_LEFT=$(( (EXPIRY_EPOCH - NOW_EPOCH) / 86400 ))

    echo "[$TIMESTAMP] ${HOST}:${PORT} — expires in ${DAYS_LEFT} days (${EXPIRY_DATE})" >> "$LOG_FILE"

    if [ "$DAYS_LEFT" -le "$CRIT_DAYS" ]; then
        ALERTS="${ALERTS}\n🔴 <b>${HOST}:${PORT}</b> — cert expires in <b>${DAYS_LEFT} days</b> (CRITICAL)"
    elif [ "$DAYS_LEFT" -le "$WARN_DAYS" ]; then
        ALERTS="${ALERTS}\n🟡 <b>${HOST}:${PORT}</b> — cert expires in <b>${DAYS_LEFT} days</b>"
    fi
done

echo "[$TIMESTAMP] Checked $CHECKED endpoint(s)." >> "$LOG_FILE"

if [ -n "$ALERTS" ]; then
    MESSAGE="<b>🔒 SSL Certificate Monitor</b>\n<i>${TIMESTAMP}</i>\n${ALERTS}"
    "$SCRIPT_DIR/notify.sh" "$(echo -e "$MESSAGE")" "ssl-monitor"
fi
