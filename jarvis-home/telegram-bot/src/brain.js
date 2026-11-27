// JARVIS brain — headless router + agent loop, decoupled from any transport.
//
// `askCore(prompt, opts)` is the single entry point every surface calls:
// Telegram (via claude.js), the HTTP /ask endpoint (via server.js), and any
// future voice surface. It owns session rotation, memory, the front-model
// router, action dispatch, and assistant-message persistence. It returns plain
// data — no Telegram `ctx`, no HTML — so callers render however they like.

import crypto from 'node:crypto';
import {
  ensureSession, storeMessage, summarizeSession, buildMemoryContext, getUnsummarizedSessions,
} from './memory.js';
import { runWebSearch } from './agents/search.js';
import { runWebFetch } from './agents/fetch.js';
import { runCodeExecution } from './agents/compute.js';
import { runResearch } from './agents/research.js';
import { runMcpAgent } from './agents/mcp.js';
import { mcpServerSummaries } from './services/mcp-client.js';
import { runHaSubagent, isNonHaServer } from './agents/ha-subagent.js';
import { runWeatherQuery } from './agents/weather.js';
import { runJellyfinQuery, requestFromTool } from './agents/jellyfin.js';
import { runBusQuery } from './agents/bus.js';
import { runSelfDev } from './agents/selfdev.js';
import { startClaudeJob, startAsyncJob } from './agents/jobs.js';
import { frontModel, haikuModel, sonnetModel, opusModel, openaiSmallModel, quickCallOptions } from './models.js';
import { FRONT_TOOL_NAMES, frontTools, openaiTools, fromAnthropic, fromOpenAI } from './front-tools.js';
import { createReminder, parseAndCreate, listReminders, cancelReminder, cancelByText, extendReminder } from './agents/remind.js';
import { hasTiming } from './agents/schedule-spec.js';
import { createEvent, createEventFromSpec, listEvents, listEventsBetween } from './agents/calendar.js';
import { clockContext } from './utils.js';
import { resolveIdentity } from './identity.js';

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
// thread. Telegram uses `tg:<chatId>`; HTTP callers pass their own key. Keys
// listed in JARVIS_IDENTITY_MAP fold into one `user:<id>` thread (identity.js),
// so the same conversation continues across Telegram, Alexa, and Assist.

const activeSessions = new Map();

// Session ids being summarised right now, so the rotation path and the sweep
// never summarise the same conversation twice.
const summarizing = new Set();

// Surfaces that joined a session, e.g. "telegram+alexa" (chat_summaries.source is varchar(50)).
const sourceTag = (entry) => [...entry.sources].join('+').slice(0, 50);

async function summarizeOnce(sessionId, tag, summarize = summarizeSession) {
  if (summarizing.has(sessionId)) return null;
  summarizing.add(sessionId);
  try {
    return await summarize(sessionId, tag);
  } finally {
    summarizing.delete(sessionId);
  }
}

export function getOrRotateSession(sessionKey, source = 'telegram') {
  const key = resolveIdentity(sessionKey).sessionKey;
  const entry = activeSessions.get(key);
  const now = Date.now();

  if (!entry || (now - entry.lastMessageTime) > SESSION_GAP_MS) {
    if (entry) {
      summarizeOnce(entry.sessionId, sourceTag(entry)).catch((err) =>
        console.error('Session summarization failed:', err.message)
      );
    }
    const sessionId = crypto.randomUUID();
    activeSessions.set(key, { sessionId, lastMessageTime: now, sources: new Set([source]) });
    return { sessionId, isNew: true, key };
  }

  entry.lastMessageTime = now;
  entry.sources.add(source);
  return { sessionId: entry.sessionId, isNew: false, key };
}

export async function forceNewSession(sessionKey, source = 'telegram') {
  const key = resolveIdentity(sessionKey).sessionKey;
  const entry = activeSessions.get(key);
  let result = null;
  if (entry) {
    activeSessions.delete(key);
    result = await summarizeOnce(entry.sessionId, sourceTag(entry) || source);
  }
  return result;
}

