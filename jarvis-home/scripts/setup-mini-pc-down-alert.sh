#!/usr/bin/env bash
# setup-mini-pc-down-alert.sh
#
# Idempotent setup of HA monitoring for the Mini PC (192.168.68.124).
#
# Strategy: piggyback on whatever entity HA is already getting from the Mini PC
# (Glances HTTP integration, MQTT-published Glances stats, or any other sensor
# tagged with the Mini PC's IP). When the host dies, that entity flips to
# `unavailable`. We trigger off that — no new integration required.
#
# Falls back to adding the ICMP `ping` config-flow integration only if no
# existing Mini PC entity can be found.
#
# Usage:
#   ./setup-mini-pc-down-alert.sh                    # auto-discover entity
#   ./setup-mini-pc-down-alert.sh --entity sensor.x  # force a specific entity
#   ./setup-mini-pc-down-alert.sh --list             # only list candidates and exit
#   ./setup-mini-pc-down-alert.sh --force-ping       # skip discovery, add ping integration
#
# Creates two automations:
#   - mini_pc_down_alert    : notify.notify after host is unreachable for N min
#   - mini_pc_back_online   : notify when host returns (skips brief blips)
#
# Notification channel: notify.notify (HA Companion app push). The notification
# originates from the Pi, so it works even when the Mini PC is fully off.
#
# Requires: HA_URL and HA_TOKEN in ~/jarvis/.env, plus curl and jq.
# Re-running is safe — automations are overwritten each time.

set -euo pipefail

ENV_FILE="${HOME}/jarvis/.env"
HOST_IP="192.168.68.124"
HOST_LABEL="Mini PC"
DELAY_MINUTES=5
DELAY_SECONDS=$((DELAY_MINUTES * 60))

OVERRIDE_ENTITY=""
LIST_ONLY=0
FORCE_PING=0

while [ $# -gt 0 ]; do
  case "$1" in
    --entity)      OVERRIDE_ENTITY="${2:-}"; shift 2 ;;
    --list)        LIST_ONLY=1; shift ;;
    --force-ping)  FORCE_PING=1; shift ;;
    -h|--help)     sed -n '2,30p' "$0"; exit 0 ;;
    *) echo "Unknown arg: $1" >&2; exit 2 ;;
  esac
done

if [ ! -f "$ENV_FILE" ]; then
  echo "ERROR: $ENV_FILE not found" >&2; exit 1
fi
# shellcheck disable=SC1090
source "$ENV_FILE"

if [ -z "${HA_URL:-}" ] || [ -z "${HA_TOKEN:-}" ]; then
  echo "ERROR: HA_URL or HA_TOKEN not set in $ENV_FILE" >&2; exit 1
fi
for cmd in curl jq; do
  command -v "$cmd" >/dev/null || { echo "ERROR: $cmd not installed" >&2; exit 1; }
done

ha() {
  curl -sS --fail-with-body \
    -H "Authorization: Bearer $HA_TOKEN" \
    -H "Content-Type: application/json" \
    "$@"
}

echo "[1/5] Verifying HA reachable at $HA_URL"
ha "$HA_URL/api/" >/dev/null
echo "      OK"

# --- Step 2: identify the trigger entity ---

