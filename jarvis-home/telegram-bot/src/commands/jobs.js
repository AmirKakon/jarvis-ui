// /jobs — list background tasks (delegated server ops that run detached from
// the request, see agents/jobs.js). Shows what's still running plus recent
// finished tasks and their outcome.

import { listJobs } from '../agents/jobs.js';
import { escapeHtml } from '../utils.js';

const STATUS_EMOJI = { running: '⏳', done: '✅', failed: '🔴', timeout: '⌛' };

function fmtAge(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.round(m / 60)}h`;
}

export async function jobsCommand(ctx) {
  const now = Date.now();
  const jobs = listJobs().slice(0, 15);
  if (!jobs.length) {
    return ctx.replyWithHTML('No background tasks, Sir.');
  }

  const lines = ['<b>🧵 Background tasks</b>', ''];
  for (const j of jobs) {
    const emoji = STATUS_EMOJI[j.status] || '•';
    const age = j.status === 'running'
      ? `running ${fmtAge(now - j.startedAt)}`
      : `${j.status} · ${fmtAge((j.finishedAt || now) - j.startedAt)}`;
    const desc = (j.task || j.label || '').replace(/\s+/g, ' ').slice(0, 80);
    lines.push(`${emoji} <code>${j.id}</code> ${escapeHtml(desc)} <i>(${age})</i>`);
  }
  return ctx.replyWithHTML(lines.join('\n'), { disable_web_page_preview: true });
}
