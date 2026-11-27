// Startup recovery and the idle-session sweep.
//
// On start: pick up conversations that were open before the restart, and tell
// the user about background jobs the restart cut off. Then, every
// SWEEP_INTERVAL_MS, summarise conversations that have gone quiet (including
// ones orphaned by earlier restarts) so they reach long-term memory.

import { restoreSessions, sweepIdleSessions } from '../brain.js';
import { recoverInterruptedJobs } from '../agents/jobs.js';
import { escapeHtml } from '../utils.js';

const SWEEP_INTERVAL_MS = 10 * 60 * 1000;

let timer = null;
let sweeping = false;

async function sweep() {
  if (sweeping) return;
  sweeping = true;
  try {
    const n = await sweepIdleSessions();
    if (n) console.log(`[sessions] summarised ${n} idle session(s)`);
  } catch (err) {
    console.error('[sessions] sweep failed:', err.message);
  } finally {
    sweeping = false;
  }
}

export async function startRecovery(bot, defaultChatId) {
  try {
    const restored = await restoreSessions();
    if (restored) console.log(`[sessions] restored ${restored} open session(s)`);
  } catch (err) {
    console.error('[sessions] restore failed:', err.message);
  }

  for (const job of await recoverInterruptedJobs()) {
    const chatId = job.chatId || defaultChatId;
    if (!chatId) continue;
    const what = escapeHtml((job.task || job.label || 'a task').replace(/\s+/g, ' ').slice(0, 200));
    await bot.telegram.sendMessage(
      chatId,
      `⚠️ I was restarted while working on this, so it didn't finish:\n<i>${what}</i>\nAsk me again if you still need it, Sir.`,
      { parse_mode: 'HTML' },
    ).catch((err) => console.error(`[jobs] could not report interrupted job ${job.id}:`, err.message));
  }

  await sweep();
  timer = setInterval(sweep, SWEEP_INTERVAL_MS);
}

export function stopRecovery() {
  if (timer) clearInterval(timer);
  timer = null;
}
