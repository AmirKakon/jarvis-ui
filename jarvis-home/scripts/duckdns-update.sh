#!/bin/bash
# Keep the DuckDNS record pointing at this home's current public IP.
#
# The ISP rotates the home IP. When DuckDNS goes stale, outside callers of the
# domain (the Alexa Lambda, anything using the Let's Encrypt cert) dial someone
# else's address, and certificate renewals for the domain fail. Leaving ip=
# empty makes DuckDNS record the address the request comes from, i.e. the
# current home IP. Alerts on Telegram when the IP changes or the update fails.
#
# Config (~/jarvis/.env):
#   DUCKDNS_TOKEN    required — token shown on the duckdns.org dashboard
#   DUCKDNS_DOMAINS  optional — comma-separated subdomains (default: kakischer)
#
# Cron: every 5 minutes

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$HOME/jarvis/.env"
LOG_FILE="$HOME/jarvis/logs/duckdns-update.log"
STATE_FILE="$HOME/jarvis/state/duckdns.ip"
TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')

mkdir -p "$(dirname "$LOG_FILE")" "$(dirname "$STATE_FILE")"

log() {
    echo "[$TIMESTAMP] $*" >> "$LOG_FILE"
}

# Read one KEY=value from .env without sourcing it (values may not be shell-safe).
env_value() {
    grep -E "^[[:space:]]*$1=" "$ENV_FILE" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d "[:space:]\"'"
}

TOKEN="$(env_value DUCKDNS_TOKEN)"
DOMAINS="$(env_value DUCKDNS_DOMAINS)"
DOMAINS="${DOMAINS:-kakischer}"

if [ -z "$TOKEN" ]; then
    log "SKIP: DUCKDNS_TOKEN not set in $ENV_FILE"
    exit 0
fi

# The URL goes to curl via its config on stdin so the token never shows up in
# the process list.
RESPONSE=$(printf 'url = "https://www.duckdns.org/update?domains=%s&token=%s&ip=&verbose=true"\n' "$DOMAINS" "$TOKEN" \
    | curl -fsS -m 20 -K - 2>&1)
CURL_RC=$?

# verbose=true answers four lines: OK|KO, IPv4, IPv6, UPDATED|NOCHANGE
STATUS=$(printf '%s\n' "$RESPONSE" | sed -n '1p')
IP=$(printf '%s\n' "$RESPONSE" | sed -n '2p')
CHANGE=$(printf '%s\n' "$RESPONSE" | sed -n '4p')

if [ "$CURL_RC" -ne 0 ] || [ "$STATUS" != "OK" ]; then
    if [ "$CURL_RC" -ne 0 ]; then
        DETAIL="Request failed: ${RESPONSE:-no response}"
    else
        DETAIL="DuckDNS answered: ${STATUS:-empty}"
    fi
    log "ERROR: update failed for $DOMAINS — $DETAIL"

    MSG="🔴 <b>DuckDNS update failed</b>

Domain: <code>${DOMAINS}.duckdns.org</code>
${DETAIL}

If the home IP changes while this is failing, Alexa can't reach JARVIS.
KO usually means DUCKDNS_TOKEN or DUCKDNS_DOMAINS in ~/jarvis/.env is wrong."
    bash "$SCRIPT_DIR/notify.sh" "$MSG" "duckdns-update"
    exit 1
fi

PREV_IP=$(cat "$STATE_FILE" 2>/dev/null || true)

if [ -z "$PREV_IP" ]; then
    log "INIT: home IP is $IP (DuckDNS $CHANGE)"
elif [ "$IP" != "$PREV_IP" ]; then
    log "CHANGED: $PREV_IP -> $IP (DuckDNS $CHANGE)"

    MSG="🌐 <b>Home IP changed</b>

<code>${PREV_IP}</code> → <code>${IP}</code>
<code>${DOMAINS}.duckdns.org</code> now points at the new address."
    bash "$SCRIPT_DIR/notify.sh" "$MSG" "duckdns-update"
else
    log "OK: $IP ($CHANGE)"
fi

echo "$IP" > "$STATE_FILE"

# Keep the log from growing unbounded (~1.7 days at one line per 5 minutes).
tail -n 500 "$LOG_FILE" > "${LOG_FILE}.tmp" 2>/dev/null && mv "${LOG_FILE}.tmp" "$LOG_FILE"
