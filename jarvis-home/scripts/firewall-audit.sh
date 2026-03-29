#!/bin/bash
# Firewall and port audit — detects changes in firewall rules and listening ports.
# Diffs against previous snapshot to catch unexpected changes.
# Runs via cron daily at 07:30.
# Logs to ~/jarvis/logs/firewall-audit.log

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_DIR="$HOME/jarvis/logs"
LOG_FILE="$LOG_DIR/firewall-audit.log"
FW_SNAPSHOT="$LOG_DIR/firewall-snapshot.txt"
PORTS_SNAPSHOT="$LOG_DIR/ports-snapshot.txt"

mkdir -p "$LOG_DIR"

TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')

# --- Capture current firewall state ---
FW_STATUS="inactive"
FW_CURRENT=""

if command -v ufw &>/dev/null; then
    UFW_STATUS=$(sudo ufw status 2>/dev/null | head -1)
    if echo "$UFW_STATUS" | grep -qi "active"; then
        FW_STATUS="active (ufw)"
        FW_CURRENT=$(sudo ufw status numbered 2>/dev/null)
    else
        FW_STATUS="inactive (ufw installed but disabled)"
        FW_CURRENT="$UFW_STATUS"
    fi
elif command -v iptables &>/dev/null; then
    RULE_COUNT=$(sudo iptables -L -n 2>/dev/null | grep -c -v '^Chain\|^target\|^$' || echo 0)
    FW_STATUS="iptables ($RULE_COUNT rules)"
    FW_CURRENT=$(sudo iptables -L -n 2>/dev/null)
else
    FW_STATUS="none"
    FW_CURRENT="No firewall detected"
fi

# --- Capture current listening ports (exclude loopback-only — not externally reachable) ---
PORTS_CURRENT=$(ss -tlnp 2>/dev/null | grep LISTEN | awk '{print $4}' | grep -v '^127\.\|^\[::1\]' | sort)

# --- First run: establish baseline ---
if [ ! -f "$FW_SNAPSHOT" ] || [ ! -f "$PORTS_SNAPSHOT" ]; then
    echo "$FW_CURRENT" > "$FW_SNAPSHOT"
    echo "$PORTS_CURRENT" > "$PORTS_SNAPSHOT"

    PORT_COUNT=$(echo "$PORTS_CURRENT" | wc -l)
    echo "[$TIMESTAMP] Baseline established. Firewall: $FW_STATUS, Listening ports: $PORT_COUNT" >> "$LOG_FILE"

    "$SCRIPT_DIR/notify.sh" "$(echo -e "<b>🛡️ Firewall Audit — Baseline</b>\n<i>${TIMESTAMP}</i>\n\nFirewall: <b>${FW_STATUS}</b>\nListening ports: <b>${PORT_COUNT}</b>\n\nBaseline saved. Future changes will trigger alerts.")" "firewall-audit"
    exit 0
fi

ALERTS=""

# --- Diff firewall rules ---
FW_DIFF=$(diff <(cat "$FW_SNAPSHOT") <(echo "$FW_CURRENT") 2>/dev/null)
if [ -n "$FW_DIFF" ]; then
    ADDED=$(echo "$FW_DIFF" | grep '^>' | head -5)
    REMOVED=$(echo "$FW_DIFF" | grep '^<' | head -5)

    ALERTS="${ALERTS}\n🔴 <b>Firewall rules changed!</b>"
    if [ -n "$ADDED" ]; then
        ALERTS="${ALERTS}\n<b>Added:</b>\n<pre>$(echo "$ADDED" | sed 's/^> //')</pre>"
    fi
    if [ -n "$REMOVED" ]; then
        ALERTS="${ALERTS}\n<b>Removed:</b>\n<pre>$(echo "$REMOVED" | sed 's/^< //')</pre>"
    fi
fi

# --- Diff listening ports ---
PORTS_DIFF_NEW=$(comm -13 "$PORTS_SNAPSHOT" <(echo "$PORTS_CURRENT") 2>/dev/null)
PORTS_DIFF_GONE=$(comm -23 "$PORTS_SNAPSHOT" <(echo "$PORTS_CURRENT") 2>/dev/null)

if [ -n "$PORTS_DIFF_NEW" ]; then
    ALERTS="${ALERTS}\n\n🟡 <b>New listening ports:</b>"
    while IFS= read -r port; do
        [ -z "$port" ] && continue
        PROC=$(ss -tlnp 2>/dev/null | grep "$port" | grep -oP 'users:\(\("\K[^"]+' | head -1)
        ALERTS="${ALERTS}\n  • <code>${port}</code> (${PROC:-unknown})"
    done <<< "$PORTS_DIFF_NEW"
fi

if [ -n "$PORTS_DIFF_GONE" ]; then
    ALERTS="${ALERTS}\n\n🟡 <b>Ports no longer listening:</b>"
    while IFS= read -r port; do
        [ -z "$port" ] && continue
        ALERTS="${ALERTS}\n  • <code>${port}</code>"
    done <<< "$PORTS_DIFF_GONE"
fi

# --- Update snapshots ---
echo "$FW_CURRENT" > "$FW_SNAPSHOT"
echo "$PORTS_CURRENT" > "$PORTS_SNAPSHOT"

echo "[$TIMESTAMP] Firewall: $FW_STATUS. Ports: $(echo "$PORTS_CURRENT" | wc -l)." >> "$LOG_FILE"

if [ -n "$ALERTS" ]; then
    MESSAGE="<b>🛡️ Firewall Audit</b>\n<i>${TIMESTAMP}</i>\n${ALERTS}"
    echo "[$TIMESTAMP] Changes detected." >> "$LOG_FILE"
    "$SCRIPT_DIR/notify.sh" "$(echo -e "$MESSAGE")" "firewall-audit"
else
    echo "[$TIMESTAMP] No changes from baseline." >> "$LOG_FILE"
fi
