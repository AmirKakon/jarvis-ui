# Feature Ideas

## ✅ Done

- ~~markdown to html converter for the telegram bot~~ — `mdToHtml()` in utils.js
- ~~control house via HA~~ — `/ha` command (status, states, toggle, automate, scene)
- ~~search the web capability~~ — Anthropic web search tool in front model + `/search` command

## 🔧 Planned

### Core Capabilities

1. TTS for the telegram bot (voice replies via OpenAI TTS — completes the STT/TTS round-trip)
3. natural language HA control — say "turn off the living room light" instead of exact entity IDs
4. reminders / scheduled messages — "remind me to check the laundry in 30 minutes"

### Automations

1. daily morning briefing (weather, calendar, HA status, system health, reminders)
2. HA improvements recommendations (analyze entities and suggest automations)
3. n8n automations recommendations
4. pre-shabbat checklist
5. shabbat timers setup (HA automations for candle lighting / havdalah times)
6. daily / weekly digest — system health trends, security events, disk growth, media additions
7. proactive anomaly alerts — pattern detection beyond simple thresholds (disk growth rate, repeated SSH failures, container restart loops)

### Integrations

1. weather integration (OpenWeatherMap or HA weather entity)
2. calendar integration (Google Calendar / CalDAV — "what's on my schedule today?")
3. media recommendations — suggest what to watch/download based on Jellyfin history
4. multi-room audio / music control — control speakers via HA from Telegram
5. HA energy dashboard via Telegram — daily/weekly consumption, cost estimates, peak hours
6. strava / training coach
7. personal app integrations — connect to self-hosted apps via their APIs (RecipeRack, QRganize, etc.)

### Personal Assistant

1. grocery / shopping list — "add milk to the list", persistent, shareable
2. expense tracking — "spent 200 on groceries", auto-categorize, monthly summaries
3. interactive troubleshooting flows — when cron alerts fire, offer inline buttons (restart service, view logs, block IP)

### Infrastructure

1. backup verification + cloud sync — test restore integrity, sync to B2/S3
2. chat from alexa dot?

## ❌ Out of Scope

- 3d scanning and modeling
- create projects and repos (github connections)

