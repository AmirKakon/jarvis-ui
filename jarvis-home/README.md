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
- `/security` — security dashboard (network, SSH, Docker, SSL, firewall)
- `/cam` — still from the mini-PC USB webcam (ustreamer)
- `/shabbat` — pre-Shabbat / Chag checklist and plata timer (see below)
- `/memory` — memory stats (fact count, summaries, topics)
- `/recall <query>` — search past conversations and facts

**Memory commands** (free + small embedding cost):
- `/remember <fact>` — store a permanent fact
- `/new` — end current session, summarize, start fresh

**Hybrid commands** (AI designs once, HA runs forever):
- `/ha automate <description>` — Claude generates an HA automation and pushes it via REST API
- `/ha scene <description>` — Claude generates an HA scene definition and pushes it

**AI-powered** (uses Claude Code):
- Send any free-text message to get a Claude-powered response
- Conversations are persisted and summarized automatically
- Rate-limited (default 20 calls/hour) to control costs

The bot runs as a systemd user service (`jarvis-telegram-bot`) and auto-starts on boot.

### Managing the bot

```bash
systemctl --user status jarvis-telegram-bot
systemctl --user restart jarvis-telegram-bot
journalctl --user -u jarvis-telegram-bot -f
cd ~/jarvis/telegram-bot && npm test   # unit tests (node --test)
```

### Pre-Shabbat checklist

One checklist with two front-ends, so you can use whichever you prefer:

- **Home Assistant** (`homeassistant/packages/shabbat_checklist.yaml` + `lovelace-shabbat-checklist.yaml`) owns the data — a Local To-do list (`todo.shabbat_checklist`) and helpers for home/away, plata timer mode and times — and runs the plata timer itself, so the plata works even if the mini-PC is down. It can also send phone notifications with Yes / Home, no plata / Away and Night/Day/Both buttons.
- **JARVIS** (`agents/shabbat.js`, `commands/shabbat.js`, `services/shabbat-scheduler.js`) shows the same list on Telegram with a button per item and plata mode, and edits the message in place when you tap. **⏱ Times** opens an editor with ± buttons for the plata lead before candle lighting, the night-off / day-on / day-off times, and the robot vacuum (on/off + minutes before candle lighting); it writes the HA helpers, so changes stick for future weeks (the HA dashboard card edits the same helpers).

**Robot vacuum:** when `input_boolean.shabbat_vacuum` is on, HA starts `vacuum.mova_e30_ultra` (Dreame/MOVA HACS integration) at candle lighting − `input_number.shabbat_vacuum_lead_minutes`, only if you answered home; answering home up to 30 min late still starts it, later doesn't. If the vacuum is offline at start time you get a phone alert. The checklist item becomes "fill the water tank (starts HH:MM)".

Flow on the day of candle lighting (Shabbat or Chag): 08:55 HA resets the list → 09:00 "home for Shabbat?" + early tasks (ice, vacuum) → candle −180 min main checklist → −45 min nudge with what's left → −15 min summary, then quiet. Answering "away" skips everything and keeps the plata off. Nothing fires while issur melacha is in effect, so a Chag running into Shabbat is asked once; at havdalah HA turns the plata off and resets the answers.

`input_select.shabbat_checklist_channel` (both / telegram / ha) picks who sends the reminders; ticks sync either way. Plata modes: **night** = candle lighting − lead → night-off time, **day** = day-on → day-off, **both** = candle lighting − lead → day-off the next day; a 26 h safety cap and havdalah always turn it off. **off** while home is a real answer ("Home, no plata", or the Off button) and ticks the plata item; until you answer, the mode is **unset** (treated as off). A timer mode ticks the item once the plug is online. Setup steps are at the top of the HA package.

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
| Session summarization (memory) | OpenAI small model (Haiku CLI fallback) | Cheap, fast — run automatically on session close |

Tier → model ID lives in `telegram-bot/src/models.js` (defaults: Haiku 5.5, Sonnet 5.5, Opus 5.5; override per tier/role in `~/jarvis/.env`). Haiku 5.x calls run with thinking disabled so short routing/extraction budgets aren't eaten by thinking. OpenAI: `gpt-6-luna` for the backup router and memory summaries (`OPENAI_SMALL_MODEL`), `gpt-transcribe` for voice notes (`OPENAI_TRANSCRIBE_MODEL`), `text-embedding-3-small` for memory search, `tts-1` for voice replies.

### qBittorrent setup (first time)

```bash
cd ~/jarvis && docker compose up -d
docker logs qbittorrent    # get initial password
# Set your password in qBittorrent web UI at http://kamuri-mini-pc:20008
# Update ~/jarvis/.env with QBT_PASSWORD
# In qBittorrent Settings > Downloads > "Run external program on torrent finished":
#   bash /home/iot/jarvis/scripts/post-download.sh "%N" "%L" "%F" "%I"
```

