#!/bin/bash
# Docker security audit — checks for outdated images, root/privileged containers.
# Runs via cron weekly (Sunday 04:00).
# Logs to ~/jarvis/logs/docker-security.log
#
# To suppress root-user findings for a container:
#   echo "container_name" >> ~/jarvis/logs/docker-security-allowlist.txt

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_DIR="$HOME/jarvis/logs"
LOG_FILE="$LOG_DIR/docker-security.log"
ALLOWLIST="$LOG_DIR/docker-security-allowlist.txt"

mkdir -p "$LOG_DIR"

TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')

if ! command -v docker &>/dev/null; then
    echo "[$TIMESTAMP] Docker not found — skipping." >> "$LOG_FILE"
    exit 0
fi

is_allowed() {
    [ -f "$ALLOWLIST" ] && grep -qxF "$1" "$ALLOWLIST"
}

FINDINGS=""
FINDING_COUNT=0

# --- Check containers running as root ---
while IFS= read -r line; do
    NAME=$(echo "$line" | cut -d'|' -f1)
    USER=$(echo "$line" | cut -d'|' -f2)
    if [ -z "$USER" ] || [ "$USER" = "root" ] || [ "$USER" = "0" ]; then
        if ! is_allowed "$NAME"; then
            FINDINGS="${FINDINGS}\n🟡 <b>${NAME}</b> runs as root"
            FINDING_COUNT=$((FINDING_COUNT + 1))
        else
            echo "[$TIMESTAMP] $NAME runs as root (allowlisted)" >> "$LOG_FILE"
        fi
    fi
done <<< "$(docker ps --format '{{.Names}}' | while read -r c; do
    USER=$(docker inspect --format '{{.Config.User}}' "$c" 2>/dev/null)
    echo "${c}|${USER}"
done)"

# --- Check privileged containers ---
for CONTAINER in $(docker ps --format '{{.Names}}'); do
    PRIV=$(docker inspect --format '{{.HostConfig.Privileged}}' "$CONTAINER" 2>/dev/null)
    if [ "$PRIV" = "true" ]; then
        FINDINGS="${FINDINGS}\n🔴 <b>${CONTAINER}</b> is running in <b>privileged</b> mode"
        FINDING_COUNT=$((FINDING_COUNT + 1))
    fi
done

# --- Check host networking ---
for CONTAINER in $(docker ps --format '{{.Names}}'); do
    NET=$(docker inspect --format '{{.HostConfig.NetworkMode}}' "$CONTAINER" 2>/dev/null)
    if [ "$NET" = "host" ]; then
        FINDINGS="${FINDINGS}\n🟡 <b>${CONTAINER}</b> uses host networking"
        FINDING_COUNT=$((FINDING_COUNT + 1))
    fi
done

# --- Check for outdated images ---
OUTDATED=""
for CONTAINER in $(docker ps --format '{{.Names}}'); do
    IMAGE=$(docker inspect --format '{{.Config.Image}}' "$CONTAINER" 2>/dev/null)
    if [[ "$IMAGE" != *"/"* ]] && [[ "$IMAGE" != *":"* ]]; then
        continue
    fi

    LOCAL_DIGEST=$(docker inspect --format '{{.Image}}' "$CONTAINER" 2>/dev/null)
    PULL_OUTPUT=$(docker pull "$IMAGE" 2>/dev/null | tail -1)

    if echo "$PULL_OUTPUT" | grep -q "Downloaded newer image\|Pull complete"; then
        OUTDATED="${OUTDATED}\n🟡 <b>${CONTAINER}</b> has an image update available (<code>${IMAGE}</code>)"
        FINDING_COUNT=$((FINDING_COUNT + 1))
    fi
done
FINDINGS="${FINDINGS}${OUTDATED}"

CONTAINER_COUNT=$(docker ps -q | wc -l)
echo "[$TIMESTAMP] Audited $CONTAINER_COUNT containers, $FINDING_COUNT findings." >> "$LOG_FILE"

if [ "$FINDING_COUNT" -gt 0 ]; then
    MESSAGE="<b>🐳 Docker Security Audit</b>\n<i>${TIMESTAMP}</i>\n\n<b>${FINDING_COUNT}</b> finding(s) across ${CONTAINER_COUNT} containers:\n${FINDINGS}"
    echo "[$TIMESTAMP] Findings:$FINDINGS" >> "$LOG_FILE"
    "$SCRIPT_DIR/notify.sh" "$(echo -e "$MESSAGE")" "docker-security"
else
    echo "[$TIMESTAMP] All $CONTAINER_COUNT containers passed security checks." >> "$LOG_FILE"
fi
