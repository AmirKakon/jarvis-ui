// Startup recovery and the idle-session sweep.
//
// On start: pick up conversations that were open before the restart, and tell
// the user about background jobs the restart cut off. Then, every
// SWEEP_INTERVAL_MS, summarise conversations that have gone quiet (including
// ones orphaned by earlier restarts) so they reach long-term memory.

import { restoreSessions, sweepIdleSessions } from '../brain.js';
import { recoverInterruptedJobs } from '../agents/jobs.js';
import { storeMessage } from '../memory.js';
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

/**
 * Tell the user about each job a restart cut off, and record it in the job's
 * conversation so JARVIS knows the request was not completed (instead of
 * seeing an unanswered request and offering to run it again).
 */
export async function reportInterruptedJobs(jobs, { defaultChatId, send, store = storeMessage }) {
  for (const job of jobs) {
    const what = (job.task || job.label || 'a task').replace(/\s+/g, ' ').slice(0, 200);
    if (job.sessionId) {
      await store(job.sessionId, 'assistant', `This task was cut off by a bot restart and did not finish: ${what}. It has not been retried.`)
        .catch((err) => console.error(`[jobs] could not record interrupted job ${job.id}:`, err.message));
    }
    const chatId = job.chatId || defaultChatId;
    if (!chatId) continue;
    await send(
      chatId,
      `⚠️ I was restarted while working on this, so it didn't finish:\n<i>${escapeHtml(what)}</i>\nAsk me again if you still need it, Sir.`,
    ).catch((err) => console.error(`[jobs] could not report interrupted job ${job.id}:`, err.message));
  }
}

export async function startRecovery(bot, defaultChatId) {
  try {
    const restored = await restoreSessions();
    if (restored) console.log(`[sessions] restored ${restored} open session(s)`);
  } catch (err) {
    console.error('[sessions] restore failed:', err.message);
  }

  await reportInterruptedJobs(await recoverInterruptedJobs(), {
    defaultChatId,
    send: (chatId, html) => bot.telegram.sendMessage(chatId, html, { parse_mode: 'HTML' }),
  });

  await sweep();
  timer = setInterval(sweep, SWEEP_INTERVAL_MS);
}

export function stopRecovery() {
  if (timer) clearInterval(timer);
  timer = null;
}
