# Feature Ideas

## ✅ Done
- ~~markdown to html converter for the telegram bot~~ — `mdToHtml()` in utils.js
- ~~control house via HA~~ — `/ha` command (status, states, toggle, automate, scene)

## 🔧 Planned

### Core Capabilities
1. search the web capability
2. TTS for the telegram bot (voice replies via OpenAI TTS — completes the STT/TTS round-trip)
3. natural language HA control — say "turn off the living room light" instead of exact entity IDs
4. reminders / scheduled messages — "remind me to check the laundry in 30 minutes"

### Automations
5. daily morning briefing (weather, calendar, HA status, system health, reminders)
6. HA improvements recommendations (analyze entities and suggest automations)
7. n8n automations recommendations
8. pre-shabbat checklist
9. shabbat timers setup (HA automations for candle lighting / havdalah times)
10. daily / weekly digest — system health trends, security events, disk growth, media additions
11. proactive anomaly alerts — pattern detection beyond simple thresholds (disk growth rate, repeated SSH failures, container restart loops)

### Integrations
12. weather integration (OpenWeatherMap or HA weather entity)
13. calendar integration (Google Calendar / CalDAV — "what's on my schedule today?")
14. media recommendations — suggest what to watch/download based on Jellyfin history
15. multi-room audio / music control — control speakers via HA from Telegram
16. HA energy dashboard via Telegram — daily/weekly consumption, cost estimates, peak hours
17. strava / training coach

### Personal Assistant
18. grocery / shopping list — "add milk to the list", persistent, shareable
19. expense tracking — "spent 200 on groceries", auto-categorize, monthly summaries
20. interactive troubleshooting flows — when cron alerts fire, offer inline buttons (restart service, view logs, block IP)

### Infrastructure
21. backup verification + cloud sync — test restore integrity, sync to B2/S3
22. chat from alexa dot?

## ❌ Out of Scope
- 3d scanning and modeling
- create projects and repos (github connections)
