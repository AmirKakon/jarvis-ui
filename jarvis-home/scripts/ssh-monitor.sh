#!/bin/bash
# SSH intrusion monitor — detects brute force login attempts.
# Parses auth.log for failed SSH logins in the last hour.
# Runs via cron every hour.
# Logs to ~/jarvis/logs/ssh-monitor.log

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_DIR="$HOME/jarvis/logs"
LOG_FILE="$LOG_DIR/ssh-monitor.log"

mkdir -p "$LOG_DIR"

TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')
THRESHOLD=${SSH_ALERT_THRESHOLD:-10}

get_failed_logins() {
    if [ -f /var/log/auth.log ]; then
        # Get entries from the last 65 minutes to account for cron drift
        local since
        since=$(date -d '65 minutes ago' '+%b %e %H:%M' 2>/dev/null || date -d '65 minutes ago' '+%h %e %H:%M' 2>/dev/null)
        if [ -n "$since" ]; then
            awk -v since="$since" '$0 >= since' /var/log/auth.log 2>/dev/null | grep -i "failed password\|authentication failure" || true
        else
            # Fallback: last 200 lines
            tail -200 /var/log/auth.log 2>/dev/null | grep -i "failed password\|authentication failure" || true
        fi
    elif command -v journalctl &>/dev/null; then
        journalctl -u ssh -u sshd --since "1 hour ago" --no-pager 2>/dev/null | grep -i "failed password\|authentication failure" || true
    else
        echo ""
    fi
}

get_successful_logins() {
    if [ -f /var/log/auth.log ]; then
        local since
        since=$(date -d '65 minutes ago' '+%b %e %H:%M' 2>/dev/null)
        if [ -n "$since" ]; then
            awk -v since="$since" '$0 >= since' /var/log/auth.log 2>/dev/null | grep "Accepted " || true
        else
            tail -200 /var/log/auth.log 2>/dev/null | grep "Accepted " || true
        fi
    elif command -v journalctl &>/dev/null; then
        journalctl -u ssh -u sshd --since "1 hour ago" --no-pager 2>/dev/null | grep "Accepted " || true
    fi
}

FAILED=$(get_failed_logins)
FAIL_COUNT=0
TOP_IPS=""

if [ -n "$FAILED" ]; then
    FAIL_COUNT=$(echo "$FAILED" | wc -l)
    TOP_IPS=$(echo "$FAILED" | grep -oP 'from \K[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+' | sort | uniq -c | sort -rn | head -5)
fi

SUCCESS=$(get_successful_logins)
SUCCESS_COUNT=0
if [ -n "$SUCCESS" ]; then
    SUCCESS_COUNT=$(echo "$SUCCESS" | wc -l)
fi

echo "[$TIMESTAMP] Failed: $FAIL_COUNT, Successful: $SUCCESS_COUNT (threshold: $THRESHOLD)" >> "$LOG_FILE"

ALERTS=""

if [ "$FAIL_COUNT" -ge "$THRESHOLD" ]; then
    ALERTS="${ALERTS}\n🔴 <b>${FAIL_COUNT}</b> failed SSH login attempts in the last hour"
    if [ -n "$TOP_IPS" ]; then
        ALERTS="${ALERTS}\n\n<b>Top source IPs:</b>"
        while IFS= read -r line; do
            COUNT=$(echo "$line" | awk '{print $1}')
            IP=$(echo "$line" | awk '{print $2}')
            ALERTS="${ALERTS}\n  • <code>${IP}</code> — ${COUNT} attempts"
        done <<< "$TOP_IPS"
    fi
fi

if [ "$SUCCESS_COUNT" -gt 0 ]; then
    SUCCESS_DETAILS=$(echo "$SUCCESS" | grep -oP 'for \K\w+.*from [0-9.]+' | sort -u)
    ALERTS="${ALERTS}\n\n🟢 <b>${SUCCESS_COUNT}</b> successful SSH login(s):"
    while IFS= read -r line; do
        ALERTS="${ALERTS}\n  • ${line}"
    done <<< "$SUCCESS_DETAILS"
fi

if [ -n "$ALERTS" ]; then
    MESSAGE="<b>🔐 SSH Monitor</b>\n<i>${TIMESTAMP}</i>\n${ALERTS}"
    echo "[$TIMESTAMP] Alerts:$ALERTS" >> "$LOG_FILE"
    "$SCRIPT_DIR/notify.sh" "$(echo -e "$MESSAGE")" "ssh-monitor"
fi
