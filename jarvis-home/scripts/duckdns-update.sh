#!/bin/bash
# Keep the DuckDNS record pointing at this home's current public IP.
#
# The ISP rotates the home IP. When DuckDNS goes stale, outside callers of the
# domain (the Alexa Lambda, anything using the Let's Encrypt cert) dial someone
# else's address, and certificate renewals for the domain fail.
#
# DuckDNS's update endpoint is flaky (frequent HTTP 500s), so it is contacted as
# little as possible: each run only looks up the public IP, and DuckDNS is called
# when that IP differs from the last one pushed, plus once a day as a refresh.
# Each update is retried, and Telegram alerts fire only for sustained failure
# (a bad token alerts immediately), then again when updates recover.
#
# Config (~/jarvis/.env):
#   DUCKDNS_TOKEN    required — token shown on the duckdns.org dashboard
#   DUCKDNS_DOMAINS  optional — comma-separated subdomains (default: kakischer)
#
# Cron: every 10 minutes

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$HOME/jarvis/.env"
LOG_FILE="$HOME/jarvis/logs/duckdns-update.log"
IP_FILE="$HOME/jarvis/state/duckdns.ip"         # last IP successfully pushed to DuckDNS
STATE_FILE="$HOME/jarvis/state/duckdns.state"   # PUSHED_AT FAILS ALERTED_AT
TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')
NOW=$(date +%s)

REFRESH_SECONDS=86400       # re-push an unchanged IP once a day
UPDATE_ATTEMPTS=3
RETRY_DELAY="${DUCKDNS_RETRY_DELAY:-10}"
FAIL_ALERT_AFTER=3          # consecutive failed runs before alerting (~30 min)
ALERT_REPEAT_SECONDS=21600  # while still failing, re-alert at most every 6 hours

mkdir -p "$(dirname "$LOG_FILE")" "$(dirname "$STATE_FILE")"

log() {
    echo "[$TIMESTAMP] $*" >> "$LOG_FILE"
}

trim_log() {
    # ~3.5 days at one line per 10 minutes.
    tail -n 500 "$LOG_FILE" > "${LOG_FILE}.tmp" 2>/dev/null && mv "${LOG_FILE}.tmp" "$LOG_FILE"
}

save_state() {
    echo "$PUSHED_AT $FAILS $ALERTED_AT" > "$STATE_FILE"
}

# Read one KEY=value from .env without sourcing it (values may not be shell-safe).
env_value() {
    grep -E "^[[:space:]]*$1=" "$ENV_FILE" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d "[:space:]\"'"
}

public_ip() {
    local src ip
    for src in https://api.ipify.org https://ifconfig.me/ip https://icanhazip.com; do
        ip=$(curl -4 -fsS -m 8 "$src" 2>/dev/null | tr -d '[:space:]')
        if [[ "$ip" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]]; then
            echo "$ip"
            return 0
        fi
    done
    return 1
}

# The URL goes to curl via its config on stdin so the token never shows up in
# the process list.
push_to_duckdns() {
    printf 'url = "https://www.duckdns.org/update?domains=%s&token=%s&ip=%s&verbose=true"\n' \
        "$DOMAINS" "$TOKEN" "$CURRENT_IP" | curl -fsS -m 15 -K - 2>&1
}

TOKEN="$(env_value DUCKDNS_TOKEN)"
DOMAINS="$(env_value DUCKDNS_DOMAINS)"
DOMAINS="${DOMAINS:-kakischer}"

if [ -z "$TOKEN" ]; then
    log "SKIP: DUCKDNS_TOKEN not set in $ENV_FILE"
    exit 0
fi

LAST_IP=$(cat "$IP_FILE" 2>/dev/null || true)
PUSHED_AT=0; FAILS=0; ALERTED_AT=0
if [ -f "$STATE_FILE" ]; then
    read -r PUSHED_AT FAILS ALERTED_AT < "$STATE_FILE"
fi
PUSHED_AT="${PUSHED_AT:-0}"; FAILS="${FAILS:-0}"; ALERTED_AT="${ALERTED_AT:-0}"

