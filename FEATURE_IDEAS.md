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
- ~~reminders → Google Calendar sync~~ — scheduled/recurring reminders (daily/weekly/monthly, or one-shots >4h out) are mirrored to Google Calendar via the `JARVIS - Create Calendar Event` n8n webhook workflow, with **calendar-only delivery**: on a successful sync the local row is retired (poller does not double-notify) and Google Calendar owns the notification + record; if sync fails it falls back to a Telegram reminder so nothing is lost. Ephemeral "timer" reminders (interval/hourly/near-term) stay local-only and fire via Telegram. Recurrence→RRULE mapping, `kind`/`calendar_event_id` columns. `services/calendar-sync.js`
- ~~daily morning briefing~~ — scheduled daily digest with best-effort sections: Hebrew calendar (date/parsha/Omer/Shabbat times via `jewish_calendar`), weather (HA weather entity), today's calendar events (HA calendar API), today's reminders, Garmin health (body battery/sleep/RHR/steps/training/stress), HA device summary, system health. Configurable time via `BRIEFING_TIME`, per-section toggles, on-demand `/briefing` command (`services/briefing.js`, `agents/{weather,garmin,jewish,calendar}.js`)

## 🔧 Planned

### Core Capabilities
1. multi-tool deep analysis agent — a combined agent with access to web search + web fetch + code execution that can chain Anthropic tools autonomously in a single API call (e.g., "find Bitcoin price history and chart it" → search → fetch data → run code → return chart). Trades per-step user feedback for autonomous multi-step reasoning. **Must run on a capable model (Fable 5 / Opus 4.6–4.8 / Sonnet 4.6–5), not Haiku:** dynamic filtering (code-execution-backed web search that filters results before they hit context) and multi-tool chaining require programmatic tool calling, which Haiku 4.5 doesn't support — Haiku can only call `web_search`/`web_fetch` directly (`allowed_callers: ['direct']`), one tool at a time. This agent is the natural target for the escalation route in Agent Architecture #5.
2. planner/orchestrator agent — a smarter model (Sonnet/Opus) that decomposes complex multi-step requests into a DAG of tasks, executes them via existing agents (parallel where independent, sequential where dependent), accumulates context between steps, and synthesizes a final response. Front model routes complex requests with `{"plan": true}`. E.g., "check how my portfolios are doing across all brokers, analyze and compare" → planner fans out 3 parallel broker-fetch agents → merges results → runs analysis via code execution → returns structured report. Streams progress updates to Telegram. Requires service integrations (Layer 1) to be built first — the planner is only valuable once there are enough "hands" to coordinate.

### Agent Architecture & Orchestration

