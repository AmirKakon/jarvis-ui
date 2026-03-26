import { readFileSync } from 'node:fs';
import { Telegraf, Markup } from 'telegraf';
import { statusCommand, statusRefresh } from './commands/status.js';
import { dockerCommand, dockerCallback, dockerRefresh } from './commands/docker.js';
import { storageCommand, storageRefresh } from './commands/storage.js';
import { networkCommand, networkRefresh } from './commands/network.js';
import { servicesCommand, servicesRefresh } from './commands/services.js';
import { haCommand, haCallback } from './commands/ha.js';
import { n8nCommand } from './commands/n8n.js';
import { downloadCommand, downloadCallback, downloadRefresh } from './commands/download.js';
import { askClaude, closePool } from './claude.js';
import { memoryCommand } from './commands/memory.js';
import { securityCommand, securityRefresh } from './commands/security.js';
import { cronRerun } from './commands/cron-rerun.js';

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
  '/download  — torrent downloads',
  '/security  — security dashboard',
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
  '<b>AI-powered (uses Claude):</b>',
  'Send any free-text message to ask Claude.',
  'Conversations are saved and summarized automatically.',
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
bot.command('remember', memoryCommand('remember'));
bot.command('recall', memoryCommand('recall'));
bot.command('memory', memoryCommand('memory'));
bot.command('new', memoryCommand('new'));

// --- Inline keyboard callbacks ---
bot.action(/^d:([rsSl]):(.+)$/, dockerCallback);
bot.action(/^h:(.+)$/, haCallback);
bot.action(/^dl:(.+)$/, downloadCallback);

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

// --- Free-text → Claude Code ---
bot.on('text', askClaude);

// --- Graceful shutdown ---
async function shutdown(signal) {
  console.log(`Received ${signal}, shutting down...`);
  bot.stop(signal);
  await closePool();
}
process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));

// --- Start ---
bot.launch({ dropPendingUpdates: true }).then(() => {
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
    { command: 'remember', description: 'Store a permanent fact' },
    { command: 'recall', description: 'Search past conversations' },
    { command: 'memory', description: 'Memory stats' },
    { command: 'new', description: 'End session & start fresh' },
    { command: 'help', description: 'Show all commands' },
  ]);
  console.log(`Jarvis Telegram bot started (chat: ${CHAT_ID})`);
});
