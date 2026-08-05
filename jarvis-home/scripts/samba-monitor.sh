#!/bin/bash
# Samba share monitoring script.
# Checks smbd service status and share mount accessibility.
# Self-heals unhealthy mounts: unmount + remount the *correct* fstab UUID
# only (never mount -a), retrying up to 3 times before alerting via Telegram.
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

# Look up the UUID fstab assigns to a mount point (empty if none).
fstab_uuid_for() {
    local mp="$1"
    awk -v mp="$mp" '
        $1 ~ /^UUID=/ && $2 == mp {
            sub(/^UUID=/, "", $1)
            print $1
            exit
        }
    ' /etc/fstab 2>/dev/null
}

# UUID currently mounted at mp (empty if not mounted).
mounted_uuid() {
    findmnt -n -o UUID --target "$1" 2>/dev/null
}

# Healthy = mounted, readable, AND (if fstab has a UUID) the correct disk.
is_healthy() {
    local mp="$1"
    local want_uuid="$2"

    findmnt "$mp" >/dev/null 2>&1 || return 1
    ls "$mp" >/dev/null 2>&1 || return 1

    if [ -n "$want_uuid" ]; then
        local got
        got="$(mounted_uuid "$mp")"
        [ "$got" = "$want_uuid" ] || return 1
    fi
    return 0
}

# Peel every mount stacked on mp (wrong disk underneath is common).
clear_mounts() {
    local mp="$1"
    local i
    for i in 1 2 3 4 5; do
        findmnt "$mp" >/dev/null 2>&1 || return 0
        timeout 15 sudo umount "$mp" 2>/dev/null \
            || timeout 15 sudo umount -l "$mp" 2>/dev/null \
            || true
        sleep 1
    done
    # Still mounted?
    ! findmnt "$mp" >/dev/null 2>&1
}

# Remount only the fstab UUID for this path. Never mount -a (that can
# re-attach the wrong disk or create stacked mounts).
heal_mount() {
    local mp="$1"
    local want_uuid="$2"
    local attempt

    if [ -z "$want_uuid" ]; then
        log "No UUID in fstab for $mp — refusing to guess a device"
        return 1
    fi

    for attempt in $(seq 1 "$MAX_RETRIES"); do
        log "Self-heal attempt $attempt/$MAX_RETRIES for $mp (expect UUID=$want_uuid)"

        clear_mounts "$mp" || log "WARN: could not fully clear mounts on $mp"

        # Prefer mount by UUID so the kernel cannot pick another disk.
        if ! timeout 30 sudo mount -U "$want_uuid" "$mp" 2>/dev/null; then
            timeout 30 sudo mount "UUID=$want_uuid" "$mp" 2>/dev/null \
                || timeout 30 sudo mount "$mp" 2>/dev/null \
                || true
        fi
        sleep 2

        if is_healthy "$mp" "$want_uuid"; then
            log "OK: self-healed $mp on attempt $attempt (UUID=$(mounted_uuid "$mp"))"
            return 0
        fi

        log "Heal attempt $attempt failed for $mp (got UUID=$(mounted_uuid "$mp" || echo none))"
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

    want_uuid="$(fstab_uuid_for "$mount_point")"
    got_uuid="$(mounted_uuid "$mount_point")"

    if is_healthy "$mount_point" "$want_uuid"; then
        continue
    fi

    # Wrong disk mounted but readable — still heal (this is what bit us).
    if [ -n "$got_uuid" ] && [ -n "$want_uuid" ] && [ "$got_uuid" != "$want_uuid" ]; then
        log "Wrong disk on $mount_point: got $got_uuid want $want_uuid"
    else
        log "Unhealthy mount: $mount_point — attempting self-heal (up to $MAX_RETRIES)"
    fi

    if heal_mount "$mount_point" "$want_uuid"; then
        log "OK: self-healed $mount_point"
    else
        alerts+=("Not mounted correctly: $mount_point (want UUID=${want_uuid:-unknown}, self-heal failed)")
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

Self-heal (UUID-checked unmount + remount ×$MAX_RETRIES) did not resolve it.
Check with: <code>findmnt ~/shared-storage ~/shared-storage-2</code>"

    bash "$SCRIPT_DIR/notify.sh" "$MSG" "samba-monitor"
fi
