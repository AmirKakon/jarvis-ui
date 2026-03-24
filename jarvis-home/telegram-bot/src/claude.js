import { exec } from 'node:child_process';
import { truncate, escapeHtml, mdToHtml } from './utils.js';

const JARVIS_DIR = process.env.HOME + '/jarvis';
const CLAUDE_TIMEOUT = 120_000; // 2 minutes max
const RATE_LIMIT_WINDOW = 60 * 60 * 1000; // 1 hour
const RATE_LIMIT_MAX = Number(process.env.CLAUDE_RATE_LIMIT) || 20;

const callLog = [];

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

function runClaude(prompt, model = 'sonnet') {
  return new Promise((resolve) => {
    const escaped = prompt.replace(/'/g, "'\\''");
    const modelFlag = MODELS[model] ? `--model ${MODELS[model]}` : '';
    const cmd = `cd ${JARVIS_DIR} && claude --dangerously-skip-permissions ${modelFlag} -p '${escaped}' 2>/dev/null`;

    exec(cmd, { timeout: CLAUDE_TIMEOUT, shell: '/bin/bash', maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        if (err.killed) {
          resolve({ ok: false, output: 'Claude timed out after 2 minutes.' });
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
 * Uses Opus for rich interactive conversations.
 */
export async function askClaude(ctx) {
  const prompt = (ctx.message.text || '').trim();
  if (!prompt) return;
  return sendToClaude(ctx, prompt, '🧠 <i>Thinking...</i>', 'opus');
}
