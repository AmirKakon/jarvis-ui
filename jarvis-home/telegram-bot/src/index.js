import { readFileSync } from 'node:fs';
import { Telegraf } from 'telegraf';
import { statusCommand } from './commands/status.js';
import { dockerCommand } from './commands/docker.js';
import { storageCommand } from './commands/storage.js';
import { networkCommand } from './commands/network.js';
import { servicesCommand } from './commands/services.js';
import { haCommand } from './commands/ha.js';
import { n8nCommand } from './commands/n8n.js';
import { askClaude } from './claude.js';

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

// --- Error handler ---
bot.catch((err, ctx) => {
  console.error(`Bot error for ${ctx.updateType}:`, err.message);
  ctx.replyWithHTML('🔴 Something went wrong. Check the bot logs.').catch(() => {});
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
  '/help      — this message',
  '',
  '<b>AI-powered (uses Claude):</b>',
  'Send any free-text message to ask Claude.',
  'Rate-limited to prevent runaway costs.',
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

// --- Free-text → Claude Code ---
bot.on('text', askClaude);

// --- Graceful shutdown ---
function shutdown(signal) {
  console.log(`Received ${signal}, shutting down...`);
  bot.stop(signal);
}
process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));

// --- Start ---
bot.launch({ dropPendingUpdates: true }).then(() => {
  console.log(`Jarvis Telegram bot started (chat: ${CHAT_ID})`);
});
