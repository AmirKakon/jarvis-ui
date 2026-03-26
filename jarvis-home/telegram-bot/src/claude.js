import { exec } from 'node:child_process';
import crypto from 'node:crypto';
import { Markup } from 'telegraf';
import { truncate, escapeHtml, mdToHtml } from './utils.js';
import {
  ensureSession, storeMessage, summarizeSession,
  buildMemoryContext, closePool,
  extractFactsFromExchange, storePendingBatch,
} from './memory.js';

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

export { closePool };

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

DELEGATION:
For tasks that require EXECUTING commands on the server — Docker, systemctl, SSH, reading logs, restarting services, deploying, disk/network diagnostics, file operations, n8n workflows, Home Assistant device actions, qBittorrent management, system health checks, or ANYTHING requiring shell access — you MUST delegate.

When delegating, respond with ONLY this JSON (no other text):
{"delegate": true, "task": "full description of what to do, with context", "acknowledge": "brief message to user about what you're doing"}

IMPORTANT:
- If the user asks you to CHECK something on the server (status, logs, disk space), that requires delegation.
- If the user asks a KNOWLEDGE question (what is Docker, explain Linux), answer directly.
- If unsure whether delegation is needed, delegate — it's safer.
- Never mention delegation, models, or architecture to the user. Just respond naturally or delegate silently.`;

// --- Front model API call (Haiku 3.5 primary, GPT-4o-mini fallback) ---

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
          model: 'claude-haiku-4-5-20241022',
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

// --- Claude Code CLI (Opus — for delegated server tasks) ---

const OPUS_TIMEOUT = 360_000; // 6 minutes

function runOpus(prompt) {
  return new Promise((resolve) => {
    const escaped = prompt.replace(/'/g, "'\\''");
    const cmd = `cd ${JARVIS_DIR} && claude --dangerously-skip-permissions --model claude-opus-4-20250514 -p '${escaped}' 2>/dev/null`;

    exec(cmd, { timeout: OPUS_TIMEOUT, shell: '/bin/bash', maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        if (err.killed) {
          resolve({ ok: false, output: 'Claude timed out after 6 minutes. Try a simpler question or use a slash command.' });
        } else {
          resolve({ ok: false, output: stderr?.trim() || err.message });
        }
      } else {
        resolve({ ok: true, output: stdout?.trim() || '(no response)' });
      }
    });
  });
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

// --- Parse delegation JSON from front model response ---

function parseDelegation(text) {
  try {
    const trimmed = text.trim();
    if (!trimmed.startsWith('{')) return null;
    const parsed = JSON.parse(trimmed);
    if (parsed.delegate === true && parsed.task) return parsed;
  } catch { /* not JSON */ }
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

  // Check if front model wants to delegate to Opus
  const delegation = parseDelegation(output);

  if (delegation) {
    console.log(`[front] Delegating to Opus: ${delegation.task.slice(0, 100)}`);
    const ack = delegation.acknowledge || 'Working on it, Sir...';
    await ctx.telegram.editMessageText(
      thinking.chat.id, thinking.message_id, undefined,
      `⚙️ <i>${escapeHtml(ack)}</i>`, { parse_mode: 'HTML' }
    ).catch(() => {});

    if (isLimited(opusCallLog, OPUS_RATE_MAX)) {
      await ctx.replyWithHTML(`⚠️ Opus rate limit reached (${OPUS_RATE_MAX}/hour). Try again later or use slash commands.`);
      return;
    }

    recordTo(opusCallLog);
    const opusPrompt = `${contextPrompt}\n\nTask to execute: ${delegation.task}`;
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

    if (opusOk && prompt.length > 10) {
      offerFactExtraction(ctx, prompt, opusOutput).catch((err) =>
        console.error('Fact extraction failed:', err.message)
      );
    }
  } else {
    // Direct response from front model
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

async function offerFactExtraction(ctx, userMessage, assistantResponse) {
  const facts = await extractFactsFromExchange(userMessage, assistantResponse);
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
