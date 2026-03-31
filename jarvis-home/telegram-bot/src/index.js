import { readFileSync } from 'node:fs';
import { Telegraf, Markup } from 'telegraf';
import { escapeHtml, editOrReply } from './utils.js';
import { statusCommand, statusRefresh } from './commands/status.js';
import { dockerCommand, dockerCallback, dockerRefresh } from './commands/docker.js';
import { storageCommand, storageRefresh } from './commands/storage.js';
import { networkCommand, networkRefresh } from './commands/network.js';
import { servicesCommand, servicesRefresh } from './commands/services.js';
import { haCommand, haCallback } from './commands/ha.js';
import { n8nCommand } from './commands/n8n.js';
import { downloadCommand, downloadCallback, downloadRefresh, handlePendingDownloadEdit } from './commands/download.js';
import { askClaude, askOpusDirect, closePool, toggleVoice, setVoice, getVoiceStatus, VALID_VOICES } from './claude.js';
import { storeFact, getPendingBatch, deletePendingBatch } from './memory.js';
import {
  handleVoice, handleAudio, handlePhoto, handleDocument,
  handleVideo, handleVideoNote, handleAnimation, handleSticker,
  handleLocation, handleContact,
} from './media.js';
import { memoryCommand } from './commands/memory.js';
import { securityCommand, securityRefresh } from './commands/security.js';
import { searchCommand } from './commands/search.js';
import { cronRerun } from './commands/cron-rerun.js';
import { listReminders, snoozeReminder, closeReminderPool } from './agents/remind.js';
import { startScheduler, stopScheduler } from './services/reminder-scheduler.js';

// --- Load environment from ~/jarvis/.env ---
const ENV_PATH = (process.env.HOME || '/home/iot') + '/jarvis/.env';
try {
  const envContent = readFileSync(ENV_PATH, 'utf-8');
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim();
    if (!process.env[key]) process.env[key] = val;
  }
} catch (err) {
  console.error(`Failed to load ${ENV_PATH}: ${err.message}`);
  process.exit(1);
}

const BOT_TOKEN = process.env.TG_BOT_TOKEN;
const CHAT_ID = process.env.TG_CHAT_ID;

if (!BOT_TOKEN || BOT_TOKEN === 'your-telegram-bot-token-here') {
  console.error('TG_BOT_TOKEN not configured in ~/jarvis/.env');
  process.exit(1);
}
if (!CHAT_ID) {
  console.error('TG_CHAT_ID not configured in ~/jarvis/.env');
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);

// --- Security middleware: only respond to authorised chat ---
bot.use((ctx, next) => {
  const chatId = String(ctx.chat?.id || '');
  if (chatId !== CHAT_ID) {
    console.log(`Rejected message from chat ${chatId}`);
    return;
  }
  return next();
});

// --- Typing indicator middleware ---
bot.use((ctx, next) => {
  if (ctx.message?.text) {
    ctx.sendChatAction('typing').catch(() => {});
  }
  return next();
});

// --- Error handler ---
bot.catch((err, ctx) => {
  console.error(`Bot error for ${ctx.updateType}:`, err);
  const short = (err.message || String(err)).slice(0, 300);
  ctx.replyWithHTML(
    `🔴 <b>Error</b> (${escapeHtml(ctx.updateType)}):\n<pre>${escapeHtml(short)}</pre>`
  ).catch(() => {});
});

