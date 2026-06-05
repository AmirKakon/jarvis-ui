# Feature Ideas

## ✅ Done

- ~~markdown to html converter for the telegram bot~~ — `mdToHtml()` in utils.js
- ~~control house via HA~~ — `/ha` command (status, states, toggle, automate, scene)
- ~~search the web capability~~ — Anthropic web search tool in front model + `/search` command
- ~~read web pages / PDFs~~ — Anthropic web fetch tool (`web_fetch_20250910`), front model routes `{"fetch": true}`
- ~~calculations & code execution~~ — Anthropic sandbox (`code_execution_20250825`), front model routes `{"compute": true}`, supports chart images
- ~~TTS voice replies~~ — OpenAI TTS (`tts-1`), `/voice` toggle with configurable voice (alloy, echo, nova, onyx, etc.)
- ~~natural language HA control~~ — Haiku-based entity resolution + direct HA API calls (~2-3s vs ~60s via Opus), front model routes `{"ha": true}`
- ~~reminders / scheduled messages~~ — Haiku NL parsing, PostgreSQL persistence, 30s polling loop, one-shot + recurring (daily/weekly/monthly), snooze inline buttons, `/reminders` command, front model routes `{"remind": true}`
- ~~daily morning briefing~~ — scheduled daily digest with best-effort sections: Hebrew calendar (date/parsha/Omer/Shabbat times via `jewish_calendar`), weather (HA weather entity), today's calendar events (HA calendar API), today's reminders, Garmin health (body battery/sleep/RHR/steps/training/stress), HA device summary, system health. Configurable time via `BRIEFING_TIME`, per-section toggles, on-demand `/briefing` command (`services/briefing.js`, `agents/{weather,garmin,jewish,calendar}.js`)

## 🔧 Planned

### Core Capabilities
1. multi-tool deep analysis agent — a combined agent with access to web search + web fetch + code execution that can chain Anthropic tools autonomously in a single API call (e.g., "find Bitcoin price history and chart it" → search → fetch data → run code → return chart). Trades per-step user feedback for autonomous multi-step reasoning.
2. planner/orchestrator agent — a smarter model (Sonnet/Opus) that decomposes complex multi-step requests into a DAG of tasks, executes them via existing agents (parallel where independent, sequential where dependent), accumulates context between steps, and synthesizes a final response. Front model routes complex requests with `{"plan": true}`. E.g., "check how my portfolios are doing across all brokers, analyze and compare" → planner fans out 3 parallel broker-fetch agents → merges results → runs analysis via code execution → returns structured report. Streams progress updates to Telegram. Requires service integrations (Layer 1) to be built first — the planner is only valuable once there are enough "hands" to coordinate.

### Automations

1. HA improvements recommendations (analyze entities and suggest automations)
2. n8n automations recommendations
3. pre-shabbat checklist
4. shabbat timers setup (HA automations for candle lighting / havdalah times)
5. daily / weekly digest — system health trends, security events, disk growth, media additions
6. proactive anomaly alerts — pattern detection beyond simple thresholds (disk growth rate, repeated SSH failures, container restart loops)

### Integrations

#### Already-connected services (extend existing access)
1. weather integration (OpenWeatherMap or HA weather entity or 02ws.co.il)
   - **02ws.co.il API docs:** https://v2013.02ws.co.il/small/?tempunit=%C2%B0c&section=Api&lang=1
   - Forecast (all days): `GET https://www.02ws.co.il/api/forecast`
   - Forecast (day N): `GET https://www.02ws.co.il/api/forecast/{dayNumber}/{language}/{tempUnit}/{futureUse}`
   - Current conditions: `GET https://www.02ws.co.il/api/now/{dataNumber}/{language}/{tempUnit}/{futureUse}`
   - dataNumber: 1=time, 2=temp, 3=temp2, 4=temp3, 5=humidity, 6=pressure, 7=wind dir, 8=wind speed, 9=rain rate, 10=rain chance, 11=solar radiation, 12=sunshine hours, 13=rain today (0=all)
   - language: 0=English, 1=Hebrew
   - **Requires `Accept` header** — requests without `Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8` return empty responses
2. Jellyfin media agent — search library, get watch history, media recommendations ("what should I watch tonight?"), trigger library scans
3. qBittorrent agent — search/add torrents, monitor downloads, auto-organize completed media (already has `/download` command, extend with NL control)
4. multi-room audio / music control — control speakers via HA from Telegram
5. HA energy dashboard via Telegram — daily/weekly consumption, cost estimates, peak hours
6. personal app integrations — connect to self-hosted apps via their APIs (RecipeRack, QRganize, etc.)

#### New service integrations
7. calendar integration (Google Calendar / CalDAV — "what's on my schedule today?", "add meeting tomorrow at 3pm")
8. email integration (Gmail API — "send confirmation email", "check inbox for X", "summarize unread emails")
9. messaging integration (WhatsApp Business API or Matrix — "send John the file", cross-platform messaging)
10. finance / portfolio integration — broker APIs (Interactive Brokers, Trading 212, IBI, etc.) for holdings, P&L, allocation analysis, cross-broker comparison
11. Strava / fitness coach — training log, weekly summaries, goal tracking, workout suggestions
12. Spotify / music — playback control, playlist management, listening stats, music recommendations
13. GitHub integration — repo status, PR notifications, issue management, commit summaries
14. note-taking integration (Obsidian / Notion API — "save this to my notes", "find my notes about X")
15. transportation / navigation (Google Maps / Waze API — "how long to get to work?", "is there traffic?")
16. food delivery / restaurant (Wolt / 10bis API — "order lunch", "what's nearby?")

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