if ! CURRENT_IP=$(public_ip); then
    # No internet or all lookup services down — nothing DuckDNS-specific to report.
    log "SKIP: could not determine the public IP"
    trim_log
    exit 0
fi

if [ "$CURRENT_IP" = "$LAST_IP" ] && [ $((NOW - PUSHED_AT)) -lt "$REFRESH_SECONDS" ]; then
    log "OK: $CURRENT_IP unchanged"
    trim_log
    exit 0
fi

# verbose=true answers four lines: OK|KO, IPv4, IPv6, UPDATED|NOCHANGE
for attempt in $(seq 1 "$UPDATE_ATTEMPTS"); do
    RESPONSE=$(push_to_duckdns)
    CURL_RC=$?
    STATUS=$(printf '%s\n' "$RESPONSE" | sed -n '1p')
    if [ "$CURL_RC" -eq 0 ] && [ "$STATUS" = "OK" ]; then
        break
    fi
    # KO means a wrong token or domain; retrying won't change the answer.
    [ "$STATUS" = "KO" ] && break
    [ "$attempt" -lt "$UPDATE_ATTEMPTS" ] && sleep "$RETRY_DELAY"
done

if [ "$CURL_RC" -ne 0 ] || [ "$STATUS" != "OK" ]; then
    FAILS=$((FAILS + 1))
    if [ "$STATUS" = "KO" ]; then
        DETAIL="DuckDNS rejected the update (KO). Check DUCKDNS_TOKEN and DUCKDNS_DOMAINS in ~/jarvis/.env."
        ALERT_NOW=1
    elif [ "$CURL_RC" -eq 22 ]; then
        DETAIL="DuckDNS's servers are failing (HTTP ${RESPONSE##*error: }). This is usually temporary."
        ALERT_NOW=0
    else
        DETAIL="Couldn't reach DuckDNS: ${RESPONSE:-no response}"
        ALERT_NOW=0
    fi
    log "ERROR ($FAILS in a row, $attempt attempt(s)): $DETAIL"

    if { [ "$ALERT_NOW" -eq 1 ] || [ "$FAILS" -ge "$FAIL_ALERT_AFTER" ]; } \
        && [ $((NOW - ALERTED_AT)) -ge "$ALERT_REPEAT_SECONDS" ]; then
        if [ -n "$LAST_IP" ] && [ "$CURRENT_IP" != "$LAST_IP" ]; then
            IMPACT="⚠️ Home IP is now <code>${CURRENT_IP}</code> but DuckDNS still points at <code>${LAST_IP}</code>, so Alexa can't reach JARVIS until this succeeds."
        else
            IMPACT="DuckDNS still points at the right address (<code>${CURRENT_IP}</code>), so nothing is broken yet."
        fi
        MSG="🔴 <b>DuckDNS updates failing</b>

Domain: <code>${DOMAINS}.duckdns.org</code>
${DETAIL}
Failed ${FAILS} run(s) in a row.

${IMPACT}"
        bash "$SCRIPT_DIR/notify.sh" "$MSG" "duckdns-update"
        ALERTED_AT=$NOW
    fi
    save_state
    trim_log
    exit 1
fi

if [ -z "$LAST_IP" ]; then
    log "INIT: pushed $CURRENT_IP"
elif [ "$CURRENT_IP" != "$LAST_IP" ]; then
    log "CHANGED: $LAST_IP -> $CURRENT_IP"
    MSG="🌐 <b>Home IP changed</b>

<code>${LAST_IP}</code> → <code>${CURRENT_IP}</code>
<code>${DOMAINS}.duckdns.org</code> now points at the new address."
    bash "$SCRIPT_DIR/notify.sh" "$MSG" "duckdns-update"
else
    log "REFRESHED: $CURRENT_IP"
fi

if [ "$ALERTED_AT" -gt 0 ]; then
    bash "$SCRIPT_DIR/notify.sh" "✅ <b>DuckDNS updates working again</b>

<code>${DOMAINS}.duckdns.org</code> points at <code>${CURRENT_IP}</code>." "duckdns-update"
fi

echo "$CURRENT_IP" > "$IP_FILE"
PUSHED_AT=$NOW; FAILS=0; ALERTED_AT=0
save_state
trim_log
