#!/bin/bash
# SMART drive health monitor — checks drive health and alerts on warnings.
# Intended to run via cron once daily.
# Requires: smartmontools (sudo apt install smartmontools)
# Logs to ~/jarvis/logs/smart-monitor.log

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_DIR="$HOME/jarvis/logs"
LOG_FILE="$LOG_DIR/smart-monitor.log"

mkdir -p "$LOG_DIR"

TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')
ALERTS=""

if ! command -v smartctl &> /dev/null; then
    echo "[$TIMESTAMP] smartctl not installed. Run: sudo apt install smartmontools" >> "$LOG_FILE"
    exit 0
fi

for DRIVE in /dev/sd?; do
    [ -b "$DRIVE" ] || continue

    MODEL=$(sudo smartctl -i "$DRIVE" 2>/dev/null | grep "Device Model\|Model Family" | head -1 | awk -F: '{print $2}' | xargs)
    [ -z "$MODEL" ] && MODEL="$DRIVE"

    HEALTH=$(sudo smartctl -H "$DRIVE" 2>/dev/null | grep -i "overall-health\|SMART Health Status")

    if echo "$HEALTH" | grep -qi "PASSED\|OK"; then
        echo "[$TIMESTAMP] $DRIVE ($MODEL): PASSED" >> "$LOG_FILE"
    else
        ALERTS="${ALERTS}\n🔴 <b>${DRIVE}</b> (${MODEL}): SMART health FAILED"
        echo "[$TIMESTAMP] $DRIVE ($MODEL): FAILED" >> "$LOG_FILE"
    fi

    # Check for reallocated sectors, pending sectors, and temperature
    ATTRS=$(sudo smartctl -A "$DRIVE" 2>/dev/null)

    REALLOC=$(echo "$ATTRS" | grep "Reallocated_Sector" | awk '{print $10}')
    if [ -n "$REALLOC" ] && [ "$REALLOC" -gt 0 ] 2>/dev/null; then
        ALERTS="${ALERTS}\n🟡 ${DRIVE} (${MODEL}): ${REALLOC} reallocated sectors"
    fi

    PENDING=$(echo "$ATTRS" | grep "Current_Pending_Sector" | awk '{print $10}')
    if [ -n "$PENDING" ] && [ "$PENDING" -gt 0 ] 2>/dev/null; then
        ALERTS="${ALERTS}\n🟡 ${DRIVE} (${MODEL}): ${PENDING} pending sectors"
    fi

    TEMP=$(echo "$ATTRS" | grep "Temperature_Celsius" | awk '{print $10}')
    if [ -n "$TEMP" ] && [ "$TEMP" -gt 55 ] 2>/dev/null; then
        ALERTS="${ALERTS}\n🟡 ${DRIVE} (${MODEL}): temperature ${TEMP}°C (high)"
    fi
done

echo "[$TIMESTAMP] SMART check complete." >> "$LOG_FILE"

if [ -n "$ALERTS" ]; then
    MESSAGE="<b>Jarvis Drive Health Alert</b>\n<i>${TIMESTAMP}</i>\n${ALERTS}"
    echo "[$TIMESTAMP] Alerts found:$ALERTS" >> "$LOG_FILE"
    "$SCRIPT_DIR/notify.sh" "$(echo -e "$MESSAGE")" "smart-monitor"
else
    echo "[$TIMESTAMP] All drives healthy." >> "$LOG_FILE"
fi