// --- Slash commands ---
const HELP_TEXT = [
  '<b>Jarvis Telegram Bot</b>',
  '',
  '<b>Free commands (no AI cost):</b>',
  '/status    — system health summary',
  '/docker    — list / manage containers',
  '/services  — systemd service status',
  '/storage   — disk usage overview',
  '/network   — network interfaces & ports',
  '/ha        — Home Assistant control',
  '/n8n       — n8n workflow management',
  '/download  — torrent downloads',
  '/security  — security dashboard',
  '/search    — web search (AI-summarized)',
  '/reminders — list active reminders',
  '/help      — this message',
  '',
  '<b>Memory (persistent across sessions):</b>',
  '/remember &lt;fact&gt;  — store a permanent fact',
  '/recall &lt;query&gt;   — search past conversations',
  '/memory            — memory stats',
  '/new               — end session &amp; start fresh',
  '',
  '<b>Smart Home (AI designs, HA runs):</b>',
  '/ha automate &lt;desc&gt; — create HA automation',
  '/ha scene &lt;desc&gt;    — create HA scene',
  '',
  '<b>AI-powered:</b>',
  'Send any message — handled by a fast, cheap model.',
  'Server tasks are automatically delegated to Opus.',
  '/deep &lt;question&gt; — bypass, send directly to Opus',
  '/voice             — toggle voice replies on/off',
  '/voice &lt;name&gt;      — switch TTS voice (e.g. echo, nova)',
  '/voice list        — show available voices',
].join('\n');

bot.command('start', (ctx) => ctx.replyWithHTML(HELP_TEXT));
bot.command('help', (ctx) => ctx.replyWithHTML(HELP_TEXT));
bot.command('status', statusCommand);
bot.command('docker', dockerCommand);
bot.command('storage', storageCommand);
bot.command('network', networkCommand);
bot.command('services', servicesCommand);
bot.command('ha', haCommand);
bot.command('n8n', n8nCommand);
bot.command('download', downloadCommand);
bot.command('security', securityCommand);
bot.command('search', searchCommand);
bot.command('reminders', async (ctx) => {
  const chatId = String(ctx.chat?.id || 'default');
  const result = await listReminders(chatId);
  await ctx.replyWithHTML(result.ok ? `⏰ ${escapeHtml(result.output)}` : `⚠️ ${escapeHtml(result.output)}`);
});
bot.command('deep', askOpusDirect);
bot.command('voice', (ctx) => {
  const chatId = String(ctx.chat?.id || 'default');
  const arg = (ctx.message.text || '').replace(/^\/voice\s*/i, '').trim().toLowerCase();

  if (arg === 'list') {
    const { voice: current } = getVoiceStatus(chatId);
    const list = VALID_VOICES.map((v) => v === current ? `<b>→ ${v}</b>` : `  ${v}`).join('\n');
    return ctx.replyWithHTML(`🎙 <b>Available voices:</b>\n<pre>${list}</pre>\n\nUsage: <code>/voice &lt;name&gt;</code>`);
  }

  if (arg) {
    const result = setVoice(chatId, arg);
    if (!result) {
      return ctx.replyWithHTML(`❌ Unknown voice "<code>${escapeHtml(arg)}</code>".\nUse <code>/voice list</code> to see options.`);
    }
    return ctx.replyWithHTML(`🎙 Voice set to <b>${result.voice}</b> and enabled.`);
  }

  const { enabled, voice } = toggleVoice(chatId);
  return ctx.replyWithHTML(enabled
    ? `🔊 Voice replies <b>enabled</b> (voice: ${voice})`
    : `🔇 Voice replies <b>disabled</b>`
  );
});
bot.command('remember', memoryCommand('remember'));
bot.command('recall', memoryCommand('recall'));
bot.command('memory', memoryCommand('memory'));
bot.command('new', memoryCommand('new'));

// --- Inline keyboard callbacks ---
bot.action(/^d:([rsSl]):(.+)$/, dockerCallback);
bot.action(/^h:(.+)$/, haCallback);
bot.action(/^dl:(.+)$/, downloadCallback);

// --- Reminder snooze callbacks ---
bot.action(/^snz:(\d+):(\d+)$/, async (ctx) => {
  const remId = parseInt(ctx.match[1]);
  const minutes = parseInt(ctx.match[2]);
  const result = await snoozeReminder(remId, minutes);

  if (result.ok) {
    await ctx.answerCbQuery(`Snoozed for ${minutes}m`);
    await editOrReply(ctx, ctx.callbackQuery.message.message_id,
      `😴 Snoozed for ${minutes} minutes (reminder #${result.newId})`
    );
  } else {
    await ctx.answerCbQuery(result.output);
  }
});

