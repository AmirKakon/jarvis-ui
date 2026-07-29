// JARVIS brain — headless router + agent loop, decoupled from any transport.
//
// `askCore(prompt, opts)` is the single entry point every surface calls:
// Telegram (via claude.js), the HTTP /ask endpoint (via server.js), and any
// future voice surface. It owns session rotation, memory, the front-model
// router, action dispatch, and assistant-message persistence. It returns plain
// data — no Telegram `ctx`, no HTML — so callers render however they like.

import crypto from 'node:crypto';
import {
  ensureSession, storeMessage, summarizeSession, buildMemoryContext,
} from './memory.js';
import { runWebSearch } from './agents/search.js';
import { runWebFetch } from './agents/fetch.js';
import { runCodeExecution } from './agents/compute.js';
import { runResearch } from './agents/research.js';
import { runMcpAgent } from './agents/mcp.js';
import { mcpServerSummaries } from './services/mcp-client.js';
import { runWeatherQuery } from './agents/weather.js';
import { runJellyfinQuery } from './agents/jellyfin.js';
import { runSelfDev } from './agents/selfdev.js';
import { startClaudeJob } from './agents/jobs.js';
import { resolveAndExecute } from './agents/ha.js';
import { parseAndCreate, listReminders, cancelReminder, cancelByText, extendReminder } from './agents/remind.js';
import { createEvent, listEvents } from './agents/calendar.js';

const SESSION_GAP_MS = 30 * 60 * 1000; // 30 minutes

// --- Rate limits (separate for front model vs Opus) ---
// Shared, in-memory sliding windows. Exported so the Telegram adapter's Opus
// paths (/deep, slash commands) draw from the SAME Opus budget as delegation.

const RATE_LIMIT_WINDOW = 60 * 60 * 1000;
const FRONT_RATE_MAX = Number(process.env.FRONT_RATE_LIMIT) || 60;
export const OPUS_RATE_MAX = Number(process.env.CLAUDE_RATE_LIMIT) || 20;

const frontCallLog = [];
export const opusCallLog = [];

export function isLimited(log, max) {
  const cutoff = Date.now() - RATE_LIMIT_WINDOW;
  while (log.length && log[0] < cutoff) log.shift();
  return log.length >= max;
}
export function recordTo(log) { log.push(Date.now()); }
export function remainingIn(log, max) {
  const cutoff = Date.now() - RATE_LIMIT_WINDOW;
  while (log.length && log[0] < cutoff) log.shift();
  return max - log.length;
}

// --- Session boundary tracking ---
// Keyed by an opaque `sessionKey` so any surface can have its own conversation
// thread. Telegram uses `tg:<chatId>`; HTTP callers pass their own key.

const activeSessions = new Map();

export function getOrRotateSession(sessionKey, source = 'telegram') {
  const entry = activeSessions.get(sessionKey);
  const now = Date.now();

  if (!entry || (now - entry.lastMessageTime) > SESSION_GAP_MS) {
    if (entry) {
      summarizeSession(entry.sessionId, entry.source || source).catch((err) =>
        console.error('Session summarization failed:', err.message)
      );
    }
    const sessionId = crypto.randomUUID();
    activeSessions.set(sessionKey, { sessionId, lastMessageTime: now, source });
    return { sessionId, isNew: true };
  }

  entry.lastMessageTime = now;
  return { sessionId: entry.sessionId, isNew: false };
}

export async function forceNewSession(sessionKey, source = 'telegram') {
  const entry = activeSessions.get(sessionKey);
  let result = null;
  if (entry) {
    result = await summarizeSession(entry.sessionId, entry.source || source);
    activeSessions.delete(sessionKey);
  }
  return result;
}

// --- Front-layer system prompt ---

