// Feed text from another surface (e.g. an SMS sent from the Gear S watch, relayed
// by Home Assistant) into the Telegram chat as if the owner had typed it, so it
// runs the full Telegram pipeline (commands, rendering, voice, background jobs)
// and the reply lands where the watch can answer it.
//
// The chat is always the bot's authorised chat — callers never choose it.

import { escapeHtml } from './utils.js';

export const MAX_INJECT_TEXT = 2000;
const COMMAND_RE = /^\/[A-Za-z0-9_]+(@[A-Za-z0-9_]+)?/;

export function buildTextUpdate(chatId, messageId, text, date = Math.floor(Date.now() / 1000)) {
  const id = Number(chatId);
  const message = {
    message_id: messageId,
    date,
    chat: { id, type: 'private' },
    from: { id, is_bot: false, first_name: 'Watch' },
    text,
  };
  // Telegraf matches commands on bot_command entities, which real clients add.
  const cmd = COMMAND_RE.exec(text);
  if (cmd) message.entities = [{ type: 'bot_command', offset: 0, length: cmd[0].length }];
  return { update_id: -Date.now(), message };
}

/**
 * Post a silent echo of the text (so the chat shows what was asked), then hand the
 * text to the bot as an incoming message. Resolves once the bot has handled it.
 */
export async function injectTelegramText(bot, chatId, text, { label = '⌚' } = {}) {
  const echo = await bot.telegram.sendMessage(chatId, `${label} <i>${escapeHtml(text)}</i>`, {
    parse_mode: 'HTML',
    disable_notification: true,
  });
  await bot.handleUpdate(buildTextUpdate(chatId, echo.message_id, text));
}
