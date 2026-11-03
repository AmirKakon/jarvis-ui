import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTextUpdate, injectTelegramText } from './telegram-inject.js';

test('buildTextUpdate makes a private-chat text message from the owner', () => {
  const { message } = buildTextUpdate('111', 42, 'next bus?', 1700000000);
  assert.deepEqual(message, {
    message_id: 42,
    date: 1700000000,
    chat: { id: 111, type: 'private' },
    from: { id: 111, is_bot: false, first_name: 'Watch' },
    text: 'next bus?',
  });
});

test('buildTextUpdate tags a leading slash command so Telegraf routes it', () => {
  const cases = [
    ['/bus', 4],
    ['/bus 616', 4],
    ['/bus@JarvisBot 616', 14],
    ['what is /bus', null],
  ];
  for (const [text, length] of cases) {
    const { message } = buildTextUpdate('111', 1, text);
    const expected = length === null ? undefined : [{ type: 'bot_command', offset: 0, length }];
    assert.deepEqual(message.entities, expected, text);
  }
});

test('injectTelegramText posts a silent escaped echo, then handles the text as that message', async () => {
  const calls = [];
  const bot = {
    telegram: {
      sendMessage: async (chatId, html, extra) => {
        calls.push(['send', chatId, html, extra]);
        return { message_id: 77 };
      },
    },
    handleUpdate: async (update) => { calls.push(['update', update.message]); },
  };

  await injectTelegramText(bot, '111', 'lights <off>');

  assert.deepEqual(calls[0], ['send', '111', '⌚ <i>lights &lt;off&gt;</i>', { parse_mode: 'HTML', disable_notification: true }]);
  assert.equal(calls[1][0], 'update');
  assert.equal(calls[1][1].message_id, 77);
  assert.equal(calls[1][1].text, 'lights <off>');
  assert.equal(calls[1][1].chat.id, 111);
});
