#!/bin/bash
# Send a Telegram notification with optional rerun button.
# Usage: ./notify.sh "Your message here" [script-name]
#   script-name: if provided, adds a "Rerun" inline button that triggers the script
# Loads TG_BOT_TOKEN and TG_CHAT_ID from ~/jarvis/.env

JARVIS_ENV="$HOME/jarvis/.env"

if [ ! -f "$JARVIS_ENV" ]; then
    echo "Error: $JARVIS_ENV not found" >&2
    exit 1
fi

source "$JARVIS_ENV"

if [ -z "$TG_BOT_TOKEN" ] || [ -z "$TG_CHAT_ID" ]; then
    echo "Error: TG_BOT_TOKEN or TG_CHAT_ID not set in $JARVIS_ENV" >&2
    exit 1
fi

MESSAGE="$1"
RERUN_SCRIPT="$2"

if [ -z "$MESSAGE" ]; then
    echo "Usage: $0 \"message\" [script-name]" >&2
    exit 1
fi

if [ -n "$RERUN_SCRIPT" ]; then
    REPLY_MARKUP="{\"inline_keyboard\":[[{\"text\":\"🔄 Rerun\",\"callback_data\":\"j:${RERUN_SCRIPT}\"}]]}"
    curl -s -X POST "https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage" \
        -d chat_id="$TG_CHAT_ID" \
        -d parse_mode="HTML" \
        -d text="$MESSAGE" \
        -d reply_markup="$REPLY_MARKUP" > /dev/null 2>&1
else
    curl -s -X POST "https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage" \
        -d chat_id="$TG_CHAT_ID" \
        -d parse_mode="HTML" \
        -d text="$MESSAGE" > /dev/null 2>&1
fi