// --- Refresh callbacks ---
const refreshHandlers = {
  status: statusRefresh,
  docker: dockerRefresh,
  storage: storageRefresh,
  network: networkRefresh,
  services: servicesRefresh,
  download: downloadRefresh,
  security: securityRefresh,
};

bot.action(/^x:(.+)$/, (ctx) => {
  const cmd = ctx.match[1];
  const handler = refreshHandlers[cmd];
  if (handler) return handler(ctx);
  return ctx.answerCbQuery('Unknown refresh target');
});

// --- Cron rerun callbacks ---
bot.action(/^j:(.+)$/, cronRerun);

// --- Memory fact confirmation callbacks ---
bot.action(/^mem:([yn]):(.+)$/, async (ctx) => {
  const action = ctx.match[1];
  const batchId = ctx.match[2];
  const facts = getPendingBatch(batchId);

  if (!facts) {
    return ctx.answerCbQuery('Expired');
  }

  if (action === 'y') {
    for (const fact of facts) {
      await storeFact(fact, null, 'telegram');
    }
    deletePendingBatch(batchId);
    await ctx.answerCbQuery('Saved!');
    const saved = facts.map((f) => `• ${escapeHtml(f)}`).join('\n');
    await editOrReply(ctx, ctx.callbackQuery.message.message_id,
      `✅ <b>Remembered ${facts.length} fact(s):</b>\n${saved}`
    );
  } else {
    deletePendingBatch(batchId);
    await ctx.answerCbQuery('Skipped');
    await editOrReply(ctx, ctx.callbackQuery.message.message_id, '⏭ Skipped.');
  }
});

// --- Media handlers → process + Claude Code ---
bot.on('voice', handleVoice);
bot.on('audio', handleAudio);
bot.on('photo', handlePhoto);
bot.on('document', handleDocument);
bot.on('video', handleVideo);
bot.on('video_note', handleVideoNote);
bot.on('animation', handleAnimation);
bot.on('sticker', handleSticker);
bot.on('location', handleLocation);
bot.on('contact', handleContact);

// --- Free-text: check pending download edit first, then Claude ---
bot.on('text', (ctx, next) => {
  if (handlePendingDownloadEdit(ctx)) return;
  return next();
});
bot.on('text', askClaude);

// --- Graceful shutdown ---
async function shutdown(signal) {
  console.log(`Received ${signal}, shutting down...`);
  stopScheduler();
  bot.stop(signal);
  await closePool();
  await closeReminderPool();
}
process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));

// --- Start ---
bot.launch({ dropPendingUpdates: true }).then(() => {
  startScheduler(bot, CHAT_ID);
  bot.telegram.setMyCommands([
    { command: 'status', description: 'System health summary' },
    { command: 'docker', description: 'List / manage containers' },
    { command: 'services', description: 'Systemd service status' },
    { command: 'storage', description: 'Disk usage overview' },
    { command: 'network', description: 'Network interfaces & ports' },
    { command: 'ha', description: 'Home Assistant control' },
    { command: 'n8n', description: 'n8n workflow management' },
    { command: 'download', description: 'Torrent downloads' },
    { command: 'security', description: 'Security dashboard' },
    { command: 'search', description: 'Web search (AI-summarized)' },
    { command: 'reminders', description: 'List active reminders' },
    { command: 'remember', description: 'Store a permanent fact' },
    { command: 'recall', description: 'Search past conversations' },
    { command: 'memory', description: 'Memory stats' },
    { command: 'new', description: 'End session & start fresh' },
    { command: 'voice', description: 'Toggle voice replies / change TTS voice' },
    { command: 'deep', description: 'Send directly to Opus (bypasses front model)' },
    { command: 'help', description: 'Show all commands' },
  ]);
  console.log(`Jarvis Telegram bot started (chat: ${CHAT_ID})`);
});