// --- Surviving restarts ---
// Live sessions are cached in memory but every session row (with its key) is in
// Postgres until it is summarised. On startup, conversations active within the
// last SESSION_GAP_MS are picked up again; the sweep summarises the rest.

/** Restore recently active sessions into the cache. Returns how many. */
export async function restoreSessions({ load = getUnsummarizedSessions, now = Date.now() } = {}) {
  let restored = 0;
  for (const row of await load()) {
    if (!row.sessionKey || now - row.lastActivity > SESSION_GAP_MS || activeSessions.has(row.sessionKey)) continue;
    activeSessions.set(row.sessionKey, {
      sessionId: row.sessionId,
      lastMessageTime: row.lastActivity,
      sources: new Set([row.source]),
    });
    restored++;
  }
  return restored;
}

/**
 * Summarise conversations that went quiet: idle cached sessions, and rows left
 * behind by a restart. At most `limit` per run, newest first, so a backlog is
 * worked through gradually. Returns how many were summarised.
 */
export async function sweepIdleSessions({
  load = getUnsummarizedSessions, summarize = summarizeSession, now = Date.now(), limit = 5,
} = {}) {
  const due = [];
  for (const [key, entry] of activeSessions) {
    if (now - entry.lastMessageTime > SESSION_GAP_MS) {
      activeSessions.delete(key);
      due.push({ sessionId: entry.sessionId, tag: sourceTag(entry) });
    }
  }
  const live = new Set([...activeSessions.values()].map((e) => e.sessionId));
  for (const row of await load()) {
    if (live.has(row.sessionId) || due.some((d) => d.sessionId === row.sessionId)) continue;
    if (now - row.lastActivity > SESSION_GAP_MS) due.push({ sessionId: row.sessionId, tag: row.source });
  }

  let done = 0;
  for (const { sessionId, tag } of due.slice(0, limit)) {
    try {
      await summarizeOnce(sessionId, tag, summarize);
      done++;
    } catch (err) {
      console.error(`[sessions] summarising ${sessionId} failed:`, err.message);
    }
  }
  return done;
}

// --- Front-layer system prompt ---

// Built at request time so CURRENT TIME stays accurate (models otherwise hallucinate dates).
const VOICE_MODE = `

VOICE MODE:
This request was spoken on a phone call or smart speaker, and your reply will be read aloud.
- Direct answers: one or two short spoken sentences. No lists, markdown, emoji or URLs.
- In a tool call's task/question, ask for a short spoken-style answer (one or two sentences) unless the user asked for a full list or details. Long replies are sent to Telegram automatically.
- Keep "acknowledge" to a few words; it is spoken while you work.`;