const FRONT_SYSTEM_PROMPT = `You are JARVIS — a British AI assistant modelled after the AI from Iron Man, running on a home server (kamuri-mini-pc) in Netanya, Israel.

PERSONA:
- Address the user as "Sir"
- Maintain a dry, courteous, slightly cheeky tone
- Be concise — avoid unnecessary verbosity
- Use British English spelling (colour, favour, organisation)

MEMORY CONTEXT:
The memory block below (if present) contains your permanent facts and conversation history. Use it naturally.

YOUR CAPABILITIES:
You handle casual conversation, simple questions, knowledge queries, and memory-related tasks DIRECTLY.

ACTIONS:
When you cannot answer directly, respond with ONLY a raw JSON object — no markdown, no XML, no wrapper tags, no prose before or after. Just the JSON.

1. Server tasks (Docker, systemctl, SSH, logs, deploys, disk/network diagnostics, file ops, n8n, HA device actions, qBittorrent, system health, curl/HTTP API calls):
{"delegate": true, "task": "full description of what to do, with context", "acknowledge": "brief message to user"}
   Optionally add "agent" to route to a faster, cheaper specialist: "docker-ops" for Docker/container work, "diagnostics" for system health/status checks. Omit "agent" for anything complex or multi-step.

2. Web search (current events, real-time info, news, prices, weather in OTHER cities, anything needing up-to-date knowledge):
{"search": true, "query": "concise search query", "acknowledge": "brief message to user"}

3. Read a public web page or PDF (user shares a URL and wants its content read or summarised):
{"fetch": true, "url": "the URL to read", "question": "what the user wants to know", "acknowledge": "brief message to user"}

4. Calculations, data analysis, or code tasks (math, conversions, charts, CSV analysis, programming puzzles — NO internet access):
{"compute": true, "task": "what to calculate or generate", "acknowledge": "brief message to user"}

5. Home Assistant device control (turn on/off lights, switches, fans, or other smart devices):
{"ha": true, "command": "the full natural language command", "acknowledge": "brief message to user"}

6. Reminders (set, list, cancel, or extend reminders — supports one-shot, recurring daily/weekly/monthly, and interval-based like "every N minutes/hours"):
{"remind": true, "action": "set|list|cancel|extend", "text": "the user's full message", "acknowledge": "brief message to user"}

7. Local weather (current conditions or forecast for HERE/Netanya — "the weather", "will it rain", "forecast", "this weekend", "tomorrow"):
{"weather": true, "question": "the user's weather question", "acknowledge": "brief message to user"}

8. Calendar events (schedule/add a meeting, appointment, or event; or list what's on the calendar for a day/range):
{"calendar": true, "action": "create|list", "text": "the user's full message", "acknowledge": "brief message to user"}

9. Deep research / multi-step analysis (needs several searches, cross-referencing multiple sources, reading full web pages, or combining web data with calculations/charts — anything a single quick lookup can't answer):
{"research": true, "query": "the full research question with all relevant context", "acknowledge": "brief message to user"}

10. Media library (Jellyfin — search the movie/TV library, what's recently added, continue watching / next up, "what should I watch tonight" recommendations, what's playing now, or trigger a library scan):
{"jellyfin": true, "query": "the user's full request", "acknowledge": "brief message to user"}

11. Self-development — modify your OWN source code / behaviour. Your source lives in the jarvis-ui repository and includes: your monitoring scripts (scripts/*.sh — e.g. samba-monitor.sh, disk-watchdog.sh), your Telegram bot code (telegram-bot/src/**), your prompts, and your .claude config. ANY request to add/edit/comment/rename/refactor those files, add a feature or command to yourself, fix a bug in your own code, or make one of your checks self-healing → selfdev. This edits the codebase, syntax-checks, commits, and offers a deploy:
{"selfdev": true, "task": "a clear, complete description of the code change to make, with all context", "acknowledge": "brief message to user"}

MULTIPLE ACTIONS:
If the user asks for several INDEPENDENT things in one message, respond with a JSON ARRAY of action objects (using the exact formats above), e.g. [{...}, {...}]. Each entry runs concurrently, so only combine actions that do not depend on one another. For a single request, return a single object — never wrap one action in an array.

EXAMPLES:
- User: "what's on this page https://example.com" → {"fetch": true, "url": "https://example.com", "question": "What is on this page?", "acknowledge": "Let me read that page for you, Sir."}
- User: "restart the nginx container" → {"delegate": true, "task": "Restart the nginx Docker container and confirm it's healthy", "agent": "docker-ops", "acknowledge": "Restarting nginx now, Sir."}
- User: "what's the weather" → {"weather": true, "question": "current weather", "acknowledge": "Checking the weather, Sir."}
- User: "will it rain tomorrow" → {"weather": true, "question": "will it rain tomorrow?", "acknowledge": "Let me check the forecast, Sir."}
- User: "what's the weather this weekend" → {"weather": true, "question": "weather this weekend", "acknowledge": "Checking the weekend forecast, Sir."}
- User: "what's the weather in Paris" → {"search": true, "query": "weather Paris France today", "acknowledge": "Checking the weather in Paris, Sir."}
- User: "compare the iPhone 16 and Pixel 9 cameras and tell me which is better" → {"research": true, "query": "Compare iPhone 16 and Pixel 9 camera quality across reviews and give a verdict", "acknowledge": "Let me research that properly, Sir."}
- User: "find Bitcoin's price over the last month and chart it" → {"research": true, "query": "Find Bitcoin daily price for the last 30 days and plot it as a chart", "acknowledge": "On it — gathering the data and charting it, Sir."}
- User: "research the gnome-remote-desktop service and whether it's a security risk" → {"research": true, "query": "What is the gnome-remote-desktop service, what does port 3390 do, and is it a security risk?", "acknowledge": "Let me dig into that, Sir."}
- User: "calculate 15% tip on 230 shekels" → {"compute": true, "task": "Calculate 15% tip on 230 ILS", "acknowledge": "Let me work that out, Sir."}
- User: "call the forecast API at https://www.02ws.co.il/api/forecast" → {"delegate": true, "task": "Make an HTTP GET request to https://www.02ws.co.il/api/forecast and return the response", "acknowledge": "Calling that API now, Sir."}
- User: "how's the server doing" → {"delegate": true, "task": "Run a full system health check (CPU, memory, disk, containers, failed services)", "agent": "diagnostics", "acknowledge": "Running a health check, Sir."}
- User: "turn off the heater plug" → {"ha": true, "command": "turn off the heater plug", "acknowledge": "Switching it off now, Sir."}
- User: "turn on the living room light" → {"ha": true, "command": "turn on the living room light", "acknowledge": "Lighting up the living room, Sir."}
- User: "remind me to check the laundry in 30 minutes" → {"remind": true, "action": "set", "text": "remind me to check the laundry in 30 minutes", "acknowledge": "Setting that reminder, Sir."}
- User: "reminder for every 5 minutes to stretch" → {"remind": true, "action": "set", "text": "reminder for every 5 minutes to stretch", "acknowledge": "Setting that recurring reminder, Sir."}
- User: "schedule a meeting with Dana tomorrow 3pm for an hour" → {"calendar": true, "action": "create", "text": "schedule a meeting with Dana tomorrow 3pm for an hour", "acknowledge": "Adding that to your calendar, Sir."}
- User: "add a dentist appointment on Friday 10am" → {"calendar": true, "action": "create", "text": "add a dentist appointment on Friday 10am", "acknowledge": "Putting that on your calendar, Sir."}
- User: "what's on my calendar Friday" → {"calendar": true, "action": "list", "text": "what's on my calendar Friday", "acknowledge": "Checking your calendar, Sir."}
- User: "what do I have this week" → {"calendar": true, "action": "list", "text": "what do I have this week", "acknowledge": "Let me check your schedule, Sir."}
- User: "what reminders do I have" → {"remind": true, "action": "list", "text": "list reminders", "acknowledge": "Let me check, Sir."}
- User: "cancel reminder 3" → {"remind": true, "action": "cancel", "text": "cancel reminder 3", "acknowledge": "Cancelling that reminder, Sir."}
- User: "extend reminder 2 by 20 minutes" → {"remind": true, "action": "extend", "text": "extend reminder 2 by 20 minutes", "acknowledge": "Extending that reminder, Sir."}
- User: "what should I watch tonight" → {"jellyfin": true, "query": "What should I watch tonight?", "acknowledge": "Let me see what's on, Sir."}
- User: "do we have the movie Dune on jellyfin" → {"jellyfin": true, "query": "Is the movie Dune in the library?", "acknowledge": "Checking the library, Sir."}
- User: "what's been added to jellyfin recently" → {"jellyfin": true, "query": "recently added", "acknowledge": "Checking what's new, Sir."}
- User: "what am I in the middle of watching" → {"jellyfin": true, "query": "continue watching", "acknowledge": "Let me check, Sir."}
- User: "add a comment at the top of scripts/samba-monitor.sh noting it self-heals mounts" → {"selfdev": true, "task": "Add a comment near the top of scripts/samba-monitor.sh (right after the shebang) explaining that the script self-heals mounts before alerting", "acknowledge": "Adding that note to my code, Sir."}
- User: "add a self-healing retry to your disk watchdog script" → {"selfdev": true, "task": "In the disk-watchdog monitoring script, add self-healing: if the disk check fails, attempt cleanup/remount and retry up to 3 times before alerting", "acknowledge": "Let me update my own code for that, Sir."}
- User: "make your morning briefing also include the weather for tomorrow" → {"selfdev": true, "task": "Modify the morning briefing so it also includes tomorrow's weather forecast, not just today's", "acknowledge": "I'll amend my briefing code, Sir."}
- User: "add a /gpu command that shows GPU temperature" → {"selfdev": true, "task": "Add a new Telegram command /gpu that reports GPU temperature and utilisation", "acknowledge": "Adding that command to myself, Sir."}
- User: "turn on the office light and tell me the news about the port strike" → [{"ha": true, "command": "turn on the office light", "acknowledge": "Lighting up the office, Sir."}, {"search": true, "query": "port strike news today", "acknowledge": "Fetching the latest, Sir."}]
- User: "what's on my calendar today and will it rain" → [{"calendar": true, "action": "list", "text": "what's on my calendar today", "acknowledge": "Checking your calendar, Sir."}, {"weather": true, "question": "will it rain today?", "acknowledge": "Checking the forecast, Sir."}]

RULES:
- Set/list/cancel/extend reminders, alarms, scheduled messages (including recurring like "every X minutes") → remind
- "Remind me to..." (a nudge/notification) → remind
- "Schedule/add a meeting/appointment/event", "put X on my calendar", or asking what's on the calendar for a day/range → calendar
- NEVER refuse a reminder request — always route to remind and let the reminder system handle it
- Smart home device control (turn on/off, toggle lights/switches/plugs/fans/covers) → ha
- Server operations (check status, read logs, restart services, run commands) → delegate
- Changing your OWN code/behaviour, adding a feature to yourself, fixing a bug in your own scripts/commands, editing or adding a comment to any of your scripts (scripts/*.sh) or bot code (telegram-bot/src/**), making a check self-healing → selfdev (this edits the source and commits it; delegate only RUNS things and edits the throwaway deploy copy, so NEVER use delegate to change a file in your own codebase)
- API calls, curl requests, HTTP endpoints that need headers/auth → delegate (server has full network access)
- Local weather / forecast (here, Netanya, "the weather", rain, temperature outlook) → weather
- Weather for a DIFFERENT city → search
- Current info, news, prices, live data (a single quick lookup) → search
- Multi-step research: comparing options, cross-referencing several sources, reading multiple pages, or search combined with calculations/charts → research
- Movies / TV / media library: "what should I watch", search titles, recently added, continue watching, now playing, library scan → jellyfin
- Read/summarise a public web page or PDF → fetch
- Math, conversions, data analysis, generate charts → compute (NO internet — cannot make HTTP requests)
- Knowledge questions (what is X, explain Y) → answer directly
- If unsure whether to delegate or search → delegate (safer)
- Several independent requests in one message → return a JSON ARRAY of actions
- NEVER invent tool call formats like <function_calls>, <tool_use>, or XML tags. Only use the JSON formats above.
- Never mention actions, models, or architecture to the user. Just respond naturally.`;

