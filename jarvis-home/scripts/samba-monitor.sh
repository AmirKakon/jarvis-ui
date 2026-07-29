#!/bin/bash
# Samba share monitoring script.
# Checks smbd service status and share mount accessibility.
# Self-heals unhealthy mounts: unmount + remount, retrying up to 3 times
# before alerting via Telegram.
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

# Number of unmount/remount attempts before giving up on a mount point.
MAX_RETRIES=3

# A mount point is healthy when it is actually mounted AND readable.
is_healthy() {
    local mp="$1"
    findmnt "$mp" >/dev/null 2>&1 && ls "$mp" >/dev/null 2>&1
}

# Attempt to recover a single mount point by unmounting then remounting,
# retrying up to MAX_RETRIES. Returns 0 if healthy afterwards, 1 otherwise.
heal_mount() {
    local mp="$1"
    local attempt
    for attempt in $(seq 1 "$MAX_RETRIES"); do
        log "Self-heal attempt $attempt/$MAX_RETRIES for $mp"

        # Best-effort unmount first (plain, then lazy); ignore errors if it
        # isn't currently mounted.
        timeout 15 sudo umount "$mp" 2>/dev/null \
            || timeout 15 sudo umount -l "$mp" 2>/dev/null
        sleep 1

        # Remount from fstab — target the specific entry, fall back to mount -a.
        timeout 15 sudo mount "$mp" 2>/dev/null \
            || timeout 15 sudo mount -a 2>/dev/null
        sleep 2

        if is_healthy "$mp"; then
            log "OK: self-healed $mp on attempt $attempt"
            return 0
        fi
    done
    return 1
}

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

for mount_point in "${EXPECTED_MOUNTS[@]}"; do
    if [ ! -d "$mount_point" ]; then
        alerts+=("Mount point missing: $mount_point")
        log "ALERT: mount point missing: $mount_point"
        continue
    fi

    if is_healthy "$mount_point"; then
        continue
    fi

    # Unhealthy (not mounted or unreadable) → try to self-heal before alerting.
    log "Unhealthy mount: $mount_point — attempting self-heal (up to $MAX_RETRIES)"
    if heal_mount "$mount_point"; then
        log "OK: self-healed $mount_point"
    else
        alerts+=("Not mounted: $mount_point (self-heal failed after $MAX_RETRIES attempts)")
        log "ALERT: self-heal failed for $mount_point after $MAX_RETRIES attempts"
    fi
done

# Log connection summary
CONNECTIONS=$(smbstatus --shares 2>/dev/null | grep -c '/' || echo "0")
log "OK: smbd active, $CONNECTIONS active share connections"

# Send alert if issues remain after self-healing
if [ ${#alerts[@]} -gt 0 ]; then
    MSG="🔴 <b>Samba Alert</b>

$(printf '• %s\n' "${alerts[@]}")

Self-heal (unmount + remount ×$MAX_RETRIES) did not resolve it.
Check with: <code>systemctl status smbd</code>"

    bash "$SCRIPT_DIR/notify.sh" "$MSG" "samba-monitor"
fi
