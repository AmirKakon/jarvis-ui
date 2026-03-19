# Jarvis — Claude Code Home Server Assistant

AI-powered home server management running on a Mini PC via Claude Code, with mobile access through Telegram.

## Architecture

```
Mobile (Telegram)                  Terminal (SSH)
       │                                │
       ▼                                ▼
┌──────────────────┐          ┌──────────────────┐
│  Telegram Bot    │          │  Claude Code CLI  │
│  (Node.js)       │          │  (interactive)    │
│  - /commands     │──FREE    │  - full access    │
│  - free-text ────│──AI $──► │  - CLAUDE.md      │
└──────────────────┘          │  - rules/commands │
                              └──────────────────┘
                                       │
                              ┌────────┴─────────┐
                              │  Mini PC (Linux)  │
                              │  - Docker         │
                              │  - n8n            │
                              │  - Jellyfin       │
                              │  - PostgreSQL     │
                              │  - Samba shares   │
                              │  - Home Assistant │
                              │  - Cron monitors  │
                              └──────────────────┘
```

## Components

| Component | Purpose |
|-----------|---------|
| `CLAUDE.md` + `.claude/` | Claude Code project context, rules, commands, agents |
| `scripts/` | Cron-based monitoring (disk, SMART, services, backups) |
| `telegram-bot/` | Telegram bot for mobile access to Jarvis |
| `setup.sh` | Deployment script — deploys everything to `~/jarvis/` |

## Setup

1. Clone the repo on the mini PC and run `setup.sh`:

```bash
cd ~/repos/jarvis-ui/jarvis-home
bash setup.sh
```

2. Edit `~/jarvis/.env` with your credentials:

```
HA_URL=http://192.168.68.113:8123
HA_TOKEN=your-token
N8N_URL=http://localhost:20003
N8N_API_KEY=your-key
TG_BOT_TOKEN=your-bot-token
TG_CHAT_ID=your-chat-id
```

3. Start Jarvis interactively:

```bash
jarvis
```

## Telegram Bot

The bot provides mobile access with two tiers:

**Free commands** (no AI cost):
- `/status` — system health
- `/docker` — container management
- `/storage` — disk usage
- `/network` — interfaces and ports
- `/services` — systemd status
- `/ha` — Home Assistant control
- `/n8n` — workflow management

**AI-powered** (uses Claude Code):
- Send any free-text message to get a Claude-powered response
- Rate-limited (default 20 calls/hour) to control costs

The bot runs as a systemd user service (`jarvis-telegram-bot`) and auto-starts on boot.

### Managing the bot

```bash
systemctl --user status jarvis-telegram-bot
systemctl --user restart jarvis-telegram-bot
journalctl --user -u jarvis-telegram-bot -f
```

## Monitoring (Cron)

All monitoring runs via cron with Telegram alerts — zero AI cost:

| Script | Schedule | Purpose |
|--------|----------|---------|
| `disk-watchdog.sh` | Every 6h | Alerts if any disk > 90% |
| `smart-monitor.sh` | Daily | SMART health checks |
| `service-monitor.sh` | Every 15m | Docker + systemd + port checks |
| `backup-checker.sh` | Daily | Home Assistant backup freshness |

## File Structure (deployed)

```
~/jarvis/
├── CLAUDE.md                    # Project context for Claude Code
├── .claude/
│   ├── rules/                   # Persona, safety, infrastructure rules
│   ├── commands/                # /status, /docker, /services, etc.
│   ├── agents/                  # Diagnostics, docker-ops, research subagents
│   └── settings.json            # Allowed/denied commands
├── scripts/                     # Monitoring cron scripts
├── logs/                        # Monitoring logs
├── telegram-bot/                # Telegram bot (Node.js)
│   ├── src/
│   │   ├── index.js             # Bot entry point
│   │   ├── commands/            # Slash command handlers
│   │   ├── claude.js            # Claude Code CLI integration
│   │   └── utils.js             # Helpers
│   └── package.json
└── .env                         # Secrets (not in git)
```
