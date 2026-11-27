import { test } from 'node:test';
import assert from 'node:assert/strict';

delete process.env.DATABASE_URL;
process.env.JARVIS_IDENTITY_MAP = 'tg:111=amir,alexa:abc=amir,ha:*=amir';

const { getOrRotateSession, forceNewSession, askCore, restoreSessions, sweepIdleSessions } = await import('./brain.js');

test('mapped surfaces continue the same live session', () => {
  const tg = getOrRotateSession('tg:111', 'telegram');
  const alexa = getOrRotateSession('alexa:abc', 'alexa');
  const assist = getOrRotateSession('ha:conv-7', 'ha-assist');
  assert.equal(tg.isNew, true);
  assert.equal(alexa.isNew, false);
  assert.equal(alexa.sessionId, tg.sessionId);
  assert.equal(assist.sessionId, tg.sessionId);
});

test('unmapped surfaces keep their own session', () => {
  const shared = getOrRotateSession('tg:111', 'telegram').sessionId;
  const other = getOrRotateSession('alexa:someone-else', 'alexa');
  assert.notEqual(other.sessionId, shared);
});

test('/new from one surface closes the shared session for all of them', async () => {
  const before = getOrRotateSession('alexa:abc', 'alexa').sessionId;
  await forceNewSession('tg:111', 'telegram');
  const after = getOrRotateSession('alexa:abc', 'alexa');
  assert.equal(after.isNew, true);
  assert.notEqual(after.sessionId, before);
});

function stubFetch(t, routes) {
  const requests = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null });
    const hit = Object.entries(routes).find(([prefix]) => String(url).startsWith(prefix));
    return hit ? Response.json(hit[1]) : new Response('not stubbed', { status: 500 });
  };
  t.after(() => { globalThis.fetch = real; });
  return requests;
}

function withKeys(t, keys) {
  const saved = Object.fromEntries(Object.keys(keys).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(keys)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  t.after(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });
}

const ANTHROPIC = 'https://api.anthropic.com/v1/messages';
const OPENAI = 'https://api.openai.com/v1/chat/completions';

test('askCore sends the front tools and dispatches the tool the router called', async (t) => {
  withKeys(t, { ANTHROPIC_API_KEY: 'test', OPENAI_API_KEY: undefined });
  const requests = stubFetch(t, {
    [ANTHROPIC]: { content: [{ type: 'tool_use', id: 't1', name: 'remind', input: { action: 'set', text: 'in 5 min', acknowledge: 'Noted, Sir.' } }] },
  });

  const out = await askCore('remind me in 5 min', { sessionKey: 'api:tools-1' });

  const sent = requests.find((r) => r.url === ANTHROPIC).body;
  assert.ok(sent.tools.some((tool) => tool.name === 'remind'));
  assert.doesNotMatch(sent.system, /raw JSON/);
  assert.equal(out.kind, 'actions');
  assert.equal(out.results[0].key, 'remind');
  assert.match(out.results[0].res.output, /only available via Telegram/);
});

test('askCore returns the text as a direct answer when no tool is called', async (t) => {
  withKeys(t, { ANTHROPIC_API_KEY: 'test', OPENAI_API_KEY: undefined });
  stubFetch(t, { [ANTHROPIC]: { content: [{ type: 'text', text: 'Good evening, Sir.' }] } });

  const out = await askCore('hello', { sessionKey: 'api:tools-2' });

  assert.equal(out.kind, 'direct');
  assert.equal(out.text, 'Good evening, Sir.');
});

test('askCore falls back to OpenAI function calling when Anthropic fails', async (t) => {
  withKeys(t, { ANTHROPIC_API_KEY: 'test', OPENAI_API_KEY: 'test' });
  const requests = stubFetch(t, {
    [OPENAI]: { choices: [{ message: { content: null, tool_calls: [{ type: 'function', function: { name: 'remind', arguments: '{"action":"list","text":"list","acknowledge":"One moment"}' } }] } }] },
  });

  const out = await askCore('what reminders do I have', { sessionKey: 'api:tools-3' });

  const sent = requests.find((r) => r.url === OPENAI).body;
  assert.equal(sent.tools[0].type, 'function');
  assert.equal(out.kind, 'actions');
  assert.equal(out.results[0].key, 'remind');
});

test('a structured reminder is created without a second model call', async (t) => {
  withKeys(t, { ANTHROPIC_API_KEY: 'test', OPENAI_API_KEY: undefined });
  const requests = stubFetch(t, {
    [ANTHROPIC]: { content: [{ type: 'tool_use', id: 't1', name: 'remind', input: {
      action: 'set', text: 'remind me to check the laundry in 30 minutes', message: 'check the laundry', in_minutes: 30, acknowledge: 'Noted, Sir.',
    } }] },
  });

  const out = await askCore('remind me to check the laundry in 30 minutes', { sessionKey: 'api:remind-1', chatId: '42' });

  assert.equal(requests.filter((r) => r.url === ANTHROPIC).length, 1);
  assert.equal(out.results[0].res.ok, true);
  assert.match(out.results[0].res.output, /Reminder set: "check the laundry"/);
});

test('a reminder without structured timing falls back to the text parser', async (t) => {
  withKeys(t, { ANTHROPIC_API_KEY: 'test', OPENAI_API_KEY: undefined });
  const requests = stubFetch(t, {
    [ANTHROPIC]: { content: [{ type: 'tool_use', id: 't1', name: 'remind', input: { action: 'set', text: 'remind me later', acknowledge: 'Noted, Sir.' } }] },
  });

  await askCore('remind me later', { sessionKey: 'api:remind-2', chatId: '42' });

  assert.equal(requests.filter((r) => r.url === ANTHROPIC).length, 2);
});