_Foundational improvements to how requests are routed and executed — stepping stones toward the full planner/orchestrator (Core #2). Ordered by leverage._

1. **Multi-intent parallel routing** — ✅ _shipped._ The front model may now return a JSON *array* of actions; `parseActions()` in `claude.js` accepts both a single object and an array. Independent actions fan out concurrently via `Promise.all` (Phase 1, `runOne`) and render in request order (Phase 2, `renderOne`), with voice + fact-extraction aggregated once over the combined output. Opus-gated actions (`research`, `delegate`) reserve rate-limit capacity synchronously so parallel dispatch stays deterministic. _Next:_ optionally serialize/deduplicate multiple mutating `delegate` actions if they ever conflict.
2. **Wire `delegate` → Claude Code subagents** — ✅ _shipped._ Delegation is now model-aware. `resolveDelegateTarget()` in `claude.js` picks a tier from an optional `"agent"` hint emitted by the front model (`docker-ops`/`diagnostics` → haiku, `research` → sonnet) or a keyword classifier fallback (`classifyDelegate`); anything complex/ambiguous still goes to Opus. `runOpus(prompt, model)` (in `agents/opus.js`) runs the chosen tier with a scaled timeout (haiku 1 min, sonnet 2 min, opus 6 min) and the delegate prompt now names the subagent to prefer. Only Opus-tier calls consume the scarce Opus rate bucket; cheap ops don't. Cheaper + faster for routine server work. _Next:_ #3 (proactive subagent cues) to strengthen auto-delegation once a task reaches the CLI.
3. **Proactive subagent cues** — ✅ _shipped._ Each subagent's `description:` frontmatter (`docker-ops`, `diagnostics`, `research`) now carries `Use PROACTIVELY … hand off immediately` language, and `jarvis-home/CLAUDE.md` gained a **Subagent Delegation** table mapping task type → subagent (with tier), so once a task reaches the CLI, auto-delegation actually triggers instead of the top-level agent doing the work inline.
4. **Single source of truth for status/docker** — ✅ _shipped._ **JS side:** a new `services/health.js` exposes canonical `collectHealth()` (uptime, load, memory, disk, containers, gathered once); both the `/status` command (`commands/status.js`) and the briefing's `buildHealthSection` (`briefing.js`) now format from it instead of running their own shell probes. **CLI side:** `.claude/agents/diagnostics.md` is the canonical metric definition, and `.claude/commands/status.md` now hands off to the `diagnostics` subagent instead of re-listing commands. (Bonus: `/status` now shows stopped containers in red, not just running ones.)
5. **Escalate tool-heavy / deep-research queries to a capable-model subagent** — the front model (Haiku 4.5) can only call `web_search`/`web_fetch` directly, one at a time, and can't use dynamic filtering or chain tools. For complex research ("compare X and Y across several sources", "find this data and chart it") the router should escalate to a Sonnet/Opus-backed subagent that uses the full tool set autonomously — i.e. the multi-tool deep analysis agent (Core #1). Add a `{"research": true, ...}` (or `{"deep": true}`) action to the router that hands off, while simple single-shot lookups stay on cheap Haiku direct search. Keeps the common case fast/cheap and reserves the expensive model for queries that actually benefit. _(Note: basic search already works on Haiku after the `allowed_callers: ['direct']` fix — this escalation is about quality + dynamic filtering + chaining, not a functional blocker.)_ ✅ _Basic version shipped: `agents/research.js` (Sonnet 5) + `{"research": true}` route._

### Voice & Multi-Surface

_Goal: talk to JARVIS out loud — a mic in the house and the same assistant on every phone — not just Telegram text. We already own ~80% of the pieces (the brain, Home Assistant, TTS, Postgres/PGVector memory), so this is mostly integration._

**Prerequisite — decouple the "brain" from the transport.** Today the intelligence lives inside the Telegram bot (`askClaude` in `claude.js` is both router *and* Telegram renderer). Extract the router/agent loop behind a stable headless API (`POST /ask {text, userId, sessionId} → {reply, audioUrl?}`) that the Telegram bot also calls. Every surface (Telegram, home mic, phones) then becomes a thin client: capture → send text → speak reply. Also consolidate the **two brains** — the Node bot (`jarvis-home`) and the older Python FastAPI backend (`jarvis-ui`/`orchestrator.py`) — to one, so behaviour/memory don't drift across devices.

**Unified identity + shared memory.** Memory is currently keyed by Telegram `chatId`. Introduce a stable `userId` that every surface attaches, backed by the existing Postgres store, so a conversation started on the kitchen mic continues on the phone and shows up in Telegram history.

**In-home mic → Home Assistant is the hub.** Reuse HA's Assist pipeline instead of building mic/wake-word infra:
- Hardware: [Home Assistant Voice PE](https://www.home-assistant.io/voice-pe/) puck (~$60, ESP32-S3) per room, or a repurposed phone / Pi + mic.
- Wake word: `openWakeWord` runs locally — enable **"Jarvis"** so nothing leaves the house until spoken (privacy win).
- STT: local Whisper (handles Hebrew + English) or cloud STT.
- Wiring: set HA Assist's conversation agent to hit the JARVIS `/ask` endpoint; speak → satellite → STT → JARVIS brain → existing TTS back out the speaker.

**Realtime API (phase-2 UX upgrade).** [OpenAI Realtime](https://platform.openai.com/docs/guides/realtime) / Gemini Live give speech-to-speech (~300ms, barge-in) for a natural conversation feel. Trade-offs: (a) gate it behind the local wake word — never stream continuously — to control cost; (b) it bypasses the tiered Haiku-router, so bridge via **function calling**: the fast conversational model handles chit-chat and calls into existing agents (`ha`, `remind`, `research`, `delegate`…) for real work.

**Cross-device (Siri / Google / Samsung).** You can't *become* Siri/Google Assistant (Google deprecated Conversational Actions in 2023; SiriKit/Bixby are narrow), so use thin adapters over the one API:
- **HA Companion app → Assist** (the sleeper hit): point its conversation agent at JARVIS → Jarvis voice on *every* phone (Android + iOS), reusing the home pipeline.
- **Siri:** an iOS Shortcut "Ask Jarvis" that POSTs to the API and speaks the reply ("Hey Siri, ask Jarvis…").
- **Samsung/Android:** Tasker + AutoVoice or a tiny app hitting the API; or just rely on HA Companion Assist.

**Constraints:** Hebrew/English multilingual STT + voices; local wake word (+ optional local Whisper) for privacy; LAN hop is fast, the model call is the latency variable (another reason to wake-word-gate Realtime).

**Phased roadmap:**
1. **Phase A** — extract the brain behind `/ask`; HA Assist + one Voice PE + "Jarvis" wake word + Whisper → reply via existing TTS. _(Fully working home voice, minimal new code.)_
2. **Phase B** — unified `userId` + shared session/memory across surfaces; add HA Companion Assist on phones.
3. **Phase C** — wake-word-gated Realtime session with function-calling into existing agents; iOS Shortcut + Samsung/Android adapter.

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
7. calendar integration (Google Calendar / CalDAV — "what's on my schedule today?", "add meeting tomorrow at 3pm") — _partial: reminders now write to GCal (see Done); still TODO: NL "add meeting" events + Phase 2 GCal-trigger nudges for events created outside JARVIS_
8. email integration (Gmail API — "send confirmation email", "check inbox for X", "summarize unread emails")
9. messaging integration (WhatsApp Business API or Matrix — "send John the file", cross-platform messaging)
10. finance / portfolio integration — broker APIs (Interactive Brokers, Trading 212, IBI, etc.) for holdings, P&L, allocation analysis, cross-broker comparison
11. Strava / fitness coach — training log, weekly summaries, goal tracking, workout suggestions
12. Spotify / music — playback control, playlist management, listening stats, music recommendations
13. GitHub integration — repo status, PR notifications, issue management, commit summaries
14. note-taking integration (Obsidian / Notion API — "save this to my notes", "find my notes about X")
15. transportation / navigation (Google Maps / Waze API — "how long to get to work?", "is there traffic?")
16. food delivery / restaurant (Wolt / 10bis API — "order lunch", "what's nearby?")

### for future reference on mcp conneciton ###
can you connect to qrganize mcp 
PS C:\Users\amirka\source\repos\QRganize\functions> cd C:\Users\amirka\source\repos\QRganize\mcp
PS C:\Users\amirka\source\repos\QRganize\mcp> $env:QRGANIZE_UUID="c66c43d2-9488-4584-a249-aa7c1f1bedbe"
PS C:\Users\amirka\source\repos\QRganize\mcp> npx @modelcontextprotocol/inspector node index.js
url https://qrganize-f651b.web.app/


PS C:\Users\amirka\source\repos\recipe-rack> cd C:\Users\amirka\source\repos\recipe-rack\mcp-server
>> npx @modelcontextprotocol/inspector node index.js
url https://studio--recipe-rack-ighp8.us-central1.hosted.app/


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