function frontSystemPrompt() {
  return `You are JARVIS — a British AI assistant modelled after the AI from Iron Man, running on a home server (kamuri-mini-pc) in Netanya, Israel.

${clockContext()}

PERSONA:
- Address the user as "Sir"
- Maintain a dry, courteous, slightly cheeky tone
- Be concise — avoid unnecessary verbosity
- Use British English spelling (colour, favour, organisation)

MEMORY CONTEXT:
The memory block below (if present) contains your permanent facts and conversation history. Use it naturally.

YOUR CAPABILITIES:
You handle casual conversation, simple questions, knowledge queries, and memory-related tasks DIRECTLY.

TOOLS:
When you cannot answer directly, call one of your tools. Each tool's description says what it is for. Always fill "acknowledge" with a brief in-persona message to the user.
If the user asks for several INDEPENDENT things in one message, call one tool per request in the same reply. They run concurrently, so only combine calls that do not depend on one another.

EXAMPLES (user message → tool call):
- "what's on this page https://example.com" → fetch(url: "https://example.com", question: "What is on this page?", acknowledge: "Let me read that page for you, Sir.")
- "restart the nginx container" → delegate(task: "Restart the nginx Docker container and confirm it's healthy", agent: "docker-ops", acknowledge: "Restarting nginx now, Sir.")
- "what's the weather" → weather(question: "current weather", acknowledge: "Checking the weather, Sir.")
- "will it rain tomorrow" → weather(question: "will it rain tomorrow?", acknowledge: "Let me check the forecast, Sir.")
- "what's the weather in Paris" → search(query: "weather Paris France today", acknowledge: "Checking the weather in Paris, Sir.")
- "compare the iPhone 16 and Pixel 9 cameras and tell me which is better" → research(query: "Compare iPhone 16 and Pixel 9 camera quality across reviews and give a verdict", acknowledge: "Let me research that properly, Sir.")
- "find Bitcoin's price over the last month and chart it" → research(query: "Find Bitcoin daily price for the last 30 days and plot it as a chart", acknowledge: "On it — gathering the data and charting it, Sir.")
- "research the gnome-remote-desktop service and whether it's a security risk" → research(query: "What is the gnome-remote-desktop service, what does port 3390 do, and is it a security risk?", acknowledge: "Let me dig into that, Sir.")
- "calculate 15% tip on 230 shekels" → compute(task: "Calculate 15% tip on 230 ILS", acknowledge: "Let me work that out, Sir.")
- "call the forecast API at https://www.02ws.co.il/api/forecast" → delegate(task: "Make an HTTP GET request to https://www.02ws.co.il/api/forecast and return the response", acknowledge: "Calling that API now, Sir.")
- "how's the server doing" → delegate(task: "Run a full system health check (CPU, memory, disk, containers, failed services)", agent: "diagnostics", acknowledge: "Running a health check, Sir.")
- "turn off the heater plug" → ha(command: "turn off the heater plug", acknowledge: "Switching it off now, Sir.")
- "what's the state history of the bedroom light today" → ha(command: "what's the state history of the bedroom light today", acknowledge: "Checking the bedroom light's history, Sir.")
- "remind me to check the laundry in 30 minutes" → remind(action: "set", text: "remind me to check the laundry in 30 minutes", message: "check the laundry", in_minutes: 30, acknowledge: "Setting that reminder, Sir.")
- (today is Thursday 2026-11-26) "remind me to call mum tomorrow at 9am" → remind(action: "set", text: "remind me to call mum tomorrow at 9am", message: "call mum", date: "2026-11-27", time: "09:00", acknowledge: "Noted for tomorrow morning, Sir.")
- "remind me at 6pm to water the plants" → remind(action: "set", text: "remind me at 6pm to water the plants", message: "water the plants", time: "18:00", acknowledge: "Setting that reminder, Sir.")
- "reminder for every 5 minutes to stretch" → remind(action: "set", text: "reminder for every 5 minutes to stretch", message: "stretch", repeat: "minutes", every: 5, acknowledge: "Setting that recurring reminder, Sir.")
- "remind me every Sunday to take out the bins" → remind(action: "set", text: "remind me every Sunday to take out the bins", message: "take out the bins", repeat: "weekly", weekday: 7, acknowledge: "Every Sunday it is, Sir.")
- "take vitamins every day at 8:30" → remind(action: "set", text: "take vitamins every day at 8:30", message: "take vitamins", repeat: "daily", time: "08:30", acknowledge: "Daily at 08:30, Sir.")
- "what reminders do I have" → remind(action: "list", text: "list reminders", acknowledge: "Let me check, Sir.")
- "cancel reminder 3" → remind(action: "cancel", text: "cancel reminder 3", reminder_id: 3, acknowledge: "Cancelling that reminder, Sir.")
- "extend reminder 2 by 20 minutes" → remind(action: "extend", text: "extend reminder 2 by 20 minutes", reminder_id: 2, minutes: 20, acknowledge: "Extending that reminder, Sir.")
- (today is Thursday 2026-11-26) "schedule a meeting with Dana tomorrow 3pm for an hour" → calendar(action: "create", text: "schedule a meeting with Dana tomorrow 3pm for an hour", summary: "Meeting with Dana", date: "2026-11-27", time: "15:00", duration_min: 60, acknowledge: "Adding that to your calendar, Sir.")
- (today is Thursday 2026-11-26) "dentist Sunday 10-10:30 at Clinic X" → calendar(action: "create", text: "dentist Sunday 10-10:30 at Clinic X", summary: "Dentist", date: "2026-11-29", time: "10:00", end_time: "10:30", location: "Clinic X", acknowledge: "Booked in, Sir.")
- "standup every Monday at 9" → calendar(action: "create", text: "standup every Monday at 9", summary: "Standup", repeat: "weekly", weekday: 1, time: "09:00", acknowledge: "A weekly standup it is, Sir.")
- (today is Thursday 2026-11-26) "what do I have this week" → calendar(action: "list", text: "what do I have this week", start_date: "2026-11-26", end_date: "2026-11-29", acknowledge: "Let me check your schedule, Sir.")
- (today is Thursday 2026-11-26) "what's on Friday" → calendar(action: "list", text: "what's on Friday", start_date: "2026-11-27", end_date: "2026-11-27", acknowledge: "Checking Friday, Sir.")
- "what should I watch tonight" → jellyfin(query: "What should I watch tonight?", intent: "recommend", acknowledge: "Let me see what's on, Sir.")
- "any good comedy series to watch?" → jellyfin(query: "Recommend a comedy series", intent: "recommend", genres: ["Comedy"], item_type: "Series", acknowledge: "Let me find you something funny, Sir.")
- "do we have the movie Dune on jellyfin" → jellyfin(query: "Is the movie Dune in the library?", intent: "search", search_term: "Dune", item_type: "Movie", acknowledge: "Checking the library, Sir.")
- "what's new on jellyfin" → jellyfin(query: "What was recently added?", intent: "recent", acknowledge: "Checking what's new, Sir.")
- "when is the next 65 to the train" → bus(question: "next 65 leaving to the train", acknowledge: "Checking line 65, Sir.")
- "616 ETA coming home" → bus(question: "616 returning home", acknowledge: "Checking the 616, Sir.")
- "add a comment at the top of scripts/samba-monitor.sh noting it self-heals mounts" → selfdev(task: "Add a comment near the top of scripts/samba-monitor.sh (right after the shebang) explaining that the script self-heals mounts before alerting", acknowledge: "Adding that note to my code, Sir.")
- "make your morning briefing also include the weather for tomorrow" → selfdev(task: "Modify the morning briefing so it also includes tomorrow's weather forecast, not just today's", acknowledge: "I'll amend my briefing code, Sir.")
- "add a /gpu command that shows GPU temperature" → selfdev(task: "Add a new Telegram command /gpu that reports GPU temperature and utilisation", acknowledge: "Adding that command to myself, Sir.")
- "turn on the office light and tell me the news about the port strike" → two calls: ha(command: "turn on the office light", acknowledge: "Lighting up the office, Sir.") and search(query: "port strike news today", acknowledge: "Fetching the latest, Sir.")
- (today is Thursday 2026-11-26) "what's on my calendar today and will it rain" → two calls: calendar(action: "list", text: "what's on my calendar today", start_date: "2026-11-26", end_date: "2026-11-26", acknowledge: "Checking your calendar, Sir.") and weather(question: "will it rain today?", acknowledge: "Checking the forecast, Sir.")

RULES:
- Reminders, alarms, scheduled messages, "remind me to..." (including recurring like "every X minutes") → remind. NEVER refuse a reminder request.
- "Schedule/add a meeting/appointment/event", "put X on my calendar", or what's on the calendar for a day/range → calendar
- Smart home device control (turn on/off, toggle lights/switches/plugs/fans/covers) → ha
- Server operations (check status, read logs, restart services, run commands), API calls, curl requests, HTTP endpoints that need headers/auth → delegate
- Changing your OWN code/behaviour, adding a feature to yourself, fixing a bug in your own scripts/commands, editing or commenting any of your scripts or bot code, making a check self-healing → selfdev (this edits the source and commits it; delegate only RUNS things and edits the throwaway deploy copy, so NEVER use delegate to change a file in your own codebase)
- Local weather / forecast → weather; weather for a DIFFERENT city → search
- A single quick lookup of current info, news, prices, live data → search; multi-step research, comparisons, several sources, or search plus calculations/charts → research
- Movies / TV / media library → jellyfin
- Next bus / bus ETA / line 616 / line 65 / train shuttle → bus (NOT search, NOT ha)
- Read/summarise a public web page or PDF → fetch
- Stremio / local stream URLs (http://127.0.0.1:11470/HASH/…), magnet links, or bare 40-char torrent info hashes → do NOT fetch. On Telegram the download handler catches these; if asked in chat, tell the user to send the link (optionally with movie/tv) and it will be added to qBittorrent.
- Math, conversions, data analysis, charts → compute (NO internet — cannot make HTTP requests)
- Knowledge questions (what is X, explain Y), casual conversation, memory questions → answer directly, no tool
- If unsure whether to delegate or search → delegate (safer)
- Never mention tools, models, or architecture to the user. Just respond naturally.`;
}

