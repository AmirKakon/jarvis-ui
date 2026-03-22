#!/bin/bash
# Backup freshness checker — alerts if HA backups are stale.
# Intended to run via cron once daily.
# Logs to ~/jarvis/logs/backup-checker.log

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_DIR="$HOME/jarvis/logs"
LOG_FILE="$LOG_DIR/backup-checker.log"
HA_BACKUP_DIR="$HOME/shared-storage-2/ha-backups"
MAX_AGE_DAYS=7

mkdir -p "$LOG_DIR"

TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')
ALERTS=""

# Check HA backups
if [ -d "$HA_BACKUP_DIR" ]; then
    NEWEST=$(find "$HA_BACKUP_DIR" -maxdepth 1 -type f -name "*.tar" -printf '%T@\n' 2>/dev/null | sort -rn | head -1)

    if [ -z "$NEWEST" ]; then
        ALERTS="${ALERTS}\n🟡 No HA backup files found in ${HA_BACKUP_DIR}"
    else
        AGE_SECONDS=$(echo "$(date +%s) - ${NEWEST%.*}" | bc)
        AGE_DAYS=$((AGE_SECONDS / 86400))

        if [ "$AGE_DAYS" -ge "$MAX_AGE_DAYS" ]; then
            ALERTS="${ALERTS}\n🔴 HA backup is ${AGE_DAYS} days old (threshold: ${MAX_AGE_DAYS} days)"
        fi
    fi
else
    ALERTS="${ALERTS}\n🟡 HA backup directory not found (${HA_BACKUP_DIR}) — drive may not be mounted"
fi

echo "[$TIMESTAMP] Backup check complete." >> "$LOG_FILE"

if [ -n "$ALERTS" ]; then
    MESSAGE="<b>Jarvis Backup Alert</b>\n<i>${TIMESTAMP}</i>\n${ALERTS}"
    echo "[$TIMESTAMP] Alerts found:$ALERTS" >> "$LOG_FILE"
    "$SCRIPT_DIR/notify.sh" "$(echo -e "$MESSAGE")" "backup-checker"
else
    echo "[$TIMESTAMP] All backups OK (within ${MAX_AGE_DAYS} days)." >> "$LOG_FILE"
fi
