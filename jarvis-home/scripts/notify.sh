#!/bin/bash
# Send a Telegram notification with optional rerun + troubleshooting buttons.
# Usage: ./notify.sh "Your message here" [script-name] [action-spec ...]
#   script-name: if provided, adds a "🔄 Rerun" inline button that triggers the script
#   action-spec: zero or more "kind:value" pairs, each rendered as an inline button:
#       restart-service:<name>       restart a system service         (ts:rs:)
#       restart-user-service:<name>  restart a user   service         (ts:ru:)
#       logs-service:<name>          view system service logs         (ts:ls:)
#       logs-user-service:<name>     view user   service logs         (ts:lu:)
#       restart-container:<name>     restart a docker container       (d:r:)
#       logs-container:<name>        view docker container logs       (d:l:)
#       block-ip:<ip>                block an IP via ufw (confirmed)   (ts:bi:)
# Deduplication: identical alerts from the same script are suppressed for 1 hour.
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
ACTIONS=("${@:3}")

if [ -z "$MESSAGE" ]; then
    echo "Usage: $0 \"message\" [script-name] [action-spec ...]" >&2
    exit 1
fi

# --- Deduplication: suppress identical alerts within cooldown ---
DEDUP_DIR="$HOME/jarvis/state/alert-dedup"
COOLDOWN_SECONDS=3600
mkdir -p "$DEDUP_DIR"

SCRIPT_TAG="${RERUN_SCRIPT:-generic}"
MSG_HASH=$(echo "$MESSAGE" | md5sum | cut -d' ' -f1)
STATE_FILE="$DEDUP_DIR/${SCRIPT_TAG}_${MSG_HASH}"

if [ -f "$STATE_FILE" ]; then
    LAST_SENT=$(cat "$STATE_FILE")
    NOW=$(date +%s)
    if [ $((NOW - LAST_SENT)) -lt $COOLDOWN_SECONDS ]; then
        exit 0
    fi
fi

date +%s > "$STATE_FILE"

# Clean up state files older than 24 hours
find "$DEDUP_DIR" -type f -mmin +1440 -delete 2>/dev/null

# --- Map an action spec ("kind:value") to a button JSON object ---
build_button() {
    local spec="$1"
    local kind="${spec%%:*}"
    local val="${spec#*:}"
    local text="" data=""

    case "$kind" in
        restart-service)      text="🔧 Restart ${val}"; data="ts:rs:${val}" ;;
        restart-user-service) text="🔧 Restart ${val}"; data="ts:ru:${val}" ;;
        logs-service)         text="📄 Logs ${val}";    data="ts:ls:${val}" ;;
        logs-user-service)    text="📄 Logs ${val}";    data="ts:lu:${val}" ;;
        restart-container)    text="🔧 Restart ${val}"; data="d:r:${val}" ;;
        logs-container)       text="📄 Logs ${val}";    data="d:l:${val}" ;;
        block-ip)             text="🚫 Block ${val}";   data="ts:bi:${val}" ;;
        *) return 1 ;;
    esac

    printf '{"text":"%s","callback_data":"%s"}' "$text" "$data"
}

# --- Build inline keyboard rows (2 action buttons per row, rerun on its own) ---
BTNS=()
for spec in "${ACTIONS[@]}"; do
    [ -z "$spec" ] && continue
    btn=$(build_button "$spec") && BTNS+=("$btn")
done

ROWS=()
i=0
while [ "$i" -lt "${#BTNS[@]}" ]; do
    if [ "$((i + 1))" -lt "${#BTNS[@]}" ]; then
        ROWS+=("[${BTNS[$i]},${BTNS[$((i + 1))]}]")
        i=$((i + 2))
    else
        ROWS+=("[${BTNS[$i]}]")
        i=$((i + 1))
    fi
done

if [ -n "$RERUN_SCRIPT" ]; then
    ROWS+=("[{\"text\":\"🔄 Rerun\",\"callback_data\":\"j:${RERUN_SCRIPT}\"}]")
fi

if [ "${#ROWS[@]}" -gt 0 ]; then
    KB=""
    for r in "${ROWS[@]}"; do
        KB="${KB:+$KB,}$r"
    done
    REPLY_MARKUP="{\"inline_keyboard\":[${KB}]}"
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