// Connected MCP tool providers are declared in ~/jarvis/mcp.json (see
// services/mcp-client.js). They're injected into the front prompt at runtime so
// the router can offer their capabilities without hard-coding any provider.
function mcpPromptSection() {
  const servers = mcpServerSummaries();
  if (!servers.length) return '';
  const list = servers
    .map((s) => `   • ${s.name}${s.description ? ` — ${s.description}` : ''}`)
    .join('\n');
  return `

12. Connected external tool providers (MCP). Route requests matching one of these here:
${list}
{"mcp": true, "task": "the user's full request in natural language", "complex": false, "acknowledge": "brief message to user"}
- Set "complex": true when the task spans MULTIPLE providers above OR needs multi-step reasoning (e.g. cross-referencing a recipe against inventory, then updating a list). Use false (or omit) for a single simple lookup or action.
- EXAMPLE (simple): "how many eggs do I have left" → {"mcp": true, "task": "How many eggs are in stock?", "acknowledge": "Checking your inventory, Sir."}
- EXAMPLE (simple): "add milk to the shopping list" → {"mcp": true, "task": "Add milk to the shopping list", "acknowledge": "Adding milk to your list, Sir."}
- EXAMPLE (bridging): "add the missing ingredients for spaghetti bolognese to my shopping list" → {"mcp": true, "task": "Look up the spaghetti bolognese recipe, check which of its ingredients are missing from my inventory, and add the missing ones to the shopping list", "complex": true, "acknowledge": "Cross-referencing the recipe with your inventory, Sir."}
- EXAMPLE (bridging): "what can I cook with what's expiring soon" → {"mcp": true, "task": "Find items expiring soon in my inventory, then suggest recipes I can make with them", "complex": true, "acknowledge": "Let me see what needs using up, Sir."}`;
}

