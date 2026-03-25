#!/bin/bash
# Weekly memory maintenance: deduplication + pruning.
# Run via cron or n8n scheduled workflow.
#
# Usage: ./memory-maintenance.sh
# Requires: psql, DATABASE_URL in ~/jarvis/.env

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="${HOME}/jarvis/.env"

if [ -f "$ENV_FILE" ]; then
  export $(grep -E '^DATABASE_URL=' "$ENV_FILE" | xargs)
fi

if [ -z "${DATABASE_URL:-}" ]; then
  echo "ERROR: DATABASE_URL not set"
  exit 1
fi

TG_BOT_TOKEN=$(grep -oP 'TG_BOT_TOKEN=\K.*' "$ENV_FILE" 2>/dev/null || true)
TG_CHAT_ID=$(grep -oP 'TG_CHAT_ID=\K.*' "$ENV_FILE" 2>/dev/null || true)

send_telegram() {
  if [ -n "$TG_BOT_TOKEN" ] && [ -n "$TG_CHAT_ID" ]; then
    curl -s -X POST "https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage" \
      -d "chat_id=${TG_CHAT_ID}" \
      -d "parse_mode=HTML" \
      -d "text=$1" > /dev/null 2>&1 || true
  fi
}

echo "=== Memory Maintenance $(date -Iseconds) ==="

# --- 1. Deduplicate facts (embedding similarity > 0.92) ---
DEDUP_COUNT=$(psql "$DATABASE_URL" -t -A -c "
  WITH duplicates AS (
    SELECT f2.id
    FROM memory_facts f1
    JOIN memory_facts f2 ON f1.id < f2.id
    WHERE f1.embedding IS NOT NULL
      AND f2.embedding IS NOT NULL
      AND 1 - (f1.embedding <=> f2.embedding) > 0.92
  )
  DELETE FROM memory_facts WHERE id IN (SELECT id FROM duplicates)
  RETURNING id;
" 2>/dev/null | wc -l)
echo "Deduplicated facts removed: $DEDUP_COUNT"

# --- 2. Prune old summaries (>180 days, never accessed) ---
PRUNED_COUNT=$(psql "$DATABASE_URL" -t -A -c "
  DELETE FROM chat_summaries
  WHERE last_accessed_at IS NULL
    AND session_ended_at < NOW() - INTERVAL '180 days'
  RETURNING id;
" 2>/dev/null | wc -l)
echo "Old summaries pruned: $PRUNED_COUNT"

# --- 3. Gather stats ---
STATS=$(psql "$DATABASE_URL" -t -A -c "
  SELECT json_build_object(
    'facts', (SELECT COUNT(*) FROM memory_facts),
    'summaries', (SELECT COUNT(*) FROM chat_summaries),
    'oldest', (SELECT MIN(session_created_at)::date FROM chat_summaries),
    'newest', (SELECT MAX(session_ended_at)::date FROM chat_summaries)
  );
" 2>/dev/null)

FACTS=$(echo "$STATS" | python3 -c "import sys,json; print(json.loads(sys.stdin.read())['facts'])" 2>/dev/null || echo "?")
SUMMARIES=$(echo "$STATS" | python3 -c "import sys,json; print(json.loads(sys.stdin.read())['summaries'])" 2>/dev/null || echo "?")

echo "Current stats: $FACTS facts, $SUMMARIES summaries"

# --- 4. Report via Telegram ---
MSG="🧠 <b>Memory Maintenance Report</b>

📌 Facts: <b>${FACTS}</b>
📝 Summaries: <b>${SUMMARIES}</b>
🗑️ Duplicates removed: <b>${DEDUP_COUNT}</b>
🗑️ Old summaries pruned: <b>${PRUNED_COUNT}</b>"

send_telegram "$MSG"

echo "=== Done ==="
