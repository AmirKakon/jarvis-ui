import { test } from 'node:test';
import assert from 'node:assert/strict';

delete process.env.DATABASE_URL;
const { reportInterruptedJobs } = await import('./recovery.js');

function recorder() {
  const sent = [];
  const stored = [];
  return {
    sent,
    stored,
    send: async (chatId, html) => { sent.push({ chatId, html }); },
    store: async (sessionId, role, content) => { stored.push({ sessionId, role, content }); },
  };
}

test('an interrupted job is reported on Telegram and recorded in its conversation', async () => {
  const r = recorder();
  await reportInterruptedJobs(
    [{ id: 'j1', task: 'Restart the   jarvis-telegram-bot service', chatId: '42', sessionId: 's-1' }],
    { defaultChatId: '1', send: r.send, store: r.store },
  );

  assert.equal(r.sent.length, 1);
  assert.equal(r.sent[0].chatId, '42');
  assert.match(r.sent[0].html, /didn't finish:\n<i>Restart the jarvis-telegram-bot service<\/i>/);
  assert.deepEqual(r.stored, [{
    sessionId: 's-1',
    role: 'assistant',
    content: 'This task was cut off by a bot restart and did not finish: Restart the jarvis-telegram-bot service. It has not been retried.',
  }]);
});

test('jobs without a conversation or chat still get what they can', async () => {
  const r = recorder();
  await reportInterruptedJobs(
    [{ id: 'j2', label: 'Working on it', chatId: null, sessionId: null }],
    { defaultChatId: '1', send: r.send, store: r.store },
  );
  assert.equal(r.stored.length, 0);
  assert.equal(r.sent[0].chatId, '1');
});

test('a failure to record or send one job does not stop the others', async () => {
  const sent = [];
  await reportInterruptedJobs(
    [{ id: 'a', task: 'first', chatId: '9', sessionId: 'gone' }, { id: 'b', task: 'second', chatId: '9', sessionId: 's-2' }],
    {
      send: async (chatId, html) => { if (html.includes('first')) throw new Error('blocked'); sent.push(html); },
      store: async (sessionId) => { if (sessionId === 'gone') throw new Error('session was summarised'); },
    },
  );
  assert.equal(sent.length, 1);
  assert.match(sent[0], /second/);
});
