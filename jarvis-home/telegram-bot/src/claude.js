import { exec } from 'node:child_process';
import crypto from 'node:crypto';
import { Markup } from 'telegraf';
import { truncate, escapeHtml, mdToHtml, sendLong } from './utils.js';
import {
  ensureSession, storeMessage, summarizeSession,
  buildMemoryContext, closePool,
  extractFactsFromExchange, deduplicateFacts, storePendingBatch,
} from './memory.js';
import { extractResponseContent } from './agents/shared.js';
import { runWebSearch } from './agents/search.js';
import { runWebFetch } from './agents/fetch.js';
import { runCodeExecution } from './agents/compute.js';
import { runResearch } from './agents/research.js';
import { runMcpAgent } from './agents/mcp.js';
import { mcpServerSummaries } from './services/mcp-client.js';
import { runWeatherQuery } from './agents/weather.js';
import { runJellyfinQuery } from './agents/jellyfin.js';
import { runOpus } from './agents/opus.js';
import { generateSpeech, isValidVoice, VALID_VOICES } from './agents/tts.js';
import { resolveAndExecute } from './agents/ha.js';
import { parseAndCreate, listReminders, cancelReminder, cancelByText, extendReminder } from './agents/remind.js';
import { createEvent, listEvents } from './agents/calendar.js';

const JARVIS_DIR = process.env.HOME + '/jarvis';
const SESSION_GAP_MS = 30 * 60 * 1000; // 30 minutes

// --- Rate limits (separate for front model vs Opus) ---

const RATE_LIMIT_WINDOW = 60 * 60 * 1000;
const FRONT_RATE_MAX = Number(process.env.FRONT_RATE_LIMIT) || 60;
const OPUS_RATE_MAX = Number(process.env.CLAUDE_RATE_LIMIT) || 20;

const frontCallLog = [];
const opusCallLog = [];

function isLimited(log, max) {
  const cutoff = Date.now() - RATE_LIMIT_WINDOW;
  while (log.length && log[0] < cutoff) log.shift();
  return log.length >= max;
}
function recordTo(log) { log.push(Date.now()); }
function remainingIn(log, max) {
  const cutoff = Date.now() - RATE_LIMIT_WINDOW;
  while (log.length && log[0] < cutoff) log.shift();
  return max - log.length;
}

// --- Session boundary tracking ---

const activeSessions = new Map();

function getOrRotateSession(chatId) {
  const entry = activeSessions.get(chatId);
  const now = Date.now();

  if (!entry || (now - entry.lastMessageTime) > SESSION_GAP_MS) {
    if (entry) {
      summarizeSession(entry.sessionId, 'telegram').catch((err) =>
        console.error('Session summarization failed:', err.message)
      );
    }
    const sessionId = crypto.randomUUID();
    activeSessions.set(chatId, { sessionId, lastMessageTime: now });
    return { sessionId, isNew: true };
  }

  entry.lastMessageTime = now;
  return { sessionId: entry.sessionId, isNew: false };
}

export async function forceNewSession(chatId) {
  const entry = activeSessions.get(chatId);
  let result = null;
  if (entry) {
    result = await summarizeSession(entry.sessionId, 'telegram');
    activeSessions.delete(chatId);
  }
  return result;
}

export { closePool, extractResponseContent };

// --- Voice TTS toggle (per-chat) ---

const DEFAULT_VOICE = 'fable';
const voiceSettings = new Map();

export function toggleVoice(chatId) {
  const current = voiceSettings.get(chatId);
  if (current?.enabled) {
    current.enabled = false;
    return { enabled: false, voice: current.voice };
  }
  const voice = current?.voice || DEFAULT_VOICE;
  voiceSettings.set(chatId, { enabled: true, voice });
  return { enabled: true, voice };
}

export function setVoice(chatId, voiceName) {
  const name = voiceName.toLowerCase();
  if (!isValidVoice(name)) return null;
  const current = voiceSettings.get(chatId) || { enabled: false, voice: DEFAULT_VOICE };
  current.voice = name;
  current.enabled = true;
  voiceSettings.set(chatId, current);
  return current;
}

