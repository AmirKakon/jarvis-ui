import { escapeHtml, mdToHtml, sendLong } from '../utils.js';
import { runJellyfinQuery } from '../agents/jellyfin.js';

export async function jellyfinCommand(ctx) {
  const question = (ctx.message.text || '').replace(/^\/jellyfin\s*/i, '').trim();

  const placeholder = await ctx.replyWithHTML('🎬 <i>Checking the media library, Sir...</i>');

  try {
    const { ok, output } = await runJellyfinQuery(question);
    if (!ok) {
      const err = `🔴 ${escapeHtml(output)}`;
      await ctx.telegram.editMessageText(
        placeholder.chat.id, placeholder.message_id, undefined, err, { parse_mode: 'HTML' }
      ).catch(() => ctx.replyWithHTML(err));
      return;
    }

    // Remove the placeholder, then stream the (possibly long) result.
    await ctx.telegram.deleteMessage(placeholder.chat.id, placeholder.message_id).catch(() => {});
    await sendLong(ctx, mdToHtml(output), { disable_web_page_preview: true });
  } catch (err) {
    const errMsg = `🔴 Jellyfin failed: ${escapeHtml(err.message)}`;
    await ctx.telegram.editMessageText(
      placeholder.chat.id, placeholder.message_id, undefined, errMsg, { parse_mode: 'HTML' }
    ).catch(() => ctx.replyWithHTML(errMsg));
  }
}