## Long-Term Memory (Phase 6)

Two-tier memory system with recency-weighted retrieval, inspired by OpenClaw's memory architecture.

```
User message → Session boundary check (30-min gap?)
                    ↓ yes                    ↓ no
            Summarize old session    Continue current session
            (Claude Haiku CLI)
            Store in chat_summaries
            (PGVector embedding)
                    ↓
            Build context for Claude:
            1. Durable facts (always included, never decay)
            2. Relevant past summaries (recency-weighted search)
            3. Current session history (last 10 messages)
                    ↓
            Claude Opus processes message with full memory context
```

### Memory tiers

| Tier | Table | Decay | Stored via |
|------|-------|-------|-----------|
| **Durable facts** | `memory_facts` | Never | `/remember` command or auto-extracted from summaries |
| **Session summaries** | `chat_summaries` | 30-day half-life | Auto-created when sessions close (30-min gap) |

### One conversation across surfaces

Facts and summaries are shared by every surface. The live session is keyed per surface (`tg:<chatId>`, `alexa:<hash>`, `ha:<id>`, `phone:<hash>`, `api:default`) unless `JARVIS_IDENTITY_MAP` maps those keys to one user (`telegram-bot/src/identity.js`):

```
JARVIS_IDENTITY_MAP=tg:123456789=amir,alexa:0123456789abcdef=amir,ha:*=amir,phone:*=amir
```

Mapped keys share one `user:<id>` session, so a question asked on the Echo can be followed up in Telegram, and `/new` from any of them closes it for all. Reminders and calendar requests from Alexa or Assist fire to that user's Telegram chat (taken from their `tg:` entry); unmapped headless surfaces still reply that reminders are Telegram-only. The summary's `source` lists every surface that joined (e.g. `telegram+alexa`). Unmapped keys are logged once as `[identity] unmapped session key …`.

### Recency-weighted retrieval

```
final_score = cosine_similarity × e^(-0.023 × age_days)
```

- Today: 100% weight
- 7 days ago: 85%
- 30 days ago: 50%
- 90 days ago: 12.5%

Summaries that keep getting retrieved have their `last_accessed_at` refreshed (spaced repetition effect).

### Memory commands

| Command | Cost | Purpose |
|---------|------|---------|
| `/remember <fact>` | Free + 1 embedding | Store a permanent fact |
| `/recall <query>` | Free + 1 embedding | Search past conversations |
| `/memory` | Free | Show memory stats |
| `/new` | Haiku + 1 embedding | End session, summarize, start fresh |

### Maintenance

Weekly cron job (`memory-maintenance.sh`) runs deduplication and pruning:
- Remove duplicate facts (embedding similarity > 92%)
- Prune summaries older than 180 days that were never accessed
- Send stats report via Telegram

### Prerequisites

Add to `~/jarvis/.env`:
```
DATABASE_URL=postgresql://jarvis:password@localhost:20004/jarvis
OPENAI_API_KEY=sk-...
```

Run the Alembic migration (from the backend directory):
```bash
cd ~/repos/jarvis-ui/backend && alembic upgrade head
```

## Phone calls (Twilio)

Call a Twilio number and talk to JARVIS. Any phone works, including the Gear S watch, which calls through the S20 and uses its own mic and speaker. Twilio turns speech into text and reads the reply aloud. The bot answers through the same `askCore` as Telegram and Alexa (`telegram-bot/src/voice.js`).

```
caller → Twilio number → https://kakischer.duckdns.org:20443/voice (nginx) → bot :20010
       ← Twilio <Say> reply, then <Gather> listens again ←
```