export function getVoiceStatus(chatId) {
  const s = voiceSettings.get(chatId);
  return { enabled: !!s?.enabled, voice: s?.voice || DEFAULT_VOICE };
}

export { VALID_VOICES };

function stripHtml(html) {
  return html.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
}

async function maybeSendVoice(ctx, text) {
  const chatId = String(ctx.chat?.id || 'default');
  const settings = voiceSettings.get(chatId);
  if (!settings?.enabled) return;

  const plain = stripHtml(text).slice(0, 4096);
  if (!plain) return;

  try {
    const buf = await generateSpeech(plain, settings.voice);
    if (buf) {
      await ctx.replyWithVoice({ source: buf, filename: 'jarvis.ogg' });
    }
  } catch (err) {
    console.error('[tts] Failed to send voice:', err.message);
  }
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
- User: "turn on the office light and tell me the news about the port strike" → [{"ha": true, "command": "turn on the office light", "acknowledge": "Lighting up the office, Sir."}, {"search": true, "query": "port strike news today", "acknowledge": "Fetching the latest, Sir."}]
- User: "what's on my calendar today and will it rain" → [{"calendar": true, "action": "list", "text": "what's on my calendar today", "acknowledge": "Checking your calendar, Sir."}, {"weather": true, "question": "will it rain today?", "acknowledge": "Checking the forecast, Sir."}]

RULES:
- Set/list/cancel/extend reminders, alarms, scheduled messages (including recurring like "every X minutes") → remind
- "Remind me to..." (a nudge/notification) → remind
- "Schedule/add a meeting/appointment/event", "put X on my calendar", or asking what's on the calendar for a day/range → calendar
- NEVER refuse a reminder request — always route to remind and let the reminder system handle it
- Smart home device control (turn on/off, toggle lights/switches/plugs/fans/covers) → ha
- Server operations (check status, read logs, restart services) → delegate
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

11. Connected external tool providers (MCP). Route requests matching one of these here:
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

// --- Legacy: sendToClaude for slash commands that use specific models ---

export async function sendToClaude(ctx, prompt, thinkingMsg = '🧠 <i>Thinking...</i>', model = 'sonnet') {
  const MODELS = {
    opus: 'claude-opus-4-8',
    sonnet: 'claude-sonnet-5',
    haiku: 'claude-haiku-4-5-20251001',
  };
  const TIMEOUTS = { opus: 360_000, sonnet: 120_000, haiku: 60_000 };

  if (isLimited(opusCallLog, OPUS_RATE_MAX)) {
    return ctx.replyWithHTML(`⚠️ Rate limit reached (${OPUS_RATE_MAX} Opus calls/hour). Use slash commands for free operations.`);
  }

  const thinking = await ctx.replyWithHTML(thinkingMsg);
  recordTo(opusCallLog);

  const timeout = TIMEOUTS[model] || TIMEOUTS.sonnet;
  const { ok, output } = await new Promise((resolve) => {
    const escaped = prompt.replace(/'/g, "'\\''");
    const modelFlag = MODELS[model] ? `--model ${MODELS[model]}` : '';
    const cmd = `cd ${JARVIS_DIR} && claude --dangerously-skip-permissions ${modelFlag} -p '${escaped}'`;
    exec(cmd, { timeout, shell: '/bin/bash', maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        if (err.killed) {
          resolve({ ok: false, output: `Claude timed out after ${Math.round(timeout / 60_000)} minutes.` });
        } else {
          resolve({ ok: false, output: stderr?.trim() || err.message });
        }
      } else {
        resolve({ ok: true, output: stdout?.trim() || '(no response)' });
      }
    });
  });

  const left = remainingIn(opusCallLog, OPUS_RATE_MAX);
  let response;
  if (ok) {
    response = truncate(mdToHtml(output), 3900) + `\n\n<i>(${left} Opus calls remaining this hour)</i>`;
  } else {
    response = `🔴 Claude error:\n<pre>${truncate(escapeHtml(output), 3800)}</pre>`;
  }

  try {
    await ctx.telegram.editMessageText(thinking.chat.id, thinking.message_id, undefined, response, { parse_mode: 'HTML' });
  } catch {
    await ctx.replyWithHTML(response);
  }
}

// --- Parse action JSON from front model response (delegate, search, or future actions) ---

const ACTION_KEYS = ['delegate', 'search', 'fetch', 'compute', 'ha', 'remind', 'weather', 'calendar', 'research', 'mcp', 'jellyfin'];

// Per-action presentation metadata (status emoji, default ack, error label)
const ACTION_META = {
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
};

const actionKeyOf = (a) => ACTION_KEYS.find((k) => a?.[k]) || null;

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

  let trimmed = text.trim();
  if (trimmed.startsWith('```')) {
    trimmed = trimmed.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '').trim();
  }
  trimmed = normalize(trimmed);

  // Array of actions
  if (trimmed.startsWith('[')) {
    const parsed = tryParse(trimmed);
    if (Array.isArray(parsed)) {
      const actions = parsed.filter(isAction);
      if (actions.length) return actions;
    }
  }

  // Single object
  if (trimmed.startsWith('{')) {
    const parsed = tryParse(trimmed);
    if (isAction(parsed)) return [parsed];
  }

  // Fallback: extract a single JSON object embedded in prose
  for (const key of ACTION_KEYS) {
    const marker = `{"${key}"`;
    const jsonStart = trimmed.indexOf(marker);
    if (jsonStart >= 0) {
      const jsonEnd = trimmed.lastIndexOf('}');
      if (jsonEnd > jsonStart) {
        const parsed = tryParse(trimmed.slice(jsonStart, jsonEnd + 1));
        if (isAction(parsed)) return [parsed];
      }
    }
  }

  return [];
}

