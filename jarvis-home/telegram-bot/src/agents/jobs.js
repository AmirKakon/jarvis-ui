// Background job runner for long-running delegated tasks.
//
// Delegated server ops (via the front router) used to run inline with a
// per-model timeout as short as 1 minute — anything slower (a big pull, an apt
// upgrade, a multi-step diagnostic) was killed and the result lost. This runner
// instead executes the Claude Code agent (claude-agent.js) in the background with
// a generous ceiling and hands the result back via a promise, so:
//   • Telegram fires-and-follows-up (immediate ack, result delivered when done)
//   • headless callers (HTTP /ask) still await the full answer
// Jobs are written to the `jobs` table as they start and finish, so `/jobs`
// history survives a restart and jobs cut off by one can be reported.

import crypto from 'node:crypto';
import { runClaudeAgent } from './claude-agent.js';
import { jarvisDir } from './opus.js';
import { query } from '../db.js';

const JOB_TIMEOUT = 25 * 60 * 1000;      // 25 min — generous ceiling for slow ops
const JOB_TTL = 6 * 60 * 60 * 1000;      // keep finished jobs 6h in memory
const MAX_JOBS = 100;                    // hard cap on in-memory entries
const HISTORY_DAYS = 30;                 // jobs table retention

// This process's jobs: id -> { id, label, task, model, chatId, sessionId, status, startedAt, finishedAt, output }
// status ∈ 'running' | 'done' | 'failed' | 'timeout' | 'interrupted'
const jobs = new Map();

function prune() {
  const cutoff = Date.now() - JOB_TTL;
  for (const [id, j] of jobs) {
    if (j.status !== 'running' && j.finishedAt && j.finishedAt < cutoff) jobs.delete(id);
  }
  if (jobs.size > MAX_JOBS) {
    const finished = [...jobs.values()]
      .filter((j) => j.status !== 'running')
      .sort((a, b) => (a.finishedAt || 0) - (b.finishedAt || 0));
    for (const j of finished) {
      if (jobs.size <= MAX_JOBS) break;
      jobs.delete(j.id);
    }
  }
}

const persist = (sql, params) => query(sql, params).catch((err) => console.error('[jobs] persist failed:', err.message));

function newJob({ label, task, model, chatId, sessionId }) {
  prune();
  const job = {
    id: crypto.randomBytes(4).toString('hex'),
    label: label || 'Task',
    task: task || '',
    model,
    chatId: chatId ? String(chatId) : null,
    sessionId: sessionId || null,
    status: 'running',
    startedAt: Date.now(),
    finishedAt: null,
    output: '',
  };
  jobs.set(job.id, job);
  persist(
    'INSERT INTO jobs (id, label, task, model, chat_id, session_id, status, started_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
    [job.id, job.label, job.task, job.model, job.chatId, job.sessionId, job.status, new Date(job.startedAt)],
  );
  return job;
}

function finish(job, status, output) {
  job.finishedAt = Date.now();
  job.status = status;
  job.output = output;
  persist(
    'UPDATE jobs SET status = $2, finished_at = $3, output = $4 WHERE id = $1',
    [job.id, status, new Date(job.finishedAt), String(output || '').slice(0, 4000)],
  );
}

const fromRow = (r) => ({
  id: r.id,
  label: r.label,
  task: r.task,
  model: r.model,
  chatId: r.chat_id,
  sessionId: r.session_id || null,
  status: r.status,
  startedAt: new Date(r.started_at).getTime(),
  finishedAt: r.finished_at ? new Date(r.finished_at).getTime() : null,
});

/** Most-recent-first jobs for /jobs: from the jobs table, or this process's memory without a database. */
export async function listJobs(limit = 15, { db = query } = {}) {
  try {
    const { rows } = await db('SELECT * FROM jobs ORDER BY started_at DESC LIMIT $1', [limit]);
    if (rows.length) return rows.map(fromRow);
  } catch (err) {
    console.error('[jobs] list failed:', err.message);
  }
  return [...jobs.values()].sort((a, b) => b.startedAt - a.startedAt).slice(0, limit);
}

/**
 * At startup: jobs still marked running were cut off by the restart. Mark them
 * interrupted, drop history past the retention window, and return the
 * interrupted ones so the caller can tell the user.
 */
export async function recoverInterruptedJobs({ db = query } = {}) {
  try {
    const { rows } = await db(
      `UPDATE jobs SET status = 'interrupted', finished_at = NOW(), output = 'Stopped by a bot restart.'
       WHERE status = 'running' RETURNING *`,
    );
    await db(`DELETE FROM jobs WHERE started_at < NOW() - ($1 || ' days')::interval`, [String(HISTORY_DAYS)]);
    return rows.map(fromRow);
  } catch (err) {
    console.error('[jobs] recovery failed:', err.message);
    return [];
  }
}

// Start a background Claude job. Returns { id, promise } where `promise` always
// RESOLVES (never rejects) to { ok, output, status } once the job finishes.
export function startClaudeJob({ prompt, model, label, task, chatId, sessionId }) {
  const job = newJob({ label, task, model, chatId, sessionId });
  const promise = runClaudeAgent({ prompt, model, cwd: jarvisDir(), timeoutMs: JOB_TIMEOUT }).then((res) => {
    finish(job, res.status, res.status === 'timeout'
      ? `The task ran past ${Math.round(JOB_TIMEOUT / 60_000)} minutes and was stopped, Sir.`
      : res.output);
    return { ok: res.ok, output: job.output, status: job.status };
  });
  return { id: job.id, promise };
}

// Start a background job that runs an arbitrary async function (e.g. complex MCP
// agent). Same return shape as startClaudeJob so Telegram /ask can fire-and-follow-up.
// `run` should resolve to { ok, output } (extra fields are fine).
export function startAsyncJob({ run, label, task, chatId, sessionId }) {
  const job = newJob({ label, task, model: 'async', chatId, sessionId });
  const promise = Promise.resolve()
    .then(() => run())
    .then((res) => {
      finish(job, res?.ok ? 'done' : 'failed', res?.output || (res?.ok ? 'Done.' : 'Failed.'));
      return { ok: !!res?.ok, output: job.output, status: job.status, ...res };
    })
    .catch((err) => {
      finish(job, 'failed', err?.message || String(err));
      return { ok: false, output: job.output, status: job.status };
    });
  return { id: job.id, promise };
}
