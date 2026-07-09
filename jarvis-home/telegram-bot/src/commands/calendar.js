import { escapeHtml, truncate, mdToHtml } from '../utils.js';
import { createEvent, listEvents } from '../agents/calendar.js';

export async function eventCommand(ctx) {
  const desc = (ctx.message.text || '').replace(/^\/event\s*/, '').trim();
  if (!desc) {
    return ctx.replyWithHTML(
      '<b>Usage:</b> <code>/event &lt;description&gt;</code>\n\n' +
      'Add a calendar event in plain English.\n' +
      '<i>e.g. /event lunch with Sam tomorrow 1pm for 45m at Cafe Xoho</i>'
    );
  }

  const chatId = String(ctx.chat?.id || 'default');
  const placeholder = await ctx.replyWithHTML('📅 <i>Adding to your calendar, Sir...</i>');

  try {
    const { ok, output } = await createEvent(chatId, desc);
    const response = ok ? truncate(mdToHtml(output), 3700) : `🔴 ${escapeHtml(output)}`;
    await ctx.telegram.editMessageText(
      placeholder.chat.id, placeholder.message_id, undefined,
      response, { parse_mode: 'HTML', disable_web_page_preview: true }
    ).catch(() => ctx.replyWithHTML(response, { disable_web_page_preview: true }));
  } catch (err) {
    const errMsg = `🔴 Failed to add event: ${escapeHtml(err.message)}`;
    await ctx.telegram.editMessageText(
      placeholder.chat.id, placeholder.message_id, undefined,
      errMsg, { parse_mode: 'HTML' }
    ).catch(() => ctx.replyWithHTML(errMsg));
  }
}

export async function agendaCommand(ctx) {
  const range = (ctx.message.text || '').replace(/^\/agenda\s*/, '').trim();

  const placeholder = await ctx.replyWithHTML('📅 <i>Checking your schedule, Sir...</i>');

  try {
    const { ok, output } = await listEvents(range);
    const response = ok ? truncate(mdToHtml(output), 3700) : `🔴 ${escapeHtml(output)}`;
    await ctx.telegram.editMessageText(
      placeholder.chat.id, placeholder.message_id, undefined,
      response, { parse_mode: 'HTML', disable_web_page_preview: true }
    ).catch(() => ctx.replyWithHTML(response, { disable_web_page_preview: true }));
  } catch (err) {
    const errMsg = `🔴 Failed to fetch schedule: ${escapeHtml(err.message)}`;
    await ctx.telegram.editMessageText(
      placeholder.chat.id, placeholder.message_id, undefined,
      errMsg, { parse_mode: 'HTML' }
    ).catch(() => ctx.replyWithHTML(errMsg));
  }
}