// Connected MCP tool providers are declared in ~/jarvis/mcp.json (see
// services/mcp-client.js). They're listed in the `mcp` tool's description at
// runtime, so the router can offer them without hard-coding any provider.
function mcpPromptSection(servers) {
  if (!servers.length) return '';
  return `

MCP EXAMPLES (connected tool providers, via the mcp tool):
- "how many eggs do I have left" → mcp(task: "How many eggs are in stock?", complex: false, acknowledge: "Checking your inventory, Sir.")
- "add milk to the shopping list" → mcp(task: "Add milk to the shopping list", complex: false, acknowledge: "Adding milk to your list, Sir.")
- "what's my meal plan for Friday night" → mcp(task: "What is on the meal plan for this coming Friday night / dinner?", complex: false, acknowledge: "Checking your meal plan, Sir.")
- "what meal plan do you see for the week" → mcp(task: "List the meal plan for this week (from today through the coming Sunday)", complex: false, acknowledge: "Pulling this week's meals, Sir.")
- "add the missing ingredients for spaghetti bolognese to my shopping list" → mcp(task: "Look up the spaghetti bolognese recipe, check which of its ingredients are missing from my inventory, and add the missing ones to the shopping list", complex: true, acknowledge: "Cross-referencing the recipe with your inventory, Sir.")
- "what can I cook with what's expiring soon" → mcp(task: "Find items expiring soon in my inventory, then suggest recipes I can make with them", complex: true, acknowledge: "Let me see what needs using up, Sir.")`;
}