// --- Send a citation list as its own bounded message ---

async function sendSources(ctx, sources) {
  if (!sources?.length) return;
  const links = sources
    .map((s) => `<a href="${escapeHtml(s.url)}">${escapeHtml(s.title)}</a>`)
    .join(' · ');
  await ctx.replyWithHTML(truncate(`📎 ${links}`), { disable_web_page_preview: true })
    .catch((err) => console.error('Failed to send sources:', err.message));
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

// --- Phase 1: execute one action, returning its raw result (no Telegram I/O) ---
// Rate-limited actions (research, delegate) gate synchronously here so parallel
// dispatch reserves capacity deterministically in request order.

async function runOne(action, sctx) {
  const key = actionKeyOf(action);
  switch (key) {
    case 'weather':
      return { key, action, res: await runWeatherQuery(action.question) };
    case 'calendar':
      return {
        key, action,
        res: action.action === 'list'
          ? await listEvents(action.text || sctx.prompt)
          : await createEvent(sctx.chatId, action.text || sctx.prompt),
      };
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
      const res = await runOpus(`${sctx.contextPrompt}\n\nTask to execute: ${action.task}${hint}`, target.model);

      const footer = target.tier === 'opus'
        ? `(${remainingIn(opusCallLog, OPUS_RATE_MAX)} Opus calls remaining this hour)`
        : undefined;
      return { key, action, res: { ...res, footer } };
    }
    default:
      return { key: null, action, res: { ok: false, output: 'Unknown action.' } };
  }
}

// --- Phase 2: render one action's result to Telegram (sequential, in order) ---
// Returns { ok, text } so the caller can aggregate voice + fact extraction.

async function renderOne(ctx, { key, action, res }, sctx) {
  const meta = ACTION_META[key] || { label: 'Action' };
  await storeMessage(sctx.sessionId, 'assistant', res.ok ? res.output : `${meta.label} failed: ${res.output}`);

  if (!res.ok) {
    await ctx.replyWithHTML(`🔴 ${escapeHtml(meta.label)} failed: ${escapeHtml(res.output)}`)
      .catch((err) => console.error('Failed to send error:', err.message));
    return { ok: false, text: '' };
  }

  if (key === 'ha') {
    await ctx.replyWithHTML(`✅ ${escapeHtml(res.output)}`);
  } else if (key === 'remind') {
    await ctx.replyWithHTML(`⏰ ${escapeHtml(res.output)}`);
  } else {
    let html = mdToHtml(res.output);
    if (res.footer) html += `\n\n<i>${escapeHtml(res.footer)}</i>`;
    await sendLong(ctx, html, { disable_web_page_preview: true });
    await sendSources(ctx, res.sources);
    if (res.images?.length) {
      for (const img of res.images) {
        try {
          const buf = Buffer.from(img.base64, 'base64');
          await ctx.replyWithPhoto({ source: buf, filename: 'chart.png' });
        } catch (err) {
          console.error('Failed to send generated image:', err.message);
        }
      }
    }
  }

  return { ok: true, text: res.output };
}

