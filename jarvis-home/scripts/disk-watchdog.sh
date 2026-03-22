#!/bin/bash
# Disk usage watchdog — alerts via Telegram when filesystems exceed thresholds.
# Intended to run via cron every 6 hours.
# Logs to ~/jarvis/logs/disk-watchdog.log

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_DIR="$HOME/jarvis/logs"
LOG_FILE="$LOG_DIR/disk-watchdog.log"
WARN_THRESHOLD=85
CRIT_THRESHOLD=95

mkdir -p "$LOG_DIR"

TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')
ALERTS=""

while read -r line; do
    USAGE=$(echo "$line" | awk '{print $5}' | tr -d '%')
    MOUNT=$(echo "$line" | awk '{print $6}')
    SIZE=$(echo "$line" | awk '{print $2}')
    AVAIL=$(echo "$line" | awk '{print $4}')

    if [ -z "$USAGE" ] || [ "$USAGE" = "Use%" ]; then
        continue
    fi

    if [ "$USAGE" -ge "$CRIT_THRESHOLD" ]; then
        ALERTS="${ALERTS}\n🔴 CRITICAL: ${MOUNT} at ${USAGE}% (${AVAIL} free of ${SIZE})"
    elif [ "$USAGE" -ge "$WARN_THRESHOLD" ]; then
        ALERTS="${ALERTS}\n🟡 WARNING: ${MOUNT} at ${USAGE}% (${AVAIL} free of ${SIZE})"
    fi
done < <(df -h --output=source,size,used,avail,pcent,target -x tmpfs -x devtmpfs -x squashfs 2>/dev/null | tail -n +2)

echo "[$TIMESTAMP] Disk check complete." >> "$LOG_FILE"

if [ -n "$ALERTS" ]; then
    MESSAGE="<b>Jarvis Disk Alert</b>\n<i>${TIMESTAMP}</i>\n${ALERTS}"
    echo "[$TIMESTAMP] Alerts found:$ALERTS" >> "$LOG_FILE"
    "$SCRIPT_DIR/notify.sh" "$(echo -e "$MESSAGE")" "disk-watchdog"
else
    echo "[$TIMESTAMP] All filesystems OK (below ${WARN_THRESHOLD}%)." >> "$LOG_FILE"
fi
