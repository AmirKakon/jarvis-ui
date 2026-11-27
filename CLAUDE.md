# CLAUDE.md

## Project overview

JARVIS is a personal AI assistant running on a home Mini PC (`kamuri-mini-pc`, user `iot`). The assistant is one Node.js service in `jarvis-home/telegram-bot/`. Surfaces (Telegram, Alexa, Twilio calls, Home Assistant Assist, watch SMS relay) all call the same brain.

There is no separate backend or web UI any more; the old FastAPI + React app was removed in November 2026.

## Architecture

```
Telegram ─┐
Alexa ────┤                      ┌─ domain agents (ha, remind, calendar, weather, jellyfin, bus, …)
Twilio ───┼─► brain.js askCore ─►├─ MCP servers (~/jarvis/mcp.json: Home Assistant, QRganize, RecipeRack)
Assist ───┤   front router        ├─ Claude Agent SDK (delegate, /deep, selfdev) with a PreToolUse guard
Watch ────┘   (native tool calls) └─ web search / fetch / code execution (Anthropic server tools)
                     │
                     └─ memory.js: PostgreSQL + pgvector (sessions, summaries, facts, knowledge graph)
```

- **Router**: `brain.js` calls the front model (Haiku) with the tools in `front-tools.js`. Each tool call becomes an action object `{ <tool>: true, ...input }` that `runOne()` dispatches. No tool call means a direct answer.
- **Domain tools take structured fields**, not the user's raw text. Date maths lives in code: `agents/schedule-spec.js` and `time.js` (always Asia/Jerusalem, never the server TZ).
- **Server tasks** run Claude Code in-process via `agents/claude-agent.js` (`@anthropic-ai/claude-agent-sdk`), in `~/jarvis` for delegate and `/deep`, and in the repo's `jarvis-home/` for selfdev. Safety rules are enforced by its `PreToolUse` hook.
- **Models**: every model ID comes from `models.js` (overridable in `~/jarvis/.env`).
- **Schedulers**: reminders, morning briefing and Shabbat run inside the bot (`services/*-scheduler.js`); system monitors are cron scripts in `jarvis-home/scripts/`.

## Repository structure

```
jarvis-home/
  telegram-bot/src/   brain.js, front-tools.js, claude.js (Telegram adapter), server.js (HTTP),
                      alexa.js, voice.js, memory.js, models.js, time.js,
                      agents/, commands/, services/
  .claude/            rules, commands, subagents for Claude Code on the server
  scripts/            cron monitors and helpers
  sql/schema.sql      database schema (idempotent; applied by setup.sh)
  setup.sh            deploys to ~/jarvis and restarts the bot
homeassistant/        HA packages, automations, dashboards (applied to HA by hand)
n8n/                  n8n workflows (Google Calendar sync webhook)
scripts/              n8n workflow import/export helpers (Windows)
FEATURE_IDEAS.md      roadmap and design notes — update it when shipping a feature
```

## Commands

```bash
cd jarvis-home/telegram-bot
npm install
npm test               # node --test, all *.test.js under src/
node --check src/x.js  # syntax check

# On the Mini PC
cd ~/repos/jarvis-ui && git pull && bash jarvis-home/setup.sh
journalctl --user -u jarvis-telegram-bot -f
```

## Code conventions

- Node.js ESM, plain JavaScript (no TypeScript), Node 18+.
- Tests use `node:test` + `node:assert/strict`, next to the code (`foo.js` → `foo.test.js`). Stub `globalThis.fetch` rather than calling real APIs.
- Read `process.env` lazily (inside functions): `index.js` loads `~/jarvis/.env` after module top-level code runs.
- Agent output is Markdown; the Telegram layer converts it with `mdToHtml`, and voice surfaces read it as plain text.
- Keep changes small and consistent with the surrounding code. No new abstractions without a second use.

## Ports (Mini PC)

| Port  | Service |
|-------|---------|
| 20002 | Jellyfin |
| 20003 | n8n |
| 20004 | PostgreSQL + pgvector |
| 20008 | qBittorrent |
| 20010 | JARVIS HTTP (`/ask`, Assist shim, Alexa, Twilio, watch relay) |
| 20011 | ustreamer webcam |
| 20443 | nginx HTTPS (Alexa + Twilio from the internet) |

## Important notes

- `~/jarvis/.env` holds secrets — never commit it, never print it.
- `~/jarvis` is a generated deploy copy; edit the repo, then run `setup.sh`.
- n8n is still used for Google Calendar sync; don't remove it without replacing that.