# Search heuristic: any entity whose attribute blob mentions the host IP, or
# whose entity_id / friendly name contains a Mini PC keyword. We then prefer
# entities that are currently NOT in {unknown, unavailable} (so we know they
# work) and have the most recent last_updated.
discover_candidates() {
  ha "$HA_URL/api/states" | jq -r --arg ip "$HOST_IP" '
    map(select(
      (.entity_id | startswith("sensor.") or startswith("binary_sensor."))
      and (
        ((.attributes // {}) | tostring | test($ip; "i"))
        or ((.entity_id | ascii_downcase) | test("kamuri|mini.?pc|glances"))
        or (((.attributes.friendly_name // "") | ascii_downcase) | test("kamuri|mini.?pc|glances"))
      )
    ))
    | sort_by(.last_updated)
    | reverse
    | .[]
    | "\(.entity_id)\t\(.state)\t\(.last_updated)\t\(.attributes.friendly_name // "")"
  '
}

CANDIDATES=$(discover_candidates)

if [ "$LIST_ONLY" = "1" ]; then
  echo ""
  echo "Candidate entities for the Mini PC (sorted by most-recent update):"
  echo ""
  printf "%-50s  %-15s  %-25s  %s\n" "ENTITY_ID" "STATE" "LAST_UPDATED" "FRIENDLY_NAME"
  echo "$CANDIDATES" | awk -F'\t' '{ printf "%-50s  %-15s  %-25s  %s\n", $1, $2, $3, $4 }'
  exit 0
fi

TRIGGER_ENTITY=""

if [ "$FORCE_PING" = "1" ]; then
  echo "      --force-ping set, skipping discovery"
elif [ -n "$OVERRIDE_ENTITY" ]; then
  TRIGGER_ENTITY="$OVERRIDE_ENTITY"
  echo "[2/5] Using override entity: $TRIGGER_ENTITY"
  # Validate it exists
  ha "$HA_URL/api/states/$TRIGGER_ENTITY" >/dev/null \
    || { echo "ERROR: entity $TRIGGER_ENTITY does not exist in HA" >&2; exit 1; }
else
  echo "[2/5] Auto-discovering existing Mini PC entity"
  # Prefer a sensor that's currently in a real numeric/text state (not
  # unavailable/unknown), since that proves the data path works.
  TRIGGER_ENTITY=$(echo "$CANDIDATES" \
    | awk -F'\t' '$2 != "unavailable" && $2 != "unknown" && $2 != "" { print $1; exit }')

  if [ -n "$TRIGGER_ENTITY" ]; then
    echo "      Picked: $TRIGGER_ENTITY"
    echo "      (use --list to see all candidates, --entity <id> to override)"
  fi
fi

# --- Step 2b: fall back to adding the ping integration if nothing usable ---

if [ -z "$TRIGGER_ENTITY" ]; then
  echo "      No suitable Mini PC entity found. Falling back to ICMP ping."

  # Check if a ping for this host already exists
  TRIGGER_ENTITY=$(ha "$HA_URL/api/states" | jq -r --arg ip "$HOST_IP" '
    .[] | select(.entity_id | startswith("binary_sensor."))
    | select((.attributes.ip_address // "") == $ip)
    | .entity_id' | head -1)

  if [ -z "$TRIGGER_ENTITY" ]; then
    FLOW=$(ha -X POST "$HA_URL/api/config/config_entries/flow" -d '{"handler": "ping"}')
    FLOW_ID=$(echo "$FLOW" | jq -r '.flow_id // empty')
    if [ -z "$FLOW_ID" ]; then
      echo "ERROR: Could not start ping config flow. Response:" >&2
      echo "$FLOW" | jq . >&2 || echo "$FLOW" >&2
      echo "" >&2
      echo "Add manually via HA UI: Settings > Devices & Services > Add" >&2
      echo "Integration > Ping (ICMP), host $HOST_IP, then re-run this script." >&2
      exit 1
    fi

    RESULT=$(ha -X POST "$HA_URL/api/config/config_entries/flow/$FLOW_ID" \
      -d "$(jq -n --arg h "$HOST_IP" '{host: $h, count: 5}')")

    if [ "$(echo "$RESULT" | jq -r '.type // empty')" != "create_entry" ]; then
      echo "ERROR: Ping config flow did not complete. Response:" >&2
      echo "$RESULT" | jq . >&2 || echo "$RESULT" >&2
      exit 1
    fi

    # Wait for the entity to materialize
    for _ in 1 2 3 4 5 6 7 8; do
      sleep 1
      TRIGGER_ENTITY=$(ha "$HA_URL/api/states" | jq -r --arg ip "$HOST_IP" '
        .[] | select(.entity_id | startswith("binary_sensor."))
        | select((.attributes.ip_address // "") == $ip)
        | .entity_id' | head -1)
      [ -n "$TRIGGER_ENTITY" ] && break
    done

    if [ -z "$TRIGGER_ENTITY" ]; then
      echo "ERROR: ping integration added but entity did not appear within 8s" >&2
      exit 1
    fi
  fi

  echo "      Using ping entity: $TRIGGER_ENTITY"
fi

# Decide which states represent "down" depending on the entity domain:
#   binary_sensor.* (ping)   -> down when state == "off"
#   sensor.*                 -> down when state == "unavailable" (or "unknown")
DOMAIN="${TRIGGER_ENTITY%%.*}"
if [ "$DOMAIN" = "binary_sensor" ]; then
  DOWN_TO="off"
  UP_FROM="off"
else
  DOWN_TO="unavailable"
  UP_FROM="unavailable"
fi

echo "      Trigger state for 'down': $DOWN_TO"

# --- Step 3: push the down-alert automation ---

echo "[3/5] Pushing automation.mini_pc_down_alert ($DELAY_MINUTES min threshold)"

DOWN_PAYLOAD=$(jq -n \
  --arg entity "$TRIGGER_ENTITY" \
  --arg down "$DOWN_TO" \
  --arg ip "$HOST_IP" \
  --arg label "$HOST_LABEL" \
  --argjson minutes "$DELAY_MINUTES" \
  '{
    alias: "Mini PC Down Alert",
    description: "Alert via notify.notify when \($entity) signals the Mini PC is down for \($minutes) minutes",
    mode: "single",
    triggers: [
      {trigger: "state", entity_id: $entity, to: $down, for: {minutes: $minutes}}
    ],
    conditions: [],
    actions: [
      {action: "notify.notify",
       data: {
         title: "🔴 Mini PC Offline",
         message: "\($label) (\($ip)) has been unreachable for \($minutes) min via \($entity). Possible power outage or hardware issue — manual power-on may be needed if BIOS is not set to restore on AC loss."
       }},
      {action: "persistent_notification.create",
       data: {
         notification_id: "mini_pc_down",
         title: "🔴 Mini PC Offline",
         message: "\($label) (\($ip)) has been unreachable for \($minutes) min via \($entity)."
       }}
    ]
  }')

ha -X POST "$HA_URL/api/config/automation/config/mini_pc_down_alert" \
  -d "$DOWN_PAYLOAD" >/dev/null
echo "      OK"

# --- Step 4: push the back-online automation ---

echo "[4/5] Pushing automation.mini_pc_back_online"

# Only fire if the entity was 'down' for at least DELAY_SECONDS — avoids
# alerting on brief flickers that never tripped the down alert.
UP_PAYLOAD=$(jq -n \
  --arg entity "$TRIGGER_ENTITY" \
  --arg from "$UP_FROM" \
  --arg ip "$HOST_IP" \
  --arg label "$HOST_LABEL" \
  --argjson threshold "$DELAY_SECONDS" \
  '{
    alias: "Mini PC Back Online",
    description: "Notify when \($entity) returns to a healthy state after a sustained outage",
    mode: "single",
    triggers: [
      {trigger: "state", entity_id: $entity, from: $from}
    ],
    conditions: [
      {condition: "template",
       value_template: "{{ trigger.to_state.state not in [\"unavailable\", \"unknown\", \"off\", \"none\"] }}"},
      {condition: "template",
       value_template: "{{ (as_timestamp(now()) - as_timestamp(trigger.from_state.last_changed | default(now()))) >= \($threshold) }}"}
    ],
    actions: [
      {action: "notify.notify",
       data: {
         title: "✅ Mini PC Back Online",
         message: "\($label) (\($ip)) is reachable again — \($entity) is reporting normally."
       }},
      {action: "persistent_notification.dismiss",
       data: {notification_id: "mini_pc_down"}}
    ]
  }')

ha -X POST "$HA_URL/api/config/automation/config/mini_pc_back_online" \
  -d "$UP_PAYLOAD" >/dev/null
echo "      OK"

# --- Step 5: verify ---

echo "[5/5] Verifying automations"
for slug in mini_pc_down_alert mini_pc_back_online; do
  STATE=$(ha "$HA_URL/api/states/automation.$slug" | jq -r '.state // "missing"')
  printf "      automation.%-25s %s\n" "$slug" "$STATE"
done

echo ""
echo "Done. Source of truth:"
echo "  Trigger entity      : $TRIGGER_ENTITY"
echo "  Down state          : $DOWN_TO"
echo "  Down threshold      : $DELAY_MINUTES min"
echo "  Notification channel: notify.notify (HA Companion mobile app)"
echo ""
echo "To test: power off the Mini PC and wait $DELAY_MINUTES minutes — the alert"
echo "should appear on your phone. Power back on — recovery notification follows."