// --- Front model API call (Haiku 4.5 primary, GPT-4o-mini fallback) — pure router, no tools ---

async function runFrontModel(systemPrompt, userMessage) {
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (anthropicKey) {
    try {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': anthropicKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 1024,
          system: systemPrompt,
          messages: [{ role: 'user', content: userMessage }],
        }),
        signal: AbortSignal.timeout(30_000),
      });
      if (res.ok) {
        const data = await res.json();
        const text = data.content?.[0]?.text?.trim();
        if (text) {
          console.log('[front] Responded via Anthropic Haiku 4.5');
          return { ok: true, output: text, provider: 'haiku' };
        }
      }
      const errBody = await res.text().catch(() => '');
      console.error(`[front] Anthropic API error: ${res.status} ${errBody.slice(0, 300)}`);
    } catch (err) {
      console.error('[front] Anthropic API failed:', err.message);
    }
  } else {
    console.log('[front] No ANTHROPIC_API_KEY — falling back to OpenAI');
  }

  const openaiKey = process.env.OPENAI_API_KEY;
  if (openaiKey) {
    try {
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${openaiKey}`,
        },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userMessage },
          ],
          temperature: 0.7,
          max_tokens: 1024,
        }),
        signal: AbortSignal.timeout(30_000),
      });
      if (res.ok) {
        const data = await res.json();
        const text = data.choices?.[0]?.message?.content?.trim();
        if (text) {
          console.log('[front] Responded via OpenAI GPT-4o-mini (fallback)');
          return { ok: true, output: text, provider: 'gpt4o-mini' };
        }
      }
      console.error(`[front] OpenAI API error: ${res.status}`);
    } catch (err) {
      console.error('[front] OpenAI API failed:', err.message);
    }
  }

  return { ok: false, output: 'No API key available for front model (set ANTHROPIC_API_KEY or OPENAI_API_KEY).' };
}

// --- Action metadata + parsing ---

const ACTION_KEYS = ['delegate', 'search', 'fetch', 'compute', 'ha', 'remind', 'weather', 'calendar', 'research', 'mcp', 'jellyfin', 'selfdev'];

// Per-action presentation metadata (status emoji, default ack, error label)
export const ACTION_META = {
  delegate: { emoji: '⚙️', ack: 'Working on it, Sir...', label: 'Task' },
  search:   { emoji: '🔍', ack: 'Searching the web, Sir...', label: 'Search' },
  fetch:    { emoji: '📄', ack: 'Reading the page, Sir...', label: 'Fetch' },
  compute:  { emoji: '🧮', ack: 'Running calculations, Sir...', label: 'Computation' },
  ha:       { emoji: '🏡', ack: 'Controlling Home Assistant, Sir...', label: 'Home Assistant' },
  remind:   { emoji: '⏰', ack: 'On it, Sir...', label: 'Reminder' },
  weather:  { emoji: '🌤️', ack: 'Checking the weather, Sir...', label: 'Weather' },
  calendar: { emoji: '📅', ack: 'Checking your calendar, Sir...', label: 'Calendar' },
  research: { emoji: '🔬', ack: 'Researching that for you, Sir...', label: 'Research' },
  mcp:      { emoji: '🧰', ack: 'Checking that for you, Sir...', label: 'Tools' },
  jellyfin: { emoji: '🎬', ack: 'Checking the media library, Sir...', label: 'Jellyfin' },
  selfdev:  { emoji: '🛠️', ack: 'Editing my own code, Sir — this may take a few minutes...', label: 'Self-update' },
};

export const actionKeyOf = (a) => ACTION_KEYS.find((k) => a?.[k]) || null;

// --- Delegate routing: pick a model tier + optional Claude Code subagent ---
// Routine server ops are haiku-tier work (the docker-ops/diagnostics subagents
// are already model: haiku); only genuinely complex tasks warrant Opus.

const DELEGATE_MODELS = {
  opus: 'claude-opus-4-8',
  sonnet: 'claude-sonnet-5',
  haiku: 'claude-haiku-4-5-20251001',
};

// Known subagents (from .claude/agents/) → tier + backing model.
const DELEGATE_AGENTS = {
  'docker-ops':  { tier: 'cheap', model: DELEGATE_MODELS.haiku },
  'diagnostics': { tier: 'cheap', model: DELEGATE_MODELS.haiku },
  'research':    { tier: 'cheap', model: DELEGATE_MODELS.sonnet },
};

// Keyword fallback when the front model didn't supply an `agent` hint.
function classifyDelegate(task) {
  const t = (task || '').toLowerCase();
  if (/\b(docker|container|compose|image|volume)s?\b/.test(t)) return 'docker-ops';
  if (/\b(status|health|diagnostic|uptime|disk|memory|cpu|load average|failed service|systemctl|journalctl|df|free)\b/.test(t)) return 'diagnostics';
  return null;
}

// Resolve a delegate action to { agent, model, tier }. Falls back to Opus.
function resolveDelegateTarget(action) {
  let agent = typeof action.agent === 'string' ? action.agent.toLowerCase() : null;
  if (!agent || !DELEGATE_AGENTS[agent]) agent = classifyDelegate(action.task);
  if (agent && DELEGATE_AGENTS[agent]) return { agent, ...DELEGATE_AGENTS[agent] };
  return { agent: null, tier: 'opus', model: DELEGATE_MODELS.opus };
}

// Parse the front model output into an ARRAY of action objects.
// Supports a single object (→ [obj]), a JSON array (→ filtered), or JSON
// embedded in prose (→ single). Returns [] when no action is present.
function parseActions(text) {
  const normalize = (s) => s
    .replace(/[\u201C\u201D\u201E\u201F\u2033\u2036]/g, '"')
    .replace(/[\u2018\u2019\u201A\u201B\u2032\u2035]/g, "'");

  const isAction = (o) => o && typeof o === 'object' && ACTION_KEYS.some((k) => o[k]);
  const tryParse = (s) => { try { return JSON.parse(s); } catch { return null; } };

  // Try to interpret a candidate string as one-or-more actions.
  const fromCandidate = (s) => {
    const parsed = tryParse(s);
    if (Array.isArray(parsed)) {
      const actions = parsed.filter(isAction);
      if (actions.length) return actions;
    }
    if (isAction(parsed)) return [parsed];
    return null;
  };

  let trimmed = normalize(text.trim());

  // 1. Fenced code block anywhere (```json ... ```), even with prose around it.
  //    Haiku sometimes adds a preamble sentence before the fence.
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) {
    const hit = fromCandidate(fence[1].trim());
    if (hit) return hit;
  }

  // 2. Whole message is JSON (array or object).
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    const hit = fromCandidate(trimmed);
    if (hit) return hit;
  }

  // 3. JSON embedded in prose: slice from the first bracket to the matching
  //    last bracket and try. Handles pretty-printed JSON + leading/trailing text.
  for (const [open, close] of [['[', ']'], ['{', '}']]) {
    const start = trimmed.indexOf(open);
    const end = trimmed.lastIndexOf(close);
    if (start >= 0 && end > start) {
      const hit = fromCandidate(trimmed.slice(start, end + 1));
      if (hit) return hit;
    }
  }

  return [];
}

// --- Reminder sub-dispatch (set/list/cancel/extend) ---

async function runReminder(action, chatId, prompt) {
  switch (action.action) {
    case 'list':
      return listReminders(chatId);
    case 'cancel': {
      const idMatch = action.text?.match(/(?:reminder\s*#?\s*)?(\d+)/i);
      const remId = idMatch ? parseInt(idMatch[1]) : null;
      return remId
        ? cancelReminder(chatId, remId)
        : cancelByText(chatId, action.text || prompt);
    }
    case 'extend': {
      const nums = action.text?.match(/\d+/g) || [];
      const remId = nums[0] ? parseInt(nums[0]) : null;
      const mins = nums[1] ? parseInt(nums[1]) : null;
      return (remId && mins)
        ? extendReminder(chatId, remId, mins)
        : { ok: false, output: 'Please specify the reminder number and minutes (e.g. "extend reminder 3 by 15 minutes").' };
    }
    default:
      return parseAndCreate(chatId, action.text || prompt);
  }
}

// --- Execute one action, returning its raw result (no transport I/O) ---
// Rate-limited actions (research, delegate) gate synchronously here so parallel
// dispatch reserves capacity deterministically in request order. Reminders and
// calendar creation need a real Telegram chatId, so they degrade gracefully when
// called from a headless surface (sctx.chatId is null).

async function runOne(action, sctx) {
  const key = actionKeyOf(action);
  switch (key) {
    case 'weather':
      return { key, action, res: await runWeatherQuery(action.question) };
    case 'calendar':
      if (action.action === 'list') {
        return { key, action, res: await listEvents(action.text || sctx.prompt) };
      }
      if (!sctx.chatId) {
        return { key, action, res: { ok: false, output: 'Calendar events can only be created via Telegram at the moment, Sir.' } };
      }
      return { key, action, res: await createEvent(sctx.chatId, action.text || sctx.prompt) };
    case 'search':
      return { key, action, res: await runWebSearch(action.query) };
    case 'fetch':
      return { key, action, res: await runWebFetch(action.url, action.question) };
    case 'compute':
      return { key, action, res: await runCodeExecution(action.task) };
    case 'mcp':
      return { key, action, res: await runMcpAgent(action.task || sctx.prompt, { complex: !!action.complex }) };
    case 'jellyfin':
      return { key, action, res: await runJellyfinQuery(action.query || sctx.prompt) };
    case 'ha':
      return { key, action, res: await resolveAndExecute(action.command) };
    case 'remind':
      if (!sctx.chatId) {
        return { key, action, res: { ok: false, output: 'Reminders are only available via Telegram at the moment, Sir.' } };
      }
      return { key, action, res: await runReminder(action, sctx.chatId, sctx.prompt) };
    case 'research': {
      if (isLimited(opusCallLog, OPUS_RATE_MAX)) {
        return { key, action, res: { ok: false, output: `rate limit reached (${OPUS_RATE_MAX}/hour). Use /search for a quick lookup.` } };
      }
      recordTo(opusCallLog);
      console.log(`[front] Deep research: ${action.query?.slice(0, 100)}`);
      return { key, action, res: await runResearch(action.query || sctx.prompt) };
    }
    case 'delegate': {
      const target = resolveDelegateTarget(action);

      // Only Opus-tier work consumes the (scarce) Opus bucket; cheap subagent
      // ops just ran through the front-call budget already.
      if (target.tier === 'opus') {
        if (isLimited(opusCallLog, OPUS_RATE_MAX)) {
          return { key, action, res: { ok: false, output: `Opus rate limit reached (${OPUS_RATE_MAX}/hour). Try again later or use slash commands.` } };
        }
        recordTo(opusCallLog);
      }

      console.log(`[front] Delegating (${target.agent || 'opus'} / ${target.model}): ${action.task?.slice(0, 100)}`);

      const hint = target.agent ? `\n\nPrefer using the ${target.agent} subagent for this if appropriate.` : '';
      const prompt = `${sctx.contextPrompt}\n\nTask to execute: ${action.task}${hint}`;
      const footer = target.tier === 'opus'
        ? `(${remainingIn(opusCallLog, OPUS_RATE_MAX)} Opus calls remaining this hour)`
        : undefined;

      // Run in the background so slow ops can't hit the old inline timeout.
      const label = action.acknowledge || ACTION_META.delegate.ack;
      const { id, promise } = startClaudeJob({ prompt, model: target.model, label, task: action.task });

      // Headless callers (no onBackground hook — e.g. HTTP /ask) await the full
      // result so their response carries the answer, not just an ack.
      if (!sctx.onBackground) {
        const res = await promise;
        return { key, action, res: { ...res, footer } };
      }

      // Telegram (async): return an ack now; deliver the real result — and
      // persist it to memory — when the job finishes.
      promise.then(async (res) => {
        try {
          await storeMessage(sctx.sessionId, 'assistant', res.ok ? res.output : `Task failed: ${res.output}`);
        } catch (err) {
          console.error('[core] background persist failed:', err.message);
        }
        try {
          await sctx.onBackground({ key, action, res: { ...res, footer } });
        } catch (err) {
          console.error('[core] onBackground delivery failed:', err.message);
        }
      });

      return { key, action, res: { ok: true, output: label, background: true, jobId: id } };
    }
    case 'selfdev': {
      // Self-edits run an Opus-tier code agent — draw from the Opus budget.
      if (isLimited(opusCallLog, OPUS_RATE_MAX)) {
        return { key, action, res: { ok: false, output: `Opus rate limit reached (${OPUS_RATE_MAX}/hour). Try again later, Sir.` } };
      }
      recordTo(opusCallLog);
      console.log(`[front] Self-development: ${action.task?.slice(0, 100)}`);
      return { key, action, res: await runSelfDev(action.task || sctx.prompt) };
    }
    default:
      return { key: null, action, res: { ok: false, output: 'Unknown action.' } };
  }
}

// --- askCore: the headless brain entry point ---
//
// Returns a plain result:
//   { ok, kind, sessionId, text, results }
// where kind ∈ 'direct' | 'actions' | 'rate_limited' | 'error' | 'empty',
// `text` is the plain reply/combined output, and `results` is the array of
// { key, action, res } for callers that want to render per-action output/media.
//
// opts:
//   sessionKey  conversation thread key (default 'api:default')
//   source      session metadata tag (default 'api')
//   chatId      Telegram chat id for chat-bound actions (reminders/calendar); null on headless surfaces
//   onPlan      optional async hook called with the parsed actions before execution (for progress UX)
//   onBackground optional async hook to deliver a long/delegated action's result AFTER askCore returns
//                (fire-and-follow-up). When omitted, such actions are awaited inline instead.

export async function askCore(prompt, { sessionKey = 'api:default', source = 'api', chatId = null, onPlan = null, onBackground = null } = {}) {
  const text = (prompt || '').trim();
  if (!text) return { ok: false, kind: 'empty', sessionId: null, text: '', results: [] };

  const { sessionId } = getOrRotateSession(sessionKey, source);
  await ensureSession(sessionId, source);
  await storeMessage(sessionId, 'user', text);

  const contextPrompt = await buildMemoryContext(text, sessionId);

  if (isLimited(frontCallLog, FRONT_RATE_MAX)) {
    return {
      ok: false, kind: 'rate_limited', sessionId,
      text: `Rate limit reached (${FRONT_RATE_MAX} calls/hour). Wait a bit or use slash commands.`,
      results: [],
    };
  }
  recordTo(frontCallLog);

  const front = await runFrontModel(FRONT_SYSTEM_PROMPT + mcpPromptSection(), contextPrompt);
  if (!front.ok) {
    return { ok: false, kind: 'error', sessionId, text: front.output, results: [] };
  }

  let actions = parseActions(front.output);

  // Fallback: user sent a URL but the front model didn't return a fetch action.
  if (!actions.length) {
    const urlMatch = text.match(/https?:\/\/[^\s]+/i);
    if (urlMatch) {
      console.log(`[core] URL fallback — auto-fetch for: ${urlMatch[0].slice(0, 100)}`);
      const questionPart = text.replace(urlMatch[0], '').trim();
      actions = [{
        fetch: true,
        url: urlMatch[0],
        question: questionPart || 'Provide an overview of the content.',
        acknowledge: 'Reading the page, Sir...',
      }];
    }
  }

  // --- Direct answer ---
  if (!actions.length) {
    await storeMessage(sessionId, 'assistant', front.output);
    return { ok: true, kind: 'direct', sessionId, text: front.output, results: [] };
  }

  // --- Action dispatch: run independent actions in parallel ---
  if (onPlan) {
    try { await onPlan(actions); } catch (err) { console.error('[core] onPlan hook failed:', err.message); }
  }

  console.log(`[core] Dispatching ${actions.length} action(s): ${actions.map(actionKeyOf).join(', ')}`);

  const sctx = { sessionId, prompt: text, contextPrompt, chatId, onBackground };
  const results = await Promise.all(
    actions.map((a) => runOne(a, sctx).catch((err) => ({
      key: actionKeyOf(a), action: a, res: { ok: false, output: err.message },
    })))
  );

  // Background actions (delegated jobs) deliver + persist their own result later
  // via onBackground; only the synchronous results are handled here and now.
  const immediate = results.filter((r) => !r.res.background);

  // Persist ONE combined assistant message for the synchronous results
  // (previously done per-action in the Telegram renderer). Include failure
  // markers so memory reflects what happened.
  if (immediate.length) {
    const memoryParts = immediate.map((r) => {
      const meta = ACTION_META[r.key] || { label: 'Action' };
      return r.res.ok ? r.res.output : `${meta.label} failed: ${r.res.output}`;
    });
    await storeMessage(sessionId, 'assistant', memoryParts.join('\n\n'));
  }

  // Reply text = successful synchronous outputs joined (voice + fact extraction).
  const combined = immediate
    .filter((r) => r.res.ok && r.res.output)
    .map((r) => r.res.output)
    .join('\n\n');

  return { ok: true, kind: 'actions', sessionId, text: combined, results };
}
