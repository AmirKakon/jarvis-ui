import { exec } from 'node:child_process';
import crypto from 'node:crypto';
import { Markup } from 'telegraf';
import { truncate, escapeHtml, mdToHtml } from './utils.js';
import {
  ensureSession, storeMessage, summarizeSession,
  buildMemoryContext, closePool,
  extractFactsFromExchange, deduplicateFacts, storePendingBatch,
} from './memory.js';
import { extractResponseContent } from './agents/shared.js';
import { runWebSearch } from './agents/search.js';
import { runWebFetch } from './agents/fetch.js';
import { runCodeExecution } from './agents/compute.js';
import { runOpus } from './agents/opus.js';

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

// --- Front-layer system prompt ---

const FRONT_SYSTEM_PROMPT = `You are JARVIS — a British AI assistant modelled after the AI from Iron Man, running on a home server (kamuri-mini-pc) in Jerusalem, Israel.

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
When you cannot answer directly, respond with ONLY a JSON object (no other text):

1. Server tasks (Docker, systemctl, SSH, logs, deploys, disk/network diagnostics, file ops, n8n, HA device actions, qBittorrent, system health):
{"delegate": true, "task": "full description of what to do, with context", "acknowledge": "brief message to user"}

2. Web search (current events, real-time info, news, prices, weather, anything needing up-to-date knowledge):
{"search": true, "query": "concise search query", "acknowledge": "brief message to user"}

3. Read a web page or PDF (user shares a URL and wants content read, summarised, or answered about):
{"fetch": true, "url": "the URL to read", "question": "what the user wants to know", "acknowledge": "brief message to user"}

4. Calculations, data analysis, or code tasks (math, conversions, charts, CSV analysis, programming puzzles):
{"compute": true, "task": "what to calculate or generate", "acknowledge": "brief message to user"}

RULES:
- Server operations (check status, read logs, restart services) → delegate
- Current info, news, prices, live data → search
- URL shared with a question about its content → fetch
- Math, conversions, data analysis, generate charts → compute
- Knowledge questions (what is X, explain Y) → answer directly
- If unsure whether to delegate or search → delegate (safer)
- Never mention actions, models, or architecture to the user. Just respond naturally.`;

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
    opus: 'claude-opus-4-20250514',
    sonnet: 'claude-sonnet-4-20250514',
    haiku: 'claude-haiku-4-20250514',
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
    const cmd = `cd ${JARVIS_DIR} && claude --dangerously-skip-permissions ${modelFlag} -p '${escaped}' 2>/dev/null`;
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

const ACTION_KEYS = ['delegate', 'search', 'fetch', 'compute'];

