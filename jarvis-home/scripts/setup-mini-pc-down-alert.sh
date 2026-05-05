#!/usr/bin/env bash
# setup-mini-pc-down-alert.sh
#
# Idempotent setup of HA monitoring for the Mini PC (192.168.68.124):
#   1. Adds the ICMP ping integration via the Home Assistant config-flow REST
#      API (or reuses an existing one).
#   2. Discovers the resulting binary_sensor entity_id.
#   3. Pushes two automations via /api/config/automation/config:
#        - mini_pc_down_alert    : notify.notify after host is off for N minutes
#        - mini_pc_back_online   : notify when the host returns (skips brief blips)
#   4. Verifies both automations exist.
#
# Notification channel: notify.notify (HA Companion mobile app push). The
# notification originates from the Pi, so it works even when the Mini PC is
# fully powered off.
#
# Requires: HA_URL and HA_TOKEN in ~/jarvis/.env, plus curl and jq.
# Re-running the script is safe — it overwrites the automations and skips the
# integration step if a ping for this host already exists.

set -euo pipefail

ENV_FILE="${HOME}/jarvis/.env"
HOST_IP="192.168.68.124"
HOST_LABEL="Mini PC"
DELAY_MINUTES=5
DELAY_SECONDS=$((DELAY_MINUTES * 60))

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

# --- Step 2: locate (or add) the ping binary_sensor for HOST_IP ---

find_ping_entity() {
  ha "$HA_URL/api/states" | jq -r --arg ip "$HOST_IP" '
    .[]
    | select(.entity_id | startswith("binary_sensor."))
    | select((.attributes.ip_address // "") == $ip)
    | .entity_id' | head -1
}

echo "[2/5] Looking for existing ping sensor for $HOST_IP"
PING_ENTITY=$(find_ping_entity || true)

if [ -n "$PING_ENTITY" ]; then
  echo "      Found existing entity: $PING_ENTITY"
else
  echo "      None found. Adding ping integration via config-flow API"

  FLOW=$(ha -X POST "$HA_URL/api/config/config_entries/flow" -d '{"handler": "ping"}')
  FLOW_ID=$(echo "$FLOW" | jq -r '.flow_id // empty')
  if [ -z "$FLOW_ID" ]; then
    echo "ERROR: Could not start ping config flow. Response:" >&2
    echo "$FLOW" | jq . >&2 || echo "$FLOW" >&2
    echo "" >&2
    echo "Fallback: add manually via HA UI:" >&2
    echo "  Settings > Devices & Services > Add Integration > Ping (ICMP)" >&2
    echo "  Host: $HOST_IP    Count: 5" >&2
    exit 1
  fi

  RESULT=$(ha -X POST "$HA_URL/api/config/config_entries/flow/$FLOW_ID" \
    -d "$(jq -n --arg h "$HOST_IP" '{host: $h, count: 5}')")

  TYPE=$(echo "$RESULT" | jq -r '.type // empty')
  if [ "$TYPE" != "create_entry" ]; then
    echo "ERROR: Ping config flow did not complete (type=$TYPE). Response:" >&2
    echo "$RESULT" | jq . >&2 || echo "$RESULT" >&2
    exit 1
  fi
  echo "      Integration added"

  # Give HA a few seconds to register the entity, then poll
  for i in 1 2 3 4 5 6 7 8; do
    sleep 1
    PING_ENTITY=$(find_ping_entity || true)
    [ -n "$PING_ENTITY" ] && break
  done

  if [ -z "$PING_ENTITY" ]; then
    echo "ERROR: Integration added but binary_sensor for $HOST_IP did not appear within 8s" >&2
    exit 1
  fi
  echo "      New entity: $PING_ENTITY"
fi

# --- Step 3: push the down-alert automation ---

echo "[3/5] Pushing automation.mini_pc_down_alert ($DELAY_MINUTES min threshold)"

DOWN_PAYLOAD=$(jq -n \
  --arg entity "$PING_ENTITY" \
  --arg ip "$HOST_IP" \
  --arg label "$HOST_LABEL" \
  --argjson minutes "$DELAY_MINUTES" \
  '{
    alias: "Mini PC Down Alert",
    description: "Alert via notify.notify when the Mini PC is unreachable for \($minutes) minutes",
    mode: "single",
    triggers: [
      {trigger: "state", entity_id: $entity, to: "off", for: {minutes: $minutes}}
    ],
    conditions: [],
    actions: [
      {action: "notify.notify",
       data: {
         title: "🔴 Mini PC Offline",
         message: "\($label) (\($ip)) has been unreachable for \($minutes) min. Possible power outage or hardware issue — manual power-on may be needed if BIOS is not set to restore on AC loss."
       }},
      {action: "persistent_notification.create",
       data: {
         notification_id: "mini_pc_down",
         title: "🔴 Mini PC Offline",
         message: "\($label) (\($ip)) has been unreachable for \($minutes) min."
       }}
    ]
  }')

ha -X POST "$HA_URL/api/config/automation/config/mini_pc_down_alert" \
  -d "$DOWN_PAYLOAD" >/dev/null
echo "      OK"

# --- Step 4: push the back-online automation ---

echo "[4/5] Pushing automation.mini_pc_back_online"

# Only fire if the entity was off for at least DELAY_SECONDS — avoids alerting
# on brief blips that never triggered the down alert in the first place.
UP_PAYLOAD=$(jq -n \
  --arg entity "$PING_ENTITY" \
  --arg ip "$HOST_IP" \
  --arg label "$HOST_LABEL" \
  --argjson threshold "$DELAY_SECONDS" \
  '{
    alias: "Mini PC Back Online",
    description: "Notify when the Mini PC returns after a sustained outage",
    mode: "single",
    triggers: [
      {trigger: "state", entity_id: $entity, from: "off", to: "on"}
    ],
    conditions: [
      {condition: "template",
       value_template: "{{ (as_timestamp(now()) - as_timestamp(trigger.from_state.last_changed | default(now()))) >= \($threshold) }}"}
    ],
    actions: [
      {action: "notify.notify",
       data: {
         title: "✅ Mini PC Back Online",
         message: "\($label) (\($ip)) is reachable again."
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
echo "  Ping entity         : $PING_ENTITY"
echo "  Down threshold      : $DELAY_MINUTES min"
echo "  Notification channel: notify.notify (HA Companion mobile app)"
echo ""
echo "To test: power off the Mini PC and wait $DELAY_MINUTES minutes — the alert"
echo "should appear on your phone. Power back on — recovery notification follows."