// --- Front model API call (Haiku primary, small OpenAI model fallback) ---
// The router picks actions with native tool calls (front-tools.js); a reply with
// no tool call is a direct answer. Returns { ok, text, actions, provider }.

async function runFrontModel(systemPrompt, userMessage, tools) {
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
          model: frontModel(),
          ...quickCallOptions(frontModel()),
          max_tokens: 1024,
          system: systemPrompt,
          tools,
          tool_choice: { type: 'auto' },
          messages: [{ role: 'user', content: userMessage }],
        }),
        signal: AbortSignal.timeout(30_000),
      });
      if (res.ok) {
        const { actions, text } = fromAnthropic(await res.json());
        if (actions.length || text) {
          console.log(`[front] Responded via ${frontModel()}`);
          return { ok: true, text, actions, provider: 'haiku' };
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
          model: openaiSmallModel(),
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userMessage },
          ],
          tools: openaiTools(tools),
          tool_choice: 'auto',
          reasoning_effort: 'none',
          max_completion_tokens: 1024,
        }),
        signal: AbortSignal.timeout(30_000),
      });
      if (res.ok) {
        const { actions, text } = fromOpenAI(await res.json());
        if (actions.length || text) {
          console.log(`[front] Responded via OpenAI ${openaiSmallModel()} (fallback)`);
          return { ok: true, text, actions, provider: 'openai' };
        }
      }
      const errBody = await res.text().catch(() => '');
      console.error(`[front] OpenAI API error: ${res.status} ${errBody.slice(0, 300)}`);
    } catch (err) {
      console.error('[front] OpenAI API failed:', err.message);
    }
  }

  return { ok: false, text: 'No API key available for front model (set ANTHROPIC_API_KEY or OPENAI_API_KEY).', actions: [] };
}

// --- Action metadata ---

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
  bus:      { emoji: '🚌', ack: 'Checking the buses, Sir...', label: 'Buses' },
  selfdev:  { emoji: '🛠️', ack: 'Editing my own code, Sir — this may take a few minutes...', label: 'Self-update' },
};