function parseAction(text) {
  const normalize = (s) => s
    .replace(/[\u201C\u201D\u201E\u201F\u2033\u2036]/g, '"')
    .replace(/[\u2018\u2019\u201A\u201B\u2032\u2035]/g, "'");

  const tryParse = (s) => {
    try {
      const parsed = JSON.parse(s);
      if (typeof parsed === 'object' && parsed !== null) {
        if (ACTION_KEYS.some((k) => parsed[k])) return parsed;
      }
    } catch { /* not valid JSON */ }
    return null;
  };

  let trimmed = text.trim();
  if (trimmed.startsWith('```')) {
    trimmed = trimmed.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '').trim();
  }
  trimmed = normalize(trimmed);

  if (trimmed.startsWith('{')) {
    const result = tryParse(trimmed);
    if (result) return result;
  }

  // Fallback: extract JSON object embedded in prose
  for (const key of ACTION_KEYS) {
    const marker = `{"${key}"`;
    const jsonStart = trimmed.indexOf(marker);
    if (jsonStart >= 0) {
      const jsonEnd = trimmed.lastIndexOf('}');
      if (jsonEnd > jsonStart) {
        const result = tryParse(trimmed.slice(jsonStart, jsonEnd + 1));
        if (result) return result;
      }
    }
  }

  return null;
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

  const { ok, output } = await runFrontModel(FRONT_SYSTEM_PROMPT, contextPrompt);

  if (!ok) {
    await ctx.telegram.editMessageText(
      thinking.chat.id, thinking.message_id, undefined,
      `🔴 ${escapeHtml(output)}`, { parse_mode: 'HTML' }
    ).catch(() => ctx.replyWithHTML(`🔴 ${escapeHtml(output)}`));
    return;
  }

  const action = parseAction(output);

  // --- Web search action ---
  if (action?.search) {
    const ack = action.acknowledge || 'Searching the web, Sir...';
    console.log(`[front] Web search: ${action.query?.slice(0, 100)}`);
    await ctx.telegram.editMessageText(
      thinking.chat.id, thinking.message_id, undefined,
      `🔍 <i>${escapeHtml(ack)}</i>`, { parse_mode: 'HTML' }
    ).catch(() => {});

    const { ok: searchOk, output: searchOutput, sources } = await runWebSearch(action.query);

    await storeMessage(sessionId, 'assistant', searchOk ? searchOutput : `Search failed: ${searchOutput}`);

    let response;
    if (searchOk) {
      response = truncate(mdToHtml(searchOutput), 3700);
      if (sources?.length) {
        const links = sources.map((s) =>
          `<a href="${escapeHtml(s.url)}">${escapeHtml(s.title)}</a>`
        ).join(' · ');
        response += `\n\n📎 ${links}`;
      }
    } else {
      response = `🔴 Search failed: ${escapeHtml(searchOutput)}`;
    }

    try {
      await ctx.telegram.editMessageText(
        thinking.chat.id, thinking.message_id, undefined,
        response, { parse_mode: 'HTML', disable_web_page_preview: true }
      );
    } catch {
      await ctx.replyWithHTML(response, { disable_web_page_preview: true });
    }

    if (searchOk && prompt.length > 10) {
      offerFactExtraction(ctx, prompt, searchOutput).catch((err) =>
        console.error('Fact extraction failed:', err.message)
      );
    }
    return;
  }

  // --- Web fetch action ---
  if (action?.fetch) {
    const ack = action.acknowledge || 'Reading the page, Sir...';
    console.log(`[front] Web fetch: ${action.url?.slice(0, 100)}`);
    await ctx.telegram.editMessageText(
      thinking.chat.id, thinking.message_id, undefined,
      `📄 <i>${escapeHtml(ack)}</i>`, { parse_mode: 'HTML' }
    ).catch(() => {});

    const { ok: fetchOk, output: fetchOutput, sources } = await runWebFetch(action.url, action.question);

    await storeMessage(sessionId, 'assistant', fetchOk ? fetchOutput : `Fetch failed: ${fetchOutput}`);

    let response;
    if (fetchOk) {
      response = truncate(mdToHtml(fetchOutput), 3700);
      if (sources?.length) {
        const links = sources.map((s) =>
          `<a href="${escapeHtml(s.url)}">${escapeHtml(s.title)}</a>`
        ).join(' · ');
        response += `\n\n📎 ${links}`;
      }
    } else {
      response = `🔴 Failed to read page: ${escapeHtml(fetchOutput)}`;
    }

    try {
      await ctx.telegram.editMessageText(
        thinking.chat.id, thinking.message_id, undefined,
        response, { parse_mode: 'HTML', disable_web_page_preview: true }
      );
    } catch {
      await ctx.replyWithHTML(response, { disable_web_page_preview: true });
    }

    if (fetchOk && prompt.length > 10) {
      offerFactExtraction(ctx, prompt, fetchOutput).catch((err) =>
        console.error('Fact extraction failed:', err.message)
      );
    }
    return;
  }

  // --- Code execution action ---
  if (action?.compute) {
    const ack = action.acknowledge || 'Running calculations, Sir...';
    console.log(`[front] Code execution: ${action.task?.slice(0, 100)}`);
    await ctx.telegram.editMessageText(
      thinking.chat.id, thinking.message_id, undefined,
      `🧮 <i>${escapeHtml(ack)}</i>`, { parse_mode: 'HTML' }
    ).catch(() => {});

    const { ok: codeOk, output: codeOutput, sources, images } = await runCodeExecution(action.task);

    await storeMessage(sessionId, 'assistant', codeOk ? codeOutput : `Computation failed: ${codeOutput}`);

    let response;
    if (codeOk) {
      response = truncate(mdToHtml(codeOutput), 3700);
      if (sources?.length) {
        const links = sources.map((s) =>
          `<a href="${escapeHtml(s.url)}">${escapeHtml(s.title)}</a>`
        ).join(' · ');
        response += `\n\n📎 ${links}`;
      }
    } else {
      response = `🔴 Computation failed: ${escapeHtml(codeOutput)}`;
    }

    try {
      await ctx.telegram.editMessageText(
        thinking.chat.id, thinking.message_id, undefined,
        response, { parse_mode: 'HTML' }
      );
    } catch {
      await ctx.replyWithHTML(response);
    }

    // Send generated images (charts, plots) as photos
    if (codeOk && images?.length) {
      for (const img of images) {
        try {
          const buf = Buffer.from(img.base64, 'base64');
          await ctx.replyWithPhoto({ source: buf, filename: 'chart.png' });
        } catch (err) {
          console.error('Failed to send generated image:', err.message);
        }
      }
    }

    if (codeOk && prompt.length > 10) {
      offerFactExtraction(ctx, prompt, codeOutput).catch((err) =>
        console.error('Fact extraction failed:', err.message)
      );
    }
    return;
  }

  // --- Server delegation action ---
  if (action?.delegate) {
    console.log(`[front] Delegating to Opus: ${action.task.slice(0, 100)}`);
    const ack = action.acknowledge || 'Working on it, Sir...';
    await ctx.telegram.editMessageText(
      thinking.chat.id, thinking.message_id, undefined,
      `⚙️ <i>${escapeHtml(ack)}</i>`, { parse_mode: 'HTML' }
    ).catch(() => {});

    if (isLimited(opusCallLog, OPUS_RATE_MAX)) {
      await ctx.replyWithHTML(`⚠️ Opus rate limit reached (${OPUS_RATE_MAX}/hour). Try again later or use slash commands.`);
      return;
    }

    recordTo(opusCallLog);
    const opusPrompt = `${contextPrompt}\n\nTask to execute: ${action.task}`;
    const { ok: opusOk, output: opusOutput } = await runOpus(opusPrompt);
    const left = remainingIn(opusCallLog, OPUS_RATE_MAX);

    const assistantMsg = opusOk ? opusOutput : `Error: ${opusOutput}`;
    await storeMessage(sessionId, 'assistant', assistantMsg);

    let response;
    if (opusOk) {
      response = truncate(mdToHtml(opusOutput), 3900) + `\n\n<i>(${left} Opus calls remaining this hour)</i>`;
    } else {
      response = `🔴 Opus error:\n<pre>${truncate(escapeHtml(opusOutput), 3800)}</pre>`;
    }

    await ctx.replyWithHTML(response);
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

  if (ok && prompt.length > 10) {
    offerFactExtraction(ctx, prompt, output).catch((err) =>
      console.error('Fact extraction failed:', err.message)
    );
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
    lines.push(`• <i>${escapeHtml(f)}</i>`);
  }

  await ctx.replyWithHTML(lines.join('\n'), Markup.inlineKeyboard([
    [
      Markup.button.callback('✅ Save', `mem:y:${batchId}`),
      Markup.button.callback('❌ Skip', `mem:n:${batchId}`),
    ],
  ]));
}
