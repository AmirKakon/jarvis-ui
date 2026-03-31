import { Markup } from 'telegraf';
import { getDueReminders, markFired, updateFireAt, computeNextFire } from '../agents/remind.js';
import { escapeHtml } from '../utils.js';

const POLL_INTERVAL = 30_000;

let intervalId = null;

function snoozeKeyboard(reminderId) {
  return Markup.inlineKeyboard([
    Markup.button.callback('Snooze 5m', `snz:${reminderId}:5`),
    Markup.button.callback('Snooze 15m', `snz:${reminderId}:15`),
    Markup.button.callback('Snooze 1h', `snz:${reminderId}:60`),
  ]);
}

async function pollReminders(bot, defaultChatId) {
  try {
    const due = await getDueReminders();

    if (due.length > 0) {
      console.log(`[scheduler] ${due.length} reminder(s) due: ${due.map((r) => `#${r.id} "${r.message}" fire_at=${r.fire_at}`).join(', ')}`);
    }

    for (const reminder of due) {
      const chatId = reminder.chat_id || defaultChatId;
      const rec = reminder.recurrence ? `\n🔁 Recurring: ${reminder.recurrence}` : '';
      const text = `🔔 <b>Reminder #${reminder.id}</b>\n${escapeHtml(reminder.message)}${rec}`;

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
