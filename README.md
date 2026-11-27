# Jarvis

A personal AI assistant running on a home Mini PC. You talk to it through Telegram, Alexa, a phone call (Twilio), Home Assistant Assist, or a Galaxy Gear S watch; it controls the home server and Home Assistant, manages reminders and the calendar, searches the web, and remembers past conversations.

Everything lives in **[`jarvis-home/`](jarvis-home/README.md)**. That README has setup, the Telegram commands, memory, monitoring and the deployed file layout.

## Layout

| Path | What it is |
|------|------------|
| `jarvis-home/telegram-bot/` | The assistant: a Node.js service holding the brain, the Telegram bot and the HTTP endpoints (Alexa, Twilio, Assist, watch relay) |
| `jarvis-home/.claude/`, `jarvis-home/CLAUDE.md` | Context, rules, commands and subagents for Claude Code runs on the server |
| `jarvis-home/scripts/` | Cron monitors and helper scripts |
| `jarvis-home/sql/schema.sql` | Database schema (PostgreSQL + pgvector) |
| `jarvis-home/setup.sh` | Deploys everything to `~/jarvis/` on the Mini PC |
| `homeassistant/` | Home Assistant packages, automations and dashboards |
| `n8n/` | n8n workflows (Google Calendar sync); `scripts/` holds their import/export helpers |
| `FEATURE_IDEAS.md` | Roadmap, shipped work and design notes |

## Deploy

On the Mini PC:

```bash
cd ~/repos/jarvis-ui && git pull && bash jarvis-home/setup.sh
```

Or tap **🚀 Deploy** after a self-development change in Telegram.

## History

Until November 2026 this repo also held a FastAPI backend and a React web UI (the original "Jarvis UI"). They were replaced by the Node.js assistant and removed; `git log -- backend frontend` finds them if you ever need them.
