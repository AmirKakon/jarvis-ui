import { test } from 'node:test';
import assert from 'node:assert/strict';

delete process.env.DATABASE_URL;
const { listJobs, recoverInterruptedJobs, startAsyncJob } = await import('./jobs.js');

test('jobs a restart cut off are marked interrupted and returned with their chat', async () => {
  const calls = [];
  const db = async (sql, params) => {
    calls.push(sql.replace(/\s+/g, ' ').trim());
    if (sql.includes('UPDATE')) {
      return { rows: [{ id: 'ab12cd34', label: 'Working on it', task: 'apt upgrade', model: 'claude-opus-5-5', chat_id: '42', status: 'interrupted', started_at: '2026-11-27T10:00:00Z', finished_at: '2026-11-27T10:05:00Z' }] };
    }
    return { rows: [] };
  };

  const jobs = await recoverInterruptedJobs({ db });

  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].chatId, '42');
  assert.equal(jobs[0].task, 'apt upgrade');
  assert.equal(jobs[0].status, 'interrupted');
  assert.match(calls[0], /SET status = 'interrupted'.*WHERE status = 'running'/);
  assert.match(calls[1], /^DELETE FROM jobs/);
});

test('recovery never throws, even without the jobs table', async () => {
  const jobs = await recoverInterruptedJobs({ db: async () => { throw new Error('relation "jobs" does not exist'); } });
  assert.deepEqual(jobs, []);
});

test('/jobs history comes from the table when there is one', async () => {
  const jobs = await listJobs(5, {
    db: async () => ({ rows: [{ id: 'x1', label: 'L', task: 'T', model: 'm', chat_id: null, status: 'done', started_at: '2026-11-27T10:00:00Z', finished_at: '2026-11-27T10:01:00Z' }] }),
  });
  assert.equal(jobs[0].id, 'x1');
  assert.equal(jobs[0].finishedAt - jobs[0].startedAt, 60_000);
});

test('without a database /jobs falls back to this process\'s jobs', async () => {
  const { id, promise } = startAsyncJob({ run: async () => ({ ok: true, output: 'fine' }), label: 'check', task: 'local task', chatId: 7 });
  await promise;
  const jobs = await listJobs();
  const job = jobs.find((j) => j.id === id);
  assert.equal(job.status, 'done');
  assert.equal(job.chatId, '7');
});
