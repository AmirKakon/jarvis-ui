#!/bin/bash
# Post-download handler for qBittorrent.
# Parses torrent filenames, proposes folder structure, and sends
# a Telegram confirmation before moving files.
#
# Called by qBittorrent "Run after completion" with:
#   post-download.sh "%N" "%L" "%F" "%I"
#   %N = torrent name, %L = category, %F = content path, %I = info hash

set -euo pipefail

JARVIS_ENV="$HOME/jarvis/.env"
PENDING_DIR="$HOME/jarvis/downloads/pending"
LOG_FILE="$HOME/jarvis/logs/post-download.log"
NOTIFY="$HOME/jarvis/scripts/notify.sh"

TORRENT_NAME="${1:-}"
CATEGORY="${2:-}"
CONTENT_PATH="${3:-}"
INFO_HASH="${4:-}"

if [ -z "$TORRENT_NAME" ] || [ -z "$CONTENT_PATH" ]; then
    echo "Usage: $0 <torrent-name> <category> <content-path> <info-hash>" >&2
    exit 1
fi

source "$JARVIS_ENV"
mkdir -p "$PENDING_DIR" "$(dirname "$LOG_FILE")"

SHORT_HASH="${INFO_HASH:0:8}"
TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')

log() {
    echo "[$TIMESTAMP] $*" >> "$LOG_FILE"
}

log "Download complete: $TORRENT_NAME (hash=$INFO_HASH, category=$CATEGORY)"

# --- Step 1: Try regex parsing ---
parse_filename() {
    local name="$1"

    # TV show: match SxxExx pattern
    if echo "$name" | grep -qiP '[.\s_-][Ss]\d{1,2}[Ee]\d{1,2}'; then
        local show season episode quality
        show=$(echo "$name" | sed -E 's/[.\s_-]*[Ss][0-9]+[Ee][0-9]+.*//' | tr '._' '  ' | sed 's/  */ /g;s/^ *//;s/ *$//')
        season=$(echo "$name" | grep -oiP '[Ss]\K\d+' | head -1 | sed 's/^0*//')
        episode=$(echo "$name" | grep -oiP '[Ee]\K\d+' | head -1 | sed 's/^0*//')
        quality=$(echo "$name" | grep -oiP '\d{3,4}p' | head -1)

        if [ -n "$show" ] && [ -n "$season" ] && [ -n "$episode" ]; then
            # Title case the show name
            show=$(echo "$show" | sed 's/\b\(.\)/\u\1/g')
            cat <<EOJSON
{
  "type": "tv",
  "title": "$show",
  "season": $season,
  "episode": $episode,
  "quality": "${quality:-unknown}",
  "source_file": "$CONTENT_PATH",
  "destination": "$HOME/shared-storage-2/tv-shows/$show/Season $season/$(basename "$CONTENT_PATH")"
}
EOJSON
            return 0
        fi
    fi

    # Movie: match year pattern (4 digits between 1920-2029)
    if echo "$name" | grep -qP '[.\s_-](19[2-9]\d|20[0-2]\d)[.\s_-]'; then
        local title year quality
        title=$(echo "$name" | sed -E 's/[.\s_-]*(19[2-9][0-9]|20[0-2][0-9]).*//' | tr '._' '  ' | sed 's/  */ /g;s/^ *//;s/ *$//')
        year=$(echo "$name" | grep -oP '(19[2-9]\d|20[0-2]\d)' | head -1)
        quality=$(echo "$name" | grep -oiP '\d{3,4}p' | head -1)

        if [ -n "$title" ] && [ -n "$year" ]; then
            title=$(echo "$title" | sed 's/\b\(.\)/\u\1/g')
            cat <<EOJSON
{
  "type": "movie",
  "title": "$title",
  "year": $year,
  "quality": "${quality:-unknown}",
  "source_file": "$CONTENT_PATH",
  "destination": "$HOME/shared-storage-2/movies/$title ($year)/$(basename "$CONTENT_PATH")"
}
EOJSON
            return 0
        fi
    fi

    return 1
}