- **A call is a conversation.** JARVIS says "Yes, Sir?", answers each sentence and keeps listening. Talking over a reply interrupts it. Silence gets one "Anything else, Sir?", then the call ends. "Bye", "thanks", "that's it" or "that will be all" end it at once; "no" or "nothing" end it only as an answer to "Anything else, Sir?".
- **No dead air.** Questions are answered in voice mode (the brain keeps replies to a sentence or two). If the answer isn't ready within about a second, JARVIS says "Right, Sir.", then the brain's own progress line ("Checking the weather, Sir."), then "Still on it, Sir." every few seconds (`/voice/wait` redirects, each well under Twilio's 15 s limit). After `VOICE_MAX_TURN_MS` (40 s) the answer goes to Telegram instead.
- **Telegram for the rest.** Answers over ~400 characters are cut at a sentence and sent to Telegram in full (📞), as are background jobs and answers that finish after you hang up. Each turn logs `[voice] answered in … ms (plan … ms, … wait(s))`.
- **JARVIS calls you.** `POST /voice/call {"message": "…"}` (bearer token, LAN only) rings `VOICE_CALL_TO`, says the message, then listens, and the brain knows what it called about. A copy goes to Telegram; at most one call per 5 minutes. Home Assistant uses it through `homeassistant/packages/jarvis_call.yaml` (`script.jarvis_call_me`).
- **Security.** Every webhook must carry a valid `X-Twilio-Signature`. Only `VOICE_ALLOWED_CALLERS` are answered; other numbers are rejected before pickup, so they cost nothing. Caller ID can be spoofed, so treat a call like any other surface that can control the house.
- **Shared session.** Map `phone:*` to yourself in `JARVIS_IDENTITY_MAP` to carry a call on in Telegram.

Setup:
1. Add `TWILIO_AUTH_TOKEN`, `VOICE_PUBLIC_URL` and `VOICE_ALLOWED_CALLERS` to `~/jarvis/.env` (see `env.example`), plus `TWILIO_ACCOUNT_SID` and `TWILIO_FROM_NUMBER` for calls out, and restart the bot. The log shows `POST /voice` and `POST /voice/call` in its route list.
2. Deploy the updated `alexa/nginx-jarvis-alexa.conf` (it proxies `/voice`, `/voice/turn` and `/voice/wait`) and reload nginx. The router must forward TCP 20443 to the mini-PC.
3. In the Twilio Console: Phone Numbers → your number → Voice configuration → "A call comes in" → Webhook `https://kakischer.duckdns.org:20443/voice`, HTTP POST.

Costs (Israel, Aug 2026): local number $5.50/month, receiving calls $0.0107/min, calling a mobile $0.0646/min, speech recognition $0.02 per turn.

## Network & Security (Phase 7)

Five security monitoring scripts run via cron with Telegram alerts — zero AI cost. Interactive dashboard via `/security` Telegram command.

| Script | Schedule | Purpose |
|--------|----------|---------|
| `network-scanner.sh` | Every hour | Detects new/unknown devices on the LAN (arp-scan / nmap / ip neigh) |
| `ssh-monitor.sh` | Every hour | SSH brute force detection (auth.log, threshold alerting) |
| `docker-security.sh` | Weekly (Sun 04:00) | Audits root/privileged containers, host networking, outdated images |
| `ssl-monitor.sh` | Daily 07:00 | SSL cert expiry alerts (14-day warning, 3-day critical) |
| `firewall-audit.sh` | Daily 07:30 | Firewall rule + listening port change detection |

Each script gracefully degrades if a required tool (`arp-scan`, `nmap`, `ufw`) is not installed.

### Known devices baseline

The network scanner maintains `~/jarvis/known-devices.txt`:
```
AA:BB:CC:DD:EE:FF  192.168.68.1    router
11:22:33:44:55:66  192.168.68.124  kamuri-mini-pc
```

First run establishes the baseline. New devices are auto-added and trigger an alert.

### SSL endpoints

Configure `~/jarvis/ssl-endpoints.txt` (one per line, format `host:port`):
```
example.com:443
myapp.local:8443
```

If no endpoints are configured and no local SSL is detected, the script silently skips.

## Monitoring (Cron)

All monitoring runs via cron with Telegram alerts — zero AI cost:

| Script | Schedule | Purpose |
|--------|----------|---------|
| `service-monitor.sh` | Every 15m | Docker + systemd + port checks |
| `samba-monitor.sh` | _disabled_ | Samba service + share mount checks (cron entry commented out) |
| `disk-watchdog.sh` | Every 6h | Alerts if any disk > 90% |
| `network-scanner.sh` | Every hour | Unknown device detection |
| `ssh-monitor.sh` | Every hour | SSH intrusion detection |
| `smart-monitor.sh` | Daily 06:00 | SMART health checks |
| `ssl-monitor.sh` | Daily 07:00 | SSL cert expiry |
| `firewall-audit.sh` | Daily 07:30 | Firewall & port audit |
| `backup-checker.sh` | Daily 08:00 | Home Assistant backup freshness |
| `ha-update.sh` | Weekly Sun 03:00 | HA auto-update |
| `docker-security.sh` | Weekly Sun 04:00 | Docker security audit |
| `memory-maintenance.sh` | Weekly Sun 03:00 | Memory deduplication & pruning |

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
├── docker-compose.yml           # qBittorrent
├── jarvis-ustreamer.service     # USB webcam streamer (MJPEG 640x480, host systemd)
├── webcam/                      # recent stills from webcam-snapshot.sh
├── qbittorrent-config/          # qBittorrent persistent config
├── telegram-bot/                # Telegram bot (Node.js)
│   ├── src/
│   │   ├── index.js             # Bot entry point
│   │   ├── commands/            # Slash command handlers
│   │   ├── claude.js            # Claude CLI + session management
│   │   ├── memory.js            # PostgreSQL + PGVector memory module
│   │   └── utils.js             # Helpers
│   └── package.json
└── .env                         # Secrets (not in git)
```
