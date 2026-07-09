import { escapeHtml, truncate, mdToHtml } from '../utils.js';
import { runWeatherQuery } from '../agents/weather.js';

export async function weatherCommand(ctx) {
  const question = (ctx.message.text || '').replace(/^\/weather\s*/, '').trim();

  const placeholder = await ctx.replyWithHTML('🌤️ <i>Checking the weather, Sir...</i>');

  try {
    const { ok, output } = await runWeatherQuery(question);
    const response = ok
      ? truncate(mdToHtml(output), 3700)
      : `🔴 ${escapeHtml(output)}`;

    await ctx.telegram.editMessageText(
      placeholder.chat.id, placeholder.message_id, undefined,
      response, { parse_mode: 'HTML', disable_web_page_preview: true }
    ).catch(() => ctx.replyWithHTML(response, { disable_web_page_preview: true }));
  } catch (err) {
    const errMsg = `🔴 Weather failed: ${escapeHtml(err.message)}`;
    await ctx.telegram.editMessageText(
      placeholder.chat.id, placeholder.message_id, undefined,
      errMsg, { parse_mode: 'HTML' }
    ).catch(() => ctx.replyWithHTML(errMsg));
  }
}
