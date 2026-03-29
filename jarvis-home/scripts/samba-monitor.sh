#!/bin/bash
# Samba share monitoring script.
# Checks smbd service status and share mount accessibility.
# Attempts auto-remount before alerting.
# Alerts via Telegram if issues detected.
#
# Cron: every 15 minutes

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_FILE="$HOME/jarvis/logs/samba-monitor.log"
TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')

mkdir -p "$(dirname "$LOG_FILE")"

log() {
    echo "[$TIMESTAMP] $*" >> "$LOG_FILE"
}

alerts=()

# Check smbd service
if ! systemctl is-active --quiet smbd 2>/dev/null; then
    alerts+=("smbd service is not running")
    log "ALERT: smbd not running"
fi

# Check expected share mount points
EXPECTED_MOUNTS=(
    "$HOME/shared-storage"
    "$HOME/shared-storage-2"
)

TRIED_REMOUNT=false

for mount_point in "${EXPECTED_MOUNTS[@]}"; do
    if [ ! -d "$mount_point" ]; then
        alerts+=("Mount point missing: $mount_point")
        log "ALERT: mount point missing: $mount_point"
    elif ! ls "$mount_point" >/dev/null 2>&1; then
        alerts+=("Mount point unreadable: $mount_point (may need remount)")
        log "ALERT: mount point unreadable: $mount_point"
    elif ! findmnt "$mount_point" >/dev/null 2>&1; then
        log "Not mounted: $mount_point — attempting remount..."
        if [ "$TRIED_REMOUNT" = false ]; then
            timeout 15 sudo mount -a 2>/dev/null
            TRIED_REMOUNT=true
            sleep 2
        fi
        # Re-check after remount attempt
        if ! findmnt "$mount_point" >/dev/null 2>&1; then
            alerts+=("Not mounted: $mount_point (remount failed)")
            log "ALERT: remount failed for $mount_point"
        else
            log "OK: remounted $mount_point successfully"
        fi
    fi
done

# Log connection summary
CONNECTIONS=$(smbstatus --shares 2>/dev/null | grep -c '/' || echo "0")
log "OK: smbd active, $CONNECTIONS active share connections"

# Send alert if issues found
if [ ${#alerts[@]} -gt 0 ]; then
    MSG="🔴 <b>Samba Alert</b>

$(printf '• %s\n' "${alerts[@]}")

Check with: <code>systemctl status smbd</code>"

    bash "$SCRIPT_DIR/notify.sh" "$MSG" "samba-monitor"
fi
