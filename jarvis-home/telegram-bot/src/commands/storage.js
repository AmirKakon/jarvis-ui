import { Markup } from 'telegraf';
import { run, bold, pre, editOrReply } from '../utils.js';

const REFRESH_BTN = Markup.inlineKeyboard([
  Markup.button.callback('🔄 Refresh', 'x:storage'),
]);

async function buildStorage() {
  const [df, lsblk] = await Promise.all([
    run('df -h / /home/iot/shared-storage /home/iot/shared-storage-2 2>/dev/null'),
    run('lsblk -o NAME,SIZE,TYPE,MOUNTPOINT 2>/dev/null'),
  ]);

  const lines = [bold('Storage Overview'), ''];

  if (df.ok) {
    lines.push(bold('Disk Usage'));
    lines.push(pre(df.output));
  }

  if (lsblk.ok) {
    lines.push('');
    lines.push(bold('Block Devices'));
    lines.push(pre(lsblk.output));
  }

  return lines.join('\n');
}

export async function storageCommand(ctx) {
  const placeholder = await ctx.replyWithHTML('<i>Checking storage...</i>');
  const html = await buildStorage();
  await editOrReply(ctx, placeholder.message_id, html, REFRESH_BTN);
}

export async function storageRefresh(ctx) {
  await ctx.answerCbQuery('Refreshing...');
  const html = await buildStorage();
  await editOrReply(ctx, ctx.callbackQuery.message.message_id, html, REFRESH_BTN);
}
