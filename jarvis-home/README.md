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
QBT_URL=http://localhost:20008
QBT_USERNAME=admin
QBT_PASSWORD=your-password
```

3. Start Jarvis interactively:

```bash
jarvis
```

## Telegram Bot

The bot provides mobile access with three tiers:

**Free commands** (no AI cost):
- `/status` — system health
- `/docker` — container management
- `/storage` — disk usage
- `/network` — interfaces and ports
- `/services` — systemd status
- `/ha` — Home Assistant control (status, states, toggle, turn_on, turn_off)
- `/n8n` — workflow management
- `/download` — torrent downloads (add, list, status)

**Hybrid commands** (AI designs once, HA runs forever):
- `/ha automate <description>` — Claude generates an HA automation and pushes it via REST API
- `/ha scene <description>` — Claude generates an HA scene definition and pushes it

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

## Smart Home (Phase 4)

Two-tier integration with Home Assistant:

| Tier | What | Cost |
|------|------|------|
| **Free** | HA-native automations (presence, time, sensors) — run on HA 24/7 | $0 |
| **Hybrid** | `/ha automate` and `/ha scene` — Claude designs once, HA runs forever | One-time AI call |

## Media Downloads (Phase 5)

Torrent-based media downloads with smart file organization:

```
/download <hash|url|magnet> [movie|tv]  →  qBittorrent downloads
                                            ↓ (on completion)
                                        post-download.sh parses filename
                                            ↓
                                        Telegram: proposed folder structure
                                            ↓ (you tap Confirm/Edit/Skip)
                                        File moved to Jellyfin library
```

**Naming convention:**
- Movies: `~/shared-storage-2/movies/<Title> (<Year>)/<file>`
- TV Shows: `~/shared-storage-2/tv-shows/<Show Name>/Season <N>/<file>`

**Input formats:** info hash, Stremio streaming URL, or magnet link.

When the filename is hard to parse (no `SxxExx` or year pattern), Claude Haiku is used to determine the correct title and folder structure.

**Claude model assignments:**

| Usage | Model | Rationale |
|-------|-------|-----------|
| Free-text chat (`askClaude`) | Opus | Deep reasoning for open-ended conversations |
| `/ha automate`, `/ha scene` | Sonnet | Balanced quality for structured tool-use tasks |
| Filename parsing (post-download) | Haiku | Fast, cheap extraction — ideal for simple JSON output |

### qBittorrent setup (first time)

```bash
cd ~/jarvis && docker compose up -d
docker logs qbittorrent    # get initial password
# Set your password in qBittorrent web UI at http://kamuri-mini-pc:20008
# Update ~/jarvis/.env with QBT_PASSWORD
# In qBittorrent Settings > Downloads > "Run external program on torrent finished":
#   bash /home/iot/jarvis/scripts/post-download.sh "%N" "%L" "%F" "%I"
```

## Monitoring (Cron)

All monitoring runs via cron with Telegram alerts — zero AI cost:

| Script | Schedule | Purpose |
|--------|----------|---------|
| `disk-watchdog.sh` | Every 6h | Alerts if any disk > 90% |
| `smart-monitor.sh` | Daily | SMART health checks |
| `service-monitor.sh` | Every 15m | Docker + systemd + port checks |
| `samba-monitor.sh` | Every 15m | Samba service + share mount checks |
| `backup-checker.sh` | Daily | Home Assistant backup freshness |

## File Structure (deployed)

```
~/jarvis/
├── CLAUDE.md                    # Project context for Claude Code
├── .claude/
│   ├── rules/                   # Persona, safety, infrastructure rules
│   ├── commands/                # /status, /docker, /ha-automate, /ha-scene, etc.
│   ├── agents/                  # Diagnostics, docker-ops, research subagents
│   └── settings.json            # Allowed/denied commands
├── scripts/                     # Monitoring cron scripts
├── logs/                        # Monitoring logs
├── downloads/pending/           # Download organize queue (JSON metadata)
├── docker-compose.yml           # qBittorrent media service
├── qbittorrent-config/          # qBittorrent persistent config
├── telegram-bot/                # Telegram bot (Node.js)
│   ├── src/
│   │   ├── index.js             # Bot entry point
│   │   ├── commands/            # Slash command handlers
│   │   ├── claude.js            # Claude Code CLI integration
│   │   └── utils.js             # Helpers
│   └── package.json
└── .env                         # Secrets (not in git)
```
