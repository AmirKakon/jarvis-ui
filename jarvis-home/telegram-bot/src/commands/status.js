import { Markup } from 'telegraf';
import { bold, pre, editOrReply } from '../utils.js';
import { collectHealth } from '../services/health.js';

const REFRESH_BTN = Markup.inlineKeyboard([
  Markup.button.callback('🔄 Refresh', 'x:status'),
]);

async function buildStatus() {
  const h = await collectHealth();

  const lines = [];
  lines.push(bold('System Status'));
  lines.push('');

  if (h.uptime) lines.push(`<b>Uptime:</b> ${h.uptime}`);
  if (h.load) lines.push(`<b>Load:</b> ${h.load.one} ${h.load.five} ${h.load.fifteen}`);

  if (h.mem) {
    lines.push('');
    lines.push(bold('Memory'));
    lines.push(pre(h.mem.block));
  }

  if (h.disk) {
    const warn = h.disk.pct > 90 ? ' ⚠️' : '';
    lines.push(`<b>Root disk:</b> ${h.disk.used} / ${h.disk.size} (${h.disk.pct}% used)${warn}`);
  }

  if (h.containers.length) {
    lines.push('');
    lines.push(bold('Docker Containers'));
    lines.push(h.containers.map((c) => `  ${c.up ? '🟢' : '🔴'} ${c.name}`).join('\n'));
  }

  return lines.join('\n');
}

export async function statusCommand(ctx) {
  const placeholder = await ctx.replyWithHTML('<i>Gathering system health...</i>');
  const html = await buildStatus();
  await editOrReply(ctx, placeholder.message_id, html, REFRESH_BTN);
}

export async function statusRefresh(ctx) {
  await ctx.answerCbQuery('Refreshing...');
  const html = await buildStatus();
  await editOrReply(ctx, ctx.callbackQuery.message.message_id, html, REFRESH_BTN);
}
