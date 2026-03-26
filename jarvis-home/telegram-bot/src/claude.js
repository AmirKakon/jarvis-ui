import { exec } from 'node:child_process';
import crypto from 'node:crypto';
import { truncate, escapeHtml, mdToHtml } from './utils.js';
import {
  ensureSession, storeMessage, summarizeSession,
  buildMemoryContext, closePool,
} from './memory.js';

const JARVIS_DIR = process.env.HOME + '/jarvis';
const RATE_LIMIT_WINDOW = 60 * 60 * 1000; // 1 hour
const RATE_LIMIT_MAX = Number(process.env.CLAUDE_RATE_LIMIT) || 20;
const SESSION_GAP_MS = 30 * 60 * 1000; // 30 minutes

const TIMEOUTS = {
  opus: 360_000,   // 6 minutes for interactive chat (complex diagnostics need time)
  sonnet: 120_000, // 2 minutes for structured tasks
  haiku: 60_000,   // 1 minute for simple extraction
};

const MODELS = {
  opus: 'claude-opus-4-20250514',
  sonnet: 'claude-sonnet-4-20250514',
  haiku: 'claude-haiku-4-20250514',
};

const callLog = [];

// --- Session boundary tracking ---
// chatId -> { sessionId, lastMessageTime }
const activeSessions = new Map();

function getOrRotateSession(chatId) {
  const entry = activeSessions.get(chatId);
  const now = Date.now();

  if (!entry || (now - entry.lastMessageTime) > SESSION_GAP_MS) {
    // Gap detected — close old session (summarization runs in background)
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

/**
 * Explicitly close the current session (for /new command).
 * Returns summary info or null.
 */
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

// --- Rate limiting ---

function isRateLimited() {
  const cutoff = Date.now() - RATE_LIMIT_WINDOW;
  while (callLog.length && callLog[0] < cutoff) callLog.shift();
  return callLog.length >= RATE_LIMIT_MAX;
}

function recordCall() {
  callLog.push(Date.now());
}

function remaining() {
  const cutoff = Date.now() - RATE_LIMIT_WINDOW;
  while (callLog.length && callLog[0] < cutoff) callLog.shift();
  return RATE_LIMIT_MAX - callLog.length;
}

// --- Claude CLI execution ---

function runClaude(prompt, model = 'sonnet') {
  const timeout = TIMEOUTS[model] || TIMEOUTS.sonnet;
  return new Promise((resolve) => {
    const escaped = prompt.replace(/'/g, "'\\''");
    const modelFlag = MODELS[model] ? `--model ${MODELS[model]}` : '';
    const cmd = `cd ${JARVIS_DIR} && claude --dangerously-skip-permissions ${modelFlag} -p '${escaped}' 2>/dev/null`;

    exec(cmd, { timeout, shell: '/bin/bash', maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        if (err.killed) {
          const mins = Math.round(timeout / 60_000);
          resolve({ ok: false, output: `Claude timed out after ${mins} minutes. Try a simpler question or use a slash command.` });
        } else {
          resolve({ ok: false, output: stderr?.trim() || err.message });
        }
      } else {
        resolve({ ok: true, output: stdout?.trim() || '(no response)' });
      }
    });
  });
}

/**
 * Send a custom prompt to Claude Code, with "thinking" placeholder and rate limiting.
 * Models: 'opus' (deep reasoning), 'sonnet' (balanced), 'haiku' (fast/cheap).
 */
export async function sendToClaude(ctx, prompt, thinkingMsg = '🧠 <i>Thinking...</i>', model = 'sonnet') {
  if (isRateLimited()) {
    return ctx.replyWithHTML(
      `⚠️ Rate limit reached (${RATE_LIMIT_MAX} Claude calls/hour). Use slash commands for free operations, or wait a bit.`
    );
  }

  const thinking = await ctx.replyWithHTML(thinkingMsg);

  recordCall();
  const { ok, output } = await runClaude(prompt, model);
  const left = remaining();

  let response;
  if (ok) {
    response = truncate(mdToHtml(output), 3900) + `\n\n<i>(${left} Claude calls remaining this hour)</i>`;
  } else {
    response = `🔴 Claude error:\n<pre>${truncate(escapeHtml(output), 3800)}</pre>`;
  }

  try {
    await ctx.telegram.editMessageText(
      thinking.chat.id,
      thinking.message_id,
      undefined,
      response,
      { parse_mode: 'HTML' }
    );
  } catch {
    await ctx.replyWithHTML(response);
  }
}

/**
 * Handle a free-text message by sending it to Claude Code.
 * Uses Opus with PostgreSQL-backed long-term memory and session management.
 * @param {object} ctx - Telegraf context
 * @param {string|null} textOverride - optional prompt (for media: transcriptions, file references, etc.)
 */
export async function askClaude(ctx, textOverride = null) {
  const prompt = (typeof textOverride === 'string' ? textOverride : ctx.message.text || '').trim();
  if (!prompt) return;

  const chatId = String(ctx.chat?.id || 'default');

  // Session boundary detection (30-min gap triggers summarization of old session)
  const { sessionId } = getOrRotateSession(chatId);
  await ensureSession(sessionId, 'telegram');

  // Store user message in PostgreSQL
  await storeMessage(sessionId, 'user', prompt);

  // Build context: durable facts + relevant past summaries + current session history
  const contextPrompt = await buildMemoryContext(prompt, sessionId);

  if (isRateLimited()) {
    return ctx.replyWithHTML(
      `⚠️ Rate limit reached (${RATE_LIMIT_MAX} Claude calls/hour). Use slash commands for free operations, or wait a bit.`
    );
  }

  const thinking = await ctx.replyWithHTML('🧠 <i>Thinking...</i>');

  recordCall();
  const { ok, output } = await runClaude(contextPrompt, 'opus');
  const left = remaining();

  // Store assistant response in PostgreSQL
  if (ok) {
    await storeMessage(sessionId, 'assistant', output);
  }

  let response;
  if (ok) {
    response = truncate(mdToHtml(output), 3900) + `\n\n<i>(${left} Claude calls remaining this hour)</i>`;
  } else {
    response = `🔴 Claude error:\n<pre>${truncate(escapeHtml(output), 3800)}</pre>`;
  }

  try {
    await ctx.telegram.editMessageText(
      thinking.chat.id,
      thinking.message_id,
      undefined,
      response,
      { parse_mode: 'HTML' }
    );
  } catch {
    await ctx.replyWithHTML(response);
  }
}
