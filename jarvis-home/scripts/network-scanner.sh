#!/bin/bash
# Network scanner — detects new/unknown devices on the local network.
# Maintains a known-devices baseline and alerts on new devices.
# Runs via cron every hour.
# Logs to ~/jarvis/logs/network-scanner.log

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_DIR="$HOME/jarvis/logs"
LOG_FILE="$LOG_DIR/network-scanner.log"
KNOWN_FILE="$HOME/jarvis/known-devices.txt"
LABELS_FILE="$HOME/jarvis/known-devices-labels.conf"
SCAN_FILE="$LOG_DIR/network-scan-latest.txt"

mkdir -p "$LOG_DIR"

get_label() {
    local ip="$1"
    if [ -f "$LABELS_FILE" ]; then
        local label
        label=$(grep -v '^#' "$LABELS_FILE" | awk -F'\t' -v ip="$ip" '$1 == ip {print $2}')
        if [ -n "$label" ]; then
            echo "$label"
            return
        fi
    fi
    echo "unknown"
}

TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')

scan_network() {
    if command -v arp-scan &>/dev/null; then
        sudo arp-scan --localnet --quiet 2>/dev/null | grep -E '^[0-9]+\.' | awk '{print $2 "\t" $1}'
    elif command -v nmap &>/dev/null; then
        sudo nmap -sn 192.168.68.0/24 2>/dev/null | grep -B1 "Host is up" | grep "Nmap scan" | awk '{print "unknown\t" $NF}' | tr -d '()'
    else
        ip neigh show | grep -v FAILED | awk '{print $5 "\t" $1}' | sort -u
    fi
}

SCAN_RESULT=$(scan_network)
if [ -z "$SCAN_RESULT" ]; then
    echo "[$TIMESTAMP] Network scan returned no results (check permissions or tool availability)" >> "$LOG_FILE"
    exit 0
fi

echo "$SCAN_RESULT" | sort > "$SCAN_FILE"
DEVICE_COUNT=$(echo "$SCAN_RESULT" | wc -l)

if [ ! -f "$KNOWN_FILE" ]; then
    while IFS=$'\t' read -r MAC IP; do
        LABEL=$(get_label "$IP")
        echo -e "${MAC}\t${IP}\t${LABEL}"
    done <<< "$SCAN_RESULT" | sort > "$KNOWN_FILE"
    echo "[$TIMESTAMP] Baseline established: $DEVICE_COUNT devices" >> "$LOG_FILE"
    "$SCRIPT_DIR/notify.sh" "$(echo -e "<b>🔍 Network Scanner — Baseline</b>\n<i>${TIMESTAMP}</i>\n\nEstablished baseline with <b>${DEVICE_COUNT}</b> devices.\nEdit ~/jarvis/known-devices-labels.conf to update labels.")" "network-scanner"
    exit 0
fi

KNOWN_MACS=$(awk '{print tolower($1)}' "$KNOWN_FILE" | sort)

ALERTS=""
NEW_DEVICES=""
while IFS=$'\t' read -r MAC IP; do
    MAC_LOWER=$(echo "$MAC" | tr '[:upper:]' '[:lower:]')
    if ! echo "$KNOWN_MACS" | grep -qx "$MAC_LOWER"; then
        LABEL=$(get_label "$IP")
        ALERTS="${ALERTS}\n🔴 New device: <b>${MAC}</b> (${IP}) — ${LABEL}"
        NEW_DEVICES="${NEW_DEVICES}\n${MAC}\t${IP}\t${LABEL}"
    fi
done <<< "$SCAN_RESULT"

echo "[$TIMESTAMP] Scanned $DEVICE_COUNT devices." >> "$LOG_FILE"

if [ -n "$ALERTS" ]; then
    echo "[$TIMESTAMP] NEW DEVICES FOUND:$ALERTS" >> "$LOG_FILE"
    if [ -n "$NEW_DEVICES" ]; then
        echo -e "$NEW_DEVICES" >> "$KNOWN_FILE"
    fi
    MESSAGE="<b>🔍 Network Scanner Alert</b>\n<i>${TIMESTAMP}</i>\n${ALERTS}\n\nDevices auto-added to known list.\nEdit ~/jarvis/known-devices.txt to label them."
    "$SCRIPT_DIR/notify.sh" "$(echo -e "$MESSAGE")" "network-scanner"
else
    echo "[$TIMESTAMP] All $DEVICE_COUNT devices are known." >> "$LOG_FILE"
fi
