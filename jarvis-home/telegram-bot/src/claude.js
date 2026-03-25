import { exec } from 'node:child_process';
import { truncate, escapeHtml, mdToHtml } from './utils.js';

const JARVIS_DIR = process.env.HOME + '/jarvis';
const RATE_LIMIT_WINDOW = 60 * 60 * 1000; // 1 hour
const RATE_LIMIT_MAX = Number(process.env.CLAUDE_RATE_LIMIT) || 20;
const MAX_HISTORY = 5;

const TIMEOUTS = {
  opus: 240_000,   // 4 minutes for interactive chat
  sonnet: 120_000, // 2 minutes for structured tasks
  haiku: 60_000,   // 1 minute for simple extraction
};

const callLog = [];
const chatHistory = new Map();

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

const MODELS = {
  opus: 'claude-opus-4-20250514',
  sonnet: 'claude-sonnet-4-20250514',
  haiku: 'claude-haiku-4-20250514',
};

function getHistory(chatId) {
  if (!chatHistory.has(chatId)) chatHistory.set(chatId, []);
  return chatHistory.get(chatId);
}

function addToHistory(chatId, role, text) {
  const history = getHistory(chatId);
  history.push({ role, text: text.slice(0, 500) });
  if (history.length > MAX_HISTORY * 2) {
    history.splice(0, history.length - MAX_HISTORY * 2);
  }
}

function buildContextPrompt(chatId, currentPrompt) {
  const history = getHistory(chatId);
  if (!history.length) return currentPrompt;

  const contextLines = history.map(h =>
    h.role === 'user' ? `User: ${h.text}` : `Jarvis: ${h.text}`
  );

  return [
    'Recent conversation context (for continuity):',
    '---',
    ...contextLines,
    '---',
    '',
    'Current message from user:',
    currentPrompt,
  ].join('\n');
}

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
 * Uses Opus with conversation history for continuity.
 */
export async function askClaude(ctx) {
  const prompt = (ctx.message.text || '').trim();
  if (!prompt) return;

  const chatId = String(ctx.chat?.id || 'default');
  addToHistory(chatId, 'user', prompt);

  const contextPrompt = buildContextPrompt(chatId, prompt);

  if (isRateLimited()) {
    return ctx.replyWithHTML(
      `⚠️ Rate limit reached (${RATE_LIMIT_MAX} Claude calls/hour). Use slash commands for free operations, or wait a bit.`
    );
  }

  const thinking = await ctx.replyWithHTML('🧠 <i>Thinking...</i>');

  recordCall();
  const { ok, output } = await runClaude(contextPrompt, 'opus');
  const left = remaining();

  if (ok) {
    addToHistory(chatId, 'assistant', output);
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
