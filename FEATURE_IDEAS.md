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
- ~~weather integration~~ — local weather/forecast via the Home Assistant weather entity: `weather` action + `/weather` command (current conditions + multi-day daily forecast, Haiku answers NL questions over the data), also feeds the daily briefing. Weather for **other cities** routes to `search` (web), and trip-planning-style multi-day questions escalate to `research`. (02ws.co.il considered as an alt source but dropped — HA covers it.) `agents/weather.js`, `commands/weather.js`
- ~~daily morning briefing~~ — scheduled daily digest with best-effort sections: Hebrew calendar (date/parsha/Omer/Shabbat times via `jewish_calendar`), weather (HA weather entity), today's calendar events (HA calendar API), today's reminders, Garmin health (body battery/sleep/RHR/steps/training/stress), HA device summary, system health. Configurable time via `BRIEFING_TIME`, per-section toggles, on-demand `/briefing` command (`services/briefing.js`, `agents/{weather,garmin,jewish,calendar}.js`)
- ~~generic MCP client (personal-app integrations)~~ — JARVIS is now a config-driven **MCP client**: any MCP server declared in `~/jarvis/mcp.json` (Streamable HTTP with SSE fallback, or stdio child process) is connected at runtime and its tools exposed to the LLM, namespaced `<server>__<tool>`. Adding a provider is a **config-only** change — no code. The front router injects each server's description into its prompt dynamically and emits a `{"mcp": true, "task": …, "complex": …}` action; `agents/mcp.js` runs a tool-use loop over **all** servers' tools in one call, so it orchestrates **across providers** with no bespoke bridge (e.g. read a RecipeRack recipe → check QRganize inventory → add missing items to the shopping list). Two-tier model: simple lookups on Haiku 4.5, complex/cross-provider tasks on Sonnet 5 (more tool-call rounds), chosen by the router's `complex` hint. **Live**: QRganize (home inventory, 13 tools) + RecipeRack (recipes & meal planning, 8 tools); cross-provider bridging tested working. `services/mcp-client.js`, `agents/mcp.js`, `mcp.json.example`
- ~~gate auto-open on arrival~~ — Home Assistant automation pair: when the phone (`device_tracker.amir_phone`, GPS) comes within 700 m of `zone.home` **and** the car Bluetooth is connected (`sensor.sm_g981u1_bluetooth_connection`), an actionable notification ("🏠 Almost home / Open the gate?") is pushed to the phone; tapping **🚪 Open gate** opens the Palgate garage cover (`cover.4g600204039`), gated by a 1 km safety check so a stale prompt can't open it from afar. Template-distance trigger fires only on approach (not departure); no extra zone needed. Built directly in HA via the config API.
- ~~self-development (JARVIS edits its own code)~~ — a `{"selfdev": true, "task": …}` route lets JARVIS modify its **own source** on request ("add a feature to yourself", "make the samba check self-healing", "add a /gpu command"). `agents/selfdev.js` runs an Opus-tier headless `claude` editor scoped to the repo's `jarvis-home/` (cwd-scoped so it can't touch backend/frontend/n8n), then the orchestrator **syntax-checks** every changed `.js` (`node --check`) / `.sh` (`bash -n`), reverts on failure, and only then commits (pathspec-scoped to `jarvis-home`) and pushes to the **currently checked-out branch** — resolved dynamically via `git rev-parse --abbrev-ref HEAD`, so it always matches what the server deploys, no hardcoded branch. Guardrails: opt-in `SELFDEV_ENABLED`, refuses to run if the tree already has uncommitted `jarvis-home` changes, one edit at a time, Opus-rate-limited, records the pre-change SHA for rollback. **Deploy is gated** — a one-tap "🚀 Deploy" button (`commands/deploy.js`) redeploys + restarts via a detached `systemd-run --user` unit (survives the bot's own restart), and the message prints the exact rollback command in case it can't come back. Push auth via optional `GIT_PUSH_TOKEN` (inline credential helper, token never in argv/config). One-time prereq: chown the repo to the bot user + drop `sudo` from the update alias. `agents/selfdev.js`, `commands/deploy.js`
- ~~Jellyfin media agent~~ — natural-language access to the home media server (`agents/jellyfin.js`, `/jellyfin` command, front router `{"jellyfin": true}`). Haiku classifies intent (search / recommend / recently-added / continue-watching / next-up / now-playing / libraries / scan) and extracts genre + item-type; recommendations draw on the **whole catalogue** (randomised, genre/type-filtered) plus in-progress signals, and Haiku phrases the reply as a concierge over real library data (never invents titles). **Poster thumbnails**: content replies now include an album of primary posters (`/Items/{id}/Images/Primary`) — the bot downloads the bytes (Telegram can't reach the LAN server) and uploads them as a media group with title/year/★rating captions, choosing the titles the summary actually mentions (episodes use the series artwork). Reads config lazily at call time (`JELLYFIN_URL` default `:20002`, `JELLYFIN_TOKEN`, optional `JELLYFIN_USER_ID`).
- ~~Voice Phase A — OpenAI Assist shim~~ — `server.js` exposes OpenAI-compatible `POST /v1/chat/completions` + `GET /v1/models` over the same `askCore` brain (chat-only; JARVIS keeps device control). HA OpenAI Conversation / Companion Assist can point at `http://<mini-pc>:20010/v1` with `ASK_HTTP_TOKEN`. Set `ASK_HTTP_BIND=0.0.0.0` when HA is on another host. Entity aliases + Assist wiring are the remaining HA-side ops (see Voice & Multi-Surface Phase A checklist). No Voice PE required.

## 🔧 Planned

### Core Capabilities
1. multi-tool deep analysis agent — ✅ _shipped (`agents/research.js`, `{"research": true}` route)._ A capable model (Sonnet 5 by default, `RESEARCH_MODEL`-overridable) chains web search → web fetch → code execution autonomously in a single API call (e.g. "find Bitcoin price history and chart it" → search → fetch → run code → return chart). **Dynamic filtering** is now on for capable models (Sonnet 5/4.6, Opus 4.6–4.8/5, Fable 5): the `web_search_20260209` / `web_fetch_20260209` tools let Claude write code that filters raw results before they reach context (cheaper, sharper on search-heavy queries). That filtering runs in a `code_execution_20260120` sandbox which we also declare so the model can chart/analyse in the same environment. Older models fall back to the basic tools (`web_search_20250305` direct); `RESEARCH_DYNAMIC_FILTER=false` forces the basic path. `agents/shared.js` detects result blocks by suffix so citation extraction survives tool-version changes. _Next:_ a `plan`/orchestrator layer (Core #2) for requests that need multiple such agents coordinated.
2. planner/orchestrator agent — a smarter model (Sonnet/Opus) that decomposes complex multi-step requests into a DAG of tasks, executes them via existing agents (parallel where independent, sequential where dependent), accumulates context between steps, and synthesizes a final response. Front model routes complex requests with `{"plan": true}`. E.g., "check how my portfolios are doing across all brokers, analyze and compare" → planner fans out 3 parallel broker-fetch agents → merges results → runs analysis via code execution → returns structured report. Streams progress updates to Telegram. Requires service integrations (Layer 1) to be built first — the planner is only valuable once there are enough "hands" to coordinate.

### Agent Architecture & Orchestration

_Foundational improvements to how requests are routed and executed — stepping stones toward the full planner/orchestrator (Core #2). Ordered by leverage._

1. **Multi-intent parallel routing** — ✅ _shipped._ The front model may now return a JSON *array* of actions; `parseActions()` in `claude.js` accepts both a single object and an array. Independent actions fan out concurrently via `Promise.all` (Phase 1, `runOne`) and render in request order (Phase 2, `renderOne`), with voice + fact-extraction aggregated once over the combined output. Opus-gated actions (`research`, `delegate`) reserve rate-limit capacity synchronously so parallel dispatch stays deterministic. _Next:_ optionally serialize/deduplicate multiple mutating `delegate` actions if they ever conflict.
2. **Wire `delegate` → Claude Code subagents** — ✅ _shipped._ Delegation is now model-aware. `resolveDelegateTarget()` in `brain.js` picks a tier from an optional `"agent"` hint emitted by the front model (`docker-ops`/`diagnostics` → haiku, `research` → sonnet) or a keyword classifier fallback (`classifyDelegate`); anything complex/ambiguous still goes to Opus. Only Opus-tier calls consume the scarce Opus rate bucket; cheap ops don't. Cheaper + faster for routine server work. _Next:_ #3 (proactive subagent cues) to strengthen auto-delegation once a task reaches the CLI.
   - **Background jobs (delegate timeout fix)** — ✅ _shipped._ Delegated ops used to run *inline* with a per-tier timeout as short as 1 min (haiku), so anything slower — a big `git pull`, an `apt upgrade`, a multi-step diagnostic — was killed and the result lost. Delegation now runs through `agents/jobs.js` (`startClaudeJob` → `{ id, promise }`) with a generous 25-min ceiling: **Telegram** fires-and-follows-up (immediate ack via `onPlan`, real result delivered later through a new `askCore` `onBackground` hook — rendered + persisted + voiced when the job finishes), while **headless callers** (HTTP `/ask`) still `await` the promise so their response carries the full answer. Jobs are tracked in-memory; `/jobs` lists what's running plus recent outcomes (`⏳`/`✅`/`🔴`/`⌛`).
3. **Proactive subagent cues** — ✅ _shipped._ Each subagent's `description:` frontmatter (`docker-ops`, `diagnostics`, `research`) now carries `Use PROACTIVELY … hand off immediately` language, and `jarvis-home/CLAUDE.md` gained a **Subagent Delegation** table mapping task type → subagent (with tier), so once a task reaches the CLI, auto-delegation actually triggers instead of the top-level agent doing the work inline.
4. **Single source of truth for status/docker** — ✅ _shipped._ **JS side:** a new `services/health.js` exposes canonical `collectHealth()` (uptime, load, memory, disk, containers, gathered once); both the `/status` command (`commands/status.js`) and the briefing's `buildHealthSection` (`briefing.js`) now format from it instead of running their own shell probes. **CLI side:** `.claude/agents/diagnostics.md` is the canonical metric definition, and `.claude/commands/status.md` now hands off to the `diagnostics` subagent instead of re-listing commands. (Bonus: `/status` now shows stopped containers in red, not just running ones.)
5. **Escalate tool-heavy / deep-research queries to a capable-model subagent** — the front model (Haiku 4.5) can only call `web_search`/`web_fetch` directly, one at a time, and can't use dynamic filtering or chain tools. For complex research ("compare X and Y across several sources", "find this data and chart it") the router should escalate to a Sonnet/Opus-backed subagent that uses the full tool set autonomously — i.e. the multi-tool deep analysis agent (Core #1). Add a `{"research": true, ...}` (or `{"deep": true}`) action to the router that hands off, while simple single-shot lookups stay on cheap Haiku direct search. Keeps the common case fast/cheap and reserves the expensive model for queries that actually benefit. _(Note: basic search already works on Haiku after the `allowed_callers: ['direct']` fix — this escalation is about quality + dynamic filtering + chaining, not a functional blocker.)_ ✅ _Shipped: `agents/research.js` (Sonnet 5) + `{"research": true}` route, now with **dynamic filtering** on capable models (see Core #1) — the full multi-tool chaining + code-execution-backed result filtering this item called for._

### Voice & Multi-Surface

_Goal: talk to JARVIS out loud — a mic in the house and the same assistant on every phone — not just Telegram text. We already own ~80% of the pieces (the brain, Home Assistant, TTS, Postgres/PGVector memory), so this is mostly integration._

**Prerequisite — decouple the "brain" from the transport.** ✅ _shipped._ The brain lives in `telegram-bot/src/brain.js` as a headless `askCore(prompt, { sessionKey, source, chatId, onPlan })` — session rotation, memory, the front-model router, action dispatch, and assistant-message persistence, all transport-agnostic (returns plain `{ ok, kind, text, results }`, no Telegram `ctx`). `claude.js` is a thin Telegram adapter; `server.js` exposes the same brain over HTTP (opt-in via `ASK_HTTP_TOKEN`):
- `POST /ask` — JARVIS-native `{ text, sessionKey?, source? }`
- `POST /v1/chat/completions` + `GET /v1/models` — **OpenAI-compatible chat-only shim** for HA OpenAI Conversation / Assist (no tools advertised; JARVIS owns all agency inside `askCore`). Session keys: `ha:<user|conversation_id>` or `ha:default`.
- `GET /health` — liveness

Default bind is localhost; for HA on another host set `ASK_HTTP_BIND=0.0.0.0` and point Assist at `http://<mini-pc-ip>:20010/v1` with API key = `ASK_HTTP_TOKEN`. Session keys are namespaced (`tg:<chatId>`, `ha:…`, `api:default`); reminders/calendar-create stay Telegram-only for now and degrade gracefully on headless surfaces. _Still TODO:_ audio responses from `/ask`, unified cross-surface `userId`, consolidating the **two brains** (Node bot vs legacy Python FastAPI) so behaviour/memory don't drift.

**Unified identity + shared memory.** Memory is currently keyed by Telegram `chatId`. Introduce a stable `userId` that every surface attaches, backed by the existing Postgres store, so a conversation started on the kitchen mic continues on the phone and shows up in Telegram history.

**In-home mic → Home Assistant is the hub.** Reuse HA's Assist pipeline instead of building mic/wake-word infra:
- **Now (no Voice PE):** HA Companion Assist (phone mic / Assist UI) → OpenAI Conversation → JARVIS `/v1/chat/completions`.
- **Later (optional hardware):** [Home Assistant Voice PE](https://www.home-assistant.io/voice-pe/) puck (~$60) or a Pi + mic; local `openWakeWord` ("Jarvis"); Whisper STT — same Assist → JARVIS pipeline, no brain changes.
- Wiring: HA OpenAI Conversation Base URL `http://<mini-pc>:20010/v1`, API key = `ASK_HTTP_TOKEN`, model `jarvis`; set that agent as the Assist conversation agent. Chat-only — do **not** enable Extended OpenAI `execute_service` functions (JARVIS already controls devices via its `ha` agent).

**Realtime API (phase-2 UX upgrade).** [OpenAI Realtime](https://platform.openai.com/docs/guides/realtime) / Gemini Live give speech-to-speech (~300ms, barge-in) for a natural conversation feel. Trade-offs: (a) gate it behind the local wake word — never stream continuously — to control cost; (b) it bypasses the tiered Haiku-router, so bridge via **function calling**: the fast conversational model handles chit-chat and calls into existing agents (`ha`, `remind`, `research`, `delegate`…) for real work.

**Cross-device (Siri / Google / Samsung).** You can't *become* Siri/Google Assistant (Google deprecated Conversational Actions in 2023; SiriKit/Bixby are narrow), so use thin adapters over the one API:
- **HA Companion app → Assist** (the sleeper hit): point its conversation agent at JARVIS → Jarvis voice on *every* phone (Android + iOS), reusing the home pipeline.
- **Siri:** an iOS Shortcut "Ask Jarvis" that POSTs to the API and speaks the reply ("Hey Siri, ask Jarvis…").
- **Samsung/Android:** Tasker + AutoVoice or a tiny app hitting the API; or just rely on HA Companion Assist.

**Constraints:** Hebrew/English multilingual STT + voices; local wake word (+ optional local Whisper) for privacy; LAN hop is fast, the model call is the latency variable (another reason to wake-word-gate Realtime).

**Phased roadmap:**
1. **Phase A** — ✅ _brain + OpenAI shim shipped_ (`brain.js` + `server.js` `/ask` and `/v1/chat/completions`). **Companion Assist path** (no Voice PE owned yet):
   1. Mini-pc: `ASK_HTTP_BIND=0.0.0.0`, `ASK_HTTP_TOKEN` set, `jarvis-update` / restart bot; open firewall TCP 20010 from HA if needed.
   2. HA: Settings → Devices → add **OpenAI Conversation** — Base URL `http://<mini-pc-ip>:20010/v1`, API key = token, model `jarvis`.
   3. Voice assistants → Assist: set conversation agent to that integration; keep preferred TTS.
   4. **Entity aliases pass** (capability #6 below) — areas, expose list, friendly names, synonyms for AC / lights / gate.
   5. Smoke tests (Assist UI or Companion): “What's the date?”, “Turn on the bathroom light”, “What's for Friday dinner?” — confirm JARVIS persona + bot logs `[ask-http]` / `[front]`.
   _Later:_ optional Voice PE + openWakeWord + Whisper on the same pipeline.
2. **Phase B** — unified `userId` + shared session/memory across surfaces; harden Companion as the daily phone surface.
3. **Phase C** — wake-word-gated Realtime session with function-calling into existing agents; iOS Shortcut + Samsung/Android adapter.

### Home Assistant (config review & backlog)

_Findings from a review of the HA instance (`http://192.168.68.113:8123`) — its `automations.yaml`, `scripts.yaml`, and helpers. Actionable cleanup + improvement backlog for the smart-home side, kept here so JARVIS can reference/execute it later (it has HA access via `HA_TOKEN`)._

**✅ Shipped — Living-room AC panel rebuilt (Option A).** The three `scene.turn_on_livingroom_ac` / `_heat` / `turn_off_livingroom_ac` "scenes" are **not HA scenes** — they're Tuya/Smart-Life cloud tap-to-run macros imported by the integration (they carry a Device, aren't in any YAML, are read-only, and survive restarts). There's **no `climate.livingroom_ac` entity** (IR-only; only a smart plug `switch.livingroom_ac_plug_*`). So instead of a climate card: added `input_select.livingroom_ac_mode` (cool/heat/off) as the state tracker, three scripts (`livingroom_ac_cool/heat/off`) that fire the cloud scene **and** set the tracker, and a `livingroom_ac_smart_toggle` script (off → pick heat/cool by `weather.forecast_home_2` outdoor temp <22 °C; on → off) behind the top tile. Dashboard `custom:button-card` reads the tracker so the view updates and Cool/Heat/Off highlight independently. `Leave the house - turn off` now calls `script.livingroom_ac_off` to keep the tracker in sync. _Cleanup remaining:_ delete the disabled `Livingroom AC Toggle` automation + the now-unused `input_boolean.livingroom_a_c`. (Note: IR has no feedback — tracker reflects last command, not physical state.)

**🔴 Bugs to fix**
1. **Motion lights never auto-off** — `script.delay_turn_off_light` reads `{{ lights }}` but the bathroom + work-room automations pass `light:` (singular) → undefined → `light.turn_off` gets an empty entity_id and fails. Fix: change those callers to `lights:`. (Red-alert callers already pass `lights:` correctly.)
2. **`bathroom_lights_mode` uses `light.toggle` in a `mode: restart` motion flow** — continued presence re-fires and toggles an already-on light *off*. Change the three `light.toggle` → `light.turn_on`.

**🧹 Cleanup / dead code**
- `script.red_alert_voice_loop` (v1) is orphaned — automations use `red_alert_voice_loop_2`. Delete v1.
- `KakonShare IP` template helper is erroring (unavailable) — fix or remove.
- Retire AC leftovers: disabled `Livingroom AC Toggle` automation + `input_boolean.livingroom_a_c`.

**🎯 Consistency**
- Standardise notifications: mixed `notify.mobile_app_amir_phone` vs `notify.mobile_app_sm_g981u1` (same phone) vs raw `device_id:` notifies (CPU Warning, Red Alert v2 — fragile, break on re-add). Move to entity form + a `notify.household` group.
- `CPU Warning` at >50 % for 1 min is too twitchy → ~85–90 % for 5 min.
- Two morning briefings (HA→ChatGPT→Alexa `ChatGpt Morning Chat` vs JARVIS Telegram briefing) — pick one canonical brain to avoid drift; JARVIS could drive the Alexa TTS too.

**🗂️ Structure**
- Split the flat 18-automation `automations.yaml` into **packages** (`homeassistant: packages: !include_dir_named packages/`), one file per feature (`red_alert`, `climate_ac`, `motion_lights`, `gate`, `jewish_calendar`, `system_health`, `morning_brief`) so each feature's automations + scripts + helpers live together. Biggest maintainability win. UI-managed `automations.yaml` can coexist.

**✨ Capability ideas (by value)**
1. Presence-aware AC + lights — replace the fixed 09:00 "Leave the house" with an "everyone left `zone.home`" trigger (AC off + lights off); on the gate-arrival automation, pre-run `livingroom_ac_smart_toggle` so the AC is running before you walk in.
2. Generalise `bathroom_lights_mode` → `adaptive_light_on` with an optional illuminance condition (skip when the room is already bright).
3. One data-driven low-battery automation (template/group over all `*_battery` sensors) replacing the 2–3 separate ones; auto-covers new devices.
4. Harden `red_alert_voice_loop_2` termination — also stop when `binary_sensor.oref_alert` clears (v1 did this), not only on `time_to_shelter`.
5. Route HA alerts (low battery / CPU / mini-pc offline) through JARVIS (Telegram + actionable buttons) for consistent formatting and one place to manage.
6. **Entity naming / aliases pass (voice prerequisite)** — audit every exposed entity and give it clean, speakable names + HA aliases so voice ("turn on the living-room AC", "close the office blinds") and JARVIS's HA agent resolve reliably. JARVIS `agents/ha.js` already matches on `friendly_name` + `entity_id`, so cleaning names helps Telegram and Assist equally. Do this as part of Voice Phase A (see **Voice & Multi-Surface**):
   1. **Areas** — assign rooms (Living room, Bathroom, Work room, …).
   2. **Expose** — Settings → Voice assistants → Expose only entities you want voice to touch (lights, covers, AC scripts, gate); hide sensors/noise.
   3. **Friendly names** — speakable (`Living room AC`, not `Livingroom Ac Plug 2`); drop vendor cruft / IDs / duplicates.
   4. **Aliases** — synonyms per entity (`AC`, `air con`, `living room air conditioner`).
   5. **First-pass priority:** living-room AC scripts / mode, bathroom + work-room lights, gate/cover, a few common switches.
   _Optional later:_ feed HA aliases into the HA agent prompt if friendly names alone are insufficient.

### Automations

1. HA improvements recommendations (analyze entities and suggest automations)
2. n8n automations recommendations
3. pre-shabbat checklist
4. shabbat timers setup (HA automations for candle lighting / havdalah times)
5. daily / weekly digest — system health trends, security events, disk growth, media additions
6. proactive anomaly alerts — pattern detection beyond simple thresholds (disk growth rate, repeated SSH failures, container restart loops)

### Integrations

#### Already-connected services (extend existing access)
1. ~~Jellyfin media agent~~ — ✅ _shipped (see Done)._ Search, recommendations, continue-watching/next-up, now-playing, library scans + poster thumbnails. _Next candidates:_ remote playback control (play/pause/cast to a session).
2. qBittorrent agent — search/add torrents, monitor downloads, auto-organize completed media (already has `/download` command, extend with NL control)
3. multi-room audio / music control — control speakers via HA from Telegram
4. HA energy dashboard via Telegram — daily/weekly consumption, cost estimates, peak hours
5. personal app integrations — ✅ _shipped via the generic MCP client (see Done)._ **QRganize** (home inventory) and **RecipeRack** (recipes & meal planning) are live over MCP, with cross-provider orchestration. Adding more self-hosted apps is now a `~/jarvis/mcp.json` entry (HTTP `url` or local stdio `command`/`args`) — no code. _Next candidates:_ **openbus** / **routes-israel** MCP for chat (see #14; ambient buses already use curlbus HTTP); scan [Skills IL skills catalog](https://agentskills.co.il/he/skills) for more keepers (see “Skills IL catalog” below).

#### New service integrations
6. calendar integration (Google Calendar / CalDAV — "what's on my schedule today?", "add meeting tomorrow at 3pm") — _partial: reminders now write to GCal (see Done); still TODO: NL "add meeting" events + Phase 2 GCal-trigger nudges for events created outside JARVIS_
7. email integration (Gmail API — "send confirmation email", "check inbox for X", "summarize unread emails")
8. messaging integration (WhatsApp Business API or Matrix — "send John the file", cross-platform messaging)
9. finance / portfolio integration — broker APIs (Interactive Brokers, Trading 212, IBI, etc.) for holdings, P&L, allocation analysis, cross-broker comparison
10. Strava / fitness coach — training log, weekly summaries, goal tracking, workout suggestions
11. Spotify / music — playback control, playlist management, listening stats, music recommendations
12. GitHub integration — repo status, PR notifications, issue management, commit summaries
13. note-taking integration (Obsidian / Notion API — "save this to my notes", "find my notes about X")
14. **Israel buses — live times, near-stop alerts, NL Q&A** — split by surface so ambient UI stays cheap and chat stays flexible:
    - **Ambient data (preferred):** **[curlbus](https://curlbus.app)** JSON stop board — `GET https://curlbus.app/<stop_code>` with `Accept: application/json`. Public wrapper over MOT **SIRI-SM** (stop arrivals), same class of signal Moovit uses. No API key. Source: [elad661/curlbus](https://github.com/elad661/curlbus).
    - **Also available:** [Open Bus Stride](https://open-bus-stride-api.hasadna.org.il/docs) (Hasadna; GTFS + SIRI vehicle locations). Good for research/vehicle GPS; weaker for stop boards (`/stop_arrivals` is poor; vehicle-location ETAs break when the VM feed lags or today’s GTFS date isn’t published yet).
    - **HA dashboard (implemented):** `jarvis-home/scripts/bus-monitor.mjs` polls **curlbus** every minute on **Sun–Thu all day**, both directions for **616** + **65**, writes `sensor.bus_{616,65}_{leaving,returning}_{eta,status}` (ETA-only English status). **No Alexa/phone alerts** (dashboard-only). Lovelace toggle sketch: `homeassistant/lovelace-bus-608.yaml` (`input_boolean.bus_leaving_home`).
    - **JARVIS + MCP (chat, not the poll loop):**
      - **openbus** — [`@skills-il/openbus-mcp`](https://agentskills.co.il/he/mcp/openbus) → Stride. Example in `mcp.json.example`. Not wired live yet.
      - **routes-israel** — [agentskills.co.il/he/mcp/routes-israel](https://agentskills.co.il/he/mcp/routes-israel) ([yoni-j/routes-mcp-israel](https://github.com/yoni-j/routes-mcp-israel)): Google Routes/Places + GTFS match + **curlbus** arrivals. Needs `GOOGLE_API_KEY`; clone + `uv`. Best for NL “how do I get from A to B?” — **do not** put in the every-minute HA poller.
    - **Later (product):** re-enable announce at ≤10 min (English); leave-home “leave by …” window; missed-bus → next ride; daily punctuality digest; confirm 616 return board at Kiryat Aryeh; wire openbus / routes-israel for chat.
    - **Lessons (2026-08-06):** Prefer curlbus stop boards over Stride GPS. HA status = ETA only (not bus position / headsign dump).
    - **Amir’s commute (sensors always both ways on weekdays):**
      | Line | Direction | Board (code) | Toward |
      |------|-----------|--------------|--------|
      | **616** | leaving | **39360** Deganya | Kiryat Aryeh |
      | **616** | returning | **26749** _(confirm)_ | Deganya / Netanya |
      | **65** | leaving | **39358** | Train (HaOrezim) |
      | **65** | returning | **33004** | Deganya |
15. transportation / navigation (Google Maps / Waze API — "how long to get to work?", "is there traffic?") — complements #14 for driving; buses are the Open Bus / curlbus track above.
16. food delivery / restaurant (Wolt / 10bis API — "order lunch", "what's nearby?")

### MCP servers (reference)

_Connecting a new provider = add an entry to `~/jarvis/mcp.json` (see `jarvis-home/mcp.json.example`) and restart the bot. HTTP servers use `url` (+ optional `headers`); local servers use `command` + `args` (+ optional `env`)._

- **QRganize** (home inventory) — `https://us-central1-qrganize-f651b.cloudfunctions.net/app/api/mcp` (Bearer token). Local inspector: `cd QRganize/mcp; $env:QRGANIZE_UUID="…"; npx @modelcontextprotocol/inspector node index.js`.
- **RecipeRack** (recipes & meal planning) — `https://us-central1-recipe-rack-ighp8.cloudfunctions.net/app/mcp` (no auth). Local inspector: `cd recipe-rack/mcp-server; npx @modelcontextprotocol/inspector node index.js`.
- **openbus** (Israel buses / Stride) — stdio: `npx -y @skills-il/openbus-mcp` ([catalog](https://agentskills.co.il/he/mcp/openbus)). No API key. Example in `mcp.json.example`. Ambient commute uses **curlbus HTTP**, not this MCP (see Integrations #14).
- **routes-israel** (trip planning + curlbus) — [catalog](https://agentskills.co.il/he/mcp/routes-israel); clone [yoni-j/routes-mcp-israel](https://github.com/yoni-j/routes-mcp-israel), needs `GOOGLE_API_KEY`. Chat / A→B routing only — not for cron poller.

### Skills IL catalog — review later

Browse [agentskills.co.il/he/skills](https://agentskills.co.il/he/skills) (Hebrew catalog of agent skills / MCP-related tooling for Israel & general use) and pick nice additions for JARVIS — e.g. new `~/jarvis/mcp.json` servers, Claude skills under `jarvis-home/`, or cron helpers. Related: [MCP catalog](https://agentskills.co.il/he/mcp) (includes [openbus](https://agentskills.co.il/he/mcp/openbus), [routes-israel](https://agentskills.co.il/he/mcp/routes-israel)). _TODO:_ walk the list and note keepers here.

### Personal Assistant

1. grocery / shopping list — "add milk to the list", persistent, shareable
2. expense tracking — "spent 200 on groceries", auto-categorize, monthly summaries
3. interactive troubleshooting flows — ✅ _shipped._ Cron alerts now carry contextual inline buttons. `notify.sh` gained generic action-button support (`restart-service`, `restart-user-service`, `logs-service`, `logs-user-service`, `restart-container`, `logs-container`, `block-ip`); `service-monitor.sh` attaches restart/logs buttons for each failed service + exited/unhealthy container, and `ssh-monitor.sh` attaches a block button for the top offending IPs. `commands/troubleshoot.js` (wired as `ts:` callbacks) handles service restart/logs in both system + user scope and IP-blocking via ufw with a confirm step; container actions reuse the existing `d:r:`/`d:l:` docker callbacks. All inputs are strictly validated (systemd unit charset, IPv4 octets) to prevent injection.

### Infrastructure

1. backup verification + cloud sync — test restore integrity, sync to B2/S3
2. chat from alexa dot?

## ❌ Out of Scope

- 3d scanning and modeling
- create projects and repos (github connections)

