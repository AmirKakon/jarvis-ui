# Feature Ideas

## ✅ Done

- ~~markdown to html converter for the telegram bot~~ — `mdToHtml()` in utils.js
- ~~control house via HA~~ — `/ha` command (status, states, toggle, automate, scene)
- ~~search the web capability~~ — Anthropic web search tool in front model + `/search` command
- ~~read web pages / PDFs~~ — Anthropic web fetch tool (`web_fetch_20250910`), front model routes `{"fetch": true}`
- ~~calculations & code execution~~ — Anthropic sandbox (`code_execution_20250825`), front model routes `{"compute": true}`, supports chart images
- ~~TTS voice replies~~ — OpenAI TTS (`tts-1`), `/voice` toggle with configurable voice (alloy, echo, nova, onyx, etc.)
- ~~natural language HA control~~ — Haiku-based entity resolution + direct HA API calls (~2-3s vs ~60s via Opus), front model routes `{"ha": true}`

## 🔧 Planned

### Core Capabilities
1. reminders / scheduled messages — "remind me to check the laundry in 30 minutes"
2. multi-tool research agent — a combined agent with access to web search + web fetch + code execution that can chain tools autonomously in a single request (e.g., "find Bitcoin price history and chart it" → search → fetch data → run code → return chart). Trades per-step user feedback for autonomous multi-step reasoning.

### Automations

1. daily morning briefing (weather, calendar, HA status, system health, reminders)
2. HA improvements recommendations (analyze entities and suggest automations)
3. n8n automations recommendations
4. pre-shabbat checklist
5. shabbat timers setup (HA automations for candle lighting / havdalah times)
6. daily / weekly digest — system health trends, security events, disk growth, media additions
7. proactive anomaly alerts — pattern detection beyond simple thresholds (disk growth rate, repeated SSH failures, container restart loops)

### Integrations

1. weather integration (OpenWeatherMap or HA weather entity or 02ws.co.il)
   - **02ws.co.il API docs:** https://v2013.02ws.co.il/small/?tempunit=%C2%B0c&section=Api&lang=1
   - Forecast (all days): `GET https://www.02ws.co.il/api/forecast`
   - Forecast (day N): `GET https://www.02ws.co.il/api/forecast/{dayNumber}/{language}/{tempUnit}/{futureUse}`
   - Current conditions: `GET https://www.02ws.co.il/api/now/{dataNumber}/{language}/{tempUnit}/{futureUse}`
   - dataNumber: 1=time, 2=temp, 3=temp2, 4=temp3, 5=humidity, 6=pressure, 7=wind dir, 8=wind speed, 9=rain rate, 10=rain chance, 11=solar radiation, 12=sunshine hours, 13=rain today (0=all)
   - language: 0=English, 1=Hebrew
   - **Requires `Accept` header** — requests without `Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8` return empty responses
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

