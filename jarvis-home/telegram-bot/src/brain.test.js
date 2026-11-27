import { test } from 'node:test';
import assert from 'node:assert/strict';

delete process.env.DATABASE_URL;
process.env.JARVIS_IDENTITY_MAP = 'tg:111=amir,alexa:abc=amir,ha:*=amir';

const { getOrRotateSession, forceNewSession, askCore } = await import('./brain.js');

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
  const saved = { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY, OPENAI_API_KEY: process.env.OPENAI_API_KEY };
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
