// Telegram transport adapter for the JARVIS brain.
//
// The intelligence lives in brain.js (askCore + router + agents). This file is
// the thin Telegram layer: it calls askCore() and renders the result to Telegram
// (messages, photos, voice, fact-extraction buttons). Other surfaces (the HTTP
// /ask endpoint in server.js) call the same askCore() directly.

import { exec } from 'node:child_process';
import { Markup } from 'telegraf';
import { truncate, escapeHtml, mdToHtml, sendLong, sendPhotoAlbum } from './utils.js';
import {
  ensureSession, storeMessage, buildMemoryContext, closePool,
  extractFactsFromExchange, deduplicateFacts, storePendingBatch,
} from './memory.js';
import { extractResponseContent } from './agents/shared.js';
import { runOpus } from './agents/opus.js';
import { registerDeploy } from './commands/deploy.js';
import { generateSpeech, isValidVoice, VALID_VOICES } from './agents/tts.js';
import {
  askCore, getOrRotateSession, forceNewSession as forceNewSessionByKey,
  ACTION_META, actionKeyOf,
  isLimited, recordTo, remainingIn, opusCallLog, OPUS_RATE_MAX,
} from './brain.js';

const JARVIS_DIR = process.env.HOME + '/jarvis';

// Telegram wrapper around the brain's session helpers (keys are `tg:<chatId>`).
export function forceNewSession(chatId) {
  return forceNewSessionByKey(`tg:${chatId}`, 'telegram');
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

// --- Legacy: sendToClaude for slash commands that use specific models ---

export async function sendToClaude(ctx, prompt, thinkingMsg = '🧠 <i>Thinking...</i>', model = 'sonnet') {
  const MODELS = {
    opus: 'claude-opus-5',
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

// --- Send a citation list as its own bounded message ---

async function sendSources(ctx, sources) {
  if (!sources?.length) return;
  const links = sources
    .map((s) => `<a href="${escapeHtml(s.url)}">${escapeHtml(s.title)}</a>`)
    .join(' · ');
  await ctx.replyWithHTML(truncate(`📎 ${links}`), { disable_web_page_preview: true })
    .catch((err) => console.error('Failed to send sources:', err.message));
}

// --- Render one action's result to Telegram (sequential, in order) ---
// Assistant-message persistence now happens once in askCore; this only renders.
// Returns { ok, text } so the caller can aggregate voice + fact extraction.

async function renderOne(ctx, { key, action, res }) {
  const meta = ACTION_META[key] || { label: 'Action' };

  if (!res.ok) {
    await ctx.replyWithHTML(`🔴 ${escapeHtml(meta.label)} failed: ${escapeHtml(res.output)}`)
      .catch((err) => console.error('Failed to send error:', err.message));
    return { ok: false, text: '' };
  }

  if (key === 'ha') {
    await ctx.replyWithHTML(`✅ ${escapeHtml(res.output)}`);
  } else if (key === 'remind') {
    await ctx.replyWithHTML(`⏰ ${escapeHtml(res.output)}`);
  } else if (key === 'selfdev' && res.deploy) {
    // Self-edit committed — offer a one-tap deploy (redeploy + restart).
    const id = registerDeploy(res.deploy);
    await sendLong(ctx, `🛠️ ${mdToHtml(res.output)}`, {
      disable_web_page_preview: true,
      ...Markup.inlineKeyboard([[
        Markup.button.callback('🚀 Deploy now', `dep:go:${id}`),
        Markup.button.callback('✖ Not yet', `dep:x:${id}`),
      ]]),
    });
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
    await sendPhotoAlbum(ctx, res.posters);
  }

  return { ok: true, text: res.output };
}

// --- Main chat handler: Telegram adapter over askCore ---

export async function askClaude(ctx, textOverride = null) {
  const prompt = (typeof textOverride === 'string' ? textOverride : ctx.message.text || '').trim();
  if (!prompt) return;

  const chatId = String(ctx.chat?.id || 'default');
  const thinking = await ctx.replyWithHTML('🧠 <i>Thinking...</i>');

  // Progress hook: turn the thinking message into per-action acks before execution.
  const onPlan = async (actions) => {
    const ackLines = actions.map((a) => {
      const meta = ACTION_META[actionKeyOf(a)] || { emoji: '⚙️', ack: 'Working on it, Sir...' };
      return `${meta.emoji} <i>${escapeHtml(a.acknowledge || meta.ack)}</i>`;
    });
    await ctx.telegram.editMessageText(
      thinking.chat.id, thinking.message_id, undefined,
      ackLines.join('\n'), { parse_mode: 'HTML' }
    ).catch(() => {});
  };

  // Delivery hook for background (delegated) actions that finish after askCore
  // returns — render them as a follow-up message, plus voice + fact extraction.
  const onBackground = async ({ key, action, res }) => {
    const r = await renderOne(ctx, { key, action, res });
    if (r.ok && r.text) {
      await maybeSendVoice(ctx, r.text);
      if (prompt.length > 10) {
        offerFactExtraction(ctx, prompt, r.text).catch((err) =>
          console.error('Fact extraction failed:', err.message)
        );
      }
    }
  };

  const result = await askCore(prompt, { sessionKey: `tg:${chatId}`, source: 'telegram', chatId, onPlan, onBackground });

  // Rate-limited or front-model error → edit the thinking message.
  if (!result.ok) {
    const prefix = result.kind === 'rate_limited' ? '⚠️' : '🔴';
    const msg = `${prefix} ${escapeHtml(result.text)}`;
    await ctx.telegram.editMessageText(
      thinking.chat.id, thinking.message_id, undefined, msg, { parse_mode: 'HTML' }
    ).catch(() => ctx.replyWithHTML(msg));
    return;
  }

  // Actions → render each result in order, then aggregate voice + fact extraction.
  if (result.kind === 'actions') {
    const texts = [];
    for (const run of result.results) {
      // Background (delegated) actions were only acked in onPlan; their real
      // result arrives later through onBackground. Skip the ack stub here.
      if (run.res.background) continue;
      const r = await renderOne(ctx, run);
      if (r.ok && r.text) texts.push(r.text);
    }
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

  // Direct answer → edit the thinking message to the response.
  const response = truncate(mdToHtml(result.text), 3900);
  try {
    await ctx.telegram.editMessageText(
      thinking.chat.id, thinking.message_id, undefined,
      response, { parse_mode: 'HTML' }
    );
  } catch {
    await ctx.replyWithHTML(response);
  }

  await maybeSendVoice(ctx, result.text);
  if (prompt.length > 10) {
    offerFactExtraction(ctx, prompt, result.text).catch((err) =>
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
  const { sessionId } = getOrRotateSession(`tg:${chatId}`, 'telegram');
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