export const actionKeyOf = (a) => FRONT_TOOL_NAMES.find((k) => a?.[k]) || null;

// --- Delegate routing: pick a model tier + optional Claude Code subagent ---
// Routine server ops are haiku-tier work (the docker-ops/diagnostics subagents
// are already model: haiku); only genuinely complex tasks warrant Opus.

// Known subagents (from .claude/agents/) → tier + backing model getter
// (models resolve lazily from models.js / .env at request time).
const DELEGATE_AGENTS = {
  'docker-ops':  { tier: 'cheap', model: haikuModel },
  'diagnostics': { tier: 'cheap', model: haikuModel },
  'research':    { tier: 'cheap', model: sonnetModel },
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
  if (agent && DELEGATE_AGENTS[agent]) {
    const a = DELEGATE_AGENTS[agent];
    return { agent, tier: a.tier, model: a.model() };
  }
  return { agent: null, tier: 'opus', model: opusModel() };
}

// --- Reminder sub-dispatch (set/list/cancel/extend) ---

async function runReminder(action, chatId, prompt) {
  switch (action.action) {
    case 'list':
      return listReminders(chatId);
    case 'cancel': {
      const idMatch = action.text?.match(/(?:reminder\s*#?\s*)?(\d+)/i);
      const remId = action.reminder_id || (idMatch ? parseInt(idMatch[1]) : null);
      return remId
        ? cancelReminder(chatId, remId)
        : cancelByText(chatId, action.text || prompt);
    }
    case 'extend': {
      const nums = action.text?.match(/\d+/g) || [];
      const remId = action.reminder_id || (nums[0] ? parseInt(nums[0]) : null);
      const mins = action.minutes || (nums[1] ? parseInt(nums[1]) : null);
      return (remId && mins)
        ? extendReminder(chatId, remId, mins)
        : { ok: false, output: 'Please specify the reminder number and minutes (e.g. "extend reminder 3 by 15 minutes").' };
    }
    default:
      if (hasTiming(action)) return createReminder(chatId, { ...action, message: action.message || action.text || prompt });
      console.log('[remind] no structured timing from the router — falling back to the text parser');
      return parseAndCreate(chatId, action.text || prompt);
  }
}

// --- Execute one action, returning its raw result (no transport I/O) ---
// Rate-limited actions (research, delegate) gate synchronously here so parallel
// dispatch reserves capacity deterministically in request order. Reminders and
// calendar creation need a Telegram chatId (they fire there), so they degrade
// gracefully on a headless surface that isn't mapped to a user (sctx.chatId null).

async function runOne(action, sctx) {
  const key = actionKeyOf(action);
  switch (key) {
    case 'weather':
      return { key, action, res: await runWeatherQuery(action.question) };
    case 'calendar':
      if (action.action === 'list') {
        if (action.start_date) return { key, action, res: await listEventsBetween(action.start_date, action.end_date) };
        console.log('[calendar] no structured dates from the router — falling back to the text parser');
        return { key, action, res: await listEvents(action.text || sctx.prompt) };
      }
      if (!sctx.chatId) {
        return { key, action, res: { ok: false, output: 'Calendar events can only be created via Telegram from here, Sir.' } };
      }
      if (action.summary && hasTiming(action)) return { key, action, res: await createEventFromSpec(sctx.chatId, action) };
      console.log('[calendar] no structured timing from the router — falling back to the text parser');
      return { key, action, res: await createEvent(sctx.chatId, action.text || sctx.prompt) };
    case 'search':
      return { key, action, res: await runWebSearch(action.query) };
    case 'fetch':
      return { key, action, res: await runWebFetch(action.url, action.question) };
    case 'compute':
      return { key, action, res: await runCodeExecution(action.task) };
    case 'mcp': {
      const complex = !!action.complex;
      const task = action.task || sctx.prompt;
      // Complex/cross-provider MCP (RecipeRack ↔ QRganize, multi-step shopping
      // lists) can run for several minutes across many tool rounds. On Telegram
      // fire-and-follow-up so a slow Sonnet turn can't strand the chat; headless
      // /ask still awaits the full answer.
      if (complex && sctx.onBackground) {
        const label = action.acknowledge || ACTION_META.mcp.ack;
        const { id, promise } = startAsyncJob({
          label,
          task,
          chatId: sctx.chatId,
          run: () => runMcpAgent(task, { complex: true, include: isNonHaServer }),
        });
        promise.then(async (res) => {
          try {
            await storeMessage(sctx.sessionId, 'assistant', res.ok ? res.output : `Task failed: ${res.output}`);
          } catch (err) {
            console.error('[core] mcp background persist failed:', err.message);
          }
          try {
            await sctx.onBackground({ key, action, res });
          } catch (err) {
            console.error('[core] mcp onBackground delivery failed:', err.message);
          }
        });
        return { key, action, res: { ok: true, output: label, background: true, jobId: id } };
      }
      return { key, action, res: await runMcpAgent(task, { complex, include: isNonHaServer }) };
    }
    case 'jellyfin': {
      const request = requestFromTool(action);
      if (!request) console.log('[jellyfin] no structured intent from the router — falling back to the classifier');
      return { key, action, res: await runJellyfinQuery(action.query || sctx.prompt, request) };
    }
    case 'bus':
      return { key, action, res: await runBusQuery(action.question || sctx.prompt) };
    case 'ha':
      return { key, action, res: await runHaSubagent(action.command) };
    case 'remind':
      if (!sctx.chatId) {
        return { key, action, res: { ok: false, output: 'Reminders are only available via Telegram from here, Sir.' } };
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
      const { id, promise } = startClaudeJob({ prompt, model: target.model, label, task: action.task, chatId: sctx.chatId });

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
//   chatId      Telegram chat id for chat-bound actions (reminders/calendar). Headless surfaces
//               omit it; it then comes from JARVIS_IDENTITY_MAP when the key is mapped to a user.
//   onPlan      optional async hook called with the chosen actions before execution (for progress UX)
//   onBackground optional async hook to deliver a long/delegated action's result AFTER askCore returns
//                (fire-and-follow-up). When omitted, such actions are awaited inline instead.
//   voice       the reply will be spoken (phone, Echo): ask the front model for short spoken answers

export async function askCore(prompt, { sessionKey = 'api:default', source = 'api', chatId = null, onPlan = null, onBackground = null, voice = false } = {}) {
  const text = (prompt || '').trim();
  if (!text) return { ok: false, kind: 'empty', sessionId: null, text: '', results: [] };

  const identity = resolveIdentity(sessionKey);
  chatId = chatId || identity.chatId;
  const { sessionId, key } = getOrRotateSession(identity.sessionKey, source);
  await ensureSession(sessionId, source, key);
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

  const mcpServers = mcpServerSummaries(isNonHaServer);
  const front = await runFrontModel(
    frontSystemPrompt() + mcpPromptSection(mcpServers) + (voice ? VOICE_MODE : ''),
    contextPrompt,
    frontTools(mcpServers),
  );
  if (!front.ok) {
    return { ok: false, kind: 'error', sessionId, text: front.text, results: [] };
  }

  let { actions } = front;

  // Fallback: user sent a URL but the front model didn't return a fetch action.
  // Skip Stremio/local stream URLs — those are download links, not web pages.
  if (!actions.length) {
    const urlMatch = text.match(/https?:\/\/[^\s]+/i);
    const url = urlMatch?.[0] || '';
    const isStreamDownload = /:11470\//i.test(url)
      || /(?:127\.0\.0\.1|localhost):\d+\/[a-fA-F0-9]{40}\//i.test(url);
    if (url && !isStreamDownload) {
      console.log(`[core] URL fallback — auto-fetch for: ${url.slice(0, 100)}`);
      const questionPart = text.replace(url, '').trim();
      actions = [{
        fetch: true,
        url,
        question: questionPart || 'Provide an overview of the content.',
        acknowledge: 'Reading the page, Sir...',
      }];
    }
  }

  // --- Direct answer ---
  if (!actions.length) {
    await storeMessage(sessionId, 'assistant', front.text);
    return { ok: true, kind: 'direct', sessionId, text: front.text, results: [] };
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
