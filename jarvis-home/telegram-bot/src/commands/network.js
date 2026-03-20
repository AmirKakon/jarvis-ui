import { Markup } from 'telegraf';
import { run, bold, pre, editOrReply } from '../utils.js';

const REFRESH_BTN = Markup.inlineKeyboard([
  Markup.button.callback('🔄 Refresh', 'x:network'),
]);

async function buildNetwork() {
  const [addrs, ports] = await Promise.all([
    run('ip -br addr'),
    run('ss -tlnp 2>/dev/null | head -30'),
  ]);

  const lines = [bold('Network Overview'), ''];

  if (addrs.ok) {
    lines.push(bold('Interfaces'));
    lines.push(pre(addrs.output));
  }

  if (ports.ok) {
    lines.push('');
    lines.push(bold('Listening Ports'));
    lines.push(pre(ports.output));
  }

  return lines.join('\n');
}

export async function networkCommand(ctx) {
  const placeholder = await ctx.replyWithHTML('<i>Checking network...</i>');
  const html = await buildNetwork();
  await editOrReply(ctx, placeholder.message_id, html, REFRESH_BTN);
}

export async function networkRefresh(ctx) {
  await ctx.answerCbQuery('Refreshing...');
  const html = await buildNetwork();
  await editOrReply(ctx, ctx.callbackQuery.message.message_id, html, REFRESH_BTN);
}
