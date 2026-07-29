// Background job runner for long-running delegated tasks.
//
// Delegated server ops (agents/opus.js via the front router) used to run inline
// with a per-model timeout as short as 1 minute — anything slower (a big pull,
// an apt upgrade, a multi-step diagnostic) was killed and the result lost. This
// runner instead executes the headless Claude Code agent in the background with
// a generous ceiling and hands the result back via a promise, so:
//   • Telegram fires-and-follows-up (immediate ack, result delivered when done)
//   • headless callers (HTTP /ask) still await the full answer
// Jobs are tracked in-memory so `/jobs` can report what's running.

import { exec } from 'node:child_process';
import crypto from 'node:crypto';
import { claudeCmd } from './opus.js';

const JOB_TIMEOUT = 25 * 60 * 1000;      // 25 min — generous ceiling for slow ops
const JOB_TTL = 6 * 60 * 60 * 1000;      // keep finished jobs 6h for /jobs history
const MAX_JOBS = 100;                    // hard cap on retained entries

// id -> { id, label, task, model, status, startedAt, finishedAt, output }
// status ∈ 'running' | 'done' | 'failed' | 'timeout'
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

// Most-recent-first snapshot for the /jobs command.
export function listJobs() {
  return [...jobs.values()].sort((a, b) => b.startedAt - a.startedAt);
}

export function getJob(id) {
  return jobs.get(id) || null;
}

export function activeJobCount() {
  let n = 0;
  for (const j of jobs.values()) if (j.status === 'running') n++;
  return n;
}

// Start a background Claude job. Returns { id, promise } where `promise` always
// RESOLVES (never rejects) to { ok, output, status } once the job finishes.
export function startClaudeJob({ prompt, model, label, task }) {
  prune();
  const id = crypto.randomBytes(4).toString('hex');
  const job = {
    id,
    label: label || 'Task',
    task: task || '',
    model,
    status: 'running',
    startedAt: Date.now(),
    finishedAt: null,
    output: '',
  };
  jobs.set(id, job);

  const promise = new Promise((resolve) => {
    const { cmd, shell } = claudeCmd(prompt, model);
    exec(cmd, { timeout: JOB_TIMEOUT, shell, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      job.finishedAt = Date.now();
      if (err) {
        if (err.killed) {
          const mins = Math.round(JOB_TIMEOUT / 60_000);
          job.status = 'timeout';
          job.output = `The task ran past ${mins} minutes and was stopped, Sir.`;
        } else {
          job.status = 'failed';
          job.output = stderr?.trim() || err.message;
        }
      } else {
        job.status = 'done';
        job.output = stdout?.trim() || '(no response)';
      }
      resolve({ ok: job.status === 'done', output: job.output, status: job.status });
    });
  });

  return { id, promise };
}