test('a structured calendar event is created without a second model call', async (t) => {
  withKeys(t, { ANTHROPIC_API_KEY: 'test', OPENAI_API_KEY: undefined });
  const requests = stubFetch(t, {
    [ANTHROPIC]: { content: [{ type: 'tool_use', id: 't1', name: 'calendar', input: {
      action: 'create', text: 'dentist on the 1st of March at 10', summary: 'Dentist', date: '2030-03-01', time: '10:00', acknowledge: 'Booked, Sir.',
    } }] },
  });

  const out = await askCore('dentist on the 1st of March at 10', { sessionKey: 'api:cal-1', chatId: '42' });

  assert.equal(requests.filter((r) => r.url === ANTHROPIC).length, 1);
  assert.equal(out.results[0].res.ok, true);
  assert.match(out.results[0].res.output, /"Dentist" — 1 Mar 2030, 10:00/);
});

test('a calendar listing with structured dates skips the range parser', async (t) => {
  withKeys(t, { ANTHROPIC_API_KEY: 'test', OPENAI_API_KEY: undefined });
  const requests = stubFetch(t, {
    [ANTHROPIC]: { content: [{ type: 'tool_use', id: 't1', name: 'calendar', input: {
      action: 'list', text: 'what do I have on Friday', start_date: '2030-03-01', end_date: '2030-03-01', acknowledge: 'Checking, Sir.',
    } }] },
  });

  await askCore('what do I have on Friday', { sessionKey: 'api:cal-2', chatId: '42' });

  assert.equal(requests.filter((r) => r.url === ANTHROPIC).length, 1);
});

test('a structured jellyfin request skips the intent classifier', async (t) => {
  withKeys(t, { ANTHROPIC_API_KEY: 'test', OPENAI_API_KEY: undefined, JELLYFIN_TOKEN: 'test', JELLYFIN_URL: 'http://jf.test' });
  const requests = stubFetch(t, {
    'http://jf.test/Sessions': [],
    [ANTHROPIC]: { content: [{ type: 'tool_use', id: 't1', name: 'jellyfin', input: {
      query: 'is anyone watching anything?', intent: 'nowplaying', acknowledge: 'Checking, Sir.',
    } }] },
  });

  const out = await askCore('is anyone watching anything?', { sessionKey: 'api:jf-1' });

  assert.equal(requests.filter((r) => r.url === ANTHROPIC).length, 1);
  assert.equal(out.results[0].res.output, 'Nothing is playing on Jellyfin right now, Sir.');
});

const MIN = 60_000;

test('a restart picks up conversations active in the last 30 minutes, keyed by identity', async () => {
  const now = Date.now();
  const restored = await restoreSessions({
    now,
    load: async () => [
      { sessionId: 'aaaaaaaa-0000-4000-8000-000000000001', sessionKey: 'tg:restore-1', lastActivity: now - 5 * MIN, source: 'telegram' },
      { sessionId: 'aaaaaaaa-0000-4000-8000-000000000002', sessionKey: 'tg:restore-2', lastActivity: now - 45 * MIN, source: 'telegram' },
      { sessionId: 'aaaaaaaa-0000-4000-8000-000000000003', sessionKey: null, lastActivity: now - 1 * MIN, source: 'telegram' },
    ],
  });

  assert.equal(restored, 1);
  const s = getOrRotateSession('tg:restore-1', 'telegram');
  assert.equal(s.isNew, false);
  assert.equal(s.sessionId, 'aaaaaaaa-0000-4000-8000-000000000001');
  assert.equal(getOrRotateSession('tg:restore-2', 'telegram').isNew, true);
});

test('getOrRotateSession returns the identity-resolved key to store with the session', () => {
  assert.equal(getOrRotateSession('alexa:abc', 'alexa').key, 'user:amir');
  assert.equal(getOrRotateSession('tg:unmapped-9', 'telegram').key, 'tg:unmapped-9');
});

test('the sweep summarises idle and orphaned sessions, newest first, a few at a time', async () => {
  const live = getOrRotateSession('tg:sweep-live', 'telegram').sessionId;
  const now = Date.now();
  const summarised = [];

  const first = await sweepIdleSessions({
    now,
    limit: 2,
    summarize: async (id) => { summarised.push(id); },
    load: async () => [
      { sessionId: live, sessionKey: 'tg:sweep-live', lastActivity: now, source: 'telegram' },
      { sessionId: 'orphan-recent', sessionKey: 'tg:x', lastActivity: now - 2 * MIN, source: 'telegram' },
      { sessionId: 'orphan-1', sessionKey: 'tg:y', lastActivity: now - 40 * MIN, source: 'telegram' },
      { sessionId: 'orphan-2', sessionKey: null, lastActivity: now - 3 * 24 * 60 * MIN, source: 'alexa' },
      { sessionId: 'orphan-3', sessionKey: null, lastActivity: now - 9 * 24 * 60 * MIN, source: 'telegram' },
    ],
  });

  assert.equal(first, 2);
  assert.deepEqual(summarised, ['orphan-1', 'orphan-2']);
  assert.equal(getOrRotateSession('tg:sweep-live', 'telegram').sessionId, live);
});

test('a cached session that has gone quiet is summarised and the next message starts a new one', async () => {
  const before = getOrRotateSession('tg:sweep-idle', 'telegram').sessionId;
  const summarised = [];

  await sweepIdleSessions({
    now: Date.now() + 31 * MIN,
    limit: 50,
    summarize: async (id) => { summarised.push(id); },
    load: async () => [],
  });

  assert.ok(summarised.includes(before));
  const after = getOrRotateSession('tg:sweep-idle', 'telegram');
  assert.equal(after.isNew, true);
  assert.notEqual(after.sessionId, before);
});