PARSE_RESULT=""

if PARSE_RESULT=$(parse_filename "$TORRENT_NAME"); then
    log "Regex parse succeeded"
else
    # --- Step 2: Fall back to Claude ---
    log "Regex parse failed, falling back to Claude"
    CLAUDE_PROMPT="Parse this torrent filename and return ONLY a JSON object (no markdown, no explanation):
\"$TORRENT_NAME\"

Return exactly this JSON structure:
{
  \"type\": \"movie\" or \"tv\",
  \"title\": \"Clean Title Name\",
  \"year\": 2024 (for movies, omit for TV),
  \"season\": 1 (for TV, omit for movies),
  \"episode\": 5 (for TV, omit for movies),
  \"quality\": \"720p\",
  \"source_file\": \"$CONTENT_PATH\",
  \"destination\": \"(fill based on type: movies/<Title> (<Year>)/<filename> or tv-shows/<Title>/Season <N>/<filename>)\"
}

Base path for destination: $HOME/shared-storage-2
Filename for destination: $(basename "$CONTENT_PATH")"

    ESCAPED_PROMPT=$(echo "$CLAUDE_PROMPT" | sed "s/'/'\\\\''/g")
    PARSE_RESULT=$(cd "$HOME/jarvis" && claude --dangerously-skip-permissions -p "$ESCAPED_PROMPT" 2>/dev/null | grep -Pzo '\{[^}]*\}' | tr '\0' '\n' | head -1) || true

    if [ -z "$PARSE_RESULT" ]; then
        log "Claude parse also failed, writing raw pending entry"
        PARSE_RESULT=$(cat <<EOJSON
{
  "type": "unknown",
  "title": "$TORRENT_NAME",
  "quality": "unknown",
  "source_file": "$CONTENT_PATH",
  "destination": "$HOME/shared-storage-2/downloads/$(basename "$CONTENT_PATH")"
}
EOJSON
)
    fi
fi

# --- Step 3: Write pending file ---
echo "$PARSE_RESULT" > "$PENDING_DIR/${SHORT_HASH}.json"
log "Pending file written: $PENDING_DIR/${SHORT_HASH}.json"

# --- Step 4: Send Telegram confirmation ---
TYPE=$(echo "$PARSE_RESULT" | grep -oP '"type"\s*:\s*"\K[^"]+')
TITLE=$(echo "$PARSE_RESULT" | grep -oP '"title"\s*:\s*"\K[^"]+')
DEST=$(echo "$PARSE_RESULT" | grep -oP '"destination"\s*:\s*"\K[^"]+')
QUALITY=$(echo "$PARSE_RESULT" | grep -oP '"quality"\s*:\s*"\K[^"]+')

# Build a clean summary
ICON="🎬"
[ "$TYPE" = "tv" ] && ICON="📺"
[ "$TYPE" = "unknown" ] && ICON="❓"

MSG="<b>${ICON} Download Complete</b>

<b>Title:</b> $TITLE
<b>Type:</b> $TYPE
<b>Quality:</b> ${QUALITY:-unknown}

<b>Move to:</b>
<code>$(echo "$DEST" | sed "s|$HOME/||")</code>

Tap below to confirm or edit."

REPLY_MARKUP="{\"inline_keyboard\":[[{\"text\":\"✅ Confirm\",\"callback_data\":\"dl:c:${SHORT_HASH}\"},{\"text\":\"✏️ Edit\",\"callback_data\":\"dl:e:${SHORT_HASH}\"},{\"text\":\"⏭ Skip\",\"callback_data\":\"dl:s:${SHORT_HASH}\"}]]}"

curl -s -X POST "https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage" \
    -d chat_id="$TG_CHAT_ID" \
    -d parse_mode="HTML" \
    -d text="$MSG" \
    -d reply_markup="$REPLY_MARKUP" > /dev/null 2>&1

log "Telegram confirmation sent for $SHORT_HASH"