// --- Main chat handler: front model + optional Opus delegation ---

export async function askClaude(ctx, textOverride = null) {
  const prompt = (typeof textOverride === 'string' ? textOverride : ctx.message.text || '').trim();
  if (!prompt) return;

  const chatId = String(ctx.chat?.id || 'default');
  const { sessionId } = getOrRotateSession(chatId);
  await ensureSession(sessionId, 'telegram');
  await storeMessage(sessionId, 'user', prompt);

  const contextPrompt = await buildMemoryContext(prompt, sessionId);

  if (isLimited(frontCallLog, FRONT_RATE_MAX)) {
    return ctx.replyWithHTML(`⚠️ Rate limit reached (${FRONT_RATE_MAX} calls/hour). Wait a bit or use slash commands.`);
  }

  const thinking = await ctx.replyWithHTML('🧠 <i>Thinking...</i>');
  recordTo(frontCallLog);

  const { ok, output } = await runFrontModel(FRONT_SYSTEM_PROMPT + mcpPromptSection(), contextPrompt);

  if (!ok) {
    await ctx.telegram.editMessageText(
      thinking.chat.id, thinking.message_id, undefined,
      `🔴 ${escapeHtml(output)}`, { parse_mode: 'HTML' }
    ).catch(() => ctx.replyWithHTML(`🔴 ${escapeHtml(output)}`));
    return;
  }

  let actions = parseActions(output);

  // Fallback: if user sent a URL but the front model didn't return a fetch action, auto-trigger fetch
  if (!actions.length) {
    const urlMatch = prompt.match(/https?:\/\/[^\s]+/i);
    if (urlMatch) {
      console.log(`[front] URL fallback — front model missed fetch action, auto-triggering for: ${urlMatch[0].slice(0, 100)}`);
      const questionPart = prompt.replace(urlMatch[0], '').trim();
      actions = [{
        fetch: true,
        url: urlMatch[0],
        question: questionPart || 'Provide an overview of the content.',
        acknowledge: 'Reading the page, Sir...',
      }];
    }
  }

  // --- Action dispatch: run independent actions in parallel, render in order ---
  if (actions.length) {
    const sctx = { sessionId, prompt, contextPrompt, chatId };

    // Header: acknowledge each action (preserves per-action feedback + ordering)
    const ackLines = actions.map((a) => {
      const meta = ACTION_META[actionKeyOf(a)] || { emoji: '⚙️', ack: 'Working on it, Sir...' };
      return `${meta.emoji} <i>${escapeHtml(a.acknowledge || meta.ack)}</i>`;
    });
    await ctx.telegram.editMessageText(
      thinking.chat.id, thinking.message_id, undefined,
      ackLines.join('\n'), { parse_mode: 'HTML' }
    ).catch(() => {});

    console.log(`[front] Dispatching ${actions.length} action(s): ${actions.map(actionKeyOf).join(', ')}`);

    // Phase 1 — run all actions concurrently (network/LLM-bound, independent)
    const runs = await Promise.all(
      actions.map((a) => runOne(a, sctx).catch((err) => ({
        key: actionKeyOf(a), action: a, res: { ok: false, output: err.message },
      })))
    );

    // Phase 2 — render sequentially, preserving request order
    const texts = [];
    for (const run of runs) {
      const r = await renderOne(ctx, run, sctx);
      if (r.ok && r.text) texts.push(r.text);
    }

    // Aggregate voice + fact extraction once over the combined output
    const combined = texts.join('\n\n');
    if (combined) {
      await maybeSendVoice(ctx, combined);
      if (prompt.length > 10) {
        offerFactExtraction(ctx, prompt, combined).catch((err) =>
          console.error('Fact extraction failed:', err.message)
        );
      }
    }
    return;
  }

  // --- Direct response ---
  await storeMessage(sessionId, 'assistant', output);

  const response = truncate(mdToHtml(output), 3900);
  try {
    await ctx.telegram.editMessageText(
      thinking.chat.id, thinking.message_id, undefined,
      response, { parse_mode: 'HTML' }
    );
  } catch {
    await ctx.replyWithHTML(response);
  }

  await maybeSendVoice(ctx, output);

  if (prompt.length > 10) {
    offerFactExtraction(ctx, prompt, output).catch((err) =>
      console.error('Fact extraction failed:', err.message)
    );
  }
}

