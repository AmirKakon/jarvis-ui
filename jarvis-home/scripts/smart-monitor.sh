#!/bin/bash
# SMART drive health monitor — checks drive health and alerts on warnings.
# Intended to run via cron once daily.
# Requires: smartmontools (sudo apt install smartmontools)
# Logs to ~/jarvis/logs/smart-monitor.log
#
# To suppress repeat alerts for a known-bad drive:
#   echo "/dev/sdb" >> ~/jarvis/logs/smart-acknowledged.txt

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_DIR="$HOME/jarvis/logs"
LOG_FILE="$LOG_DIR/smart-monitor.log"
ACK_FILE="$LOG_DIR/smart-acknowledged.txt"

mkdir -p "$LOG_DIR"

TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')
ALERTS=""

if ! command -v smartctl &> /dev/null; then
    echo "[$TIMESTAMP] smartctl not installed. Run: sudo apt install smartmontools" >> "$LOG_FILE"
    exit 0
fi

is_acknowledged() {
    [ -f "$ACK_FILE" ] && grep -qxF "$1" "$ACK_FILE"
}

for DRIVE in /dev/sd?; do
    [ -b "$DRIVE" ] || continue

    MODEL=$(sudo smartctl -i "$DRIVE" 2>/dev/null | grep "Device Model\|Model Family" | head -1 | awk -F: '{print $2}' | xargs)
    [ -z "$MODEL" ] && MODEL="$DRIVE"

    HEALTH_OUTPUT=$(sudo smartctl -H "$DRIVE" 2>&1)

    # Detect USB drives that can't report SMART
    if echo "$HEALTH_OUTPUT" | grep -qi "scsi error\|unable to detect\|SMART command failed\|device will be ready"; then
        echo "[$TIMESTAMP] $DRIVE ($MODEL): SMART unavailable (USB passthrough not supported)" >> "$LOG_FILE"
        if ! is_acknowledged "$DRIVE"; then
            ALERTS="${ALERTS}\n🟠 <b>${DRIVE}</b> (${MODEL}): SMART unavailable via USB"
        fi
        continue
    fi

    if echo "$HEALTH_OUTPUT" | grep -qi "PASSED\|OK"; then
        echo "[$TIMESTAMP] $DRIVE ($MODEL): PASSED" >> "$LOG_FILE"
    else
        echo "[$TIMESTAMP] $DRIVE ($MODEL): FAILED" >> "$LOG_FILE"
        if ! is_acknowledged "$DRIVE"; then
            ALERTS="${ALERTS}\n🔴 <b>${DRIVE}</b> (${MODEL}): SMART health FAILED"
        fi
    fi

    ATTRS=$(sudo smartctl -A "$DRIVE" 2>/dev/null)

    REALLOC=$(echo "$ATTRS" | grep "Reallocated_Sector" | awk '{print $10}')
    if [ -n "$REALLOC" ] && [ "$REALLOC" -gt 0 ] 2>/dev/null; then
        echo "[$TIMESTAMP] $DRIVE ($MODEL): $REALLOC reallocated sectors" >> "$LOG_FILE"
        if ! is_acknowledged "$DRIVE"; then
            ALERTS="${ALERTS}\n🟡 ${DRIVE} (${MODEL}): ${REALLOC} reallocated sectors"
        fi
    fi

    PENDING=$(echo "$ATTRS" | grep "Current_Pending_Sector" | awk '{print $10}')
    if [ -n "$PENDING" ] && [ "$PENDING" -gt 0 ] 2>/dev/null; then
        echo "[$TIMESTAMP] $DRIVE ($MODEL): $PENDING pending sectors" >> "$LOG_FILE"
        if ! is_acknowledged "$DRIVE"; then
            ALERTS="${ALERTS}\n🟡 ${DRIVE} (${MODEL}): ${PENDING} pending sectors"
        fi
    fi

    TEMP=$(echo "$ATTRS" | grep "Temperature_Celsius" | awk '{print $10}')
    if [ -n "$TEMP" ] && [ "$TEMP" -gt 55 ] 2>/dev/null; then
        ALERTS="${ALERTS}\n🟡 ${DRIVE} (${MODEL}): temperature ${TEMP}°C (high)"
    fi
done

echo "[$TIMESTAMP] SMART check complete." >> "$LOG_FILE"

if [ -n "$ALERTS" ]; then
    MESSAGE="<b>Jarvis Drive Health Alert</b>\n<i>${TIMESTAMP}</i>\n${ALERTS}"
    MESSAGE="${MESSAGE}\n\n<i>To dismiss a drive: echo \"/dev/sdX\" &gt;&gt; ~/jarvis/logs/smart-acknowledged.txt</i>"
    echo "[$TIMESTAMP] Alerts found:$ALERTS" >> "$LOG_FILE"
    "$SCRIPT_DIR/notify.sh" "$(echo -e "$MESSAGE")" "smart-monitor"
else
    echo "[$TIMESTAMP] All drives healthy." >> "$LOG_FILE"
fi
