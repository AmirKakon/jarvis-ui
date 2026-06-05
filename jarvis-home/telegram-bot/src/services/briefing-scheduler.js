import { buildBriefing } from './briefing.js';

const TZ = 'Asia/Jerusalem';
const CHECK_INTERVAL = 60_000; // check once a minute

let intervalId = null;
let lastSentDate = null; // 'YYYY-MM-DD' (Jerusalem) of the last briefing sent

function jerusalemParts() {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(new Date()).map((p) => [p.type, p.value]));
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    hm: `${parts.hour}:${parts.minute}`,
  };
}

async function maybeSendBriefing(bot, chatId) {
  if (process.env.BRIEFING_ENABLED === 'false') return;

  const target = (process.env.BRIEFING_TIME || '07:00').trim();
  const { date, hm } = jerusalemParts();

  if (hm !== target || lastSentDate === date) return;

  lastSentDate = date; // mark before sending to avoid double-fire on slow send
  try {
    const html = await buildBriefing(chatId);
    await bot.telegram.sendMessage(chatId, html, { parse_mode: 'HTML', disable_web_page_preview: true });
    console.log(`[briefing] Sent daily briefing to ${chatId} at ${hm}`);
  } catch (err) {
    console.error('[briefing] Failed to send:', err.message);
  }
}

export function startBriefingScheduler(bot, chatId) {
  if (intervalId) return;
  intervalId = setInterval(() => maybeSendBriefing(bot, chatId), CHECK_INTERVAL);
  const target = (process.env.BRIEFING_TIME || '07:00').trim();
  const enabled = process.env.BRIEFING_ENABLED !== 'false';
  console.log(`[briefing] Scheduler started (${enabled ? `daily at ${target} ${TZ}` : 'disabled'})`);
}

export function stopBriefingScheduler() {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    console.log('[briefing] Scheduler stopped');
  }
}