// --- Direct Opus handler (for /deep command) ---

export async function askOpusDirect(ctx, textOverride = null) {
  const prompt = (typeof textOverride === 'string' ? textOverride : ctx.message.text || '').replace(/^\/deep\s*/i, '').trim();
  if (!prompt) {
    return ctx.replyWithHTML('<b>Usage:</b> <code>/deep &lt;question&gt;</code>\n\nBypasses the front model and sends directly to Opus.');
  }

  const chatId = String(ctx.chat?.id || 'default');
  const { sessionId } = getOrRotateSession(chatId);
  await ensureSession(sessionId, 'telegram');
  await storeMessage(sessionId, 'user', prompt);

  const contextPrompt = await buildMemoryContext(prompt, sessionId);

  if (isLimited(opusCallLog, OPUS_RATE_MAX)) {
    return ctx.replyWithHTML(`⚠️ Opus rate limit reached (${OPUS_RATE_MAX}/hour).`);
  }

  const thinking = await ctx.replyWithHTML('🧠 <i>Opus thinking...</i>');
  recordTo(opusCallLog);

  const { ok, output } = await runOpus(contextPrompt);
  const left = remainingIn(opusCallLog, OPUS_RATE_MAX);

  if (ok) {
    await storeMessage(sessionId, 'assistant', output);
  }

  let response;
  if (ok) {
    response = truncate(mdToHtml(output), 3900) + `\n\n<i>(${left} Opus calls remaining this hour)</i>`;
  } else {
    response = `🔴 Opus error:\n<pre>${truncate(escapeHtml(output), 3800)}</pre>`;
  }

  try {
    await ctx.telegram.editMessageText(thinking.chat.id, thinking.message_id, undefined, response, { parse_mode: 'HTML' });
  } catch {
    await ctx.replyWithHTML(response);
  }

  if (ok) {
    await maybeSendVoice(ctx, output);
    if (prompt.length > 10) {
      offerFactExtraction(ctx, prompt, output).catch((err) =>
        console.error('Fact extraction failed:', err.message)
      );
    }
  }
}

// --- Background fact extraction ---

const MEMORY_RECALL_PATTERN = /\b(remember|memory|recall|forget|what\s+do\s+you\s+(know|remember))\b/i;

async function offerFactExtraction(ctx, userMessage, assistantResponse) {
  if (MEMORY_RECALL_PATTERN.test(userMessage)) return;

  const rawFacts = await extractFactsFromExchange(userMessage, assistantResponse);
  if (!rawFacts.length) return;

  const facts = await deduplicateFacts(rawFacts);
  if (!facts.length) return;

  const batchId = storePendingBatch(facts);
  const lines = ['💾 <b>Should I remember?</b>', ''];
  for (const f of facts) {
    const content = typeof f === 'string' ? f : f.content;
    const category = typeof f === 'string' ? null : f.category;
    const tag = category && category !== 'general' ? ` <code>[${escapeHtml(category)}]</code>` : '';
    lines.push(`•${tag} <i>${escapeHtml(content)}</i>`);
  }

  await ctx.replyWithHTML(lines.join('\n'), Markup.inlineKeyboard([
    [
      Markup.button.callback('✅ Save', `mem:y:${batchId}`),
      Markup.button.callback('❌ Skip', `mem:n:${batchId}`),
    ],
  ]));
}
