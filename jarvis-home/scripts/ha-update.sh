#!/bin/bash
# Home Assistant auto-updater — checks for updates and installs them.
# Intended to run via cron weekly (Sunday 3:00 AM).
# Logs to ~/jarvis/logs/ha-update.log

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_DIR="$HOME/jarvis/logs"
LOG_FILE="$LOG_DIR/ha-update.log"

mkdir -p "$LOG_DIR"

source "$HOME/jarvis/.env"

if [ -z "$HA_URL" ] || [ -z "$HA_TOKEN" ]; then
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] HA_URL or HA_TOKEN not set" >> "$LOG_FILE"
    exit 1
fi

TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')
UPDATED=""
FAILED=""
SKIPPED=0

ha_curl() {
    curl -sS -H "Authorization: Bearer $HA_TOKEN" -H "Content-Type: application/json" "$@"
}

echo "[$TIMESTAMP] Starting HA update check..." >> "$LOG_FILE"

# Verify HA is reachable
if ! ha_curl "$HA_URL/api/" > /dev/null 2>&1; then
    echo "[$TIMESTAMP] HA unreachable at $HA_URL" >> "$LOG_FILE"
    "$SCRIPT_DIR/notify.sh" "$(echo -e "<b>Jarvis HA Update</b>\n<i>${TIMESTAMP}</i>\n\n🔴 Home Assistant is unreachable.")" "ha-update"
    exit 1
fi

# Get all update entities
STATES=$(ha_curl "$HA_URL/api/states" 2>/dev/null)
if [ -z "$STATES" ]; then
    echo "[$TIMESTAMP] Failed to fetch states" >> "$LOG_FILE"
    exit 1
fi

# Parse update entities with state=on (update available)
UPDATES=$(echo "$STATES" | python3 -c "
import json, sys
states = json.load(sys.stdin)
for s in states:
    if s['entity_id'].startswith('update.') and s['state'] == 'on':
        eid = s['entity_id']
        name = s['attributes'].get('friendly_name', eid)
        cur = s['attributes'].get('installed_version', '?')
        nxt = s['attributes'].get('latest_version', '?')
        print(f'{eid}|{name}|{cur}|{nxt}')
" 2>/dev/null)

if [ -z "$UPDATES" ]; then
    echo "[$TIMESTAMP] All up to date." >> "$LOG_FILE"
    exit 0
fi

TOTAL=$(echo "$UPDATES" | wc -l)
echo "[$TIMESTAMP] Found $TOTAL updates available" >> "$LOG_FILE"

while IFS='|' read -r ENTITY_ID NAME CUR_VER NEW_VER; do
    [ -z "$ENTITY_ID" ] && continue

    echo "[$TIMESTAMP] Installing: $NAME ($CUR_VER -> $NEW_VER)..." >> "$LOG_FILE"

    # Trigger install (HA OS Supervisor requires backup: true for core updates)
    HTTP_CODE=$(curl -sS -o /tmp/ha-update-response.json -w "%{http_code}" \
        -H "Authorization: Bearer $HA_TOKEN" -H "Content-Type: application/json" \
        -X POST "$HA_URL/api/services/update/install" \
        -d "{\"entity_id\": \"$ENTITY_ID\", \"backup\": true}" 2>>/tmp/ha-update-err.txt)

    if [ "$HTTP_CODE" -ge 400 ] 2>/dev/null || [ -z "$HTTP_CODE" ]; then
        BODY=$(cat /tmp/ha-update-response.json 2>/dev/null | head -c 200)
        echo "[$TIMESTAMP] Failed to trigger: $NAME (HTTP $HTTP_CODE: $BODY)" >> "$LOG_FILE"
        FAILED="${FAILED}\n  🔴 ${NAME}: ${CUR_VER} → ${NEW_VER} (HTTP ${HTTP_CODE})"
        continue
    fi

    # Wait for update to complete (poll every 30s, max 10 min)
    ATTEMPTS=0
    MAX_ATTEMPTS=20
    SUCCESS=false

    while [ $ATTEMPTS -lt $MAX_ATTEMPTS ]; do
        sleep 30
        ATTEMPTS=$((ATTEMPTS + 1))

        STATE_JSON=$(ha_curl "$HA_URL/api/states/$ENTITY_ID" 2>/dev/null)
        if [ -z "$STATE_JSON" ]; then
            # HA might be restarting
            sleep 30
            continue
        fi

        IN_PROGRESS=$(echo "$STATE_JSON" | python3 -c "
import json, sys
s = json.load(sys.stdin)
print(s['attributes'].get('in_progress', False))
" 2>/dev/null)

        CURRENT_STATE=$(echo "$STATE_JSON" | python3 -c "
import json, sys
s = json.load(sys.stdin)
print(s['state'])
" 2>/dev/null)

        if [ "$IN_PROGRESS" = "False" ] && [ "$CURRENT_STATE" = "off" ]; then
            SUCCESS=true
            break
        fi
        if [ "$IN_PROGRESS" = "False" ] && [ "$CURRENT_STATE" != "on" ]; then
            SUCCESS=true
            break
        fi
    done

    if [ "$SUCCESS" = true ]; then
        echo "[$TIMESTAMP] Updated: $NAME to $NEW_VER" >> "$LOG_FILE"
        UPDATED="${UPDATED}\n  ✅ ${NAME}: ${CUR_VER} → ${NEW_VER}"
    else
        echo "[$TIMESTAMP] Timed out: $NAME" >> "$LOG_FILE"
        FAILED="${FAILED}\n  🟡 ${NAME}: ${CUR_VER} → ${NEW_VER} (timed out)"
    fi

done <<< "$UPDATES"

# Build summary message
MESSAGE="<b>Jarvis HA Update</b>\n<i>${TIMESTAMP}</i>\n"

if [ -n "$UPDATED" ]; then
    MESSAGE="${MESSAGE}\n<b>Updated:</b>${UPDATED}"
fi

if [ -n "$FAILED" ]; then
    MESSAGE="${MESSAGE}\n<b>Issues:</b>${FAILED}"
fi

if [ -z "$UPDATED" ] && [ -z "$FAILED" ]; then
    MESSAGE="${MESSAGE}\nAll up to date."
fi

echo "[$TIMESTAMP] Update check complete." >> "$LOG_FILE"
"$SCRIPT_DIR/notify.sh" "$(echo -e "$MESSAGE")" "ha-update"
