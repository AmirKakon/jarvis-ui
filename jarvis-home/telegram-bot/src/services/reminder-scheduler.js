import { Markup } from 'telegraf';
import { getDueReminders, markFired, updateFireAt, computeNextFire, purgeOldReminders } from '../agents/remind.js';
import { escapeHtml } from '../utils.js';

const POLL_INTERVAL = 30_000;

const PURGE_EVERY = 2880; // ~24h at 30s intervals

let intervalId = null;
let pollCount = 0;

function snoozeKeyboard(reminderId) {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('5m', `snz:${reminderId}:5`),
      Markup.button.callback('15m', `snz:${reminderId}:15`),
      Markup.button.callback('1h', `snz:${reminderId}:60`),
      Markup.button.callback('More...', `snz_more:${reminderId}`),
    ],
  ]);
}

async function pollReminders(bot, defaultChatId) {
  try {
    const due = await getDueReminders();

    if (due.length > 0) {
      console.log(`[scheduler] ${due.length} reminder(s) due: ${due.map((r) => `#${r.id} "${r.message}"`).join(', ')}`);
    }

    for (const reminder of due) {
      const chatId = reminder.chat_id || defaultChatId;
      const rec = reminder.recurrence ? `\n🔁 Recurring` : '';
      const text = `🔔 <b>Reminder</b>\n${escapeHtml(reminder.message)}${rec}`;

      try {
        await bot.telegram.sendMessage(chatId, text, {
          parse_mode: 'HTML',
          ...snoozeKeyboard(reminder.id),
        });
      } catch (err) {
        console.error(`[scheduler] Failed to send reminder #${reminder.id}:`, err.message);
      }

      if (reminder.recurrence) {
        const next = computeNextFire(reminder.recurrence, reminder.fire_at);
        if (next) {
          await updateFireAt(reminder.id, next);
        } else {
          await markFired(reminder.id);
        }
      } else {
        await markFired(reminder.id);
      }
    }
    pollCount++;
    if (pollCount % PURGE_EVERY === 0) {
      await purgeOldReminders();
    }
  } catch (err) {
    console.error('[scheduler] Poll error:', err.message);
  }
}

export function startScheduler(bot, chatId) {
  if (intervalId) return;

  pollReminders(bot, chatId);
  intervalId = setInterval(() => pollReminders(bot, chatId), POLL_INTERVAL);
  console.log(`[scheduler] Reminder poller started (every ${POLL_INTERVAL / 1000}s)`);
}

export function stopScheduler() {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    console.log('[scheduler] Reminder poller stopped');
  }
}
